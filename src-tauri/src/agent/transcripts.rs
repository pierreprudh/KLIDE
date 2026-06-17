use super::types::{AgentContentBlock, AgentEvent, AgentRunSummary};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptLine {
    schema_version: u8,
    run_id: String,
    seq: u64,
    ts: i64,
    event: AgentEvent,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn run_id() -> String {
    let ts = now_ms();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("run_{ts}_{nanos:x}")
}

pub fn app_runs_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Unable to resolve app data dir: {e}"))?
        .join("runs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Unable to create runs dir: {e}"))?;
    Ok(dir)
}

fn summary_path(runs_dir: &Path, run_id: &str) -> PathBuf {
    runs_dir.join(format!("{run_id}.summary.json"))
}

pub fn transcript_path(runs_dir: &Path, run_id: &str) -> PathBuf {
    runs_dir.join(format!("{run_id}.jsonl"))
}

pub fn append_event(
    runs_dir: &Path,
    run_id: &str,
    seq: u64,
    event: &AgentEvent,
) -> Result<(), String> {
    let ts = match event {
        AgentEvent::RunStarted { ts, .. }
        | AgentEvent::ContextSnapshot { ts, .. }
        | AgentEvent::UserMessage { ts, .. }
        | AgentEvent::AssistantDelta { ts, .. }
        | AgentEvent::AssistantMessage { ts, .. }
        | AgentEvent::ToolCallStarted { ts, .. }
        | AgentEvent::ToolProgress { ts, .. }
        | AgentEvent::ToolCallFinished { ts, .. }
        | AgentEvent::PermissionResolved { ts, .. }
        | AgentEvent::DiffResolved { ts, .. }
        | AgentEvent::PermissionRequested { ts, .. }
        | AgentEvent::DiffProposed { ts, .. }
        | AgentEvent::FileChanged { ts, .. }
        | AgentEvent::RunResult { ts, .. }
        | AgentEvent::RunError { ts, .. }
        | AgentEvent::UserQuestionRequested { ts, .. }
        | AgentEvent::UserQuestionResolved { ts, .. }
        | AgentEvent::ContextCompacted { ts, .. } => *ts,
    };
    let line = TranscriptLine {
        schema_version: 1,
        run_id: run_id.to_string(),
        seq,
        ts,
        event: event.clone(),
    };
    let encoded = serde_json::to_string(&line).map_err(|e| e.to_string())?;
    use std::io::Write;
    let path = transcript_path(runs_dir, run_id);
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("Unable to open transcript: {e}"))?;
    writeln!(file, "{encoded}").map_err(|e| format!("Unable to append transcript: {e}"))
}

pub fn write_summary(runs_dir: &Path, summary: &AgentRunSummary) -> Result<(), String> {
    // Lazy enrichment: the run loop writes summaries throughout a run's
    // life, but only the *transcript* carries the full event stream that
    // the Mission Control row needs (file_changed paths, summed usage).
    // Rather than thread the per-turn counts through the run loop, we
    // re-walk the transcript here whenever the caller didn't pre-fill
    // them. The transcript is the source of truth — callers that already
    // computed values (none today) can pass them in and skip the re-walk.
    let mut summary = summary.clone();
    if let Ok(events) = read_events(runs_dir, &summary.id) {
        // Stats are additive sums — only fill them when the caller left them
        // at zero (no caller pre-fills them today).
        if summary.input_tokens == 0
            && summary.output_tokens == 0
            && summary.files_touched == 0
            && summary.cost_usd.is_none()
        {
            let (input, output, files) = summarize_event_stats(&events);
            summary.input_tokens = input;
            summary.output_tokens = output;
            summary.files_touched = files;
            summary.cost_usd = crate::pricing::cost_for_run(&summary.model, input, output);
        }
        // last_event tracks the *latest* assistant turn, so recompute it every
        // write — the transcript grows as the run progresses. Klide's own
        // transcripts are bounded (≤16 turns), so the re-read is cheap.
        summary.last_event = last_assistant_summary(&events);
    }
    let path = summary_path(runs_dir, &summary.id);
    let encoded = serde_json::to_string_pretty(&summary).map_err(|e| e.to_string())?;
    std::fs::write(path, encoded).map_err(|e| format!("Unable to write run summary: {e}"))
}

