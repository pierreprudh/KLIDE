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
use std::collections::HashSet;

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
        // A second Compact can keep a tail that crosses an older marker.
        // Only the newest summary is authoritative: replaying the old marker
        // would clear the new notes and the recent turns just reconstructed.
        .chain(events[marker - kept..marker].iter().filter(|event| !matches!(event, AgentEvent::ContextCompacted { .. })))
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
        AgentEvent::ObserverCompleted { text, context_recorded: false, .. } => text.len(),
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
    // A manual Compact on a large-window model must still fold most of the
    // conversation. A fraction of the model's capacity alone can exceed the
    // entire history and keep almost everything (86k tokens on a 1M window).
    let active_tokens: usize = effective_events(events).into_iter().map(event_tokens).sum();
    let keep_tokens = keep_tokens.min((active_tokens / 4).max(1));
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
    let openers: Vec<usize> = (floor + 1..events.len()).filter(|&i| opens_a_turn(&events[i])).collect();
    // A user turn keeps the context the loop recorded in front of it.
    let with_context = |mut start: usize| {
        if matches!(events[start], AgentEvent::UserMessage { .. }) {
            while start > floor + 1 && matches!(events[start - 1], AgentEvent::ContextInjected { .. }) {
                start -= 1;
            }
        }
        start
    };
    let tail = |start: usize| events[start..].iter().map(event_tokens).sum::<usize>();
    // The budget's cut: the latest boundary that keeps at least `keep_tokens`,
    // or, when even the whole tail is smaller, the earliest one.
    let budget = openers
        .iter()
        .rposition(|&i| tail(with_context(i)) >= keep_tokens)
        .unwrap_or(0);
    // Turns are coarse: one exchange can hold a whole batch of tool results,
    // and the boundary that meets the budget may keep all of it and fold
    // nothing. Then a later boundary — keeping less than the budget — is the
    // one that frees the window.
    openers[budget..].iter().map(|&i| with_context(i)).find_map(|start| {
        let folded: usize = events[floor..start].iter().map(event_tokens).sum();
        // Folding a sliver buys nothing and spends a model call.
        (folded >= 512).then(|| Cut { start, kept: events.len() - start })
    })
}

/// The instruction the model answers to write its summary. It rides as one
/// more user turn after the conversation exactly as the model last read it,
/// so the call reads the provider's cached prefix instead of paying for it.
/// Worded so a small model can't mistake it for the next step of the task
/// (dogfood: lfm2.5 answered "We need to read the file…").
pub(super) const SUMMARY_INSTRUCTION: &str = "[Klide — context compaction. This is not a message from the user, and not part of the task.]\n\
Stop working on the task for this one reply. The conversation is about to be shortened: everything \
before the most recent turns will be replaced by notes you write now, and you will continue from \
those notes. Write them: the user's goal, decisions made and why, files and functions touched, facts \
established (paths, names, commands, errors and their fixes), and the work still open. Bullets or a \
tight paragraph. Do not call a tool, do not answer or continue the task, do not address the user. \
Reply with the notes only.";

/// The summary request: the conversation as sent, plus the instruction.
pub(super) fn summary_request(messages: &[serde_json::Value]) -> Vec<serde_json::Value> {
    let mut request = messages.to_vec();
    request.push(serde_json::json!({ "role": "user", "content": SUMMARY_INSTRUCTION }));
    request
}

