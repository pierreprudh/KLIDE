//! Agent access to approved Missions. Uses the same dispatch and validation
//! journal as Mission Control; callers cannot approve, retry, or accept work.
use super::*;
use serde_json::{json, Value};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    List {},
    Dispatch {
        mission_id: String,
        task_id: String,
    },
    Inspect {
        mission_id: String,
        task_id: String,
        run_id: String,
        #[serde(default)]
        timeout_seconds: u64,
    },
    /// Author a Mission from inside a conversation. It is written as a draft
    /// — `dispatch: None` on every task — and only the operator's approval,
    /// answered on the conversation's card, freezes a route and starts it.
    Plan {
        title: String,
        intent: String,
        #[serde(default)]
        tasks: Vec<PlanTaskInput>,
    },
}

/// One task as the model states it: a short id it chose, the prose, and the
/// ids it waits on. Everything the durable spec needs beyond this is a default
/// a draft can carry (Goal mode, medium risk, no routing).
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanTaskInput {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub phase: MissionTaskPhase,
    #[serde(default)]
    pub risk: Option<MissionTaskRisk>,
    #[serde(default)]
    pub writes_files: bool,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
}

/// The most tasks one plan may carry. A Mission is a bounded outcome, not a
/// backlog; past this the model is asked to plan the first slice.
pub const MAX_PLAN_TASKS: usize = 12;

impl PlanTaskInput {
    fn into_create(self) -> CreateMissionTaskInput {
        let acceptance_criteria = if self.acceptance_criteria.iter().any(|c| !c.trim().is_empty()) {
            self.acceptance_criteria
        } else if !self.description.trim().is_empty() {
            vec![self.description.trim().to_string()]
        } else {
            vec![format!("The task outcome satisfies: {}", self.title.trim())]
        };
        CreateMissionTaskInput {
            id: Some(self.id),
            title: self.title,
            body_markdown: self.description,
            phase: self.phase,
            mode: MissionMode::Goal,
            risk: self.risk.unwrap_or(MissionTaskRisk::Medium),
            writes_files: self.writes_files,
            dependencies: self.depends_on,
            acceptance_criteria,
            needs_repo_wide_context: false,
            needs_strong_reasoning: false,
            needs_delegate_cli: false,
            needs_visual_review: false,
        }
    }
}

/// The `plan_mission` Tool: the one way a Run authors a Mission. Separate
/// from `mission_orchestrate` so a conversation can draw the plan it returns
/// by name, and so coordinating approved work keeps its own, smaller schema.
pub fn plan_tool() -> Value {
    json!({
        "name": "plan_mission",
        "description": "Turn the operator's objective into a durable Mission: 3 to 8 concrete tasks with dependencies, written to the workspace for the operator to approve in the conversation. Call it once per objective and never before you have inspected enough to name real files and checks. It never dispatches work: after the operator approves, mission_orchestrate list/dispatch/inspect coordinate the tasks. Task ids are short slugs you choose; dependsOn names them. A task should be one bounded change a single worker can finish and verify.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type":"string", "minLength":1, "maxLength":120, "description":"The Mission in a few words."},
                "intent": {"type":"string", "minLength":1, "description":"The operator's objective, as they stated it."},
                "tasks": {
                    "type":"array", "minItems":1, "maxItems": MAX_PLAN_TASKS,
                    "items": {
                        "type":"object",
                        "properties": {
                            "id": {"type":"string", "minLength":1, "maxLength":40, "description":"A short slug, unique in this plan (e.g. scaffold-tool)."},
                            "title": {"type":"string", "minLength":1, "maxLength":120},
                            "description": {"type":"string", "description":"What to do and where — the files, functions and commands involved."},
                            "phase": {"type":"string", "enum":["Understand","Build","Verify"]},
                            "risk": {"type":"string", "enum":["low","medium","high"]},
                            "writesFiles": {"type":"boolean"},
                            "dependsOn": {"type":"array", "items":{"type":"string"}, "description":"Ids of tasks that must be accepted first."},
                            "acceptanceCriteria": {"type":"array", "items":{"type":"string"}, "description":"How a reviewer knows it is done."}
                        },
                        "required":["id","title","phase"],
                        "additionalProperties":false
                    }
                }
            },
            "required":["title","intent","tasks"],
            "additionalProperties":false
        }
    })
}