/// Walk the event stream once and return `(input_tokens, output_tokens, files_touched)`.
/// `assistant_message.usage` carries the per-turn accounting; `file_changed.path`
/// is what the row needs to display. Pure function — used by `write_summary`
/// and by tests.
pub(crate) fn summarize_event_stats(events: &[AgentEvent]) -> (i64, i64, u32) {
    use std::collections::HashSet;
    let mut input: i64 = 0;
    let mut output: i64 = 0;
    let mut files: HashSet<String> = HashSet::new();
    for event in events {
        match event {
            AgentEvent::AssistantMessage { usage, .. } => {
                if let Some(u) = usage {
                    input += u.prompt_tokens.unwrap_or(0) as i64;
                    output += u.completion_tokens.unwrap_or(0) as i64;
                }
            }
            AgentEvent::FileChanged { path, .. } => {
                let trimmed = path.trim();
                if !trimmed.is_empty() {
                    files.insert(trimmed.to_string());
                }
            }
            _ => {}
        }
    }
    (input, output, files.len() as u32)
}

/// One-line summary of the run's most recent assistant turn — "what it last
/// did" — for the Mission Control row. Text blocks concatenate; tool calls
/// collapse to `[tool: <name>]`; thinking is dropped. The newest assistant
/// turn wins, capped to a single 120-char line. `None` when there's no
/// assistant turn with renderable content yet.
pub(crate) fn last_assistant_summary(events: &[AgentEvent]) -> Option<String> {
    let mut last: Option<String> = None;
    for event in events {
        if let AgentEvent::AssistantMessage { content, .. } = event {
            let mut buf = String::new();
            for block in content {
                match block {
                    AgentContentBlock::Text { text } => {
                        let t = text.trim();
                        if !t.is_empty() {
                            if !buf.is_empty() {
                                buf.push('\n');
                            }
                            buf.push_str(t);
                        }
                    }
                    AgentContentBlock::ToolCall { name, .. } => {
                        if !buf.is_empty() {
                            buf.push('\n');
                        }
                        buf.push_str(&format!("[tool: {name}]"));
                    }
                    _ => {} // thinking blocks have no place in a one-line résumé
                }
            }
            let trimmed = buf.trim();
            if !trimmed.is_empty() {
                last = Some(trimmed.lines().next().unwrap_or(trimmed).chars().take(120).collect());
            }
        }
    }
    last
}

pub fn read_events(runs_dir: &Path, run_id: &str) -> Result<Vec<AgentEvent>, String> {
    let path = transcript_path(runs_dir, run_id);
    let content =
        std::fs::read_to_string(path).map_err(|e| format!("Unable to read transcript: {e}"))?;
    let mut events = Vec::new();
    for line in content.lines() {
        let Ok(row) = serde_json::from_str::<TranscriptLine>(line) else {
            continue;
        };
        events.push(row.event);
    }
    Ok(events)
}

