use super::types::{
    AgentContentBlock, AgentEvent, AgentRunSummary, AgentValidationCheckSummary,
    AgentValidationSummary,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptLine {
    schema_version: u8,
    run_id: String,
    seq: u64,
    ts: i64,
    event: AgentEvent,
}

/// The transcript format this build writes and understands. A line claiming a
/// higher version was written by a newer Klide, and guessing at its meaning is
/// how a "replayed" conversation quietly loses a turn.
const TRANSCRIPT_SCHEMA_VERSION: u8 = 1;

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

/// Where this app's run transcripts live. The folder is configurable
/// (Settings → Storage), and `crate::storage::runs_dir` is the one place that
/// resolves it — every caller here goes through this function, so a moved
/// folder cannot half-apply and leave one writer behind.
pub fn app_runs_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    crate::storage::runs_dir(app)
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
    append_event_with(runs_dir, run_id, seq, event, crate::durable::append_line)
}

/// Streamed output only: the turn's final, synced event supersedes it, so a
/// power loss costs at most the live tail, and a stream of chunks does not
/// wait on the disk once per chunk.
pub fn append_stream_event(
    runs_dir: &Path,
    run_id: &str,
    seq: u64,
    event: &AgentEvent,
) -> Result<(), String> {
    append_event_with(runs_dir, run_id, seq, event, crate::durable::append_line_unsynced)
}

fn append_event_with(
    runs_dir: &Path,
    run_id: &str,
    seq: u64,
    event: &AgentEvent,
    append: fn(&Path, &str) -> Result<(), String>,
) -> Result<(), String> {
    let ts = event.ts();
    let line = TranscriptLine {
        schema_version: TRANSCRIPT_SCHEMA_VERSION,
        run_id: run_id.to_string(),
        seq,
        ts,
        event: event.clone(),
    };
    let encoded = serde_json::to_string(&line).map_err(|e| e.to_string())?;
    // One flushed `write_all` on an `O_APPEND` descriptor, through the same
    // helper the Mission event log uses. A bare `writeln!` left the bytes in
    // the page cache, so a crash could publish a torn line — and the Transcript
    // is what replay, the Validation contract, the cost totals and the evidence
    // packet are all derived from.
    append(&transcript_path(runs_dir, run_id), &encoded)
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
            summary.cost_usd = crate::model_capabilities::cost_for_run(
                &summary.provider,
                &summary.model,
                input,
                output,
            );
        }
        // last_event tracks the *latest* assistant turn, so recompute it every
        // write — the transcript grows as the run progresses. Klide's own
        // transcripts are bounded (≤16 turns), so the re-read is cheap.
        summary.last_event = last_assistant_summary(&events);
        summary.validation = Some(summarize_validation(&events));
    }
    let path = summary_path(runs_dir, &summary.id);
    let encoded = serde_json::to_string_pretty(&summary).map_err(|e| e.to_string())?;
    // Atomic: the run board polls these summaries while a run is still writing
    // them, and a truncating write hands a mid-write reader half a document.
    crate::durable::write_atomic(&path, encoded.as_bytes())
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
                tool_call_id,
                name,
                capability,
                ..
            } => {
                tool_names.insert(tool_call_id.clone(), name.clone());
                // Ask what the Tool *was*, not what it was called. A
                // workspace-defined command tool carries its author's name, and
                // if it was already on the project allowlist the permission gate
                // executes it without emitting a request — so both of the older
                // signals missed it, `commands_run` stayed 0, and a run that had
                // validated its own edits reported `unverified`.
                //
                // The `name` fallback keeps transcripts written before
                // `capability` existed counting correctly.
                let is_command = match capability.as_deref() {
                    Some(cap) => cap == crate::agent::tools::ToolCapability::RunCommand.wire(),
                    None => name == "run_command",
                };
                if is_command {
                    command_ids.insert(tool_call_id.clone());
                }
            }
            AgentEvent::PermissionRequested { request, .. } if request.command().is_some() => {
                command_ids.insert(request.tool_call_id.clone());
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
            } if (command_ids.contains(tool_call_id)
                || tool_names
                    .get(tool_call_id)
                    .map(|name| name == "run_command")
                    == Some(true)) =>
            {
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

/// Read a run's Transcript.
///
/// This used to `continue` past any line it could not parse, which made a
/// damaged transcript indistinguishable from a shorter one: a resumed run was
/// handed a history with a turn missing, `summarize_validation` under-counted
/// (so the Validation contract read `unverified`), and the cost totals came out
/// low — all silently.
///
/// Appends now go out through `durable::append_line`: one flushed `write_all`
/// on an `O_APPEND` descriptor, which cannot interleave. That leaves exactly one
/// way to get a bad line — a crash between the write and the flush, which can
/// only ever damage the *last* line. So that one is tolerated (and reported),
/// and anything else is refused rather than guessed at.
pub fn read_events(runs_dir: &Path, run_id: &str) -> Result<Vec<AgentEvent>, String> {
    let path = transcript_path(runs_dir, run_id);
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("Unable to read transcript: {e}"))?;
    let lines: Vec<&str> = content.lines().collect();
    let last_index = lines.len().saturating_sub(1);
    let mut events = Vec::with_capacity(lines.len());

    for (index, raw) in lines.iter().enumerate() {
        if raw.trim().is_empty() {
            continue;
        }
        let row: TranscriptLine = match serde_json::from_str(raw) {
            Ok(row) => row,
            Err(e) if index == last_index => {
                // The documented crash artefact. Drop it, but say so — a silent
                // drop here is the bug this function used to have.
                eprintln!(
                    "klide: transcript {path:?} ends in a torn line ({e}); \
                     dropping the final partial event."
                );
                break;
            }
            Err(e) => {
                return Err(format!(
                    "Transcript {path:?} is corrupt at line {}: {e}. The transcript is \
                     the record of what this run did, so Klide will not guess past it.",
                    index + 1
                ));
            }
        };
        if row.schema_version > TRANSCRIPT_SCHEMA_VERSION {
            return Err(format!(
                "Transcript {path:?} line {} was written by a newer Klide \
                 (schemaVersion {} > {TRANSCRIPT_SCHEMA_VERSION}).",
                index + 1,
                row.schema_version
            ));
        }
        events.push(row.event);
    }
    Ok(events)
}

