//! Conversation compaction — the summary half. Trimming old tool results
//! (`run_core::compact_old_tool_results`) is the cheap first resort; when a
//! conversation still crowds its window after that, the turns before a cut
//! point fold into one summary the model writes for itself, and the turns
//! after it stay verbatim.
//!
//! The transcript is append-only, so the `ContextCompacted` marker lands at
//! its end, after the turns it keeps. `kept` says how many events right before
//! the marker are still part of the conversation; [`effective_events`] is the
//! one reading of that, used by replay and by anything else that asks what the
//! model sees. A marker without `kept` (every one written before this) keeps
//! nothing before it, as it always did.
//!
//! Pure: no IO, no provider. The run loop and the manual command make the
//! model call and write the marker.

use super::types::{AgentContentBlock, AgentEvent};

/// The events the model's conversation is made of: the newest marker's
/// summary, the events it kept, then everything after it. Without a marker,
/// every event.
pub(super) fn effective_events(events: &[AgentEvent]) -> Vec<&AgentEvent> {
    let Some(marker) = events
        .iter()
        .rposition(|e| matches!(e, AgentEvent::ContextCompacted { .. }))
    else {
        return events.iter().collect();
    };
    let kept = match &events[marker] {
        AgentEvent::ContextCompacted { kept, .. } => kept.unwrap_or(0).min(marker),
        _ => 0,
    };
    std::iter::once(&events[marker])
        .chain(&events[marker - kept..marker])
        .chain(&events[marker + 1..])
        .collect()
}

/// Rough prompt tokens an event contributes when replayed — the same
/// four-characters-a-token heuristic the loop's estimate uses.
fn event_tokens(event: &AgentEvent) -> usize {
    let chars = match event {
        AgentEvent::UserMessage { text, attachments, .. } => {
            text.len() + attachments.iter().map(|a| a.content.len()).sum::<usize>()
        }
        AgentEvent::AssistantMessage { content, .. } => content
            .iter()
            .map(|block| match block {
                AgentContentBlock::Text { text } => text.len(),
                AgentContentBlock::ToolCall { name, input, .. } => name.len() + input.to_string().len(),
                _ => 0,
            })
            .sum(),
        AgentEvent::ToolCallFinished { result, .. } => result.content.len(),
        AgentEvent::ContextInjected { content, .. } => content.len(),
        AgentEvent::ObserverCompleted { text, .. } => text.len(),
        AgentEvent::ContextCompacted { summary, .. } => summary.len(),
        _ => 0,
    };
    chars / 4
}

/// Where a compaction cuts: everything from `start` on stays verbatim.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Cut {
    /// Index into the raw events of the first one kept.
    pub start: usize,
    /// How many events the marker keeps — `events.len() - start` at the time
    /// it is written.
    pub kept: usize,
}

/// A place a kept tail can begin: a user turn (with the context the loop set
/// in front of it) or an assistant turn. Never a tool result — it would arrive
/// without the call it answers.
fn opens_a_turn(event: &AgentEvent) -> bool {
    matches!(event, AgentEvent::UserMessage { .. } | AgentEvent::AssistantMessage { .. })
}

/// The cut that keeps roughly `keep_tokens` of the newest conversation
/// verbatim and folds the rest. `None` when there is nothing worth folding:
/// no turn boundary after the last marker, or nothing substantial before it.
///
/// The cut never reaches behind the previous marker — what that marker folded
/// is already the summary, and what it kept is folded again by this one.
pub(super) fn plan_cut(events: &[AgentEvent], keep_tokens: usize) -> Option<Cut> {
    let floor = events
        .iter()
        .rposition(|e| matches!(e, AgentEvent::ContextCompacted { .. }))
        .map_or(0, |marker| {
            let kept = match &events[marker] {
                AgentEvent::ContextCompacted { kept, .. } => kept.unwrap_or(0).min(marker),
                _ => 0,
            };
            marker - kept
        });
    let mut tail = 0usize;
    let mut chosen = None;
    for i in (floor..events.len()).rev() {
        tail += event_tokens(&events[i]);
        if opens_a_turn(&events[i]) && i > floor {
            chosen = Some(i);
            if tail >= keep_tokens {
                break;
            }
        }
    }
    let mut start = chosen?;
    // A user turn keeps the context the loop recorded in front of it.
    if matches!(events[start], AgentEvent::UserMessage { .. }) {
        while start > floor + 1 && matches!(events[start - 1], AgentEvent::ContextInjected { .. }) {
            start -= 1;
        }
    }
    let folded: usize = events[floor..start].iter().map(event_tokens).sum();
    // Folding a sliver buys nothing and spends a model call.
    if folded < 512 {
        return None;
    }
    Some(Cut { start, kept: events.len() - start })
}

