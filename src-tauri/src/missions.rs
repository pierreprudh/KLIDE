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
    AgentContextSnapshot, AgentMode, AgentValidationSummary, StartRunRequest,
};
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
            } => {
                runtime
                    .tasks
                    .entry(task_id.clone())
                    .or_default()
                    .active
                    .remove(run_id);
            }
            MissionEvent::AttemptValidationRecorded {
                task_id,
                run_id,
                accepted,
                ..
            } => {
                let task = runtime.tasks.entry(task_id.clone()).or_default();
                task.active.remove(run_id);
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
    if task_runtime.accepted_run_id.is_some() || !task_runtime.active.is_empty() {
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
    if runtime.tasks.values().any(|task| !task.active.is_empty()) {
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
    if dispatch.worker_kind == MissionWorkerKind::Delegate {
        return Err(format!(
            "Task `{}` routes to a Delegate CLI; durable Delegate dispatch lands in a later slice.",
            task.id
        ));
    }
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

fn validation_accepts(summary_status: &str, validation: &AgentValidationSummary) -> bool {
    summary_status == "done"
        && matches!(validation.status.as_str(), "passed" | "skipped")
        && !validation
            .checks
            .iter()
            .any(|check| check.required && check.status == "failed")
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
    let _guard = state
        .write_gate
        .lock()
        .map_err(|_| "Mission store is unavailable.".to_string())?;
    validate_id(&input.id, "task")?;
    let dir = mission_dir(&workspace_root, &mission_id, true)?;
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
    let now = now_ms();
    let updated = MissionTaskSpec {
        schema_version: MISSION_SCHEMA_VERSION,
        id: input.id.clone(),
        mission_id: mission_id.clone(),
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
        &mission_id,
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
    let (run_id, request) = {
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
        let request = start_request_for(workspace_root, &bundle, &task, &attempt_run_id);
        (attempt_run_id, request)
    };

    let request = match request {
        Ok(request) => request,
        Err(error) => {
            record_dispatch_failure(app, workspace_root, mission_id, task_id, &run_id, &error)?;
            return Err(error);
        }
    };
    if let Err(error) = crate::agent::start_background_run(app.clone(), request).await {
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
                append_lifecycle_event(
                    &dir,
                    mission_id,
                    MissionEvent::MissionParked {
                        reason: format!("Task `{task_id}` could not start: {error}"),
                    },
                )?;
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
    let key = format!("{workspace_root}\0{mission_id}");
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
        let dispatch_was_recorded = matches!(
            bundle.events.last().map(|line| &line.event),
            Some(MissionEvent::AttemptDispatchFailed {
                task_id: failed_task,
                ..
            }) if failed_task == &task_id
        );
        if !dispatch_was_recorded {
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
