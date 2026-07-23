use super::types::{
    AgentContentBlock, AgentEvent, AgentRunSummary, AgentValidationCheckSummary,
    AgentValidationSummary,
};
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

/// A run id must be a single plain path component — no separators, no parent
/// refs — because it becomes a file name inside the runs dir (transcript,
/// summary, checkpoint folder). Run ids are minted here (`run_{ts}_{hex}`) but
/// also arrive from the frontend (conversation-id reuse in `agent_start_run`,
/// and every read/checkpoint command), so without this check a hostile
/// `{"runId": "../../x"}` over IPC would read or write outside the runs dir.
pub fn validate_run_id(run_id: &str) -> Result<(), String> {
    if run_id.contains('\\') {
        return Err("Invalid run id.".into());
    }
    let mut components = Path::new(run_id).components();
    match (components.next(), components.next()) {
        (Some(std::path::Component::Normal(_)), None) => Ok(()),
        _ => Err("Invalid run id.".into()),
    }
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
        | AgentEvent::SubagentRequested { ts, .. }
        | AgentEvent::SubagentResolved { ts, .. }
        | AgentEvent::AdvisorRequested { ts, .. }
        | AgentEvent::AdvisorResolved { ts, .. }
        | AgentEvent::ContextCompacted { ts, .. }
        | AgentEvent::SteeringInjected { ts, .. } => *ts,
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
        summary.validation = Some(summarize_validation(&events));
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

pub(crate) fn summarize_validation(events: &[AgentEvent]) -> AgentValidationSummary {
    use std::collections::{HashMap, HashSet};

    let mut tool_names: HashMap<String, String> = HashMap::new();
    let mut command_ids: HashSet<String> = HashSet::new();
    let mut files: HashSet<String> = HashSet::new();
    let mut commands_run = 0u32;
    let mut commands_failed = 0u32;
    let mut diff_reviews = 0u32;
    let mut applied_diffs = 0u32;
    let mut rejected_diffs = 0u32;
    let mut permissions_approved = 0u32;
    let mut permissions_denied = 0u32;

    for event in events {
        match event {
            AgentEvent::ToolCallStarted {
                tool_call_id, name, ..
            } => {
                tool_names.insert(tool_call_id.clone(), name.clone());
                if name == "run_command" {
                    command_ids.insert(tool_call_id.clone());
                }
            }
            AgentEvent::PermissionRequested { request, .. }
                if request
                    .get("input")
                    .and_then(|input| input.get("command"))
                    .and_then(|command| command.as_str())
                    .is_some()
                => {
                    if let Some(tool_call_id) = request.get("toolCallId").and_then(|v| v.as_str()) {
                        command_ids.insert(tool_call_id.to_string());
                    }
                }
            AgentEvent::PermissionResolved { decision, .. } => {
                if decision.get("behavior").and_then(|b| b.as_str()) == Some("allow") {
                    permissions_approved += 1;
                } else {
                    permissions_denied += 1;
                }
            }
            AgentEvent::ToolCallFinished {
                tool_call_id,
                result,
                ..
            }
                if (command_ids.contains(tool_call_id)
                    || tool_names
                        .get(tool_call_id)
                        .map(|name| name == "run_command")
                        == Some(true))
                => {
                    commands_run += 1;
                    if !result.ok {
                        commands_failed += 1;
                    }
                }
            AgentEvent::DiffResolved { decision, .. } => {
                diff_reviews += 1;
                if decision.get("behavior").and_then(|b| b.as_str()) == Some("apply") {
                    applied_diffs += 1;
                } else {
                    rejected_diffs += 1;
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

    let files_changed = files.len() as u32;
    let mut checks = Vec::new();
    let mut warnings = Vec::new();

    if files_changed > 0 {
        checks.push(AgentValidationCheckSummary {
            id: "diff-review".to_string(),
            label: "Changed files passed Diff review".to_string(),
            status: if applied_diffs > 0 {
                "passed"
            } else {
                "failed"
            }
            .to_string(),
            required: true,
            evidence: Some(format!(
                "{applied_diffs} applied, {rejected_diffs} rejected"
            )),
        });
    } else {
        checks.push(AgentValidationCheckSummary {
            id: "diff-review".to_string(),
            label: "No file changes required Diff review".to_string(),
            status: "skipped".to_string(),
            required: false,
            evidence: None,
        });
    }

    if commands_run > 0 {
        checks.push(AgentValidationCheckSummary {
            id: "command-validation".to_string(),
            label: "Command validation completed".to_string(),
            status: if commands_failed == 0 {
                "passed"
            } else {
                "failed"
            }
            .to_string(),
            required: files_changed > 0,
            evidence: Some(format!(
                "{} passed, {} failed",
                commands_run.saturating_sub(commands_failed),
                commands_failed
            )),
        });
    } else {
        checks.push(AgentValidationCheckSummary {
            id: "command-validation".to_string(),
            label: if files_changed > 0 {
                "No validation command recorded after file changes".to_string()
            } else {
                "No validation command needed for read-only run".to_string()
            },
            status: "skipped".to_string(),
            required: files_changed > 0,
            evidence: None,
        });
        if files_changed > 0 {
            warnings.push("Files changed without a recorded validation command.".to_string());
        }
    }

    if permissions_denied > 0 {
        warnings.push(format!(
            "{permissions_denied} permission request(s) denied."
        ));
    }

    let status = if commands_failed > 0
        || checks
            .iter()
            .any(|check| check.required && check.status == "failed")
    {
        "failed"
    } else if files_changed > 0 && commands_run == 0 {
        "unverified"
    } else if files_changed == 0 && commands_run == 0 {
        "skipped"
    } else {
        "passed"
    }
    .to_string();

    AgentValidationSummary {
        status,
        checks,
        files_changed,
        commands_run,
        commands_failed,
        diff_reviews,
        permissions_approved,
        permissions_denied,
        warnings,
    }
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
                last = Some(
                    trimmed
                        .lines()
                        .next()
                        .unwrap_or(trimmed)
                        .chars()
                        .take(120)
                        .collect(),
                );
            }
        }
    }
    last
}

/// Read one run's summary file. Errors when the run has no summary on disk
/// (never persisted, or a delegate CLI run that lives outside `runs/`).
pub fn read_summary(runs_dir: &Path, run_id: &str) -> Result<AgentRunSummary, String> {
    let path = summary_path(runs_dir, run_id);
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("Unable to read run summary: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("Unable to parse run summary: {e}"))
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
    use crate::agent::types::{AgentUsage, ToolResult};

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

    fn tool_started(id: &str, tool_call_id: &str, name: &str) -> AgentEvent {
        AgentEvent::ToolCallStarted {
            run_id: id.to_string(),
            tool_call_id: tool_call_id.to_string(),
            name: name.to_string(),
            input: serde_json::json!({}),
            summary: name.to_string(),
            ts: 1,
        }
    }

    fn tool_finished(id: &str, tool_call_id: &str, ok: bool) -> AgentEvent {
        AgentEvent::ToolCallFinished {
            run_id: id.to_string(),
            tool_call_id: tool_call_id.to_string(),
            result: ToolResult {
                ok,
                content: if ok { "ok" } else { "failed" }.to_string(),
                metadata: None,
            },
            ts: 1,
        }
    }

    fn permission_requested(id: &str, request_id: &str, tool_call_id: &str) -> AgentEvent {
        AgentEvent::PermissionRequested {
            run_id: id.to_string(),
            request: serde_json::json!({
                "id": request_id,
                "toolCallId": tool_call_id,
                "input": { "command": "npm test" }
            }),
            ts: 1,
        }
    }

    fn permission_resolved(id: &str, request_id: &str, behavior: &str) -> AgentEvent {
        AgentEvent::PermissionResolved {
            run_id: id.to_string(),
            request_id: request_id.to_string(),
            decision: serde_json::json!({ "behavior": behavior }),
            ts: 1,
        }
    }

    fn diff_resolved(id: &str, behavior: &str) -> AgentEvent {
        AgentEvent::DiffResolved {
            run_id: id.to_string(),
            proposal_id: "proposal-1".to_string(),
            decision: serde_json::json!({ "behavior": behavior }),
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
    fn summarize_validation_marks_read_only_run_skipped() {
        let id = "test-run";
        let summary = summarize_validation(&[assistant_with_text(id, "inspected the code")]);

        assert_eq!(summary.status, "skipped");
        assert_eq!(summary.files_changed, 0);
        assert_eq!(summary.commands_run, 0);
        assert!(summary.warnings.is_empty());
        assert_eq!(summary.checks[0].status, "skipped");
        assert_eq!(summary.checks[1].status, "skipped");
    }

    #[test]
    fn summarize_validation_marks_changed_files_without_command_unverified() {
        let id = "test-run";
        let summary =
            summarize_validation(&[diff_resolved(id, "apply"), file_changed(id, "src/main.rs")]);

        assert_eq!(summary.status, "unverified");
        assert_eq!(summary.files_changed, 1);
        assert_eq!(summary.commands_run, 0);
        assert_eq!(summary.diff_reviews, 1);
        assert!(summary
            .warnings
            .iter()
            .any(|warning| warning.contains("without a recorded validation command")));
    }

    #[test]
    fn summarize_validation_marks_failed_command_failed() {
        let id = "test-run";
        let call_id = "tool-1";
        let summary = summarize_validation(&[
            tool_started(id, call_id, "run_command"),
            tool_finished(id, call_id, false),
        ]);

        assert_eq!(summary.status, "failed");
        assert_eq!(summary.commands_run, 1);
        assert_eq!(summary.commands_failed, 1);
    }

    #[test]
    fn summarize_validation_counts_permission_backed_dynamic_commands() {
        let id = "test-run";
        let call_id = "tool-1";
        let request_id = "permission-1";
        let summary = summarize_validation(&[
            tool_started(id, call_id, "npm_test"),
            permission_requested(id, request_id, call_id),
            permission_resolved(id, request_id, "allow"),
            tool_finished(id, call_id, true),
        ]);

        assert_eq!(summary.status, "passed");
        assert_eq!(summary.commands_run, 1);
        assert_eq!(summary.commands_failed, 0);
        assert_eq!(summary.permissions_approved, 1);
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
        append_event(&dir, id, 0, &file_changed(id, "src/a.rs")).unwrap();
        append_event(&dir, id, 1, &assistant_with_usage(id, 100, 50)).unwrap();
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
            worktree: None,
            validation: None,
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

    #[test]
    fn write_summary_enriches_validation_from_transcript() {
        let dir = std::env::temp_dir().join("klide-transcripts-test-validation");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let id = "validation-1";
        let call_id = "tool-1";
        append_event(&dir, id, 0, &diff_resolved(id, "apply")).unwrap();
        append_event(&dir, id, 1, &file_changed(id, "src/main.rs")).unwrap();
        append_event(&dir, id, 2, &tool_started(id, call_id, "run_command")).unwrap();
        append_event(&dir, id, 3, &tool_finished(id, call_id, true)).unwrap();

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
            worktree: None,
            validation: None,
            parent_id: None,
        };
        write_summary(&dir, &summary).unwrap();
        let on_disk = std::fs::read_to_string(dir.join(format!("{id}.summary.json"))).unwrap();

        assert!(on_disk.contains("\"validation\""), "got: {on_disk}");
        assert!(on_disk.contains("\"status\": \"passed\""), "got: {on_disk}");
        assert!(on_disk.contains("\"filesChanged\": 1"), "got: {on_disk}");
        assert!(on_disk.contains("\"commandsRun\": 1"), "got: {on_disk}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn run_id_accepts_minted_and_frontend_ids() {
        assert!(validate_run_id(&run_id()).is_ok());
        assert!(validate_run_id("subagent_run_123_abc").is_ok());
        assert!(validate_run_id("m3kq0z1x4f2a").is_ok()); // frontend convo id shape
    }

    #[test]
    fn run_id_rejects_traversal_and_separators() {
        assert!(validate_run_id("..").is_err());
        assert!(validate_run_id("../../etc/passwd").is_err());
        assert!(validate_run_id("a/b").is_err());
        assert!(validate_run_id("/abs").is_err());
        assert!(validate_run_id("a\\b").is_err());
        assert!(validate_run_id(".").is_err());
        assert!(validate_run_id("").is_err());
    }
}