pub fn tool() -> Value {
    json!({
        "name": "mission_orchestrate",
        "description": "Coordinate approved Mission tasks. list discovers tasks and exact attempt Run ids. dispatch starts an unattempted ready task using its approved provider/model; repeating dispatch returns the existing attempt, never retries failed work. inspect reads or waits up to 120 seconds for that exact attempt's settlement and validation. Use agent_send for reviewed follow-ups. Only the operator can approve a plan, retry a task, accept Delegate work or integrate changes. Tasks currently share the Mission checkout; checkout evidence is not proof of exclusive ownership.",
        "outputSchema": serde_json::from_str::<Value>(include_str!("../../../schemas/klide-mission-orchestration.schema.json")).expect("valid Mission receipt schema"),
        // No `oneOf` at the top level: Anthropic's API refuses a tool whose
        // input schema unions there, and one refused tool fails the whole
        // request — every Goal run on a direct Anthropic key died on this.
        // The per-action shape is stated in the descriptions and enforced by
        // `Request`'s deserialization, which is where it was enforced anyway.
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type":"string", "enum":["list", "dispatch", "inspect"], "description":"list takes nothing else; dispatch needs missionId and taskId; inspect needs missionId, taskId and runId."},
                "missionId": {"type":"string", "minLength":1, "description":"Required for dispatch and inspect."},
                "taskId": {"type":"string", "minLength":1, "description":"Required for dispatch and inspect."},
                "runId": {"type":"string", "minLength":1, "description":"Required for inspect: the exact attempt to read."},
                "timeoutSeconds": {"type":"integer", "minimum":0, "maximum":120, "description":"inspect only: how long to wait for the attempt to settle."}
            },
            "required":["action"],
            "additionalProperties":false
        }
    })
}

fn scope<'a>(
    snapshot: &'a crate::coordination::CoordinationSnapshot,
    actor: &str,
) -> Result<&'a crate::coordination::CoordinationRunRegistration, String> {
    snapshot
        .runs
        .iter()
        .find(|r| r.registration.run_id == actor)
        .map(|r| &r.registration)
        .ok_or_else(|| "Orchestration requires a registered Run.".into())
}

fn authorized(
    registration: &crate::coordination::CoordinationRunRegistration,
    mission: &str,
) -> bool {
    // A user-created top-level Run coordinates the workspace's approved plans.
    // A spawned worker stays inside its assigned Mission.
    match registration.mission_id.as_deref() {
        Some(own) => own == mission,
        None => registration.parent_run_id.is_none(),
    }
}

pub(super) fn existing_attempt(
    runtime: &FoldedMissionRuntime,
    actor: &str,
    task_id: &str,
) -> Result<Option<String>, String> {
    let task = runtime.tasks.get(task_id).ok_or("Unknown Mission task.")?;
    // The durable attachment is the retry receipt, even after a failed launch.
    if let Some(id) = task.attempts.last() {
        return Ok(Some(id.clone()));
    }
    if mission_is_busy(runtime, Some(actor)) {
        return Err("Another Mission attempt is active or awaiting review.".into());
    }
    Ok(None)
}

fn task_rows(bundle: &DurableMissionBundle, actor: &str) -> Vec<Value> {
    let runtime = fold_runtime(bundle);
    bundle.tasks.iter().map(|task| {
        let state = runtime.tasks.get(&task.id).cloned().unwrap_or_default();
        json!({"taskId":task.id,"title":task.title,"dispatch":task.dispatch,
            "dependencies":task.dependencies,"acceptanceCriteria":task.acceptance_criteria,
            "ready":task_is_ready(bundle,&runtime,&task.id).unwrap_or(false) && state.attempts.is_empty() && existing_attempt(&runtime, actor, &task.id).is_ok(),
            "runIds":state.attempts,"acceptedRunId":state.accepted_run_id})
    }).collect()
}

