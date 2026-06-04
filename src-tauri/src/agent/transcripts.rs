use super::types::{AgentEvent, AgentRunSummary};
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
        | AgentEvent::RunError { ts, .. } => *ts,
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
    let path = summary_path(runs_dir, &summary.id);
    let encoded = serde_json::to_string_pretty(summary).map_err(|e| e.to_string())?;
    std::fs::write(path, encoded).map_err(|e| format!("Unable to write run summary: {e}"))
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