/// What the marker stores: the model's notes — its private reasoning cut
/// away, since a model that thinks inline returns `<think>…` as text — or a
/// deterministic stand-in when it wrote none. Then the user's own requests
/// from the folded turns, with the latest kept word for word: what the user
/// asked is the one fact a weak summary must not lose ("what's my first
/// message?"), even when a constraint is at the end of a long request.
pub(super) fn summary_text(model_notes: &str, events: &[AgentEvent], cut: Cut, stored: &HashSet<String>) -> String {
    let (answer, _thinking) = crate::adapters::split_thinking_tags(model_notes);
    let notes = answer.trim();
    let mut summary = if notes.is_empty() {
        fallback_summary(&events[..cut.start])
    } else {
        notes.to_string()
    };
    let requests: Vec<&str> = events[..cut.start]
        .iter()
        .filter_map(|e| match e {
            AgentEvent::UserMessage { text, .. } if !text.trim().is_empty() => Some(text.as_str()),
            _ => None,
        })
        .collect();
    // The first request and the newest ones: a long thread keeps its opening
    // and its recent asks without the list growing with every compaction.
    const MAX_REQUESTS: usize = 12;
    let shown: Vec<(usize, &str)> = requests
        .iter()
        .copied()
        .enumerate()
        .filter(|(i, _)| *i == 0 || *i + MAX_REQUESTS > requests.len())
        .collect();
    if !shown.is_empty() {
        summary.push_str("\n\nThe user's requests in the folded turns (oldest first; latest verbatim, older requests may be shortened):");
        let mut previous = None;
        for (i, text) in shown {
            if previous.is_some_and(|p: usize| i > p + 1) {
                summary.push_str("\n…");
            }
            summary.push_str(&format!("\n{}. ", i + 1));
            if i + 1 == requests.len() {
                summary.push_str(text);
            } else {
                summary.push_str(&clip(text, 600));
            }
            previous = Some(i);
        }
    }
    summary.push_str(&tool_ledger(&events[..cut.start], stored));
    summary
}

/// What the folded turns *did*, from the events: each tool call with the
/// argument that names it, failed ones marked, and — where the result was
/// saved — the id to reopen it with. A small model's notes forget progress
/// (dogfood: lfm2.5 re-read files it had already read after every
/// compaction, compacting again each time); this list can't.
fn tool_ledger(events: &[AgentEvent], stored: &HashSet<String>) -> String {
    let failed: HashSet<&str> = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::ToolCallFinished { tool_call_id, result, .. } if !result.ok => Some(tool_call_id.as_str()),
            _ => None,
        })
        .collect();
    let mut lines: Vec<(String, String)> = Vec::new();
    for event in events {
        let AgentEvent::AssistantMessage { content, .. } = event else { continue };
        for block in content {
            let AgentContentBlock::ToolCall { tool_call_id, name, input } = block else { continue };
            let arg = ["path", "command", "query", "pattern", "url", "id"]
                .iter()
                .find_map(|k| input.get(*k).and_then(|v| v.as_str()))
                .map(str::to_string)
                .unwrap_or_else(|| clip(&input.to_string(), 80));
            let key = format!("{name} {arg}");
            // Deduplicate on the full arguments, but only carry a short,
            // single-line label. Commands can contain whole scripts; copying
            // those into the notes defeats compaction. Keep the reopen id
            // outside the clipped label so it always remains usable.
            let mut line = format!("- {}", clip(&key.replace(['\r', '\n'], " "), 240));
            if failed.contains(tool_call_id.as_str()) {
                line.push_str(" (failed)");
            } else if stored.contains(tool_call_id) {
                line.push_str(&format!(" — result stored: peek_value id \"{}\"", super::retained::value_id(tool_call_id)));
            }
            // The same call again replaces its line: the newest result is the one to reopen.
            lines.retain(|(k, _)| *k != key);
            lines.push((key, line));
        }
    }
    if lines.is_empty() {
        return String::new();
    }
    const MAX_LINES: usize = 40;
    const MAX_BYTES: usize = 8_192;
    const HEADER: &str = "\n\nAlready done in the folded turns — reopen a stored result with peek_value instead of running the call again:";
    // Keep the newest entries within a byte budget as well as a line limit:
    // a Unicode label can cost several bytes per character. Reserve space
    // for the omitted-call count rather than clipping any result id.
    let mut bytes = HEADER.len() + 80;
    let mut hidden = lines.len();
    for (_, line) in lines.iter().rev().take(MAX_LINES) {
        if bytes + 1 + line.len() > MAX_BYTES {
            break;
        }
        bytes += 1 + line.len();
        hidden -= 1;
    }
    let mut out = String::from(HEADER);
    if hidden > 0 {
        out.push_str(&format!("\n- … {hidden} earlier call(s)"));
    }
    for (_, line) in &lines[hidden..] {
        out.push('\n');
        out.push_str(line);
    }
    out
}