pub fn list_summaries(
    runs_dir: &Path,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<AgentRunSummary>, String> {
    let mut summaries = Vec::new();
    for entry in std::fs::read_dir(runs_dir).map_err(|e| format!("Unable to read runs dir: {e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name.ends_with(".summary.json") {
            continue;
        }
        let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        if let Ok(summary) = serde_json::from_str::<AgentRunSummary>(&text) {
            summaries.push(summary);
        }
    }
    summaries.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms));
    Ok(summaries
        .into_iter()
        .skip(offset.unwrap_or(0))
        .take(limit.unwrap_or(50))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::types::AgentUsage;

    fn file_changed(id: &str, path: &str) -> AgentEvent {
        AgentEvent::FileChanged {
            run_id: id.to_string(),
            path: path.to_string(),
            old_hash: "a".to_string(),
            new_hash: "b".to_string(),
            ts: 1,
        }
    }

    fn assistant_with_usage(id: &str, prompt: u64, completion: u64) -> AgentEvent {
        AgentEvent::AssistantMessage {
            run_id: id.to_string(),
            message_id: "m".to_string(),
            content: vec![],
            usage: Some(AgentUsage {
                prompt_tokens: Some(prompt),
                completion_tokens: Some(completion),
                ..Default::default()
            }),
            ts: 1,
        }
    }

    fn assistant_with_text(id: &str, text: &str) -> AgentEvent {
        AgentEvent::AssistantMessage {
            run_id: id.to_string(),
            message_id: "m".to_string(),
            content: vec![AgentContentBlock::Text {
                text: text.to_string(),
            }],
            usage: None,
            ts: 1,
        }
    }

    #[test]
    fn last_assistant_summary_takes_newest_turn_first_line() {
        let id = "r";
        let events = vec![
            assistant_with_text(id, "first turn"),
            file_changed(id, "src/a.rs"),
            assistant_with_text(id, "done — committed the fix\nextra line"),
        ];
        // Newest assistant turn wins; only its first line, trimmed.
        assert_eq!(
            last_assistant_summary(&events).as_deref(),
            Some("done — committed the fix")
        );
    }

    #[test]
    fn last_assistant_summary_none_without_assistant_text() {
        let id = "r";
        // Usage-only assistant turns carry no renderable content.
        let events = vec![assistant_with_usage(id, 10, 5)];
        assert_eq!(last_assistant_summary(&events), None);
    }

    #[test]
    fn summarize_event_stats_sums_usage_and_dedupes_paths() {
        let id = "test-run";
        let events = vec![
            file_changed(id, "src/main.rs"),
            file_changed(id, "src/main.rs"), // re-touch — same path
            file_changed(id, "Cargo.toml"),
            assistant_with_usage(id, 100, 20),
            assistant_with_usage(id, 50, 10),
        ];
        let (input, output, files) = summarize_event_stats(&events);
        assert_eq!(input, 150);
        assert_eq!(output, 30);
        assert_eq!(files, 2);
    }

    #[test]
    fn summarize_event_stats_ignores_events_without_usage() {
        let id = "test-run";
        // An assistant_message with no usage block contributes nothing.
        let events = vec![AgentEvent::AssistantMessage {
            run_id: id.to_string(),
            message_id: "m".to_string(),
            content: vec![],
            usage: None,
            ts: 1,
        }];
        let (input, output, files) = summarize_event_stats(&events);
        assert_eq!(input, 0);
        assert_eq!(output, 0);
        assert_eq!(files, 0);
    }

    #[test]
    fn summarize_event_stats_skips_empty_file_paths() {
        let id = "test-run";
        let events = vec![file_changed(id, ""), file_changed(id, "   ")];
        let (_, _, files) = summarize_event_stats(&events);
        assert_eq!(files, 0, "empty / whitespace paths shouldn't count");
    }

    #[test]
    fn write_summary_enriches_from_transcript_when_zero() {
        // Set up a temp runs dir, append two events, call write_summary
        // with the new fields at their default (0/None), and verify the
        // file on disk has the enriched values.
        let dir = std::env::temp_dir().join("klide-transcripts-test-enrich");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let id = "enrich-1";
        // Append events directly (write_summary expects them to exist).
        append_event(
            &dir,
            id,
            0,
            &file_changed(id, "src/a.rs"),
        )
        .unwrap();
        append_event(
            &dir,
            id,
            1,
            &assistant_with_usage(id, 100, 50),
        )
        .unwrap();
        let summary = AgentRunSummary {
            id: id.to_string(),
            path: String::new(),
            source: "klide".to_string(),
            title: "t".to_string(),
            status: "done".to_string(),
            provider: "anthropic".to_string(),
            model: "claude-sonnet-4-6".to_string(),
            cwd: None,
            project: None,
            git_branch: None,
            created_ms: 0,
            updated_ms: 0,
            message_count: 1,
            input_tokens: 0,
            output_tokens: 0,
            files_touched: 0,
            cost_usd: None,
            last_event: None,
            parent_id: None,
        };
        write_summary(&dir, &summary).unwrap();
        let on_disk = std::fs::read_to_string(dir.join(format!("{id}.summary.json"))).unwrap();
        // Sonnet 4.6 at 100/50 = 0.0003 + 0.00075 = 0.00105 USD.
        assert!(on_disk.contains("\"inputTokens\": 100"), "got: {on_disk}");
        assert!(on_disk.contains("\"outputTokens\": 50"));
        assert!(on_disk.contains("\"filesTouched\": 1"));
        assert!(on_disk.contains("\"costUsd\": 0.00105"), "got: {on_disk}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