/// The Provider/model a run was *dispatched* with, as recorded by the first
/// `RunStarted` line of its Transcript.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunOrigin {
    pub run_id: String,
    pub provider: String,
    pub model: String,
}

/// How far into a transcript to look for the origin. `RunStarted` is the first
/// line a run writes, so a bound this generous only exists so a damaged head
/// cannot turn into a full-file scan of a multi-megabyte transcript.
const ORIGIN_SCAN_LINES: usize = 64;

/// The pair a run started on, or `None` when its transcript names no origin.
///
/// This is the authority on what produced a Conversation's turns. The run
/// summary is not: it is a rollup that the *latest* run rewrites, so a thread
/// that began on one model and continued on another reports the continuation
/// there. `RunStarted` is written once per run at dispatch, so the first one is
/// the thread's origin — exactly what `originProvider`/`originModel` mean.
///
/// Reads the head only, and streams: this runs over every stored Conversation
/// at boot, and the answer is on line one.
pub fn read_run_origin(runs_dir: &Path, run_id: &str) -> Result<Option<RunOrigin>, String> {
    use std::io::BufRead;
    let path = transcript_path(runs_dir, run_id);
    let file = match std::fs::File::open(&path) {
        Ok(file) => file,
        // No transcript is not a failure: plenty of Conversations never ran
        // through the Harness at all.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Unable to read transcript: {e}")),
    };
    for raw in std::io::BufReader::new(file)
        .lines()
        .take(ORIGIN_SCAN_LINES)
    {
        let raw = raw.map_err(|e| format!("Unable to read transcript: {e}"))?;
        if raw.trim().is_empty() {
            continue;
        }
        // A line this scan cannot parse is skipped rather than refused. Unlike
        // `read_events`, nothing here is reconstructing what a run did — a
        // label is being checked against evidence, and "no evidence" is an
        // answer this caller handles by leaving the record alone.
        let Ok(row) = serde_json::from_str::<TranscriptLine>(&raw) else {
            continue;
        };
        if let AgentEvent::RunStarted {
            provider, model, ..
        } = row.event
        {
            return Ok(Some(RunOrigin {
                run_id: run_id.to_string(),
                provider,
                model,
            }));
        }
    }
    Ok(None)
}