/// Save each folded tool result through `store` (the run's value store) and
/// return the call ids that landed — the ledger's "reopen with" ids.
pub(super) fn store_folded_results(
    folded: &[AgentEvent],
    store: &mut dyn FnMut(&str, &str, &str) -> bool,
) -> HashSet<String> {
    let names: std::collections::HashMap<&str, &str> = folded
        .iter()
        .filter_map(|e| match e {
            AgentEvent::AssistantMessage { content, .. } => Some(content.iter().filter_map(|b| match b {
                AgentContentBlock::ToolCall { tool_call_id, name, .. } => Some((tool_call_id.as_str(), name.as_str())),
                _ => None,
            })),
            _ => None,
        })
        .flatten()
        .collect();
    folded
        .iter()
        .filter_map(|e| match e {
            AgentEvent::ToolCallFinished { tool_call_id, result, .. } if result.ok => {
                let name = names.get(tool_call_id.as_str()).copied().unwrap_or("tool");
                store(tool_call_id, name, &result.content).then(|| tool_call_id.clone())
            }
            _ => None,
        })
        .collect()
}

fn clip(s: &str, n: usize) -> String {
    if s.chars().count() > n {
        format!("{}…", s.chars().take(n - 1).collect::<String>())
    } else {
        s.to_string()
    }
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
        AgentEvent::ContextInjected { run_id: "r".into(), role: "system".into(), content: content.into(), before_user: false, ts: 0 }
    }
    fn marker(kept: Option<usize>) -> AgentEvent {
        AgentEvent::ContextCompacted { run_id: "r".into(), summary: "notes".into(), kept, context_tokens: None, cost_usd: None, manual: false, ts: 0 }
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
    fn one_exchange_with_a_big_batch_folds_the_batch_and_keeps_the_answer() {
        // Dogfood 2026-10-21: one request, one turn reading nine files, the
        // answer. The budget's boundary (the reading turn) kept everything; the
        // compaction refused with "every turn is still recent".
        let mut events = vec![user("read the nine files"), calls("f0.rs")];
        for i in 0..9 {
            events.push(result(&format!("f{i}.rs"), 12_000));
        }
        events.push(assistant("one line per file"));
        let cut = plan_cut(&events, 5_000).expect("the batch is worth folding");
        assert_eq!(cut.start, events.len() - 1, "the answer stays verbatim");
    }

    #[test]
    fn every_folded_request_is_kept_word_for_word_first_and_newest() {
        let mut events: Vec<AgentEvent> = (0..20).map(|i| user(&format!("request {i}"))).collect();
        events.push(assistant("ok"));
        let cut = Cut { start: 20, kept: 1 };
        let summary = summary_text("notes", &events, cut, &HashSet::new());
        assert!(summary.contains("\n1. request 0"), "the first request survives: {summary}");
        assert!(summary.contains("\n…\n10. request 9"), "{summary}");
        assert!(summary.ends_with("\n20. request 19"), "no calls, no ledger");
        assert!(!summary.contains("request 3\n"), "the middle is elided");
    }

    #[test]
    fn a_large_model_window_does_not_make_compact_keep_the_whole_conversation() {
        let mut events = vec![user(&"request ".repeat(400))];
        for i in 0..26 {
            events.push(calls(&format!("f{i}.rs")));
            events.push(result(&format!("f{i}.rs"), 12_000));
        }
        events.push(assistant(&"final explanation ".repeat(400)));
        let cut = plan_cut(&events, 1_000_000 / 4).unwrap();
        let before: usize = events.iter().map(event_tokens).sum();
        let after: usize = events[cut.start..].iter().map(event_tokens).sum();
        assert!(after < before / 2, "a 1M window kept {after} of {before} tokens: {cut:?}");
        assert!(matches!(events[cut.start], AgentEvent::AssistantMessage { .. }));
    }

    #[test]
    fn the_latest_folded_request_keeps_constraints_after_600_characters() {
        let request = format!("\n  {}\nDo not deploy or delete any files.\n", "背景🦀 ".repeat(200));
        let events = vec![user("the first request"), user(&request), assistant("ok")];
        for notes in ["Work so far.", ""] {
            let summary = summary_text(notes, &events, Cut { start: 2, kept: 1 }, &HashSet::new());
            assert!(summary.contains(&request), "the latest request must survive in full: {summary}");
        }
    }

    #[test]
    fn a_ledger_of_long_commands_is_bounded_and_keeps_the_newest_reopen_ids() {
        let mut events = Vec::new();
        let mut stored = HashSet::new();
        for i in 0..80 {
            let id = format!("command-{i}");
            stored.insert(id.clone());
            events.push(AgentEvent::AssistantMessage {
                run_id: "r".into(), message_id: format!("a-{i}"),
                content: vec![AgentContentBlock::ToolCall {
                    tool_call_id: id, name: "run_command".into(),
                    input: serde_json::json!({ "command": format!("echo {i}\n{}", "背景🦀".repeat(2_000)) }),
                }],
                usage: None, timing: None, ts: 0,
            });
        }
        let ledger = tool_ledger(&events, &stored);
        assert!(ledger.len() <= 8_192, "ledger grew to {} bytes", ledger.len());
        assert!(ledger.contains("earlier call(s)"));
        assert!(ledger.contains("peek_value id \"command-79\""));
        assert!(!ledger.contains("peek_value id \"command-0\""));
        assert!(ledger.lines().filter(|line| line.starts_with("- run_command")).all(|line| line.chars().count() < 400));
    }

    #[test]
    fn ledger_deduplication_uses_the_full_arguments_not_the_shortened_labels() {
        let prefix = "echo ".repeat(200);
        let events: Vec<_> = ["first", "second"].iter().map(|suffix| AgentEvent::AssistantMessage {
            run_id: "r".into(), message_id: suffix.to_string(),
            content: vec![AgentContentBlock::ToolCall {
                tool_call_id: suffix.to_string(), name: "run_command".into(),
                input: serde_json::json!({ "command": format!("{prefix}{suffix}") }),
            }],
            usage: None, timing: None, ts: 0,
        }).collect();
        let stored = ["first".to_string(), "second".to_string()].into();
        let ledger = tool_ledger(&events, &stored);
        assert!(ledger.contains("peek_value id \"first\""));
        assert!(ledger.contains("peek_value id \"second\""));
    }

    #[test]
    fn the_folded_calls_are_listed_with_where_to_reopen_them() {
        let events = vec![
            user("read them"),
            calls("a.rs"),
            result("a.rs", 4_000),
            calls("b.rs"),
            AgentEvent::ToolCallFinished {
                run_id: "r".into(),
                tool_call_id: "c-b.rs".into(),
                result: ToolResult { ok: false, content: "no such file".into(), metadata: None },
                ts: 0,
            },
            calls("a.rs"),
            result("a.rs", 4_000),
            assistant("ok"),
        ];
        let stored: HashSet<String> = ["c-a.rs".to_string()].into();
        let summary = summary_text("notes", &events, Cut { start: 7, kept: 1 }, &stored);
        let ledger = summary.split("Already done in the folded turns").nth(1).expect("a ledger");
        assert!(ledger.contains("- read_file b.rs (failed)"), "{ledger}");
        assert!(ledger.contains("- read_file a.rs — result stored: peek_value id"), "{ledger}");
        assert_eq!(ledger.matches("read_file a.rs").count(), 1, "a repeated call is one line");
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
        let summary = summary_text("Read a.rs; it defines Parser.", &events, cut, &HashSet::new());
        assert!(summary.starts_with("Read a.rs"));
        assert!(summary.contains("\n1. rename the parser module"), "{summary}");
        let fallback = summary_text("  ", &events, cut, &HashSet::new());
        assert!(fallback.contains("Files touched: a.rs"), "{fallback}");
        // A model that thinks inline: the reasoning goes, the notes stay.
        let thought = summary_text("<think>\nWe need to read the file…</think>\nParser lives in a.rs.", &events, cut, &HashSet::new());
        assert!(thought.starts_with("Parser lives in a.rs."), "{thought}");
        // Reasoning that never closed is no notes at all: the stand-in.
        let unclosed = summary_text("<think>\nWe need to read the file", &events, cut, &HashSet::new());
        assert!(unclosed.contains("Files touched: a.rs"), "{unclosed}");
    }
}
