//! Durable Missions.
//!
//! A Mission is workspace state, not React state. Rust owns the files under
//! `.klide/missions/<mission-id>/`, appends the runtime event log, and judges a
//! Harness attempt from the Harness' persisted validation summary. TypeScript
//! receives the authored specs plus events and folds them into the UI view.
//!
//! The authored/runtime split is deliberate:
//! - `mission.md` and `tasks/*.md` are human/agent editable specifications.
//! - `events.jsonl` is append-only execution history.
//! - Harness transcripts remain the evidence source and are referenced by run
//!   id; Missions never duplicate them.

use crate::agent::transcripts::{app_runs_dir, now_ms, read_summary, run_id, validate_run_id};
use crate::agent::types::{
    AgentContextSnapshot, AgentMode, AgentValidationCheckSummary, AgentValidationSummary,
    StartRunRequest,
};
use crate::pty_host::{PtyExitOutcome, ScrollbackMeta};
use crate::workspace::Workspace;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

const MISSION_SCHEMA_VERSION: u8 = 1;

/// Mission file/event writes are small. One process-wide gate gives append
/// ordering a single writer without making React or a background task own the
/// durable loop. Different app launches reconstruct solely from disk.
#[derive(Default)]
pub struct MissionStoreState {
    write_gate: Mutex<()>,
    /// Per-Mission single-flight loop. `false` means running; `true` means a
    /// validation/approval signal arrived while running and one more decision
    /// pass is owed before releasing the claim.
    driving: Mutex<HashMap<String, bool>>,
    /// Workspace activation can fire more than once in one desktop session.
    /// Restart reconciliation is a launch-time repair pass, not a poll.
    reconciled_workspaces: Mutex<HashSet<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MissionMode {
    Plan,
    Goal,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MissionTaskRisk {
    Low,
    Medium,
    High,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub enum MissionTaskPhase {
    Understand,
    Build,
    Verify,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MissionWorkerKind {
    Harness,
    Delegate,
}

/// The execution choice frozen when the user approves a plan. Routing may be
/// compiled in TypeScript, but the durable supervisor never consults React or
/// localStorage after approval.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MissionTaskDispatch {
    pub worker_kind: MissionWorkerKind,
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub require_diff_review: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionSpec {
    pub schema_version: u8,
    pub id: String,
    pub title: String,
    pub intent: String,
    pub mode: MissionMode,
    pub task_ids: Vec<String>,
    pub created_ms: i64,
    pub updated_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionTaskSpec {
    pub schema_version: u8,
    pub id: String,
    pub mission_id: String,
    pub title: String,
    #[serde(default)]
    pub body_markdown: String,
    pub phase: MissionTaskPhase,
    pub mode: MissionMode,
    pub risk: MissionTaskRisk,
    #[serde(default)]
    pub writes_files: bool,
    #[serde(default)]
    pub dependencies: Vec<String>,
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
    #[serde(default)]
    pub needs_repo_wide_context: bool,
    #[serde(default)]
    pub needs_strong_reasoning: bool,
    #[serde(default)]
    pub needs_delegate_cli: bool,
    #[serde(default)]
    pub needs_visual_review: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dispatch: Option<MissionTaskDispatch>,
    pub created_ms: i64,
    pub updated_ms: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMissionInput {
    #[serde(default)]
    pub id: Option<String>,
    pub title: String,
    pub intent: String,
    pub mode: MissionMode,
    #[serde(default)]
    pub tasks: Vec<CreateMissionTaskInput>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMissionTaskInput {
    #[serde(default)]
    pub id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub body_markdown: String,
    pub phase: MissionTaskPhase,
    pub mode: MissionMode,
    pub risk: MissionTaskRisk,
    #[serde(default)]
    pub writes_files: bool,
    #[serde(default)]
    pub dependencies: Vec<String>,
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
    #[serde(default)]
    pub needs_repo_wide_context: bool,
    #[serde(default)]
    pub needs_strong_reasoning: bool,
    #[serde(default)]
    pub needs_delegate_cli: bool,
    #[serde(default)]
    pub needs_visual_review: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveMissionTaskInput {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub body_markdown: String,
    pub phase: MissionTaskPhase,
    pub mode: MissionMode,
    pub risk: MissionTaskRisk,
    #[serde(default)]
    pub writes_files: bool,
    #[serde(default)]
    pub dependencies: Vec<String>,
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
    #[serde(default)]
    pub needs_repo_wide_context: bool,
    #[serde(default)]
    pub needs_strong_reasoning: bool,
    #[serde(default)]
    pub needs_delegate_cli: bool,
    #[serde(default)]
    pub needs_visual_review: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionApprovalInput {
    #[serde(default)]
    pub tasks: Vec<MissionTaskApprovalInput>,
    #[serde(default)]
    pub auto_start: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionTaskApprovalInput {
    pub task_id: String,
    pub worker_kind: MissionWorkerKind,
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub require_diff_review: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewMissionAttemptInput {
    pub task_id: String,
    pub run_id: String,
    pub accepted: bool,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum MissionEvent {
    MissionCreated,
    TaskCreated {
        task_id: String,
    },
    TaskUpdated {
        task_id: String,
    },
    PlanApproved,
    AttemptAttached {
        task_id: String,
        run_id: String,
    },
    AttemptDispatchFailed {
        task_id: String,
        run_id: String,
        message: String,
    },
    AttemptInterrupted {
        task_id: String,
        run_id: String,
        reason: String,
    },
    AttemptSettled {
        task_id: String,
        run_id: String,
        exit_code: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signal: Option<String>,
    },
    AttemptValidationRecorded {
        task_id: String,
        run_id: String,
        accepted: bool,
        validation: AgentValidationSummary,
    },
    MissionCompleted,
    MissionParked {
        reason: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionEventLine {
    pub schema_version: u8,
    pub mission_id: String,
    pub seq: u64,
    pub ts: i64,
    pub event: MissionEvent,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DurableMissionBundle {
    pub mission: MissionSpec,
    pub tasks: Vec<MissionTaskSpec>,
    pub events: Vec<MissionEventLine>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedMissionAttempt {
    pub run_id: String,
    pub bundle: DurableMissionBundle,
}

#[derive(Clone, Default)]
struct FoldedTaskRuntime {
    attempts: Vec<String>,
    active: HashSet<String>,
    reviewing: HashSet<String>,
    accepted_run_id: Option<String>,
}

#[derive(Default)]
struct FoldedMissionRuntime {
    approved: bool,
    tasks: HashMap<String, FoldedTaskRuntime>,
}

fn validate_id(id: &str, label: &str) -> Result<(), String> {
    if id.trim().is_empty() || id.contains('\\') {
        return Err(format!("Invalid {label} id."));
    }
    let mut components = Path::new(id).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) => Ok(()),
        _ => Err(format!("Invalid {label} id.")),
    }
}

fn clean_title(title: &str, label: &str) -> Result<String, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err(format!("{label} title cannot be empty."));
    }
    Ok(title.chars().take(160).collect())
}

fn slugify(input: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for ch in input.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out.truncate(48);
    if out.is_empty() {
        out.push_str("mission");
    }
    out
}

fn generated_mission_id(title: &str) -> String {
    format!("{}-{}", slugify(title), now_ms())
}

fn generated_task_id(index: usize, title: &str) -> String {
    format!("t{}-{}", index + 1, slugify(title))
}

fn missions_root(workspace_root: &str) -> Result<PathBuf, String> {
    let workspace = Workspace::new(workspace_root)?;
    let root = workspace.resolve_new(".klide/missions")?;
    std::fs::create_dir_all(&root)
        .map_err(|e| format!("Unable to create .klide/missions directory: {e}"))?;
    Ok(root)
}

fn mission_dir(workspace_root: &str, mission_id: &str, existing: bool) -> Result<PathBuf, String> {
    validate_id(mission_id, "mission")?;
    let workspace = Workspace::new(workspace_root)?;
    let rel = format!(".klide/missions/{mission_id}");
    if existing {
        workspace.resolve_existing(&rel)
    } else {
        workspace.resolve_new(&rel)
    }
}

fn task_path(dir: &Path, task_id: &str) -> Result<PathBuf, String> {
    validate_id(task_id, "task")?;
    Ok(dir.join("tasks").join(format!("{task_id}.md")))
}

fn json<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| format!("Unable to encode mission Markdown: {e}"))
}

fn render_mission_markdown(spec: &MissionSpec) -> Result<String, String> {
    Ok(format!(
        "---\nschemaVersion: {}\nid: {}\ntitle: {}\nmode: {}\ntaskIds: {}\ncreatedMs: {}\nupdatedMs: {}\n---\n\n# Intent\n\n{}\n",
        spec.schema_version,
        json(&spec.id)?,
        json(&spec.title)?,
        json(&spec.mode)?,
        json(&spec.task_ids)?,
        spec.created_ms,
        spec.updated_ms,
        spec.intent.trim()
    ))
}

fn render_task_markdown(spec: &MissionTaskSpec) -> Result<String, String> {
    Ok(format!(
        "---\nschemaVersion: {}\nid: {}\nmissionId: {}\ntitle: {}\nphase: {}\nmode: {}\nrisk: {}\nwritesFiles: {}\ndependencies: {}\nacceptanceCriteria: {}\nneedsRepoWideContext: {}\nneedsStrongReasoning: {}\nneedsDelegateCli: {}\nneedsVisualReview: {}\ndispatch: {}\ncreatedMs: {}\nupdatedMs: {}\n---\n\n{}\n",
        spec.schema_version,
        json(&spec.id)?,
        json(&spec.mission_id)?,
        json(&spec.title)?,
        json(&spec.phase)?,
        json(&spec.mode)?,
        json(&spec.risk)?,
        spec.writes_files,
        json(&spec.dependencies)?,
        json(&spec.acceptance_criteria)?,
        spec.needs_repo_wide_context,
        spec.needs_strong_reasoning,
        spec.needs_delegate_cli,
        spec.needs_visual_review,
        json(&spec.dispatch)?,
        spec.created_ms,
        spec.updated_ms,
        spec.body_markdown.trim()
    ))
}

fn split_frontmatter(text: &str) -> Result<(HashMap<String, String>, String), String> {
    let normalized = text.replace("\r\n", "\n");
    let mut lines = normalized.lines();
    if lines.next() != Some("---") {
        return Err("Mission Markdown is missing frontmatter.".to_string());
    }
    let mut fields = HashMap::new();
    let mut found_end = false;
    let mut body = Vec::new();
    for line in lines {
        if !found_end {
            if line == "---" {
                found_end = true;
                continue;
            }
            if let Some((key, value)) = line.split_once(':') {
                fields.insert(key.trim().to_string(), value.trim().to_string());
            }
        } else {
            body.push(line);
        }
    }
    if !found_end {
        return Err("Mission Markdown has unterminated frontmatter.".to_string());
    }
    Ok((fields, body.join("\n").trim().to_string()))
}

fn required_json<T: for<'de> Deserialize<'de>>(
    fields: &HashMap<String, String>,
    key: &str,
) -> Result<T, String> {
    let raw = fields
        .get(key)
        .ok_or_else(|| format!("Mission Markdown is missing `{key}`."))?;
    serde_json::from_str(raw).map_err(|e| format!("Invalid `{key}` in Mission Markdown: {e}"))
}

fn required_i64(fields: &HashMap<String, String>, key: &str) -> Result<i64, String> {
    fields
        .get(key)
        .ok_or_else(|| format!("Mission Markdown is missing `{key}`."))?
        .parse::<i64>()
        .map_err(|e| format!("Invalid `{key}` in Mission Markdown: {e}"))
}

fn required_u8(fields: &HashMap<String, String>, key: &str) -> Result<u8, String> {
    fields
        .get(key)
        .ok_or_else(|| format!("Mission Markdown is missing `{key}`."))?
        .parse::<u8>()
        .map_err(|e| format!("Invalid `{key}` in Mission Markdown: {e}"))
}

fn required_bool(fields: &HashMap<String, String>, key: &str) -> Result<bool, String> {
    fields
        .get(key)
        .ok_or_else(|| format!("Mission Markdown is missing `{key}`."))?
        .parse::<bool>()
        .map_err(|e| format!("Invalid `{key}` in Mission Markdown: {e}"))
}

fn optional_json<T: for<'de> Deserialize<'de>>(
    fields: &HashMap<String, String>,
    key: &str,
) -> Result<Option<T>, String> {
    let Some(raw) = fields.get(key) else {
        return Ok(None);
    };
    serde_json::from_str(raw).map_err(|e| format!("Invalid `{key}` in Mission Markdown: {e}"))
}

fn parse_mission_markdown(text: &str) -> Result<MissionSpec, String> {
    let (fields, body) = split_frontmatter(text)?;
    let intent = body
        .strip_prefix("# Intent")
        .unwrap_or(&body)
        .trim()
        .to_string();
    let spec = MissionSpec {
        schema_version: required_u8(&fields, "schemaVersion")?,
        id: required_json(&fields, "id")?,
        title: required_json(&fields, "title")?,
        intent,
        mode: required_json(&fields, "mode")?,
        task_ids: required_json(&fields, "taskIds")?,
        created_ms: required_i64(&fields, "createdMs")?,
        updated_ms: required_i64(&fields, "updatedMs")?,
    };
    if spec.schema_version != MISSION_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported Mission schema version {}.",
            spec.schema_version
        ));
    }
    validate_id(&spec.id, "mission")?;
    Ok(spec)
}

fn parse_task_markdown(text: &str) -> Result<MissionTaskSpec, String> {
    let (fields, body_markdown) = split_frontmatter(text)?;
    let spec = MissionTaskSpec {
        schema_version: required_u8(&fields, "schemaVersion")?,
        id: required_json(&fields, "id")?,
        mission_id: required_json(&fields, "missionId")?,
        title: required_json(&fields, "title")?,
        body_markdown,
        phase: required_json(&fields, "phase")?,
        mode: required_json(&fields, "mode")?,
        risk: required_json(&fields, "risk")?,
        writes_files: required_bool(&fields, "writesFiles")?,
        dependencies: required_json(&fields, "dependencies")?,
        acceptance_criteria: required_json(&fields, "acceptanceCriteria")?,
        needs_repo_wide_context: required_bool(&fields, "needsRepoWideContext")?,
        needs_strong_reasoning: required_bool(&fields, "needsStrongReasoning")?,
        needs_delegate_cli: required_bool(&fields, "needsDelegateCli")?,
        needs_visual_review: required_bool(&fields, "needsVisualReview")?,
        dispatch: optional_json(&fields, "dispatch")?,
        created_ms: required_i64(&fields, "createdMs")?,
        updated_ms: required_i64(&fields, "updatedMs")?,
    };
    if spec.schema_version != MISSION_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported Mission task schema version {}.",
            spec.schema_version
        ));
    }
    validate_id(&spec.id, "task")?;
    validate_id(&spec.mission_id, "mission")?;
    Ok(spec)
}

fn events_path(dir: &Path) -> PathBuf {
    dir.join("events.jsonl")
}

fn read_events(dir: &Path) -> Result<Vec<MissionEventLine>, String> {
    let path = events_path(dir);
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("Unable to read Mission events: {e}"))?;
    Ok(text
        .lines()
        .filter_map(|line| serde_json::from_str::<MissionEventLine>(line).ok())
        .collect())
}

fn append_event(dir: &Path, mission_id: &str, event: MissionEvent) -> Result<(), String> {
    let prior = read_events(dir).unwrap_or_default();
    let line = MissionEventLine {
        schema_version: MISSION_SCHEMA_VERSION,
        mission_id: mission_id.to_string(),
        seq: prior.last().map(|line| line.seq + 1).unwrap_or(0),
        ts: now_ms(),
        event,
    };
    let encoded =
        serde_json::to_string(&line).map_err(|e| format!("Unable to encode Mission event: {e}"))?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(events_path(dir))
        .map_err(|e| format!("Unable to open Mission events: {e}"))?;
    writeln!(file, "{encoded}").map_err(|e| format!("Unable to append Mission event: {e}"))
}

fn load_bundle_from_dir(dir: &Path) -> Result<DurableMissionBundle, String> {
    let mission_text = std::fs::read_to_string(dir.join("mission.md"))
        .map_err(|e| format!("Unable to read mission.md: {e}"))?;
    let mission = parse_mission_markdown(&mission_text)?;
    let mut tasks = Vec::with_capacity(mission.task_ids.len());
    for task_id in &mission.task_ids {
        let path = task_path(dir, task_id)?;
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("Unable to read task `{task_id}`: {e}"))?;
        let task = parse_task_markdown(&text)?;
        if task.mission_id != mission.id {
            return Err(format!("Task `{task_id}` belongs to a different Mission."));
        }
        tasks.push(task);
    }
    Ok(DurableMissionBundle {
        mission,
        tasks,
        events: read_events(dir)?,
    })
}

fn load_bundle(workspace_root: &str, mission_id: &str) -> Result<DurableMissionBundle, String> {
    let dir = mission_dir(workspace_root, mission_id, true)?;
    load_bundle_from_dir(&dir)
}

fn fold_runtime(bundle: &DurableMissionBundle) -> FoldedMissionRuntime {
    let mut runtime = FoldedMissionRuntime::default();
    for task in &bundle.tasks {
        runtime.tasks.entry(task.id.clone()).or_default();
    }
    for line in &bundle.events {
        match &line.event {
            MissionEvent::PlanApproved => runtime.approved = true,
            MissionEvent::AttemptAttached { task_id, run_id } => {
                let task = runtime.tasks.entry(task_id.clone()).or_default();
                if !task.attempts.iter().any(|id| id == run_id) {
                    task.attempts.push(run_id.clone());
                }
                task.active.insert(run_id.clone());
            }
            MissionEvent::AttemptDispatchFailed {
                task_id, run_id, ..
            }
            | MissionEvent::AttemptInterrupted {
                task_id, run_id, ..
            } => {
                runtime
                    .tasks
                    .entry(task_id.clone())
                    .or_default()
                    .active
                    .remove(run_id);
            }
            MissionEvent::AttemptSettled {
                task_id, run_id, ..
            } => {
                let task = runtime.tasks.entry(task_id.clone()).or_default();
                task.active.remove(run_id);
                task.reviewing.insert(run_id.clone());
            }
            MissionEvent::AttemptValidationRecorded {
                task_id,
                run_id,
                accepted,
                ..
            } => {
                let task = runtime.tasks.entry(task_id.clone()).or_default();
                task.active.remove(run_id);
                task.reviewing.remove(run_id);
                if *accepted {
                    task.accepted_run_id = Some(run_id.clone());
                }
            }
            _ => {}
        }
    }
    runtime
}

fn task_is_ready(
    bundle: &DurableMissionBundle,
    runtime: &FoldedMissionRuntime,
    task_id: &str,
) -> Result<bool, String> {
    if !runtime.approved {
        return Ok(false);
    }
    let task = bundle
        .tasks
        .iter()
        .find(|task| task.id == task_id)
        .ok_or_else(|| format!("Unknown Mission task `{task_id}`."))?;
    let task_runtime = runtime.tasks.get(task_id).cloned().unwrap_or_default();
    if task_runtime.accepted_run_id.is_some()
        || !task_runtime.active.is_empty()
        || !task_runtime.reviewing.is_empty()
    {
        return Ok(false);
    }
    for dependency in &task.dependencies {
        let Some(dep_runtime) = runtime.tasks.get(dependency) else {
            return Err(format!(
                "Task `{task_id}` depends on missing task `{dependency}`."
            ));
        };
        if dep_runtime.accepted_run_id.is_none() {
            return Ok(false);
        }
    }
    Ok(true)
}

#[derive(Debug, PartialEq, Eq)]
enum SupervisorDecision {
    Wait,
    Dispatch(String),
    Complete,
    Park(String),
}

/// One Mission owns one active Harness attempt at a time in this slice. The
/// decision is pure so the accept-not-exit edge and no-automatic-retry rule are
/// independently testable from Tauri/provider plumbing.
fn supervisor_decision(
    bundle: &DurableMissionBundle,
    runtime: &FoldedMissionRuntime,
) -> Result<SupervisorDecision, String> {
    if !runtime.approved {
        return Ok(SupervisorDecision::Wait);
    }
    if runtime
        .tasks
        .values()
        .any(|task| !task.active.is_empty() || !task.reviewing.is_empty())
    {
        return Ok(SupervisorDecision::Wait);
    }
    for task in &bundle.tasks {
        let task_runtime = runtime.tasks.get(&task.id).cloned().unwrap_or_default();
        if task_runtime.attempts.is_empty() && task_is_ready(bundle, runtime, &task.id)? {
            return Ok(SupervisorDecision::Dispatch(task.id.clone()));
        }
    }
    if bundle.tasks.iter().all(|task| {
        runtime
            .tasks
            .get(&task.id)
            .and_then(|runtime| runtime.accepted_run_id.as_ref())
            .is_some()
    }) {
        return Ok(SupervisorDecision::Complete);
    }
    Ok(SupervisorDecision::Park(
        "No unattempted task is ready. Retry a rejected task or revise the plan.".to_string(),
    ))
}

/// A failed `dispatch_task` only parks the mission when the failure was
/// actually recorded as an `AttemptDispatchFailed` for this task. A transient
/// "not ready" — the dispatch race where another actor (a manual dispatch, or a
/// second supervisor loop) attached this task first — records nothing, so the
/// mission is running normally and must not be parked. Pure so the accept vs
/// spurious-park edge is testable without the Tauri/harness plumbing.
fn dispatch_failure_should_park(bundle: &DurableMissionBundle, task_id: &str) -> bool {
    matches!(
        bundle.events.last().map(|line| &line.event),
        Some(MissionEvent::AttemptDispatchFailed { task_id: failed_task, .. })
            if failed_task == task_id
    )
}

fn agent_mode(mode: &MissionMode) -> AgentMode {
    match mode {
        MissionMode::Plan => AgentMode::Plan,
        MissionMode::Goal => AgentMode::Goal,
    }
}

fn task_prompt(bundle: &DurableMissionBundle, task: &MissionTaskSpec) -> String {
    let criteria = if task.acceptance_criteria.is_empty() {
        "- Satisfy the task description.".to_string()
    } else {
        task.acceptance_criteria
            .iter()
            .map(|criterion| format!("- {criterion}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!(
        "Mission: {}\n\nUser story: {}\n\nTask: {}\n\n{}\n\nAcceptance criteria:\n{}",
        bundle.mission.title,
        bundle.mission.intent,
        task.title,
        task.body_markdown.trim(),
        criteria
    )
}

fn start_request_for(
    workspace_root: &str,
    bundle: &DurableMissionBundle,
    task: &MissionTaskSpec,
    attempt_run_id: &str,
) -> Result<StartRunRequest, String> {
    let dispatch = task.dispatch.as_ref().ok_or_else(|| {
        format!(
            "Task `{}` has no approved execution snapshot. Approve its provider and model first.",
            task.id
        )
    })?;
    if dispatch.provider.trim().is_empty() || dispatch.model.trim().is_empty() {
        return Err(format!(
            "Task `{}` has an incomplete provider/model execution snapshot.",
            task.id
        ));
    }
    let prompt = task_prompt(bundle, task);
    Ok(StartRunRequest {
        run_id: Some(attempt_run_id.to_string()),
        workspace_root: Some(workspace_root.to_string()),
        mode: agent_mode(&task.mode),
        provider: dispatch.provider.clone(),
        model: dispatch.model.clone(),
        initial_text: prompt,
        attachments: vec![],
        context: Some(AgentContextSnapshot {
            workspace_root: Some(workspace_root.to_string()),
            attachments: vec![],
            lens_items: vec![],
            estimated_tokens: 0,
            omitted: vec![],
        }),
        system_prompt: None,
        // A headless run cannot service interactive questions, nested agents,
        // or advisor callbacks. Permission and optional diff-review pauses stay
        // enabled because they have durable supervisor state and may be
        // resolved after a surface reattaches.
        disabled_tools: vec![
            "userAnswerQuestion".to_string(),
            "spawn_subagent".to_string(),
            "consult_advisor".to_string(),
        ],
        num_ctx: None,
        num_predict: None,
        reflection_level: None,
        max_parallel_tools: None,
        max_turns: None,
        command_timeout_secs: None,
        test_after_edit_command: None,
        command_allowlist: vec![],
        require_diff_review: Some(dispatch.require_diff_review),
        parent_id: None,
        mission_id: Some(bundle.mission.id.clone()),
        mission_task_id: Some(task.id.clone()),
    })
}

enum MissionLaunch {
    Harness(StartRunRequest),
    Delegate {
        provider: String,
        model: String,
        prompt: String,
    },
}

fn launch_for(
    workspace_root: &str,
    bundle: &DurableMissionBundle,
    task: &MissionTaskSpec,
    attempt_run_id: &str,
) -> Result<MissionLaunch, String> {
    let dispatch = task.dispatch.as_ref().ok_or_else(|| {
        format!(
            "Task `{}` has no approved execution snapshot. Approve its provider and model first.",
            task.id
        )
    })?;
    match dispatch.worker_kind {
        MissionWorkerKind::Harness => {
            start_request_for(workspace_root, bundle, task, attempt_run_id)
                .map(MissionLaunch::Harness)
        }
        MissionWorkerKind::Delegate => {
            if dispatch.provider.trim().is_empty() || dispatch.model.trim().is_empty() {
                return Err(format!(
                    "Task `{}` has an incomplete Delegate provider/model snapshot.",
                    task.id
                ));
            }
            if crate::delegate::lookup(&dispatch.provider).is_none() {
                return Err(format!(
                    "Delegate `{}` does not support durable Mission dispatch.",
                    dispatch.provider
                ));
            }
            Ok(MissionLaunch::Delegate {
                provider: dispatch.provider.clone(),
                model: dispatch.model.clone(),
                prompt: task_prompt(bundle, task),
            })
        }
    }
}

fn validation_accepts(summary_status: &str, validation: &AgentValidationSummary) -> bool {
    summary_status == "done"
        && matches!(validation.status.as_str(), "passed" | "skipped")
        && !validation
            .checks
            .iter()
            .any(|check| check.required && check.status == "failed")
}

/// The first dependency cycle in an id→dependencies graph, as the ids on the
/// cycle in traversal order (with the closing id repeated), or `None` when the
/// graph is acyclic. Missing dependency ids are skipped — callers reject those
/// separately with a clearer message. Kept pure so the acyclic invariant is
/// unit-testable away from Tauri; the frontend mirrors it in `missionGraph.ts`
/// for pre-write feedback, but this Rust check is the durable authority — a
/// cyclic plan can never reach disk, so `task_is_ready` always terminates.
fn first_dependency_cycle(deps_by_id: &HashMap<String, Vec<String>>) -> Option<Vec<String>> {
    #[derive(Clone, Copy, PartialEq)]
    enum Mark {
        Visiting,
        Done,
    }
    fn walk<'a>(
        node: &'a str,
        deps_by_id: &'a HashMap<String, Vec<String>>,
        mark: &mut HashMap<&'a str, Mark>,
        stack: &mut Vec<&'a str>,
    ) -> Option<Vec<String>> {
        mark.insert(node, Mark::Visiting);
        stack.push(node);
        if let Some(deps) = deps_by_id.get(node) {
            for dep in deps {
                let dep = dep.as_str();
                if !deps_by_id.contains_key(dep) {
                    continue; // missing dependency — reported by the caller
                }
                match mark.get(dep) {
                    Some(Mark::Done) => {}
                    Some(Mark::Visiting) => {
                        let start = stack.iter().position(|n| *n == dep).unwrap_or(0);
                        let mut cycle: Vec<String> =
                            stack[start..].iter().map(|n| n.to_string()).collect();
                        cycle.push(dep.to_string());
                        return Some(cycle);
                    }
                    None => {
                        if let Some(found) = walk(dep, deps_by_id, mark, stack) {
                            return Some(found);
                        }
                    }
                }
            }
        }
        stack.pop();
        mark.insert(node, Mark::Done);
        None
    }
    let mut mark: HashMap<&str, Mark> = HashMap::new();
    for id in deps_by_id.keys() {
        if !mark.contains_key(id.as_str()) {
            let mut stack: Vec<&str> = Vec::new();
            if let Some(cycle) = walk(id.as_str(), deps_by_id, &mut mark, &mut stack) {
                return Some(cycle);
            }
        }
    }
    None
}

fn do_create(
    workspace_root: &str,
    input: CreateMissionInput,
) -> Result<DurableMissionBundle, String> {
    let title = clean_title(&input.title, "Mission")?;
    let mission_id = input.id.unwrap_or_else(|| generated_mission_id(&title));
    validate_id(&mission_id, "mission")?;
    let root = missions_root(workspace_root)?;
    let dir = root.join(&mission_id);
    if dir.exists() {
        return Err(format!("Mission `{mission_id}` already exists."));
    }

    let now = now_ms();
    let mut seen = HashSet::new();
    let mut tasks = Vec::with_capacity(input.tasks.len());
    for (index, task) in input.tasks.into_iter().enumerate() {
        let task_title = clean_title(&task.title, "Task")?;
        let id = task
            .id
            .unwrap_or_else(|| generated_task_id(index, &task_title));
        validate_id(&id, "task")?;
        if !seen.insert(id.clone()) {
            return Err(format!("Duplicate Mission task id `{id}`."));
        }
        tasks.push(MissionTaskSpec {
            schema_version: MISSION_SCHEMA_VERSION,
            id,
            mission_id: mission_id.clone(),
            title: task_title,
            body_markdown: task.body_markdown,
            phase: task.phase,
            mode: task.mode,
            risk: task.risk,
            writes_files: task.writes_files,
            dependencies: task.dependencies,
            acceptance_criteria: task.acceptance_criteria,
            needs_repo_wide_context: task.needs_repo_wide_context,
            needs_strong_reasoning: task.needs_strong_reasoning,
            needs_delegate_cli: task.needs_delegate_cli,
            needs_visual_review: task.needs_visual_review,
            dispatch: None,
            created_ms: now,
            updated_ms: now,
        });
    }
    for task in &tasks {
        for dependency in &task.dependencies {
            if !seen.contains(dependency) {
                return Err(format!(
                    "Task `{}` depends on missing task `{dependency}`.",
                    task.id
                ));
            }
        }
    }
    let deps_by_id: HashMap<String, Vec<String>> = tasks
        .iter()
        .map(|task| (task.id.clone(), task.dependencies.clone()))
        .collect();
    if let Some(cycle) = first_dependency_cycle(&deps_by_id) {
        return Err(format!(
            "Task dependencies form a cycle: {}.",
            cycle.join(" → ")
        ));
    }

    let mission = MissionSpec {
        schema_version: MISSION_SCHEMA_VERSION,
        id: mission_id.clone(),
        title,
        intent: input.intent.trim().to_string(),
        mode: input.mode,
        task_ids: tasks.iter().map(|task| task.id.clone()).collect(),
        created_ms: now,
        updated_ms: now,
    };

    std::fs::create_dir_all(dir.join("tasks"))
        .map_err(|e| format!("Unable to create Mission directory: {e}"))?;
    std::fs::write(dir.join("mission.md"), render_mission_markdown(&mission)?)
        .map_err(|e| format!("Unable to write mission.md: {e}"))?;
    for task in &tasks {
        std::fs::write(task_path(&dir, &task.id)?, render_task_markdown(task)?)
            .map_err(|e| format!("Unable to write task `{}`: {e}", task.id))?;
    }
    std::fs::write(events_path(&dir), "")
        .map_err(|e| format!("Unable to create Mission event log: {e}"))?;
    append_event(&dir, &mission_id, MissionEvent::MissionCreated)?;
    for task in &tasks {
        append_event(
            &dir,
            &mission_id,
            MissionEvent::TaskCreated {
                task_id: task.id.clone(),
            },
        )?;
    }
    load_bundle_from_dir(&dir)
}

#[tauri::command]
pub fn mission_create(
    state: tauri::State<'_, MissionStoreState>,
    workspace_root: String,
    input: CreateMissionInput,
) -> Result<DurableMissionBundle, String> {
    let _guard = state
        .write_gate
        .lock()
        .map_err(|_| "Mission store is unavailable.".to_string())?;
    do_create(&workspace_root, input)
}

#[tauri::command]
pub fn mission_read(
    workspace_root: String,
    mission_id: String,
) -> Result<DurableMissionBundle, String> {
    load_bundle(&workspace_root, &mission_id)
}

#[tauri::command]
pub fn mission_list(workspace_root: String) -> Result<Vec<DurableMissionBundle>, String> {
    let root = missions_root(&workspace_root)?;
    let mut bundles = Vec::new();
    for entry in std::fs::read_dir(root).map_err(|e| format!("Unable to list Missions: {e}"))? {
        let entry = entry.map_err(|e| format!("Unable to read Mission entry: {e}"))?;
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        if let Ok(bundle) = load_bundle_from_dir(&entry.path()) {
            bundles.push(bundle);
        }
    }
    bundles.sort_by(|a, b| {
        let a_updated = a
            .events
            .last()
            .map(|event| event.ts)
            .unwrap_or(a.mission.updated_ms)
            .max(a.mission.updated_ms);
        let b_updated = b
            .events
            .last()
            .map(|event| event.ts)
            .unwrap_or(b.mission.updated_ms)
            .max(b.mission.updated_ms);
        b_updated.cmp(&a_updated)
    });
    Ok(bundles)
}

#[tauri::command]
pub fn mission_save_task(
    state: tauri::State<'_, MissionStoreState>,
    workspace_root: String,
    mission_id: String,
    input: SaveMissionTaskInput,
) -> Result<DurableMissionBundle, String> {
    do_save_task(&state, &workspace_root, &mission_id, input)
}

fn do_save_task(
    state: &MissionStoreState,
    workspace_root: &str,
    mission_id: &str,
    input: SaveMissionTaskInput,
) -> Result<DurableMissionBundle, String> {
    let _guard = state
        .write_gate
        .lock()
        .map_err(|_| "Mission store is unavailable.".to_string())?;
    validate_id(&input.id, "task")?;
    let dir = mission_dir(workspace_root, mission_id, true)?;
    let mut bundle = load_bundle_from_dir(&dir)?;
    if fold_runtime(&bundle).approved {
        return Err(
            "This Mission plan is approved. Editing a running plan requires a revision event (lands in a later slice)."
                .to_string(),
        );
    }
    let existing = bundle
        .tasks
        .iter()
        .find(|task| task.id == input.id)
        .cloned()
        .ok_or_else(|| format!("Unknown Mission task `{}`.", input.id))?;
    let ids = bundle
        .tasks
        .iter()
        .map(|task| task.id.as_str())
        .collect::<HashSet<_>>();
    for dependency in &input.dependencies {
        if !ids.contains(dependency.as_str()) {
            return Err(format!(
                "Task `{}` depends on missing task `{dependency}`.",
                input.id
            ));
        }
        if dependency == &input.id {
            return Err("A task cannot depend on itself.".to_string());
        }
    }
    let deps_by_id: HashMap<String, Vec<String>> = bundle
        .tasks
        .iter()
        .map(|task| {
            let dependencies = if task.id == input.id {
                input.dependencies.clone()
            } else {
                task.dependencies.clone()
            };
            (task.id.clone(), dependencies)
        })
        .collect();
    if let Some(cycle) = first_dependency_cycle(&deps_by_id) {
        return Err(format!(
            "Task dependencies form a cycle: {}.",
            cycle.join(" → ")
        ));
    }
    let now = now_ms();
    let updated = MissionTaskSpec {
        schema_version: MISSION_SCHEMA_VERSION,
        id: input.id.clone(),
        mission_id: mission_id.to_string(),
        title: clean_title(&input.title, "Task")?,
        body_markdown: input.body_markdown,
        phase: input.phase,
        mode: input.mode,
        risk: input.risk,
        writes_files: input.writes_files,
        dependencies: input.dependencies,
        acceptance_criteria: input.acceptance_criteria,
        needs_repo_wide_context: input.needs_repo_wide_context,
        needs_strong_reasoning: input.needs_strong_reasoning,
        needs_delegate_cli: input.needs_delegate_cli,
        needs_visual_review: input.needs_visual_review,
        dispatch: existing.dispatch,
        created_ms: existing.created_ms,
        updated_ms: now,
    };
    std::fs::write(
        task_path(&dir, &updated.id)?,
        render_task_markdown(&updated)?,
    )
    .map_err(|e| format!("Unable to update task `{}`: {e}", updated.id))?;
    bundle.mission.updated_ms = now;
    std::fs::write(
        dir.join("mission.md"),
        render_mission_markdown(&bundle.mission)?,
    )
    .map_err(|e| format!("Unable to update mission.md: {e}"))?;
    append_event(
        &dir,
        mission_id,
        MissionEvent::TaskUpdated {
            task_id: updated.id,
        },
    )?;
    load_bundle_from_dir(&dir)
}

fn snapshot_approval(
    dir: &Path,
    bundle: &DurableMissionBundle,
    input: MissionApprovalInput,
) -> Result<(), String> {
    let mut by_task = HashMap::new();
    for route in input.tasks {
        validate_id(&route.task_id, "task")?;
        if by_task.insert(route.task_id.clone(), route).is_some() {
            return Err("A task has more than one execution snapshot.".to_string());
        }
    }
    if let Some(unknown) = by_task
        .keys()
        .find(|task_id| !bundle.tasks.iter().any(|task| &task.id == *task_id))
    {
        return Err(format!(
            "Execution snapshot contains unknown task `{unknown}`."
        ));
    }
    let mut updates = Vec::new();
    for task in &bundle.tasks {
        let route = by_task.remove(&task.id);
        if task.dispatch.is_some() {
            continue;
        }
        let route =
            route.ok_or_else(|| format!("Task `{}` has no execution snapshot.", task.id))?;
        if route.provider.trim().is_empty() || route.model.trim().is_empty() {
            return Err(format!(
                "Task `{}` needs both a provider and model before approval.",
                task.id
            ));
        }
        let mut updated = task.clone();
        updated.dispatch = Some(MissionTaskDispatch {
            worker_kind: route.worker_kind,
            provider: route.provider.trim().to_string(),
            model: route.model.trim().to_string(),
            require_diff_review: route.require_diff_review,
        });
        updated.updated_ms = now_ms();
        updates.push(updated);
    }
    for updated in updates {
        std::fs::write(
            task_path(dir, &updated.id)?,
            render_task_markdown(&updated)?,
        )
        .map_err(|e| format!("Unable to save task execution snapshot: {e}"))?;
        append_event(
            dir,
            &bundle.mission.id,
            MissionEvent::TaskUpdated {
                task_id: updated.id,
            },
        )?;
    }
    Ok(())
}

fn append_lifecycle_event(dir: &Path, mission_id: &str, event: MissionEvent) -> Result<(), String> {
    let prior = read_events(dir)?;
    let duplicate = matches!(
        (prior.last().map(|line| &line.event), &event),
        (
            Some(MissionEvent::MissionCompleted),
            MissionEvent::MissionCompleted
        ) | (
            Some(MissionEvent::MissionParked { .. }),
            MissionEvent::MissionParked { .. }
        )
    );
    if duplicate {
        return Ok(());
    }
    append_event(dir, mission_id, event)
}

fn record_dispatch_failure(
    app: &tauri::AppHandle,
    workspace_root: &str,
    mission_id: &str,
    task_id: &str,
    run_id: &str,
    message: &str,
) -> Result<(), String> {
    let state = app.state::<MissionStoreState>();
    let _guard = state
        .write_gate
        .lock()
        .map_err(|_| "Mission store is unavailable.".to_string())?;
    let dir = mission_dir(workspace_root, mission_id, true)?;
    append_event(
        &dir,
        mission_id,
        MissionEvent::AttemptDispatchFailed {
            task_id: task_id.to_string(),
            run_id: run_id.to_string(),
            message: message.chars().take(500).collect(),
        },
    )
}

async fn dispatch_task(
    app: &tauri::AppHandle,
    workspace_root: &str,
    mission_id: &str,
    task_id: &str,
) -> Result<(), String> {
    let (run_id, launch) = {
        let state = app.state::<MissionStoreState>();
        let _guard = state
            .write_gate
            .lock()
            .map_err(|_| "Mission store is unavailable.".to_string())?;
        let dir = mission_dir(workspace_root, mission_id, true)?;
        let bundle = load_bundle_from_dir(&dir)?;
        let runtime = fold_runtime(&bundle);
        if !task_is_ready(&bundle, &runtime, task_id)? {
            return Err(format!(
                "Task `{task_id}` is not ready. Its plan must be approved and every dependency accepted."
            ));
        }
        let task = bundle
            .tasks
            .iter()
            .find(|task| task.id == task_id)
            .cloned()
            .ok_or_else(|| format!("Unknown Mission task `{task_id}`."))?;
        let attempt_run_id = run_id();
        append_event(
            &dir,
            mission_id,
            MissionEvent::AttemptAttached {
                task_id: task_id.to_string(),
                run_id: attempt_run_id.clone(),
            },
        )?;
        let launch = launch_for(workspace_root, &bundle, &task, &attempt_run_id);
        (attempt_run_id, launch)
    };

    let launch = match launch {
        Ok(launch) => launch,
        Err(error) => {
            record_dispatch_failure(app, workspace_root, mission_id, task_id, &run_id, &error)?;
            return Err(error);
        }
    };
    let result = match launch {
        MissionLaunch::Harness(request) => crate::agent::start_background_run(app.clone(), request)
            .await
            .map(|_| ()),
        MissionLaunch::Delegate {
            provider,
            model,
            prompt,
        } => crate::pty::delegate_pty_spawn(
            app.clone(),
            app.state::<crate::pty::DelegatePtyState>(),
            app.state::<crate::delegate::status::DelegateStatusState>(),
            run_id.clone(),
            provider,
            Some(workspace_root.to_string()),
            Some(prompt),
            Some(model),
            None,
            None,
            Some(mission_id.to_string()),
            Some(task_id.to_string()),
            Some(true),
        ),
    };
    if let Err(error) = result {
        record_dispatch_failure(app, workspace_root, mission_id, task_id, &run_id, &error)?;
        return Err(error);
    }
    Ok(())
}

async fn drive_mission_inner(
    app: &tauri::AppHandle,
    workspace_root: &str,
    mission_id: &str,
) -> Result<(), String> {
    let decision = {
        let state = app.state::<MissionStoreState>();
        let _guard = state
            .write_gate
            .lock()
            .map_err(|_| "Mission store is unavailable.".to_string())?;
        let bundle = load_bundle(workspace_root, mission_id)?;
        supervisor_decision(&bundle, &fold_runtime(&bundle))?
    };
    match decision {
        SupervisorDecision::Wait => Ok(()),
        SupervisorDecision::Dispatch(task_id) => {
            if let Err(error) = dispatch_task(app, workspace_root, mission_id, &task_id).await {
                let state = app.state::<MissionStoreState>();
                let _guard = state
                    .write_gate
                    .lock()
                    .map_err(|_| "Mission store is unavailable.".to_string())?;
                let dir = mission_dir(workspace_root, mission_id, true)?;
                let bundle = load_bundle_from_dir(&dir)?;
                // Only a genuinely recorded dispatch failure parks the mission
                // (mirrors `mission_dispatch_task`); a "not ready" race must not.
                if dispatch_failure_should_park(&bundle, &task_id) {
                    append_lifecycle_event(
                        &dir,
                        mission_id,
                        MissionEvent::MissionParked {
                            reason: format!("Task `{task_id}` could not start: {error}"),
                        },
                    )?;
                }
            }
            Ok(())
        }
        SupervisorDecision::Complete => {
            let state = app.state::<MissionStoreState>();
            let _guard = state
                .write_gate
                .lock()
                .map_err(|_| "Mission store is unavailable.".to_string())?;
            let dir = mission_dir(workspace_root, mission_id, true)?;
            append_lifecycle_event(&dir, mission_id, MissionEvent::MissionCompleted)
        }
        SupervisorDecision::Park(reason) => {
            let state = app.state::<MissionStoreState>();
            let _guard = state
                .write_gate
                .lock()
                .map_err(|_| "Mission store is unavailable.".to_string())?;
            let dir = mission_dir(workspace_root, mission_id, true)?;
            append_lifecycle_event(&dir, mission_id, MissionEvent::MissionParked { reason })
        }
    }
}

pub(crate) async fn drive_mission(
    app: tauri::AppHandle,
    workspace_root: String,
    mission_id: String,
) -> Result<(), String> {
    // Single-flight per (workspace, mission). Callers reach us with the root in
    // different string forms — the raw frontend string (approve / validation
    // writeback) or the already-canonical form (restart reconcile). Key on the
    // canonical root so those forms can't split into two concurrently-driving
    // loops, which would make the loser's dispatch see "not ready" and
    // spuriously park a mission that is in fact running normally.
    let canonical_root = Workspace::new(&workspace_root)
        .map(|workspace| workspace.root().to_string_lossy().to_string())
        .unwrap_or_else(|_| workspace_root.clone());
    let key = format!("{canonical_root}\0{mission_id}");
    {
        let state = app.state::<MissionStoreState>();
        let mut driving = state
            .driving
            .lock()
            .map_err(|_| "Mission supervisor is unavailable.".to_string())?;
        if let Some(pending) = driving.get_mut(&key) {
            *pending = true;
            return Ok(());
        }
        driving.insert(key.clone(), false);
    }

    loop {
        let result = drive_mission_inner(&app, &workspace_root, &mission_id).await;
        let rerun = {
            let state = app.state::<MissionStoreState>();
            let mut driving = state
                .driving
                .lock()
                .map_err(|_| "Mission supervisor is unavailable.".to_string())?;
            if result.is_ok() && driving.get(&key).copied() == Some(true) {
                driving.insert(key.clone(), false);
                true
            } else {
                driving.remove(&key);
                false
            }
        };
        if !rerun {
            return result;
        }
    }
}

#[tauri::command]
pub async fn mission_approve(
    app: tauri::AppHandle,
    state: tauri::State<'_, MissionStoreState>,
    workspace_root: String,
    mission_id: String,
    input: MissionApprovalInput,
) -> Result<DurableMissionBundle, String> {
    let auto_start = input.auto_start;
    {
        let _guard = state
            .write_gate
            .lock()
            .map_err(|_| "Mission store is unavailable.".to_string())?;
        let dir = mission_dir(&workspace_root, &mission_id, true)?;
        let bundle = load_bundle_from_dir(&dir)?;
        snapshot_approval(&dir, &bundle, input)?;
        let refreshed = load_bundle_from_dir(&dir)?;
        if !fold_runtime(&refreshed).approved {
            append_event(&dir, &mission_id, MissionEvent::PlanApproved)?;
        }
    }
    if auto_start {
        drive_mission(app, workspace_root.clone(), mission_id.clone()).await?;
    }
    load_bundle(&workspace_root, &mission_id)
}

#[tauri::command]
pub async fn mission_dispatch_task(
    app: tauri::AppHandle,
    workspace_root: String,
    mission_id: String,
    task_id: String,
) -> Result<DurableMissionBundle, String> {
    if let Err(error) = dispatch_task(&app, &workspace_root, &mission_id, &task_id).await {
        let state = app.state::<MissionStoreState>();
        let _guard = state
            .write_gate
            .lock()
            .map_err(|_| "Mission store is unavailable.".to_string())?;
        let dir = mission_dir(&workspace_root, &mission_id, true)?;
        let bundle = load_bundle_from_dir(&dir)?;
        if !dispatch_failure_should_park(&bundle, &task_id) {
            return Err(error);
        }
        append_lifecycle_event(
            &dir,
            &mission_id,
            MissionEvent::MissionParked {
                reason: format!("Task `{task_id}` could not start: {error}"),
            },
        )?;
    }
    load_bundle(&workspace_root, &mission_id)
}

#[tauri::command]
pub fn mission_prepare_attempt(
    state: tauri::State<'_, MissionStoreState>,
    workspace_root: String,
    mission_id: String,
    task_id: String,
) -> Result<PreparedMissionAttempt, String> {
    let _guard = state
        .write_gate
        .lock()
        .map_err(|_| "Mission store is unavailable.".to_string())?;
    let dir = mission_dir(&workspace_root, &mission_id, true)?;
    let bundle = load_bundle_from_dir(&dir)?;
    let runtime = fold_runtime(&bundle);
    if !task_is_ready(&bundle, &runtime, &task_id)? {
        return Err(format!(
            "Task `{task_id}` is not ready. Its plan must be approved and every dependency accepted."
        ));
    }
    let attempt_run_id = run_id();
    append_event(
        &dir,
        &mission_id,
        MissionEvent::AttemptAttached {
            task_id,
            run_id: attempt_run_id.clone(),
        },
    )?;
    Ok(PreparedMissionAttempt {
        run_id: attempt_run_id,
        bundle: load_bundle_from_dir(&dir)?,
    })
}

#[tauri::command]
pub fn mission_fail_attempt_dispatch(
    state: tauri::State<'_, MissionStoreState>,
    workspace_root: String,
    mission_id: String,
    task_id: String,
    run_id: String,
    message: String,
) -> Result<DurableMissionBundle, String> {
    let _guard = state
        .write_gate
        .lock()
        .map_err(|_| "Mission store is unavailable.".to_string())?;
    validate_run_id(&run_id)?;
    let dir = mission_dir(&workspace_root, &mission_id, true)?;
    let bundle = load_bundle_from_dir(&dir)?;
    let runtime = fold_runtime(&bundle);
    let task = runtime
        .tasks
        .get(&task_id)
        .ok_or_else(|| format!("Unknown Mission task `{task_id}`."))?;
    if !task.active.contains(&run_id) {
        return Err(format!(
            "Run `{run_id}` is not an active attempt of task `{task_id}`."
        ));
    }
    append_event(
        &dir,
        &mission_id,
        MissionEvent::AttemptDispatchFailed {
            task_id,
            run_id,
            message: message.chars().take(500).collect(),
        },
    )?;
    load_bundle_from_dir(&dir)
}

/// Called from the Delegate PTY exit sink. Settlement is durable evidence that
/// the one-shot CLI stopped; it deliberately moves the attempt to operator
/// review rather than accepting it or driving the next Task.
pub(crate) fn record_linked_delegate_attempt_settlement(
    app: &tauri::AppHandle,
    meta: &ScrollbackMeta,
) -> Result<(), String> {
    let Some(link) = meta.mission_link.as_ref() else {
        return Ok(());
    };
    let outcome = meta
        .exit_outcome
        .as_ref()
        .ok_or_else(|| "Delegate session ended without a durable exit outcome.".to_string())?;
    let state = app.state::<MissionStoreState>();
    let _guard = state
        .write_gate
        .lock()
        .map_err(|_| "Mission store is unavailable.".to_string())?;
    validate_run_id(&meta.session_id)?;
    let dir = mission_dir(&link.workspace_root, &link.mission_id, true)?;
    let bundle = load_bundle_from_dir(&dir)?;
    let runtime = fold_runtime(&bundle);
    let task = runtime
        .tasks
        .get(&link.task_id)
        .ok_or_else(|| format!("Unknown Mission task `{}`.", link.task_id))?;
    if !task
        .attempts
        .iter()
        .any(|run_id| run_id == &meta.session_id)
    {
        return Err(format!(
            "Delegate Run `{}` is not an attempt of task `{}`.",
            meta.session_id, link.task_id
        ));
    }
    let already_terminal = bundle.events.iter().any(|line| match &line.event {
        MissionEvent::AttemptSettled {
            task_id, run_id, ..
        }
        | MissionEvent::AttemptInterrupted {
            task_id, run_id, ..
        }
        | MissionEvent::AttemptValidationRecorded {
            task_id, run_id, ..
        } => task_id == &link.task_id && run_id == &meta.session_id,
        _ => false,
    });
    if already_terminal {
        return Ok(());
    }
    if outcome.stop_requested {
        append_event(
            &dir,
            &link.mission_id,
            MissionEvent::AttemptInterrupted {
                task_id: link.task_id.clone(),
                run_id: meta.session_id.clone(),
                reason: "The Delegate attempt was stopped before operator review.".to_string(),
            },
        )
    } else {
        append_event(
            &dir,
            &link.mission_id,
            MissionEvent::AttemptSettled {
                task_id: link.task_id.clone(),
                run_id: meta.session_id.clone(),
                exit_code: outcome.exit_code,
                signal: outcome.signal.clone(),
            },
        )
    }
}

fn delegate_review_validation(
    outcome: &PtyExitOutcome,
    accepted: bool,
    note: Option<&str>,
) -> AgentValidationSummary {
    let exit_label = if outcome.exit_code == 0 && outcome.signal.is_none() {
        "Delegate process exited successfully"
    } else {
        "Delegate process reported a non-success exit"
    };
    let mut warnings = Vec::new();
    if outcome.exit_code != 0 || outcome.signal.is_some() {
        warnings.push(format!(
            "Delegate exit code {}{}.",
            outcome.exit_code,
            outcome
                .signal
                .as_deref()
                .map(|signal| format!(" ({signal})"))
                .unwrap_or_default()
        ));
    }
    if let Some(note) = note.map(str::trim).filter(|note| !note.is_empty()) {
        warnings.push(note.chars().take(500).collect());
    }
    AgentValidationSummary {
        status: if accepted { "passed" } else { "failed" }.to_string(),
        checks: vec![
            AgentValidationCheckSummary {
                id: "delegate-exit".to_string(),
                label: exit_label.to_string(),
                status: if outcome.exit_code == 0 && outcome.signal.is_none() {
                    "passed"
                } else {
                    "failed"
                }
                .to_string(),
                // Exit is evidence, not acceptance: an operator may accept
                // useful work after a CLI returned non-zero.
                required: false,
                evidence: Some(format!("exit code {}", outcome.exit_code)),
            },
            AgentValidationCheckSummary {
                id: "operator-review".to_string(),
                label: "Operator reviewed Delegate output and workspace changes".to_string(),
                status: if accepted { "passed" } else { "failed" }.to_string(),
                required: true,
                evidence: note
                    .map(str::trim)
                    .filter(|note| !note.is_empty())
                    .map(|note| note.chars().take(500).collect()),
            },
        ],
        files_changed: 0,
        commands_run: 0,
        commands_failed: u32::from(outcome.exit_code != 0 || outcome.signal.is_some()),
        diff_reviews: 1,
        permissions_approved: 0,
        permissions_denied: 0,
        warnings,
    }
}

#[tauri::command]
pub async fn mission_review_attempt(
    app: tauri::AppHandle,
    state: tauri::State<'_, MissionStoreState>,
    workspace_root: String,
    mission_id: String,
    input: ReviewMissionAttemptInput,
) -> Result<DurableMissionBundle, String> {
    {
        let _guard = state
            .write_gate
            .lock()
            .map_err(|_| "Mission store is unavailable.".to_string())?;
        validate_run_id(&input.run_id)?;
        let dir = mission_dir(&workspace_root, &mission_id, true)?;
        let bundle = load_bundle_from_dir(&dir)?;
        if bundle.events.iter().any(|line| {
            matches!(
                &line.event,
                MissionEvent::AttemptValidationRecorded {
                    task_id,
                    run_id,
                    ..
                } if task_id == &input.task_id && run_id == &input.run_id
            )
        }) {
            return Ok(bundle);
        }
        let outcome = bundle
            .events
            .iter()
            .rev()
            .find_map(|line| match &line.event {
                MissionEvent::AttemptSettled {
                    task_id,
                    run_id,
                    exit_code,
                    signal,
                } if task_id == &input.task_id && run_id == &input.run_id => Some(PtyExitOutcome {
                    exit_code: *exit_code,
                    signal: signal.clone(),
                    stop_requested: false,
                }),
                _ => None,
            })
            .ok_or_else(|| {
                format!(
                    "Delegate Run `{}` has not settled for operator review.",
                    input.run_id
                )
            })?;
        append_event(
            &dir,
            &mission_id,
            MissionEvent::AttemptValidationRecorded {
                task_id: input.task_id,
                run_id: input.run_id,
                accepted: input.accepted,
                validation: delegate_review_validation(
                    &outcome,
                    input.accepted,
                    input.note.as_deref(),
                ),
            },
        )?;
    }
    drive_mission(app, workspace_root.clone(), mission_id.clone()).await?;
    load_bundle(&workspace_root, &mission_id)
}

#[tauri::command]
pub fn mission_validate_attempt(
    app: tauri::AppHandle,
    state: tauri::State<'_, MissionStoreState>,
    workspace_root: String,
    mission_id: String,
    task_id: String,
    run_id: String,
) -> Result<DurableMissionBundle, String> {
    let _guard = state
        .write_gate
        .lock()
        .map_err(|_| "Mission store is unavailable.".to_string())?;
    let runs_dir = app_runs_dir(&app)?;
    validate_attempt_from_runs_dir(&runs_dir, &workspace_root, &mission_id, &task_id, &run_id)
}

fn validate_attempt_from_runs_dir(
    runs_dir: &Path,
    workspace_root: &str,
    mission_id: &str,
    task_id: &str,
    run_id: &str,
) -> Result<DurableMissionBundle, String> {
    validate_run_id(&run_id)?;
    let dir = mission_dir(workspace_root, mission_id, true)?;
    let bundle = load_bundle_from_dir(&dir)?;
    let runtime = fold_runtime(&bundle);
    let task_runtime = runtime
        .tasks
        .get(task_id)
        .ok_or_else(|| format!("Unknown Mission task `{task_id}`."))?;
    if !task_runtime.attempts.iter().any(|id| id == run_id) {
        return Err(format!(
            "Run `{run_id}` is not an attempt of task `{task_id}`."
        ));
    }
    if bundle.events.iter().any(|line| {
        matches!(
            &line.event,
            MissionEvent::AttemptValidationRecorded {
                task_id: recorded_task,
                run_id: recorded_run,
                ..
            } if recorded_task == task_id && recorded_run == run_id
        )
    }) {
        return Ok(bundle);
    }

    let summary = read_summary(runs_dir, run_id)?;
    if !matches!(summary.status.as_str(), "done" | "error" | "cancelled") {
        return Err(format!("Run `{run_id}` has not settled yet."));
    }
    let validation = summary
        .validation
        .ok_or_else(|| format!("Run `{run_id}` has no Harness validation summary."))?;
    let accepted = validation_accepts(&summary.status, &validation);
    append_event(
        &dir,
        mission_id,
        MissionEvent::AttemptValidationRecorded {
            task_id: task_id.to_string(),
            run_id: run_id.to_string(),
            accepted,
            validation,
        },
    )?;
    load_bundle_from_dir(&dir)
}

#[derive(Debug, PartialEq, Eq)]
enum AttemptRecoveryDecision {
    LeaveLive,
    ValidateTerminal,
    Interrupt(String),
}

fn attempt_recovery_decision(
    live_in_this_process: bool,
    summary_status: Option<&str>,
) -> AttemptRecoveryDecision {
    if live_in_this_process {
        return AttemptRecoveryDecision::LeaveLive;
    }
    match summary_status {
        Some("done" | "error" | "cancelled") => AttemptRecoveryDecision::ValidateTerminal,
        Some(status) => AttemptRecoveryDecision::Interrupt(format!(
            "Klide restarted while the Harness summary was `{status}`."
        )),
        None => AttemptRecoveryDecision::Interrupt(
            "Klide restarted before the Harness wrote a Run summary.".to_string(),
        ),
    }
}

/// Repair active Mission attempts from Harness evidence after a process
/// restart. A terminal summary is safe to validate. A missing/non-terminal
/// summary is ambiguous—edits may already have landed—so it becomes an
/// interrupted attempt and must never be replayed automatically.
fn reconcile_orphaned_attempts_from_runs_dir(
    runs_dir: &Path,
    workspace_root: &str,
    mission_id: &str,
    is_live: impl Fn(&str) -> bool,
) -> Result<usize, String> {
    let dir = mission_dir(workspace_root, mission_id, true)?;
    let bundle = load_bundle_from_dir(&dir)?;
    let runtime = fold_runtime(&bundle);
    let mut active = Vec::new();
    for task in &bundle.tasks {
        if task
            .dispatch
            .as_ref()
            .is_some_and(|dispatch| dispatch.worker_kind == MissionWorkerKind::Delegate)
        {
            continue;
        }
        let mut run_ids = runtime
            .tasks
            .get(&task.id)
            .map(|task| task.active.iter().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        run_ids.sort();
        active.extend(run_ids.into_iter().map(|run_id| (task.id.clone(), run_id)));
    }

    let mut repaired = 0;
    for (task_id, run_id) in active {
        let summary = read_summary(runs_dir, &run_id).ok();
        match attempt_recovery_decision(
            is_live(&run_id),
            summary.as_ref().map(|summary| summary.status.as_str()),
        ) {
            AttemptRecoveryDecision::LeaveLive => {}
            AttemptRecoveryDecision::ValidateTerminal => {
                if let Err(error) = validate_attempt_from_runs_dir(
                    runs_dir,
                    workspace_root,
                    mission_id,
                    &task_id,
                    &run_id,
                ) {
                    append_event(
                        &dir,
                        mission_id,
                        MissionEvent::AttemptInterrupted {
                            task_id,
                            run_id,
                            reason: format!(
                                "Klide found a terminal Run but could not recover its validation: {error}"
                            )
                            .chars()
                            .take(500)
                            .collect(),
                        },
                    )?;
                }
                repaired += 1;
            }
            AttemptRecoveryDecision::Interrupt(reason) => {
                append_event(
                    &dir,
                    mission_id,
                    MissionEvent::AttemptInterrupted {
                        task_id,
                        run_id,
                        reason,
                    },
                )?;
                repaired += 1;
            }
        }
    }
    Ok(repaired)
}

fn reconcile_delegate_attempts(
    app: &tauri::AppHandle,
    workspace_root: &str,
    mission_id: &str,
) -> Result<usize, String> {
    let dir = mission_dir(workspace_root, mission_id, true)?;
    let bundle = load_bundle_from_dir(&dir)?;
    let runtime = fold_runtime(&bundle);
    let mut active = Vec::new();
    for task in &bundle.tasks {
        if !task
            .dispatch
            .as_ref()
            .is_some_and(|dispatch| dispatch.worker_kind == MissionWorkerKind::Delegate)
        {
            continue;
        }
        let mut run_ids = runtime
            .tasks
            .get(&task.id)
            .map(|task| task.active.iter().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        run_ids.sort();
        active.extend(run_ids.into_iter().map(|run_id| (task.id.clone(), run_id)));
    }

    let mut repaired = 0;
    for (task_id, run_id) in active {
        match crate::pty::delegate_attempt_recovery(app, &run_id) {
            crate::pty::DelegateAttemptRecovery::Live => {}
            crate::pty::DelegateAttemptRecovery::Settled(outcome) if outcome.stop_requested => {
                append_event(
                    &dir,
                    mission_id,
                    MissionEvent::AttemptInterrupted {
                        task_id,
                        run_id,
                        reason: "The Delegate attempt was stopped before operator review."
                            .to_string(),
                    },
                )?;
                repaired += 1;
            }
            crate::pty::DelegateAttemptRecovery::Settled(outcome) => {
                append_event(
                    &dir,
                    mission_id,
                    MissionEvent::AttemptSettled {
                        task_id,
                        run_id,
                        exit_code: outcome.exit_code,
                        signal: outcome.signal,
                    },
                )?;
                repaired += 1;
            }
            crate::pty::DelegateAttemptRecovery::Missing => {
                append_event(
                    &dir,
                    mission_id,
                    MissionEvent::AttemptInterrupted {
                        task_id,
                        run_id,
                        reason:
                            "Klide restarted before the Delegate host recorded a process outcome."
                                .to_string(),
                    },
                )?;
                repaired += 1;
            }
        }
    }
    Ok(repaired)
}

fn mission_should_resume(bundle: &DurableMissionBundle) -> bool {
    let runtime = fold_runtime(bundle);
    runtime.approved
        && !matches!(
            bundle.events.last().map(|line| &line.event),
            Some(MissionEvent::MissionCompleted | MissionEvent::MissionParked { .. })
        )
}

/// Called when the frontend activates/restores a workspace. The pass runs once
/// per canonical workspace per desktop launch, then gives every non-terminal
/// approved Mission one supervisor decision pass.
pub(crate) async fn reconcile_workspace(
    app: tauri::AppHandle,
    workspace_root: String,
) -> Result<(), String> {
    let workspace = Workspace::new(&workspace_root)?;
    let canonical_root = workspace.root().to_string_lossy().to_string();
    {
        let state = app.state::<MissionStoreState>();
        let mut reconciled = state
            .reconciled_workspaces
            .lock()
            .map_err(|_| "Mission recovery state is unavailable.".to_string())?;
        if !reconciled.insert(canonical_root.clone()) {
            return Ok(());
        }
    }

    let result = async {
        let runs_dir = app_runs_dir(&app)?;
        let resume_ids = {
            let state = app.state::<MissionStoreState>();
            let _guard = state
                .write_gate
                .lock()
                .map_err(|_| "Mission store is unavailable.".to_string())?;
            let root = PathBuf::from(&canonical_root).join(".klide/missions");
            if !root.is_dir() {
                return Ok(());
            }
            let mut mission_ids = Vec::new();
            for entry in
                std::fs::read_dir(root).map_err(|e| format!("Unable to list Missions: {e}"))?
            {
                let entry = entry.map_err(|e| format!("Unable to read Mission entry: {e}"))?;
                if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                    continue;
                }
                let Ok(bundle) = load_bundle_from_dir(&entry.path()) else {
                    continue;
                };
                reconcile_orphaned_attempts_from_runs_dir(
                    &runs_dir,
                    &canonical_root,
                    &bundle.mission.id,
                    |run_id| crate::agent::run_is_active(&app, run_id),
                )?;
                reconcile_delegate_attempts(&app, &canonical_root, &bundle.mission.id)?;
                let repaired = load_bundle(&canonical_root, &bundle.mission.id)?;
                if mission_should_resume(&repaired) {
                    mission_ids.push(bundle.mission.id);
                }
            }
            mission_ids
        };

        for mission_id in resume_ids {
            drive_mission(app.clone(), canonical_root.clone(), mission_id).await?;
        }
        Ok(())
    }
    .await;

    if result.is_err() {
        if let Ok(mut reconciled) = app
            .state::<MissionStoreState>()
            .reconciled_workspaces
            .lock()
        {
            reconciled.remove(&canonical_root);
        }
    }
    result
}

/// Called by the detached Rust Harness after a linked attempt settles. This is
/// the durable validation writer; a mounted UI may observe it but is not
/// required to make acceptance happen.
pub(crate) fn record_linked_attempt_validation(
    app: &tauri::AppHandle,
    workspace_root: &str,
    mission_id: &str,
    task_id: &str,
    run_id: &str,
) -> Result<(), String> {
    {
        let state = app.state::<MissionStoreState>();
        let _guard = state
            .write_gate
            .lock()
            .map_err(|_| "Mission store is unavailable.".to_string())?;
        let runs_dir = app_runs_dir(app)?;
        validate_attempt_from_runs_dir(&runs_dir, workspace_root, mission_id, task_id, run_id)?;
    }
    let mission_app = app.clone();
    let root = workspace_root.to_string();
    let linked_mission_id = mission_id.to_string();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = drive_mission(mission_app, root, linked_mission_id).await {
            eprintln!("mission supervisor could not continue: {error}");
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_workspace(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("klide-mission-test-{name}-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_input() -> CreateMissionInput {
        CreateMissionInput {
            id: Some("mission-one".to_string()),
            title: "Ship the tracer bullet".to_string(),
            intent: "Persist, run, and accept two dependent tasks.".to_string(),
            mode: MissionMode::Goal,
            tasks: vec![
                CreateMissionTaskInput {
                    id: Some("inspect".to_string()),
                    title: "Inspect the seam".to_string(),
                    body_markdown: "Read the existing Harness evidence.".to_string(),
                    phase: MissionTaskPhase::Understand,
                    mode: MissionMode::Plan,
                    risk: MissionTaskRisk::Low,
                    writes_files: false,
                    dependencies: vec![],
                    acceptance_criteria: vec!["The seam is identified".to_string()],
                    needs_repo_wide_context: false,
                    needs_strong_reasoning: false,
                    needs_delegate_cli: false,
                    needs_visual_review: false,
                },
                CreateMissionTaskInput {
                    id: Some("implement".to_string()),
                    title: "Implement the seam".to_string(),
                    body_markdown: "Wire the durable path.".to_string(),
                    phase: MissionTaskPhase::Build,
                    mode: MissionMode::Goal,
                    risk: MissionTaskRisk::Medium,
                    writes_files: true,
                    dependencies: vec!["inspect".to_string()],
                    acceptance_criteria: vec!["Validation passes".to_string()],
                    needs_repo_wide_context: false,
                    needs_strong_reasoning: false,
                    needs_delegate_cli: false,
                    needs_visual_review: false,
                },
            ],
        }
    }

    fn skipped_validation() -> AgentValidationSummary {
        AgentValidationSummary {
            status: "skipped".to_string(),
            checks: vec![],
            files_changed: 0,
            commands_run: 0,
            commands_failed: 0,
            diff_reviews: 0,
            permissions_approved: 0,
            permissions_denied: 0,
            warnings: vec![],
        }
    }

    fn write_test_summary(
        runs_dir: &Path,
        workspace_root: &Path,
        run_id: &str,
        status: &str,
        validation_status: &str,
    ) {
        std::fs::create_dir_all(runs_dir).unwrap();
        let summary = serde_json::json!({
            "id": run_id,
            "path": runs_dir.join(format!("{run_id}.jsonl")).to_string_lossy(),
            "source": "klide",
            "title": "Recovered Mission attempt",
            "status": status,
            "provider": "mock",
            "model": "mock-model",
            "cwd": workspace_root.to_string_lossy(),
            "project": "test",
            "gitBranch": null,
            "createdMs": 1,
            "updatedMs": 2,
            "messageCount": 2,
            "inputTokens": 0,
            "outputTokens": 0,
            "filesTouched": 0,
            "validation": {
                "status": validation_status,
                "checks": [],
                "filesChanged": 0,
                "commandsRun": 0,
                "commandsFailed": 0,
                "diffReviews": 0,
                "permissionsApproved": 0,
                "permissionsDenied": 0,
                "warnings": []
            }
        });
        std::fs::write(
            runs_dir.join(format!("{run_id}.summary.json")),
            serde_json::to_string_pretty(&summary).unwrap(),
        )
        .unwrap();
    }

    fn deps(pairs: &[(&str, &[&str])]) -> HashMap<String, Vec<String>> {
        pairs
            .iter()
            .map(|(id, ds)| {
                (
                    id.to_string(),
                    ds.iter().map(|d| d.to_string()).collect::<Vec<_>>(),
                )
            })
            .collect()
    }

    #[test]
    fn cycle_detection_finds_direct_and_indirect_loops() {
        assert!(
            first_dependency_cycle(&deps(&[("a", &[]), ("b", &["a"]), ("c", &["b"])])).is_none()
        );
        // A missing dependency is not a cycle — the caller reports it instead.
        assert!(first_dependency_cycle(&deps(&[("a", &["ghost"])])).is_none());
        assert!(first_dependency_cycle(&deps(&[("a", &["b"]), ("b", &["a"])])).is_some());
        let three = first_dependency_cycle(&deps(&[("a", &["b"]), ("b", &["c"]), ("c", &["a"])]))
            .expect("a→b→c→a is a cycle");
        assert_eq!(three.first(), three.last());
    }

    #[test]
    fn create_rejects_a_cyclic_plan() {
        let root = temp_workspace("create-cycle");
        let mut input = sample_input();
        // inspect now also depends on implement, and implement depends on inspect.
        input.tasks[0].dependencies = vec!["implement".to_string()];
        let err = do_create(root.to_str().unwrap(), input).unwrap_err();
        assert!(err.contains("cycle"), "unexpected error: {err}");
        assert!(!root.join(".klide/missions/mission-one").exists());
    }

    #[test]
    fn save_task_rejects_an_edit_that_introduces_a_cycle() {
        let root = temp_workspace("save-cycle");
        let store = MissionStoreState::default();
        do_create(root.to_str().unwrap(), sample_input()).unwrap();
        // implement already depends on inspect; making inspect depend on implement
        // would close the loop.
        let input = SaveMissionTaskInput {
            id: "inspect".to_string(),
            title: "Inspect the seam".to_string(),
            body_markdown: "Read the existing Harness evidence.".to_string(),
            phase: MissionTaskPhase::Understand,
            mode: MissionMode::Plan,
            risk: MissionTaskRisk::Low,
            writes_files: false,
            dependencies: vec!["implement".to_string()],
            acceptance_criteria: vec!["The seam is identified".to_string()],
            needs_repo_wide_context: false,
            needs_strong_reasoning: false,
            needs_delegate_cli: false,
            needs_visual_review: false,
        };
        let err = do_save_task(&store, root.to_str().unwrap(), "mission-one", input).unwrap_err();
        assert!(err.contains("cycle"), "unexpected error: {err}");
        // The on-disk task Markdown is untouched by the rejected edit.
        let bundle = load_bundle(root.to_str().unwrap(), "mission-one").unwrap();
        assert!(bundle.tasks[0].dependencies.is_empty());
    }

    #[test]
    fn persists_markdown_and_replays_events() {
        let root = temp_workspace("persist");
        let bundle = do_create(root.to_str().unwrap(), sample_input()).unwrap();
        assert_eq!(bundle.mission.id, "mission-one");
        assert_eq!(bundle.tasks.len(), 2);
        assert_eq!(bundle.events.len(), 3);
        assert!(root
            .join(".klide/missions/mission-one/tasks/inspect.md")
            .exists());

        let loaded = load_bundle(root.to_str().unwrap(), "mission-one").unwrap();
        assert_eq!(loaded.tasks[1].dependencies, vec!["inspect"]);
        assert_eq!(
            loaded.tasks[0].body_markdown,
            "Read the existing Harness evidence."
        );
    }

    #[test]
    fn downstream_is_ready_only_after_dependency_acceptance() {
        let root = temp_workspace("ready");
        do_create(root.to_str().unwrap(), sample_input()).unwrap();
        let dir = mission_dir(root.to_str().unwrap(), "mission-one", true).unwrap();
        append_event(&dir, "mission-one", MissionEvent::PlanApproved).unwrap();

        let bundle = load_bundle_from_dir(&dir).unwrap();
        let runtime = fold_runtime(&bundle);
        assert!(task_is_ready(&bundle, &runtime, "inspect").unwrap());
        assert!(!task_is_ready(&bundle, &runtime, "implement").unwrap());

        append_event(
            &dir,
            "mission-one",
            MissionEvent::AttemptAttached {
                task_id: "inspect".to_string(),
                run_id: "run-inspect".to_string(),
            },
        )
        .unwrap();
        append_event(
            &dir,
            "mission-one",
            MissionEvent::AttemptValidationRecorded {
                task_id: "inspect".to_string(),
                run_id: "run-inspect".to_string(),
                accepted: true,
                validation: AgentValidationSummary {
                    status: "skipped".to_string(),
                    checks: vec![],
                    files_changed: 0,
                    commands_run: 0,
                    commands_failed: 0,
                    diff_reviews: 0,
                    permissions_approved: 0,
                    permissions_denied: 0,
                    warnings: vec![],
                },
            },
        )
        .unwrap();

        let bundle = load_bundle_from_dir(&dir).unwrap();
        let runtime = fold_runtime(&bundle);
        assert!(task_is_ready(&bundle, &runtime, "implement").unwrap());
    }

    #[test]
    fn task_and_attempt_are_distinct_and_retries_accumulate() {
        let root = temp_workspace("attempts");
        do_create(root.to_str().unwrap(), sample_input()).unwrap();
        let dir = mission_dir(root.to_str().unwrap(), "mission-one", true).unwrap();
        append_event(&dir, "mission-one", MissionEvent::PlanApproved).unwrap();
        for id in ["run-a", "run-b"] {
            append_event(
                &dir,
                "mission-one",
                MissionEvent::AttemptAttached {
                    task_id: "inspect".to_string(),
                    run_id: id.to_string(),
                },
            )
            .unwrap();
            append_event(
                &dir,
                "mission-one",
                MissionEvent::AttemptDispatchFailed {
                    task_id: "inspect".to_string(),
                    run_id: id.to_string(),
                    message: "not started".to_string(),
                },
            )
            .unwrap();
        }
        let runtime = fold_runtime(&load_bundle_from_dir(&dir).unwrap());
        let task = runtime.tasks.get("inspect").unwrap();
        assert_eq!(task.attempts, vec!["run-a", "run-b"]);
        assert!(task.active.is_empty());
    }

    #[test]
    fn dispatch_race_does_not_park_but_a_recorded_failure_does() {
        let root = temp_workspace("dispatch-park");
        do_create(root.to_str().unwrap(), sample_input()).unwrap();
        let dir = mission_dir(root.to_str().unwrap(), "mission-one", true).unwrap();
        append_event(&dir, "mission-one", MissionEvent::PlanApproved).unwrap();

        // Nothing recorded yet → a stray dispatch error can't justify a park.
        let bundle = load_bundle_from_dir(&dir).unwrap();
        assert!(!dispatch_failure_should_park(&bundle, "inspect"));

        // The dispatch race: another actor attached this task first, so our
        // dispatch returns "not ready" without recording anything. The mission
        // is running normally and must NOT be parked (regression: it was).
        append_event(
            &dir,
            "mission-one",
            MissionEvent::AttemptAttached {
                task_id: "inspect".to_string(),
                run_id: "run-inspect".to_string(),
            },
        )
        .unwrap();
        let bundle = load_bundle_from_dir(&dir).unwrap();
        assert!(!dispatch_failure_should_park(&bundle, "inspect"));

        // A genuine, recorded dispatch failure for this task DOES park it.
        append_event(
            &dir,
            "mission-one",
            MissionEvent::AttemptDispatchFailed {
                task_id: "inspect".to_string(),
                run_id: "run-inspect".to_string(),
                message: "harness offline".to_string(),
            },
        )
        .unwrap();
        let bundle = load_bundle_from_dir(&dir).unwrap();
        assert!(dispatch_failure_should_park(&bundle, "inspect"));
        // ...but not attributed to a different task than the failure recorded.
        assert!(!dispatch_failure_should_park(&bundle, "implement"));
    }

    #[test]
    fn supervisor_dispatches_one_task_waits_and_never_auto_retries_rejection() {
        let root = temp_workspace("supervisor-decision");
        do_create(root.to_str().unwrap(), sample_input()).unwrap();
        let dir = mission_dir(root.to_str().unwrap(), "mission-one", true).unwrap();
        append_event(&dir, "mission-one", MissionEvent::PlanApproved).unwrap();

        let bundle = load_bundle_from_dir(&dir).unwrap();
        assert_eq!(
            supervisor_decision(&bundle, &fold_runtime(&bundle)).unwrap(),
            SupervisorDecision::Dispatch("inspect".to_string())
        );

        append_event(
            &dir,
            "mission-one",
            MissionEvent::AttemptAttached {
                task_id: "inspect".to_string(),
                run_id: "run-inspect".to_string(),
            },
        )
        .unwrap();
        let bundle = load_bundle_from_dir(&dir).unwrap();
        assert_eq!(
            supervisor_decision(&bundle, &fold_runtime(&bundle)).unwrap(),
            SupervisorDecision::Wait
        );

        append_event(
            &dir,
            "mission-one",
            MissionEvent::AttemptValidationRecorded {
                task_id: "inspect".to_string(),
                run_id: "run-inspect".to_string(),
                accepted: false,
                validation: AgentValidationSummary {
                    status: "unverified".to_string(),
                    ..skipped_validation()
                },
            },
        )
        .unwrap();
        let bundle = load_bundle_from_dir(&dir).unwrap();
        assert!(matches!(
            supervisor_decision(&bundle, &fold_runtime(&bundle)).unwrap(),
            SupervisorDecision::Park(_)
        ));
    }

    #[test]
    fn delegate_settlement_waits_for_operator_review_before_unlocking_dependencies() {
        let root = temp_workspace("delegate-review-gate");
        do_create(root.to_str().unwrap(), sample_input()).unwrap();
        let dir = mission_dir(root.to_str().unwrap(), "mission-one", true).unwrap();
        append_event(&dir, "mission-one", MissionEvent::PlanApproved).unwrap();
        append_event(
            &dir,
            "mission-one",
            MissionEvent::AttemptAttached {
                task_id: "inspect".to_string(),
                run_id: "delegate-inspect".to_string(),
            },
        )
        .unwrap();
        append_event(
            &dir,
            "mission-one",
            MissionEvent::AttemptSettled {
                task_id: "inspect".to_string(),
                run_id: "delegate-inspect".to_string(),
                exit_code: 0,
                signal: None,
            },
        )
        .unwrap();

        let bundle = load_bundle_from_dir(&dir).unwrap();
        let runtime = fold_runtime(&bundle);
        assert!(runtime.tasks["inspect"].active.is_empty());
        assert!(runtime.tasks["inspect"]
            .reviewing
            .contains("delegate-inspect"));
        assert!(!task_is_ready(&bundle, &runtime, "inspect").unwrap());
        assert!(!task_is_ready(&bundle, &runtime, "implement").unwrap());
        assert_eq!(
            supervisor_decision(&bundle, &runtime).unwrap(),
            SupervisorDecision::Wait
        );

        append_event(
            &dir,
            "mission-one",
            MissionEvent::AttemptValidationRecorded {
                task_id: "inspect".to_string(),
                run_id: "delegate-inspect".to_string(),
                accepted: true,
                validation: delegate_review_validation(
                    &PtyExitOutcome {
                        exit_code: 0,
                        signal: None,
                        stop_requested: false,
                    },
                    true,
                    None,
                ),
            },
        )
        .unwrap();
        let accepted = load_bundle_from_dir(&dir).unwrap();
        assert_eq!(
            supervisor_decision(&accepted, &fold_runtime(&accepted)).unwrap(),
            SupervisorDecision::Dispatch("implement".to_string())
        );
    }

    #[test]
    fn supervisor_advances_only_after_acceptance_and_completes() {
        let root = temp_workspace("supervisor-acceptance");
        do_create(root.to_str().unwrap(), sample_input()).unwrap();
        let dir = mission_dir(root.to_str().unwrap(), "mission-one", true).unwrap();
        append_event(&dir, "mission-one", MissionEvent::PlanApproved).unwrap();
        for (task_id, run_id) in [("inspect", "run-inspect"), ("implement", "run-implement")] {
            append_event(
                &dir,
                "mission-one",
                MissionEvent::AttemptAttached {
                    task_id: task_id.to_string(),
                    run_id: run_id.to_string(),
                },
            )
            .unwrap();
            append_event(
                &dir,
                "mission-one",
                MissionEvent::AttemptValidationRecorded {
                    task_id: task_id.to_string(),
                    run_id: run_id.to_string(),
                    accepted: true,
                    validation: skipped_validation(),
                },
            )
            .unwrap();
            let bundle = load_bundle_from_dir(&dir).unwrap();
            let expected = if task_id == "inspect" {
                SupervisorDecision::Dispatch("implement".to_string())
            } else {
                SupervisorDecision::Complete
            };
            assert_eq!(
                supervisor_decision(&bundle, &fold_runtime(&bundle)).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn restart_recovery_decision_never_interrupts_a_live_run() {
        assert_eq!(
            attempt_recovery_decision(true, Some("running")),
            AttemptRecoveryDecision::LeaveLive
        );
        assert_eq!(
            attempt_recovery_decision(false, Some("done")),
            AttemptRecoveryDecision::ValidateTerminal
        );
        assert!(matches!(
            attempt_recovery_decision(false, Some("waiting_for_diff")),
            AttemptRecoveryDecision::Interrupt(reason) if reason.contains("waiting_for_diff")
        ));
        assert!(matches!(
            attempt_recovery_decision(false, None),
            AttemptRecoveryDecision::Interrupt(reason) if reason.contains("before the Harness wrote")
        ));
    }

    #[test]
    fn restart_marks_an_orphan_interrupted_without_replaying_it() {
        let root = temp_workspace("restart-interrupted");
        do_create(root.to_str().unwrap(), sample_input()).unwrap();
        let dir = mission_dir(root.to_str().unwrap(), "mission-one", true).unwrap();
        append_event(&dir, "mission-one", MissionEvent::PlanApproved).unwrap();
        append_event(
            &dir,
            "mission-one",
            MissionEvent::AttemptAttached {
                task_id: "inspect".to_string(),
                run_id: "run-orphaned".to_string(),
            },
        )
        .unwrap();

        let runs_dir = root.join("runs");
        std::fs::create_dir_all(&runs_dir).unwrap();
        assert_eq!(
            reconcile_orphaned_attempts_from_runs_dir(
                &runs_dir,
                root.to_str().unwrap(),
                "mission-one",
                |_| false,
            )
            .unwrap(),
            1
        );
        let bundle = load_bundle_from_dir(&dir).unwrap();
        assert!(matches!(
            bundle.events.last().map(|line| &line.event),
            Some(MissionEvent::AttemptInterrupted { run_id, .. }) if run_id == "run-orphaned"
        ));
        let runtime = fold_runtime(&bundle);
        assert!(runtime.tasks["inspect"].active.is_empty());
        assert!(matches!(
            supervisor_decision(&bundle, &runtime).unwrap(),
            SupervisorDecision::Park(_)
        ));
        assert_eq!(
            reconcile_orphaned_attempts_from_runs_dir(
                &runs_dir,
                root.to_str().unwrap(),
                "mission-one",
                |_| false,
            )
            .unwrap(),
            0,
            "recovery is idempotent once the attempt is no longer active"
        );
    }

    #[test]
    fn restart_recovers_terminal_validation_and_unlocks_the_next_task() {
        let root = temp_workspace("restart-terminal");
        do_create(root.to_str().unwrap(), sample_input()).unwrap();
        let dir = mission_dir(root.to_str().unwrap(), "mission-one", true).unwrap();
        append_event(&dir, "mission-one", MissionEvent::PlanApproved).unwrap();
        append_event(
            &dir,
            "mission-one",
            MissionEvent::AttemptAttached {
                task_id: "inspect".to_string(),
                run_id: "run-finished-before-restart".to_string(),
            },
        )
        .unwrap();
        let runs_dir = root.join("runs");
        write_test_summary(
            &runs_dir,
            &root,
            "run-finished-before-restart",
            "done",
            "skipped",
        );

        assert_eq!(
            reconcile_orphaned_attempts_from_runs_dir(
                &runs_dir,
                root.to_str().unwrap(),
                "mission-one",
                |_| false,
            )
            .unwrap(),
            1
        );
        let bundle = load_bundle_from_dir(&dir).unwrap();
        let runtime = fold_runtime(&bundle);
        assert_eq!(
            runtime.tasks["inspect"].accepted_run_id.as_deref(),
            Some("run-finished-before-restart")
        );
        assert_eq!(
            supervisor_decision(&bundle, &runtime).unwrap(),
            SupervisorDecision::Dispatch("implement".to_string())
        );
    }

    #[test]
    fn approval_snapshot_persists_the_exact_execution_choice() {
        let root = temp_workspace("approval-snapshot");
        let bundle = do_create(root.to_str().unwrap(), sample_input()).unwrap();
        let dir = mission_dir(root.to_str().unwrap(), "mission-one", true).unwrap();
        snapshot_approval(
            &dir,
            &bundle,
            MissionApprovalInput {
                auto_start: false,
                tasks: bundle
                    .tasks
                    .iter()
                    .map(|task| MissionTaskApprovalInput {
                        task_id: task.id.clone(),
                        worker_kind: MissionWorkerKind::Harness,
                        provider: "openai".to_string(),
                        model: "gpt-test".to_string(),
                        require_diff_review: true,
                    })
                    .collect(),
            },
        )
        .unwrap();

        let loaded = load_bundle_from_dir(&dir).unwrap();
        let dispatch = loaded.tasks[0].dispatch.as_ref().unwrap();
        assert_eq!(dispatch.worker_kind, MissionWorkerKind::Harness);
        assert_eq!(dispatch.provider, "openai");
        assert_eq!(dispatch.model, "gpt-test");
        assert!(dispatch.require_diff_review);
        let markdown = std::fs::read_to_string(dir.join("tasks/inspect.md")).unwrap();
        assert!(markdown.contains("dispatch: {"));
    }

    #[test]
    fn validation_accepts_only_terminal_verified_runs() {
        let skipped = skipped_validation();
        assert!(validation_accepts("done", &skipped));
        assert!(!validation_accepts("running", &skipped));
        let mut unverified = skipped;
        unverified.status = "unverified".to_string();
        assert!(!validation_accepts("done", &unverified));
    }

    #[test]
    fn rust_records_harness_validation_as_mission_acceptance() {
        let root = temp_workspace("harness-acceptance");
        do_create(root.to_str().unwrap(), sample_input()).unwrap();
        let dir = mission_dir(root.to_str().unwrap(), "mission-one", true).unwrap();
        append_event(&dir, "mission-one", MissionEvent::PlanApproved).unwrap();
        append_event(
            &dir,
            "mission-one",
            MissionEvent::AttemptAttached {
                task_id: "inspect".to_string(),
                run_id: "run-accepted".to_string(),
            },
        )
        .unwrap();

        let runs_dir = root.join("runs");
        std::fs::create_dir_all(&runs_dir).unwrap();
        let summary = serde_json::json!({
            "id": "run-accepted",
            "path": runs_dir.join("run-accepted.jsonl").to_string_lossy(),
            "source": "klide",
            "title": "Inspect",
            "status": "done",
            "provider": "mock",
            "model": "mock-model",
            "cwd": root.to_string_lossy(),
            "project": "test",
            "gitBranch": null,
            "createdMs": 1,
            "updatedMs": 2,
            "messageCount": 2,
            "inputTokens": 0,
            "outputTokens": 0,
            "filesTouched": 0,
            "validation": {
                "status": "skipped",
                "checks": [],
                "filesChanged": 0,
                "commandsRun": 0,
                "commandsFailed": 0,
                "diffReviews": 0,
                "permissionsApproved": 0,
                "permissionsDenied": 0,
                "warnings": []
            }
        });
        std::fs::write(
            runs_dir.join("run-accepted.summary.json"),
            serde_json::to_string_pretty(&summary).unwrap(),
        )
        .unwrap();

        let bundle = validate_attempt_from_runs_dir(
            &runs_dir,
            root.to_str().unwrap(),
            "mission-one",
            "inspect",
            "run-accepted",
        )
        .unwrap();
        let runtime = fold_runtime(&bundle);
        assert_eq!(
            runtime.tasks["inspect"].accepted_run_id.as_deref(),
            Some("run-accepted")
        );
        assert!(task_is_ready(&bundle, &runtime, "implement").unwrap());
    }
}