/// The instruction the model answers to write its summary. It rides as one
/// more user turn after the conversation exactly as the model last read it,
/// so the call reads the provider's cached prefix instead of paying for it.
pub(super) const SUMMARY_INSTRUCTION: &str = "[Klide: compacting this conversation]\n\
The conversation is close to the context window. Write the notes that will replace the earlier part \
of it as your own memory; the most recent turns stay verbatim after them. Keep everything needed to \
carry on: the user's goal and requests, decisions made and why, files and functions touched, facts \
established (paths, names, commands, errors and their fixes), and the work still open. Be concise — \
bullets or a tight paragraph. Do not call any tool, do not address the user, invent nothing; reply \
with the notes only.";

/// The summary request: the conversation as sent, plus the instruction.
pub(super) fn summary_request(messages: &[serde_json::Value]) -> Vec<serde_json::Value> {
    let mut request = messages.to_vec();
    request.push(serde_json::json!({ "role": "user", "content": SUMMARY_INSTRUCTION }));
    request
}

/// What the marker stores. The model's notes, or a deterministic stand-in
/// when it wrote none — compaction must free the window either way. When the
/// operator's latest message is among the folded turns, it rides along word
/// for word: the task itself is never left to a paraphrase.
pub(super) fn summary_text(model_notes: &str, events: &[AgentEvent], cut: Cut) -> String {
    let notes = model_notes.trim();
    let mut summary = if notes.is_empty() {
        fallback_summary(&events[..cut.start])
    } else {
        notes.to_string()
    };
    let latest_request = events.iter().rposition(|e| matches!(e, AgentEvent::UserMessage { .. }));
    if let Some(i) = latest_request.filter(|i| *i < cut.start) {
        if let AgentEvent::UserMessage { text, .. } = &events[i] {
            if !text.trim().is_empty() {
                summary.push_str("\n\nThe user's latest request, verbatim:\n");
                summary.push_str(text.trim());
            }
        }
    }
    summary
}