fn attempt_evidence(
    bundle: &DurableMissionBundle,
    task_id: &str,
    run_id: &str,
) -> Result<Value, String> {
    validate_id(task_id, "task")?;
    validate_run_id(run_id)?;
    let runtime = fold_runtime(bundle);
    let task = runtime.tasks.get(task_id).ok_or("Unknown Mission task.")?;
    if !task.attempts.iter().any(|id| id == run_id) {
        return Err("That Run is not an attempt of this Mission task.".into());
    }
    let mut status = "running";
    let mut validation = None;
    let mut accepted = None;
    let mut failure = None;
    let mut exit_code = None;
    for line in &bundle.events {
        match &line.event {
            MissionEvent::AttemptValidationRecorded {
                task_id: t,
                run_id: r,
                validation: v,
                accepted: a,
            } if t == task_id && r == run_id => {
                status = if *a { "accepted" } else { "rejected" };
                validation = Some(v);
                accepted = Some(*a);
            }
            MissionEvent::AttemptSettled {
                task_id: t,
                run_id: r,
                exit_code: code,
                ..
            } if t == task_id && r == run_id => {
                status = "awaiting_review";
                exit_code = Some(*code);
            }
            MissionEvent::AttemptDispatchFailed {
                task_id: t,
                run_id: r,
                message,
            } if t == task_id && r == run_id => {
                status = "dispatch_failed";
                failure = Some(message);
            }
            MissionEvent::AttemptInterrupted {
                task_id: t,
                run_id: r,
                reason,
            } if t == task_id && r == run_id => {
                status = "interrupted";
                failure = Some(reason);
            }
            _ => {}
        }
    }
    Ok(
        json!({"schemaVersion":1,"action":"inspect","missionId":bundle.mission.id,
        "taskId":task_id,"runId":run_id,"status":status,"settled":status != "running",
        "accepted":accepted,"validation":validation,"exitCode":exit_code,"failure":failure,
        "timedOut":false}),
    )
}

pub async fn execute(
    app: tauri::AppHandle,
    root: String,
    actor: String,
    request: Request,
) -> Result<Value, String> {
    let snapshot = crate::coordination::read_snapshot(
        app.state::<crate::coordination::CoordinationStoreState>()
            .inner(),
        &root,
    )?;
    let registration = scope(&snapshot, &actor)?;
    // Independent conversations normally live in linked worktrees. Preserve
    // a Mission authored there, otherwise discover the owning checkout's
    // Missions, as coordination already does for its shared journal.
    let local = Workspace::new(&root)?;
    let has_local_missions = std::fs::read_dir(local.root().join(".klide/missions"))
        .map(|entries| {
            entries
                .flatten()
                .any(|entry| entry.path().join("mission.md").is_file())
        })
        .unwrap_or(false);
    let root = if has_local_missions {
        local.root().to_string_lossy().to_string()
    } else {
        crate::coordination::effective_workspace(&root)?
            .root()
            .to_string_lossy()
            .to_string()
    };
    let mission_id = match &request {
        Request::List {} | Request::Plan { .. } => None,
        Request::Dispatch { mission_id, .. } | Request::Inspect { mission_id, .. } => {
            Some(mission_id)
        }
    };
    if let Some(mission) = mission_id {
        validate_id(mission, "mission")?;
        if !authorized(registration, mission) {
            return Err("This worker cannot access another Mission.".into());
        }
        if !fold_runtime(&load_bundle(&root, mission)?).approved {
            return Err("The operator must approve this Mission first.".into());
        }
    }
    match request {
        Request::Plan { title, intent, tasks } => {
            // A worker inside a Mission plans nothing: its scope is its task.
            if registration.parent_run_id.is_some() || registration.mission_id.is_some() {
                return Err("Only a top-level Run may plan a Mission.".into());
            }
            if tasks.is_empty() {
                return Err("A Mission needs at least one task.".into());
            }
            if tasks.len() > MAX_PLAN_TASKS {
                return Err(format!(
                    "A Mission carries at most {MAX_PLAN_TASKS} tasks — plan the first slice and keep the rest for a later Mission."
                ));
            }
            let input = CreateMissionInput {
                id: None,
                title,
                intent,
                mode: MissionMode::Goal,
                tasks: tasks.into_iter().map(PlanTaskInput::into_create).collect(),
            };
            // The draft lives beside the Run — in its own checkout, worktree
            // or not — which is where the conversation's card reads and
            // approves it; the coordinator rule above then finds it first.
            let plan_root = local.root().to_string_lossy().to_string();
            let bundle = {
                let state = app.state::<MissionStoreState>();
                let _guard = state
                    .write_gate
                    .lock()
                    .map_err(|_| "Mission store is unavailable.".to_string())?;
                do_create_for_run(&plan_root, input, Some(actor.clone()))?
            };
            Ok(json!({"schemaVersion":1,"action":"plan","missionId":bundle.mission.id,
                "title":bundle.mission.title,"approved":false,
                "tasks":bundle.tasks.iter().map(|t| json!({"taskId":t.id,"title":t.title,
                    "phase":t.phase,"dependencies":t.dependencies})).collect::<Vec<_>>(),
                "next":"The operator approves this plan on the conversation's card; until then nothing runs. Tell them what the plan covers in two or three lines and stop."}))
        }
        Request::List {} => {
            let missions = list_missions(&root)?.into_iter()
                .filter(|b| authorized(registration, &b.mission.id) && fold_runtime(b).approved)
                .map(|b| json!({"missionId":b.mission.id,"title":b.mission.title,"tasks":task_rows(&b, &actor)})).collect::<Vec<_>>();
            Ok(json!({"schemaVersion":1,"action":"list","missions":missions}))
        }
        Request::Dispatch {
            mission_id,
            task_id,
        } => {
            let id = dispatch_task_for(&app, &root, &mission_id, &task_id, Some(&actor)).await?;
            let mut value = attempt_evidence(&load_bundle(&root, &mission_id)?, &task_id, &id)?;
            value["action"] = json!("dispatch");
            Ok(value)
        }
        Request::Inspect {
            mission_id,
            task_id,
            run_id,
            timeout_seconds,
        } => {
            if timeout_seconds > 120 {
                return Err("timeoutSeconds must be between 0 and 120.".into());
            }
            let deadline =
                tokio::time::Instant::now() + std::time::Duration::from_secs(timeout_seconds);
            loop {
                let mut value =
                    attempt_evidence(&load_bundle(&root, &mission_id)?, &task_id, &run_id)?;
                if value["settled"] == true || tokio::time::Instant::now() >= deadline {
                    value["timedOut"] = json!(timeout_seconds > 0 && value["settled"] != true);
                    // Summary is supporting evidence, never the acceptance decision.
                    value["summary"] = app_runs_dir(&app)
                        .ok()
                        .and_then(|dir| read_summary(&dir, &run_id).ok())
                        .map(|s| json!(s))
                        .unwrap_or(Value::Null);
                    let checkout_root = root.clone();
                    value["checkout"] =
                        crate::blocking::run(move || Ok(checkout_evidence(&checkout_root))).await?;
                    return Ok(value);
                }
                tokio::time::sleep(std::time::Duration::from_millis(400)).await;
            }
        }
    }
}