pub fn list_summaries(
    runs_dir: &Path,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<AgentRunSummary>, String> {
    // Every summary on disk is read before `limit` applies — the board needs
    // the newest N, and "newest" is a field inside each file. The memo makes
    // the steady-state tick a stat per file; only a summary rewritten since
    // the last tick (a live Run's) is read and parsed again (file_memo.rs).
    static SUMMARIES: crate::file_memo::FileMemo<Result<Option<AgentRunSummary>, String>> =
        crate::file_memo::FileMemo::new();
    let mut summaries = Vec::new();
    for entry in std::fs::read_dir(runs_dir).map_err(|e| format!("Unable to read runs dir: {e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        // `write_atomic` leaves a `.name.klide-tmp` sibling in flight; never
        // read one as if it were a finished summary.
        if crate::durable::is_tmp_path(&path) {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name.ends_with(".summary.json") {
            continue;
        }
        let parsed = SUMMARIES.get_or_compute(&path, 0, |p| {
            let text = std::fs::read_to_string(p).map_err(|e| e.to_string())?;
            Ok(serde_json::from_str::<AgentRunSummary>(&text).ok())
        })?;
        if let Some(summary) = parsed {
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
    use crate::agent::types::{AgentUsage, PermissionRequest, ToolResult};

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
            timing: None,
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
            timing: None,
            ts: 1,
        }
    }

    fn tool_started(id: &str, tool_call_id: &str, name: &str) -> AgentEvent {
        tool_started_with_capability(id, tool_call_id, name, None)
    }

    fn tool_started_with_capability(
        id: &str,
        tool_call_id: &str,
        name: &str,
        capability: Option<&str>,
    ) -> AgentEvent {
        AgentEvent::ToolCallStarted {
            run_id: id.to_string(),
            tool_call_id: tool_call_id.to_string(),
            name: name.to_string(),
            input: serde_json::json!({}),
            summary: name.to_string(),
            capability: capability.map(|c| c.to_string()),
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
            request: PermissionRequest::for_command(request_id, tool_call_id, "npm test"),
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
            timing: None,
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
    fn summarize_validation_counts_an_allowlisted_dynamic_command_by_capability() {
        // The gap the capability field closes. A workspace-defined command tool
        // that is already on the project allowlist takes `Precheck::Execute`, so
        // it emits NO PermissionRequested — and its name is not `run_command`.
        // Both older signals missed it: `commands_run` came out 0 and a run that
        // had verified its own edits reported `unverified`.
        let id = "test-run";
        let call_id = "tool-1";
        // A reviewed edit, then the project's own validation command.
        let summary = summarize_validation(&[
            diff_resolved(id, "apply"),
            file_changed(id, "src/a.rs"),
            tool_started_with_capability(id, call_id, "npm_test", Some("run_command")),
            tool_finished(id, call_id, true),
        ]);
        assert_eq!(summary.commands_run, 1, "capability says it ran a command");
        assert_eq!(summary.status, "passed");

        // The same run as it would have been recorded before `capability`
        // existed — and exactly what an allowlisted dynamic command tool used
        // to produce: verified work, reported as unverified.
        let legacy = summarize_validation(&[
            diff_resolved(id, "apply"),
            file_changed(id, "src/a.rs"),
            tool_started(id, call_id, "npm_test"),
            tool_finished(id, call_id, true),
        ]);
        assert_eq!(legacy.commands_run, 0);
        assert_eq!(legacy.status, "unverified");
    }

    #[test]
    fn summarize_validation_does_not_count_a_read_as_a_command() {
        let id = "test-run";
        let summary = summarize_validation(&[
            tool_started_with_capability(id, "t1", "read_file", Some("read_workspace")),
            tool_finished(id, "t1", true),
        ]);
        assert_eq!(summary.commands_run, 0);
        assert_eq!(summary.status, "skipped");
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

    // ── The durable-read contract ───────────────────────────────────────────
    // A transcript is what replay, the Validation contract, the cost totals and
    // the evidence packet are derived from. These pin the difference between
    // "the crash artefact we tolerate" and "damage we refuse to guess past".

    fn read_dir_for(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "klide-transcripts-read-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn run_started(id: &str, provider: &str, model: &str) -> AgentEvent {
        AgentEvent::RunStarted {
            run_id: id.to_string(),
            cwd: None,
            mode: crate::agent::types::AgentMode::Chat,
            provider: provider.to_string(),
            model: model.to_string(),
            ts: 1,
        }
    }

    #[test]
    fn run_origin_is_the_first_dispatch_not_the_latest() {
        let dir = read_dir_for("origin-first");
        let id = "origin1";
        append_event(&dir, id, 0, &run_started(id, "openrouter", "deepseek/deepseek-v4-flash"))
            .unwrap();
        append_event(&dir, id, 1, &assistant_with_text(id, "hi")).unwrap();
        // A continuation on another model: the thread's origin is unchanged.
        append_event(&dir, id, 2, &run_started(id, "openrouter", "sakana/fugu-ultra")).unwrap();
        let origin = read_run_origin(&dir, id).unwrap().unwrap();
        assert_eq!(origin.provider, "openrouter");
        assert_eq!(origin.model, "deepseek/deepseek-v4-flash");
    }

    #[test]
    fn run_origin_is_absent_for_a_transcript_that_never_started() {
        let dir = read_dir_for("origin-none");
        let id = "origin2";
        append_event(&dir, id, 0, &assistant_with_text(id, "no start line")).unwrap();
        assert!(read_run_origin(&dir, id).unwrap().is_none());
    }

    #[test]
    fn run_origin_of_a_conversation_that_never_ran_is_absent_not_an_error() {
        let dir = read_dir_for("origin-missing");
        assert!(read_run_origin(&dir, "never-ran").unwrap().is_none());
    }

    #[test]
    fn read_events_round_trips_what_append_event_wrote() {
        let dir = read_dir_for("roundtrip");
        let id = "r1";
        append_event(&dir, id, 0, &file_changed(id, "src/a.rs")).unwrap();
        append_event(&dir, id, 1, &assistant_with_text(id, "hello")).unwrap();

        let events = read_events(&dir, id).unwrap();
        assert_eq!(events.len(), 2);
        // One line per append, newline-terminated — no interleaving.
        let raw = std::fs::read_to_string(transcript_path(&dir, id)).unwrap();
        assert_eq!(raw.lines().count(), 2);
        assert!(raw.ends_with('\n'));
    }

    #[test]
    fn read_events_tolerates_a_torn_final_line() {
        // The only damage an O_APPEND + sync_data writer can leave: a crash
        // between the write and the flush, which truncates the last record.
        let dir = read_dir_for("torn-tail");
        let id = "r2";
        append_event(&dir, id, 0, &file_changed(id, "src/a.rs")).unwrap();
        append_event(&dir, id, 1, &assistant_with_text(id, "kept")).unwrap();

        let path = transcript_path(&dir, id);
        let mut raw = std::fs::read_to_string(&path).unwrap();
        raw.push_str("{\"schemaVersion\":1,\"runId\":\"r2\",\"se");
        std::fs::write(&path, raw).unwrap();

        let events = read_events(&dir, id).unwrap();
        assert_eq!(events.len(), 2, "the two whole records must survive");
    }

    #[test]
    fn read_events_refuses_a_corrupt_interior_line_instead_of_dropping_it() {
        // The regression this replaces: a dropped interior line handed a
        // resumed run a history with a turn missing, and nothing said so.
        let dir = read_dir_for("interior");
        let id = "r3";
        append_event(&dir, id, 0, &file_changed(id, "src/a.rs")).unwrap();
        append_event(&dir, id, 1, &assistant_with_text(id, "middle")).unwrap();
        append_event(&dir, id, 2, &assistant_with_text(id, "last")).unwrap();

        let path = transcript_path(&dir, id);
        let lines: Vec<String> = std::fs::read_to_string(&path)
            .unwrap()
            .lines()
            .map(|l| l.to_string())
            .collect();
        let damaged = format!("{}\n{{\"not\":\"a line\"}}\n{}\n", lines[0], lines[2]);
        std::fs::write(&path, damaged).unwrap();

        let err = read_events(&dir, id).unwrap_err();
        assert!(err.contains("corrupt at line 2"), "got: {err}");
        assert!(err.contains("will not guess past it"), "got: {err}");
    }

    #[test]
    fn read_events_refuses_a_transcript_from_a_newer_klide() {
        let dir = read_dir_for("future");
        let id = "r4";
        append_event(&dir, id, 0, &file_changed(id, "src/a.rs")).unwrap();
        let path = transcript_path(&dir, id);
        let raw = std::fs::read_to_string(&path)
            .unwrap()
            .replace("\"schemaVersion\":1", "\"schemaVersion\":9");
        std::fs::write(&path, raw).unwrap();

        let err = read_events(&dir, id).unwrap_err();
        assert!(err.contains("newer Klide"), "got: {err}");
    }

    #[test]
    fn read_events_skips_blank_padding() {
        let dir = read_dir_for("blank");
        let id = "r5";
        append_event(&dir, id, 0, &file_changed(id, "src/a.rs")).unwrap();
        let path = transcript_path(&dir, id);
        let raw = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, format!("\n{raw}\n\n")).unwrap();
        assert_eq!(read_events(&dir, id).unwrap().len(), 1);
    }

    #[test]
    fn list_summaries_ignores_an_in_flight_atomic_write() {
        // `write_atomic` leaves a `.name.klide-tmp` sibling mid-write; the run
        // board must not parse one as a finished summary.
        let dir = read_dir_for("tmp-skip");
        let id = "r6";
        append_event(&dir, id, 0, &file_changed(id, "src/a.rs")).unwrap();
        write_summary(&dir, &summary_for(id)).unwrap();

        let real = summary_path(&dir, id);
        std::fs::write(crate::durable::tmp_path(&real), b"{ truncated").unwrap();

        let rows = list_summaries(&dir, None, None).unwrap();
        assert_eq!(rows.len(), 1, "the temp sibling must be skipped");
        assert_eq!(rows[0].id, id);
    }

    fn summary_for(id: &str) -> AgentRunSummary {
        AgentRunSummary {
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
        }
    }
}