/// Notes built from the events themselves: the requests as typed and the
/// paths the tools touched. No prose scraping.
pub(super) fn fallback_summary(events: &[AgentEvent]) -> String {
    let clip = |s: &str, n: usize| {
        if s.chars().count() > n {
            format!("{}…", s.chars().take(n - 1).collect::<String>())
        } else {
            s.to_string()
        }
    };
    let requests: Vec<String> = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::UserMessage { text, .. } if !text.trim().is_empty() => Some(clip(text.trim(), 300)),
            _ => None,
        })
        .collect();
    let mut files: Vec<String> = Vec::new();
    for event in events {
        if let AgentEvent::AssistantMessage { content, .. } = event {
            for block in content {
                if let AgentContentBlock::ToolCall { input, .. } = block {
                    if let Some(path) = input.get("path").and_then(|p| p.as_str()) {
                        if !files.iter().any(|f| f == path) {
                            files.push(path.to_string());
                        }
                    }
                }
            }
        }
    }
    let mut parts = Vec::new();
    if !requests.is_empty() {
        parts.push(format!(
            "Requests so far:\n{}",
            requests.iter().map(|r| format!("- {r}")).collect::<Vec<_>>().join("\n")
        ));
    }
    if !files.is_empty() {
        parts.push(format!("Files touched: {}", files.join(", ")));
    }
    if parts.is_empty() {
        "Earlier turns were compacted; no requests or file changes were recorded in them.".to_string()
    } else {
        parts.join("\n\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::types::ToolResult;

    fn user(text: &str) -> AgentEvent {
        AgentEvent::UserMessage { run_id: "r".into(), message_id: "u".into(), text: text.into(), attachments: vec![], ts: 0 }
    }
    fn assistant(text: &str) -> AgentEvent {
        AgentEvent::AssistantMessage {
            run_id: "r".into(),
            message_id: "a".into(),
            content: vec![AgentContentBlock::Text { text: text.into() }],
            usage: None,
            timing: None,
            ts: 0,
        }
    }
    fn calls(path: &str) -> AgentEvent {
        AgentEvent::AssistantMessage {
            run_id: "r".into(),
            message_id: "a".into(),
            content: vec![AgentContentBlock::ToolCall {
                tool_call_id: format!("c-{path}"),
                name: "read_file".into(),
                input: serde_json::json!({ "path": path }),
            }],
            usage: None,
            timing: None,
            ts: 0,
        }
    }
    fn result(path: &str, size: usize) -> AgentEvent {
        AgentEvent::ToolCallFinished {
            run_id: "r".into(),
            tool_call_id: format!("c-{path}"),
            result: ToolResult { ok: true, content: "x".repeat(size), metadata: None },
            ts: 0,
        }
    }
    fn injected(content: &str) -> AgentEvent {
        AgentEvent::ContextInjected { run_id: "r".into(), role: "system".into(), content: content.into(), ts: 0 }
    }
    fn marker(kept: Option<usize>) -> AgentEvent {
        AgentEvent::ContextCompacted { run_id: "r".into(), summary: "notes".into(), kept, context_tokens: None, ts: 0 }
    }

    #[test]
    fn an_old_marker_keeps_nothing_before_it() {
        let events = vec![user("a"), assistant("b"), marker(None), user("c")];
        let seen: Vec<_> = effective_events(&events).into_iter().cloned().collect();
        assert!(matches!(seen[0], AgentEvent::ContextCompacted { .. }));
        assert_eq!(seen.len(), 2);
    }

    #[test]
    fn a_marker_keeps_the_tail_it_names() {
        let events = vec![user("a"), assistant("b"), user("c"), assistant("d"), marker(Some(2)), user("e")];
        let seen = effective_events(&events);
        let texts: Vec<_> = seen
            .iter()
            .map(|e| match e {
                AgentEvent::UserMessage { text, .. } => text.clone(),
                AgentEvent::AssistantMessage { .. } => "A".into(),
                AgentEvent::ContextCompacted { .. } => "S".into(),
                _ => "?".into(),
            })
            .collect();
        assert_eq!(texts, vec!["S", "c", "A", "e"]);
    }

    #[test]
    fn a_cut_opens_a_turn_and_never_strands_a_result() {
        // One long run: a request, then tool turns. The kept tail must begin
        // at an assistant turn, carrying its results with it.
        let mut events = vec![user("fix it")];
        for i in 0..10 {
            events.push(calls(&format!("f{i}.rs")));
            events.push(result(&format!("f{i}.rs"), 4_000));
        }
        let cut = plan_cut(&events, 2_000).unwrap();
        assert!(matches!(events[cut.start], AgentEvent::AssistantMessage { .. }));
        assert_eq!(cut.kept, events.len() - cut.start);
        assert!(cut.kept >= 2 && cut.kept < events.len() - 1, "{cut:?}");
    }

    #[test]
    fn a_user_turn_keeps_the_context_set_in_front_of_it() {
        let events = vec![
            user(&"old ".repeat(2_000)),
            assistant(&"reply ".repeat(2_000)),
            injected("[TODO list]\n- [ ] a"),
            user("now this, please"),
            assistant("ok"),
        ];
        // A budget the newest exchange already covers: the cut lands on the
        // user turn, and reaches back over its TODO snapshot.
        let cut = plan_cut(&events, 2).unwrap();
        assert!(matches!(events[cut.start], AgentEvent::ContextInjected { .. }), "{cut:?}");
    }

    #[test]
    fn nothing_worth_folding_is_left_alone() {
        assert_eq!(plan_cut(&[user("hi"), assistant("hello")], 10), None);
        // Behind a fresh marker whose kept tail is tiny, there is nothing new to fold.
        let events = vec![user("a"), marker(Some(1)), assistant("b")];
        assert_eq!(plan_cut(&events, 10), None);
    }

    #[test]
    fn the_operators_request_survives_its_own_fold() {
        let events = vec![user("rename the parser module"), calls("a.rs"), result("a.rs", 4_000), calls("b.rs"), result("b.rs", 10)];
        let cut = Cut { start: 3, kept: 2 };
        let summary = summary_text("Read a.rs; it defines Parser.", &events, cut);
        assert!(summary.starts_with("Read a.rs"));
        assert!(summary.ends_with("verbatim:\nrename the parser module"));
        let fallback = summary_text("  ", &events, cut);
        assert!(fallback.contains("Files touched: a.rs"), "{fallback}");
    }
}