/// A bounded working-tree preview, explicitly distinct from an attempt-owned
/// patch. Include untracked/staged status so a tracked diff cannot imply clean.
fn checkout_evidence(root: &str) -> Value {
    let read = |args: &[&str]| crate::git::git_output(root, args);
    match (
        read(&["rev-parse", "HEAD"]),
        read(&[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--stat",
            "HEAD",
            "--",
        ]),
        read(&["status", "--porcelain=v1"]),
    ) {
        (Ok(head), Ok(diff), Ok(status)) => json!({
            "path":root,"exclusive":false,"baseCommit":head.trim(),
            "diffScope":"working_tree_vs_HEAD","diffFormat":"stat","diff":diff.chars().take(24000).collect::<String>(),
            "diffTruncated":diff.chars().count() > 24000,
            "status":status.chars().take(8000).collect::<String>(),"statusTruncated":status.chars().count() > 8000,
            "note":"Shared checkout diff statistics; includes other work and excludes committed changes and file contents. Inspect the branch and files before integration."
        }),
        (head, diff, status) => json!({"path":root,"exclusive":false,
            "error":head.err().or_else(|| diff.err()).or_else(|| status.err()),
            "note":"Checkout evidence is unavailable; do not infer a clean diff."}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn bundle(events: Vec<MissionEvent>) -> DurableMissionBundle {
        DurableMissionBundle {
            report: None,
            mission: MissionSpec {
                schema_version: 1,
                id: "m1".into(),
                title: "Test".into(),
                intent: "Test".into(),
                mode: MissionMode::Goal,
                task_ids: vec!["t1".into()],
                coordinator_run_id: None,
                created_ms: 0,
                updated_ms: 0,
            },
            tasks: vec![MissionTaskSpec {
                schema_version: 1,
                id: "t1".into(),
                mission_id: "m1".into(),
                title: "Worker".into(),
                body_markdown: String::new(),
                phase: MissionTaskPhase::Build,
                mode: MissionMode::Goal,
                risk: MissionTaskRisk::Low,
                writes_files: true,
                dependencies: vec![],
                acceptance_criteria: vec!["Tests pass".into()],
                needs_repo_wide_context: false,
                needs_strong_reasoning: false,
                needs_delegate_cli: false,
                needs_visual_review: false,
                dispatch: None,
                created_ms: 0,
                updated_ms: 0,
            }],
            events: events
                .into_iter()
                .enumerate()
                .map(|(seq, event)| MissionEventLine {
                    schema_version: 1,
                    mission_id: "m1".into(),
                    seq: seq as u64,
                    ts: 0,
                    event,
                })
                .collect(),
        }
    }
    fn attached(id: &str) -> MissionEvent {
        MissionEvent::AttemptAttached {
            task_id: "t1".into(),
            run_id: id.into(),
        }
    }
    #[test]
    fn plan_request_is_the_plan_action_with_draft_defaults() {
        let request: Request = serde_json::from_value(json!({
            "action":"plan","title":"Ship /mission","intent":"let Kit plan from chat",
            "tasks":[
                {"id":"map","title":"Map the seams","phase":"Understand"},
                {"id":"tool","title":"Add plan_mission","phase":"Build","dependsOn":["map"],"risk":"high","writesFiles":true,
                 "description":"tools.rs + orchestration.rs","acceptanceCriteria":["cargo test passes"]}
            ]
        }))
        .unwrap();
        let Request::Plan { tasks, .. } = request else { panic!("not a plan") };
        let create: Vec<CreateMissionTaskInput> = tasks.into_iter().map(PlanTaskInput::into_create).collect();
        // Every draft task is Goal mode with no route; risk defaults to medium.
        assert!(matches!(create[0].mode, MissionMode::Goal));
        assert!(matches!(create[0].risk, MissionTaskRisk::Medium));
        assert_eq!(create[0].acceptance_criteria, vec!["The task outcome satisfies: Map the seams"]);
        assert_eq!(create[1].id.as_deref(), Some("tool"));
        assert_eq!(create[1].dependencies, vec!["map"]);
        assert_eq!(create[1].body_markdown, "tools.rs + orchestration.rs");
        assert_eq!(create[1].acceptance_criteria, vec!["cargo test passes"]);
        assert!(matches!(create[1].risk, MissionTaskRisk::High));
        // The model cannot smuggle a route or an actor through a task.
        assert!(serde_json::from_value::<Request>(json!({"action":"plan","title":"t","intent":"i",
            "tasks":[{"id":"a","title":"a","phase":"Build","dispatch":{"provider":"x"}}]})).is_err());
    }

    #[test]
    fn plan_tool_schema_has_no_action_and_no_union() {
        let tool = plan_tool();
        assert_eq!(tool["name"], "plan_mission");
        let schema = &tool["inputSchema"];
        assert!(schema.get("oneOf").is_none() && schema.get("anyOf").is_none());
        assert!(schema["properties"].get("action").is_none());
        assert_eq!(schema["properties"]["tasks"]["maxItems"], MAX_PLAN_TASKS);
    }

    #[test]
    fn old_completion_never_satisfies_a_new_attempt() {
        let b = bundle(vec![
            attached("old"),
            MissionEvent::AttemptSettled {
                task_id: "t1".into(),
                run_id: "old".into(),
                exit_code: 0,
                signal: None,
            },
            attached("new"),
        ]);
        assert_eq!(
            attempt_evidence(&b, "t1", "old").unwrap()["status"],
            "awaiting_review"
        );
        assert_eq!(attempt_evidence(&b, "t1", "new").unwrap()["settled"], false);
        assert!(attempt_evidence(&b, "t1", "unrelated").is_err());
        assert!(attempt_evidence(&b, "other-task", "new").is_err());
        let poisoned = bundle(vec![attached("../escape")]);
        assert!(attempt_evidence(&poisoned, "t1", "../escape").is_err());
    }
    #[test]
    fn successful_exit_requires_review_and_validation() {
        let mut b = bundle(vec![
            attached("r1"),
            MissionEvent::AttemptSettled {
                task_id: "t1".into(),
                run_id: "r1".into(),
                exit_code: 0,
                signal: None,
            },
        ]);
        let evidence = attempt_evidence(&b, "t1", "r1").unwrap();
        assert_eq!(evidence["accepted"], Value::Null);
        assert_eq!(evidence["settled"], true);
        b.events.push(MissionEventLine {
            schema_version: 1,
            mission_id: "m1".into(),
            seq: 2,
            ts: 0,
            event: MissionEvent::AttemptValidationRecorded {
                task_id: "t1".into(),
                run_id: "r1".into(),
                accepted: false,
                validation: AgentValidationSummary {
                    status: "failed".into(),
                    checks: vec![],
                    files_changed: 0,
                    commands_run: 1,
                    commands_failed: 1,
                    diff_reviews: 0,
                    permissions_approved: 0,
                    permissions_denied: 0,
                    warnings: vec![],
                },
            },
        });
        let evidence = attempt_evidence(&b, "t1", "r1").unwrap();
        assert_eq!(evidence["status"], "rejected");
        assert_eq!(evidence["validation"]["commandsFailed"], 1);
    }
    #[test]
    fn lost_dispatch_response_and_failed_launch_return_same_attempt() {
        let mut b = bundle(vec![attached("r1")]);
        assert_eq!(
            existing_attempt(&fold_runtime(&b), "coordinator", "t1").unwrap(),
            Some("r1".into())
        );
        b.events.push(MissionEventLine {
            schema_version: 1,
            mission_id: "m1".into(),
            seq: 1,
            ts: 0,
            event: MissionEvent::AttemptDispatchFailed {
                task_id: "t1".into(),
                run_id: "r1".into(),
                message: "offline".into(),
            },
        });
        assert_eq!(
            existing_attempt(&fold_runtime(&b), "coordinator", "t1").unwrap(),
            Some("r1".into())
        );
        assert_eq!(
            attempt_evidence(&b, "t1", "r1").unwrap()["status"],
            "dispatch_failed"
        );
    }
    #[test]
    fn unknown_tasks_and_busy_missions_cannot_launch() {
        let b = bundle(vec![]);
        let mut runtime = fold_runtime(&b);
        assert!(existing_attempt(&runtime, "coordinator", "unknown").is_err());
        runtime.tasks.insert(
            "busy".into(),
            FoldedTaskRuntime {
                active: HashSet::from(["worker".into()]),
                ..Default::default()
            },
        );
        assert!(existing_attempt(&runtime, "coordinator", "t1").is_err());
    }
    #[test]
    fn worker_scope_and_request_fields_cannot_be_forged() {
        use crate::coordination::{
            CoordinationRunRegistration, CoordinationSnapshot, CoordinationWorkerKind,
        };
        let mut actor = CoordinationRunRegistration {
            run_id: "r1".into(),
            worker_kind: CoordinationWorkerKind::Harness,
            parent_run_id: None,
            mission_id: None,
            mission_task_id: None,
            label: None,
        };
        assert!(authorized(&actor, "m1"));
        actor.parent_run_id = Some("parent".into());
        assert!(!authorized(&actor, "m1"));
        actor.mission_id = Some("m1".into());
        assert!(authorized(&actor, "m1"));
        assert!(!authorized(&actor, "m2"));
        assert!(scope(&CoordinationSnapshot::default(), "r1").is_err());
        for args in [
            json!({"action":"list","actor":"other"}),
            json!({"action":"dispatch","missionId":"m1"}),
            json!({"action":"dispatch","missionId":"m1","taskId":"t1","provider":"other"}),
            json!({"action":"inspect","missionId":"m1","taskId":"t1"}),
        ] {
            assert!(serde_json::from_value::<Request>(args).is_err());
        }
    }
    #[test]
    fn native_catalog_limits_orchestration_to_goal() {
        for mode in [AgentMode::Chat, AgentMode::Plan, AgentMode::Goal] {
            let tools = crate::agent::tools::list_tools(&mode);
            assert_eq!(
                tools
                    .iter()
                    .any(|t| t["function"]["name"] == "mission_orchestrate"),
                matches!(mode, AgentMode::Goal)
            );
        }
    }
    #[test]
    fn checkout_evidence_is_statistics_and_reports_unavailable_git() {
        let dir = std::env::temp_dir().join(format!(
            "klide-orchestration-evidence-{}",
            crate::agent::transcripts::run_id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();
        assert!(checkout_evidence(root).get("error").is_some());
        for args in [
            vec!["init"],
            vec!["config", "user.name", "Test"],
            vec!["config", "user.email", "test@example.invalid"],
        ] {
            crate::git::git_output(root, &args).unwrap();
        }
        std::fs::write(dir.join(".env"), "TOKEN=before").unwrap();
        crate::git::git_output(root, &["add", ".env"]).unwrap();
        crate::git::git_output(root, &["commit", "-m", "base"]).unwrap();
        std::fs::write(dir.join(".env"), "TOKEN=never-in-evidence").unwrap();
        std::fs::write(dir.join("new.txt"), "untracked contents").unwrap();
        let evidence = checkout_evidence(root);
        assert_eq!(evidence["exclusive"], false);
        assert_eq!(evidence["diffFormat"], "stat");
        assert!(evidence["status"].as_str().unwrap().contains("new.txt"));
        assert!(!evidence.to_string().contains("never-in-evidence"));
        assert!(!evidence.to_string().contains("untracked contents"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
