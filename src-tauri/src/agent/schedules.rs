//! Durable clock triggers. Execution still enters the ordinary Run host.
//! A claim is synced before admission: ambiguous crash windows fail visibly,
//! never replay automatically. Repeats coalesce missed ticks and never overlap.

use super::{
    transcripts,
    types::{AgentEvent, StartRunRequest},
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager};

// Cancellation and dispatch share this gate, so a successful Cancel cannot
// be followed by a launch that was still being prepared.
static DISPATCH_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const MIN_INTERVAL: i64 = 60_000;
const MAX_SCHEDULES: usize = 100;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExecutionTarget {
    #[default]
    Local,
    Remote {
        machine_id: String,
    },
}

impl ExecutionTarget {
    fn available(&self) -> Result<(), String> {
        match self {
            Self::Local => Ok(()),
            Self::Remote { .. } => {
                Err("Remote machines are not available yet. Choose This Mac.".into())
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Pending,
    Dispatching,
    Running,
    Completed,
    Failed,
    Paused,
    Cancelled,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Schedule {
    id: String,
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    name: String,
    request: StartRunRequest,
    due_at: i64,
    interval_ms: Option<i64>,
    status: Status,
    from_seq: usize,
    error: Option<String>,
    #[serde(default)]
    history: Vec<ScheduledRun>,
    #[serde(default)]
    run_now: bool,
    #[serde(default)]
    target: ExecutionTarget,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRun {
    run_id: String,
    scheduled_at: i64,
    started_at: i64,
    finished_at: Option<i64>,
    status: Status,
    error: Option<String>,
    #[serde(default)]
    target: ExecutionTarget,
    #[serde(default)]
    runs_dir: Option<PathBuf>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleInfo {
    id: String,
    revision: u64,
    name: String,
    run_id: Option<String>,
    active_run_id: Option<String>,
    text: String,
    provider: String,
    model: String,
    mode: super::types::AgentMode,
    workspace_root: Option<String>,
    due_at: i64,
    interval_ms: Option<i64>,
    status: Status,
    error: Option<String>,
    target: ExecutionTarget,
}

impl Schedule {
    fn active(&self) -> Option<&ScheduledRun> {
        self.history
            .last()
            .filter(|r| matches!(r.status, Status::Running | Status::Dispatching))
    }

    fn info(&self) -> ScheduleInfo {
        ScheduleInfo {
            id: self.id.clone(),
            revision: self.revision,
            name: if self.name.is_empty() {
                self.request.initial_text.chars().take(80).collect()
            } else {
                self.name.clone()
            },
            run_id: self.history.last().map(|r| r.run_id.clone()),
            active_run_id: self.active().map(|r| r.run_id.clone()),
            text: self.request.initial_text.clone(),
            due_at: if self.run_now {
                self.due_at.min(transcripts::now_ms())
            } else {
                self.due_at
            },
            provider: self.request.provider.clone(),
            model: self.request.model.clone(),
            mode: self.request.mode.clone(),
            workspace_root: self.request.workspace_root.clone(),
            interval_ms: self.interval_ms,
            status: self.status.clone(),
            error: self.error.clone(),
            target: self.target.clone(),
        }
    }
}

// Preserve an occurrence launched by the original conversation-bound version.
// Future occurrences always get fresh ids, independent of that conversation.
fn decode(body: &str) -> Result<Schedule, String> {
    let mut s: Schedule = serde_json::from_str(body).map_err(|e| e.to_string())?;
    if s.history.is_empty() && matches!(s.status, Status::Running | Status::Dispatching) {
        if let Some(id) = s.request.run_id.clone() {
            s.history.push(ScheduledRun {
                run_id: id,
                scheduled_at: s.due_at,
                started_at: s.due_at,
                finished_at: None,
                status: s.status.clone(),
                error: None,
                target: s.target.clone(),
                runs_dir: None,
            });
        }
    }
    Ok(s)
}

fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("schedules.sqlite3"))
        .map_err(|e| e.to_string())
}

fn open(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    crate::durable::set_private(path);
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    conn.execute_batch(
        "PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, body TEXT NOT NULL);",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn list(path: &Path) -> Result<Vec<Schedule>, String> {
    let conn = open(path)?;
    let mut stmt = conn
        .prepare("SELECT body FROM schedules ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|r| decode(&r.map_err(|e| e.to_string())?))
        .collect()
}

fn update(
    path: &Path,
    id: &str,
    change: impl FnOnce(&mut Schedule) -> Result<(), String>,
) -> Result<Schedule, String> {
    let mut conn = open(path)?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let body: String = tx
        .query_row("SELECT body FROM schedules WHERE id=?1", [id], |r| r.get(0))
        .map_err(|_| "Schedule not found".to_string())?;
    let mut schedule = decode(&body)?;
    change(&mut schedule)?;
    schedule.revision = schedule.revision.saturating_add(1);
    tx.execute(
        "UPDATE schedules SET body=?2 WHERE id=?1",
        params![
            id,
            serde_json::to_string(&schedule).map_err(|e| e.to_string())?
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(schedule)
}

fn prepare_request(
    mut request: StartRunRequest,
    due_at: i64,
    interval_ms: Option<i64>,
    now: i64,
) -> Result<StartRunRequest, String> {
    if request.initial_text.trim().is_empty() {
        return Err("Write a message to schedule".into());
    }
    if due_at <= now {
        return Err("Choose a future time".into());
    }
    if interval_ms.is_some_and(|ms| ms < MIN_INTERVAL) {
        return Err("Repeats must be at least one minute apart".into());
    }
    if request.parent_id.is_some()
        || request.mission_id.is_some()
        || request.mission_task_id.is_some()
        || request.side_question_of.is_some()
    {
        return Err("Schedule a standalone conversation".into());
    }
    let root = request
        .workspace_root
        .as_deref()
        .ok_or("Choose a workspace before scheduling")?;
    crate::workspace::Workspace::new(root)?;
    // A saved trigger cannot preserve temporary command authority or a CLI's
    // stale resume pointer. The Run reads its own latest transcript/session.
    request.auto_approve_commands = None;
    request.command_allowlist.clear();
    request.delegate_session = None;
    request.retry = false;
    request.naming = None;
    request.run_id = None;
    request.conversation_history = None;
    Ok(request)
}

#[cfg(test)]
fn create(
    path: &Path,
    request: StartRunRequest,
    name: String,
    due_at: i64,
    interval_ms: Option<i64>,
    now: i64,
) -> Result<Schedule, String> {
    create_at_target(
        path,
        request,
        name,
        due_at,
        interval_ms,
        now,
        ExecutionTarget::Local,
    )
}

fn create_at_target(
    path: &Path,
    request: StartRunRequest,
    name: String,
    due_at: i64,
    interval_ms: Option<i64>,
    now: i64,
    target: ExecutionTarget,
) -> Result<Schedule, String> {
    target.available()?;
    let request = prepare_request(request, due_at, interval_ms, now)?;
    let schedule = Schedule {
        id: transcripts::run_id(),
        revision: 0,
        name,
        request,
        due_at,
        interval_ms,
        status: Status::Pending,
        from_seq: 0,
        error: None,
        history: Vec::new(),
        run_now: false,
        target,
    };
    let mut conn = open(path)?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let count: i64 = tx
        .query_row("SELECT count(*) FROM schedules", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if count >= MAX_SCHEDULES as i64 {
        return Err("Remove an old schedule before adding another (limit 100)".into());
    }
    tx.execute(
        "INSERT INTO schedules (id, body) VALUES (?1, ?2)",
        params![
            schedule.id,
            serde_json::to_string(&schedule).map_err(|e| e.to_string())?
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(schedule)
}

fn next_due(due: i64, interval: i64, now: i64) -> Option<i64> {
    if due > now {
        return Some(due);
    }
    let missed = now.saturating_sub(due).max(0) / interval;
    due.checked_add(missed.checked_add(1)?.checked_mul(interval)?)
}

fn claim(path: &Path, id: &str, from_seq: usize, now: i64) -> Result<Schedule, String> {
    update(path, id, |s| {
        if s.status != Status::Pending || s.due_at > now && !s.run_now || s.active().is_some() {
            return Err("Schedule changed before dispatch".into());
        }
        s.status = Status::Dispatching;
        s.from_seq = from_seq;
        s.history.push(ScheduledRun {
            run_id: format!("{}-occurrence-{}", s.id, s.history.len() + 1),
            scheduled_at: if s.run_now { now } else { s.due_at },
            started_at: now,
            finished_at: None,
            status: Status::Dispatching,
            error: None,
            target: s.target.clone(),
            runs_dir: None,
        });
        s.run_now = false;
        Ok(())
    })
}

fn recovered_outcome(events: &[AgentEvent], from: usize, ambiguous: bool) -> Result<(), String> {
    if ambiguous {
        return Err("Dispatch confirmation was interrupted. Review the conversation before retrying; work may have started.".into());
    }
    // Take the first terminal event of the admitted turn, not the latest
    // reply: a user may already have continued this conversation.
    let mut started = false;
    for event in events.iter().skip(from) {
        match event {
            AgentEvent::RunStarted { .. } => {
                if started {
                    return Err("Scheduled turn was interrupted before a later turn began. Review the conversation before retrying.".into());
                }
                started = true;
            }
            AgentEvent::RunResult { result, .. } => {
                let status = result
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                return if status == "done" {
                    Ok(())
                } else {
                    Err(format!("Run ended: {status}"))
                };
            }
            AgentEvent::RunError { error, .. } => return Err(error.message.clone()),
            _ => {}
        }
    }
    Err(
        "Dispatch interrupted. Review the conversation before retrying; work may have started."
            .into(),
    )
}

fn settle(schedule: &mut Schedule, result: Result<(), String>, now: i64) {
    match result {
        Err(error) => {
            schedule.status = Status::Failed;
            schedule.error = Some(error);
        }
        Ok(()) => {
            schedule.error = None;
            if let Some(interval) = schedule.interval_ms {
                if let Some(due) = next_due(schedule.due_at, interval, now) {
                    schedule.due_at = due;
                    schedule.status = Status::Pending;
                } else {
                    schedule.status = Status::Failed;
                    schedule.error = Some("Repeat time is out of range".into());
                }
            } else {
                schedule.status = Status::Completed;
            }
        }
    }
}

fn finish_occurrence(schedule: &mut Schedule, result: Result<(), String>, now: i64) {
    if let Some(run) = schedule.history.last_mut() {
        run.finished_at = Some(now);
        run.status = if result.is_ok() {
            Status::Completed
        } else {
            Status::Failed
        };
        run.error = result.as_ref().err().cloned();
    }
    if matches!(schedule.status, Status::Running | Status::Dispatching) {
        settle(schedule, result, now);
    }
}

#[tauri::command]
pub async fn agent_schedule_history(
    app: tauri::AppHandle,
    id: String,
) -> Result<Vec<ScheduledRun>, String> {
    let path = db_path(&app)?;
    crate::blocking::run(move || {
        list(&path)?
            .into_iter()
            .find(|s| s.id == id)
            .map(|s| s.history)
            .ok_or("Schedule not found".into())
    })
    .await
}

fn changed(app: &tauri::AppHandle, schedule: &Schedule) {
    let _ = app.emit("schedule:changed", schedule.info());
}

#[tauri::command]
pub async fn agent_schedule_create(
    app: tauri::AppHandle,
    request: StartRunRequest,
    name: Option<String>,
    due_at: i64,
    interval_ms: Option<i64>,
    target: Option<ExecutionTarget>,
) -> Result<ScheduleInfo, String> {
    let target = target.unwrap_or_default();
    target.available()?;
    let checked = request.clone();
    crate::blocking::run(move || {
        prepare_request(checked, due_at, interval_ms, transcripts::now_ms())
    })
    .await?;
    crate::scheduled_service::ensure_for_app(&app).await?;
    let path = db_path(&app)?;
    let schedule = crate::blocking::run(move || {
        create_at_target(
            &path,
            request,
            name.unwrap_or_default(),
            due_at,
            interval_ms,
            transcripts::now_ms(),
            target,
        )
    })
    .await?;
    changed(&app, &schedule);
    Ok(schedule.info())
}

#[tauri::command]
pub async fn agent_schedule_update(
    app: tauri::AppHandle,
    id: String,
    name: String,
    request: StartRunRequest,
    due_at: i64,
    interval_ms: Option<i64>,
    target: Option<ExecutionTarget>,
) -> Result<ScheduleInfo, String> {
    let target = target.unwrap_or_default();
    target.available()?;
    crate::scheduled_service::ensure_for_app(&app).await?;
    let _gate = DISPATCH_GATE.lock().await;
    let path = db_path(&app)?;
    let _lease = dispatch_lease(path.parent().unwrap().to_path_buf()).await?;
    let schedule = crate::blocking::run(move || {
        let request = prepare_request(request, due_at, interval_ms, transcripts::now_ms())?;
        update(&path, &id, |s| {
            if s.active().is_some() {
                return Err("Wait for or stop the active Run before editing".into());
            }
            s.name = name;
            s.target = target;
            s.request = request;
            s.due_at = due_at;
            s.interval_ms = interval_ms;
            s.status = Status::Pending;
            s.error = None;
            s.run_now = false;
            Ok(())
        })
    })
    .await?;
    changed(&app, &schedule);
    Ok(schedule.info())
}

#[tauri::command]
pub async fn agent_schedule_list(
    app: tauri::AppHandle,
    run_id: Option<String>,
) -> Result<Vec<ScheduleInfo>, String> {
    let path = db_path(&app)?;
    crate::blocking::run(move || {
        Ok(list(&path)?
            .iter()
            .filter(|s| {
                run_id
                    .as_ref()
                    .is_none_or(|id| s.history.iter().any(|run| &run.run_id == id))
            })
            .map(Schedule::info)
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn agent_schedule_action(
    app: tauri::AppHandle,
    id: String,
    action: String,
) -> Result<(), String> {
    if matches!(action.as_str(), "resume" | "run_now") {
        crate::scheduled_service::ensure_for_app(&app).await?;
    }
    let _gate = DISPATCH_GATE.lock().await;
    let path = db_path(&app)?;
    let _lease = dispatch_lease(path.parent().unwrap().to_path_buf()).await?;
    if action == "remove" {
        let removed = crate::blocking::run(move || {
            // Active occurrences must be stopped through the normal Run door.
            let removed = update(&path, &id, |s| {
                if s.active().is_some() {
                    Err("Stop the active Run before removing its schedule".into())
                } else {
                    Ok(())
                }
            })?;
            open(&path)?
                .execute("DELETE FROM schedules WHERE id=?1", [id])
                .map_err(|e| e.to_string())?;
            Ok(removed)
        })
        .await?;
        let _ = app.emit("schedule:removed", removed.info());
        return Ok(());
    }
    let schedule = crate::blocking::run(move || {
        update(&path, &id, |s| {
            match action.as_str() {
                "cancel" => {
                    s.status = Status::Cancelled;
                    s.error = None;
                }
                "pause"
                    if matches!(
                        s.status,
                        Status::Pending | Status::Running | Status::Dispatching
                    ) =>
                {
                    s.status = Status::Paused
                }
                "resume" | "run_now" if s.active().is_none() => {
                    s.status = Status::Pending;
                    s.error = None;
                    // Resume is explicit retry authority; do not backfill missed runs.
                    s.run_now = true;
                }
                _ => return Err("This schedule cannot perform that action".into()),
            }
            Ok(())
        })
    })
    .await?;
    changed(&app, &schedule);
    Ok(())
}

async fn dispatch_lease(data: PathBuf) -> Result<crate::process_lock::Lease, String> {
    crate::blocking::run(move || {
        crate::process_lock::exclusive(&data.join("schedule-dispatch.lock"))
    })
    .await
}

pub(crate) fn has_active(data: &Path) -> Result<bool, String> {
    let path = data.join("schedules.sqlite3");
    if !path.exists() {
        return Ok(false);
    }
    Ok(list(&path)?.iter().any(|s| s.active().is_some()))
}

#[cfg(unix)]
async fn owner_status(
    data: PathBuf,
    host: std::sync::Arc<super::daemon::RunHost>,
    target: ExecutionTarget,
    id: String,
) -> Result<Option<String>, String> {
    target.available()?;
    if let Some(status) = host.status(&id).0 {
        return Ok(Some(status));
    }
    // A legacy occurrence may still belong to the original background host.
    crate::blocking::run(move || {
        for dir in crate::pty_client::chat_host_dirs(&data).into_iter().take(2) {
            match crate::pty_client::request(
                &dir,
                &crate::pty_wire::Request::ChatStatus { run_id: id.clone() },
            ) {
                Ok(crate::pty_wire::Response::ChatStatus {
                    status: Some(status),
                    ..
                }) => return Ok(Some(status)),
                Ok(crate::pty_wire::Response::ChatStatus { status: None, .. }) => {}
                Err(error) if error.starts_with("connect:") => {}
                Err(error) => return Err(error),
                _ => return Err("Cannot determine the owner of this scheduled Run".into()),
            }
        }
        Ok(None)
    })
    .await
}

#[cfg(unix)]
async fn tick_service(
    data: &Path,
    host: &std::sync::Arc<super::daemon::RunHost>,
) -> Result<(), String> {
    let path = data.join("schedules.sqlite3");
    let p = path.clone();
    let ids =
        crate::blocking::run(move || Ok(list(&p)?.into_iter().map(|s| s.id).collect::<Vec<_>>()))
            .await?;
    for id in ids {
        let _gate = DISPATCH_GATE.lock().await;
        let _cross_process = dispatch_lease(data.to_path_buf()).await?;
        let p = path.clone();
        // Controls may have changed/deleted it while this tick waited.
        let schedule =
            crate::blocking::run(move || Ok(list(&p)?.into_iter().find(|s| s.id == id))).await?;
        let Some(schedule) = schedule else { continue };
        if let Some(active) = schedule.active() {
            let id = active.run_id.clone();
            if owner_status(
                data.to_path_buf(),
                host.clone(),
                active.target.clone(),
                id.clone(),
            )
            .await?
            .is_some()
            {
                continue;
            }
            let runs = match active.runs_dir.clone() {
                Some(path) => path,
                None => {
                    let data = data.to_path_buf();
                    crate::blocking::run(move || crate::storage::runs_dir_for_data(&data)).await?
                }
            };
            let from = schedule.from_seq;
            let ambiguous = active.status == Status::Dispatching;
            let p = path.clone();
            crate::blocking::run(move || {
                let events = if transcripts::transcript_path(&runs, &id).exists() {
                    transcripts::read_events(&runs, &id)?
                } else {
                    Vec::new()
                };
                let outcome = recovered_outcome(&events, from, ambiguous);
                update(&p, &schedule.id, |s| {
                    finish_occurrence(s, outcome, transcripts::now_ms());
                    Ok(())
                })?;
                Ok(())
            })
            .await?;
        } else if schedule.status == Status::Pending
            && (schedule.run_now || schedule.due_at <= transcripts::now_ms())
        {
            let data = data.to_path_buf();
            let _storage_lease = crate::blocking::run({
                let data = data.clone();
                move || crate::process_lock::exclusive(&data.join("run-storage.lock"))
            })
            .await?;
            let p = path.clone();
            let claimed = crate::blocking::run(move || {
                let runs = crate::storage::runs_dir_for_data(&data)?;
                let mut claimed = claim(&p, &schedule.id, 0, transcripts::now_ms())?;
                claimed = update(&p, &claimed.id, |s| {
                    s.history.last_mut().unwrap().runs_dir = Some(runs);
                    Ok(())
                })?;
                Ok(claimed)
            })
            .await?;
            let mut request = claimed.request.clone();
            request.run_id = claimed.history.last().map(|r| r.run_id.clone());
            request.conversation_history = None;
            request.delegate_session = None;
            let runs = claimed.history.last().unwrap().runs_dir.clone().unwrap();
            let result = match claimed.target.available() {
                Ok(()) => host.start_scheduled(request, runs).await,
                Err(error) => Err(error),
            };
            let p = path.clone();
            crate::blocking::run(move || {
                update(&p, &claimed.id, |s| {
                    match result {
                        Ok(from) => {
                            s.status = Status::Running;
                            s.from_seq = from as usize;
                            if let Some(run) = s.history.last_mut() {
                                run.status = Status::Running;
                            }
                        }
                        Err(error) => finish_occurrence(s, Err(error), transcripts::now_ms()),
                    }
                    Ok(())
                })?;
                Ok(())
            })
            .await?;
        }
    }
    Ok(())
}

#[cfg(unix)]
pub(crate) fn start_service(data: PathBuf, host: std::sync::Arc<super::daemon::RunHost>) {
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(error) = tick_service(&data, &host).await {
                eprintln!("klide scheduled service: {error}");
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    });
}

/// The desktop only observes durable state; it never launches occurrences.
/// This also restores notifications for work done while every UI was closed.
pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let Ok(data) = app.path().app_data_dir() else {
            return;
        };
        let mut previous = std::collections::HashMap::<String, String>::new();
        let mut last_ensure = std::time::Instant::now() - std::time::Duration::from_secs(30);
        loop {
            let p = data.join("schedules.sqlite3");
            match crate::blocking::run(move || list(&p)).await {
                Ok(rows) => {
                    if !rows.is_empty() && last_ensure.elapsed().as_secs() >= 30 {
                        last_ensure = std::time::Instant::now();
                        let info = match crate::scheduled_service::ensure_for_app(&app).await {
                            Ok(info) => info,
                            Err(error) => {
                                let d = data.clone();
                                let info = crate::blocking::run(move || {
                                    Ok(crate::scheduled_service::status(&d))
                                })
                                .await;
                                let Ok(mut info) = info else { continue };
                                info.error = Some(error);
                                info
                            }
                        };
                        let _ = app.emit("schedule:service", info);
                    }
                    let mut current = std::collections::HashMap::new();
                    for row in rows {
                        let json = serde_json::to_string(&row.info()).unwrap_or_default();
                        if previous.get(&row.id) != Some(&json) {
                            changed(&app, &row);
                        }
                        current.insert(row.id.clone(), json);
                    }
                    for (id, body) in &previous {
                        if !current.contains_key(id) {
                            if let Ok(info) = serde_json::from_str::<serde_json::Value>(body) {
                                let _ = app.emit("schedule:removed", info);
                            }
                        }
                    }
                    previous = current;
                }
                Err(error) => eprintln!("klide: cannot observe schedules: {error}"),
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (PathBuf, StartRunRequest) {
        static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "klide-schedule-{}-{}",
            transcripts::run_id(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let request = serde_json::from_value(serde_json::json!({
            "runId": "conversation", "workspaceRoot": dir, "mode": "plan",
            "provider": "ollama", "model": "test", "initialText": "Inspect changes", "autoApproveCommands": true
        })).unwrap();
        (dir.join("schedules.sqlite3"), request)
    }

    #[test]
    fn saved_trigger_survives_reopen_without_temporary_trust() {
        let (path, request) = setup();
        create(
            &path,
            request,
            String::new(),
            2000,
            Some(MIN_INTERVAL),
            1000,
        )
        .unwrap();
        let saved = list(&path).unwrap().pop().unwrap();
        assert_eq!(saved.status, Status::Pending);
        assert_eq!(saved.request.auto_approve_commands, None);
        assert_eq!(saved.due_at, 2000);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn due_claim_is_atomic_and_never_claimed_twice() {
        let (path, request) = setup();
        let saved = create(&path, request, String::new(), 2000, None, 1000).unwrap();
        let attempts: Vec<_> = (0..2)
            .map(|_| {
                let path = path.clone();
                let id = saved.id.clone();
                std::thread::spawn(move || claim(&path, &id, 7, 2000).is_ok())
            })
            .collect();
        assert_eq!(
            attempts
                .into_iter()
                .map(|attempt| attempt.join().unwrap())
                .filter(|succeeded| *succeeded)
                .count(),
            1
        );
        assert_eq!(list(&path).unwrap()[0].status, Status::Dispatching);
        assert_eq!(list(&path).unwrap()[0].from_seq, 7);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn repeats_skip_backlog_and_failures_stop_repeating() {
        let (path, request) = setup();
        let mut s = create(
            &path,
            request,
            String::new(),
            2000,
            Some(MIN_INTERVAL),
            1000,
        )
        .unwrap();
        settle(&mut s, Ok(()), 182_001);
        assert_eq!(s.due_at, 242_000);
        assert_eq!(s.status, Status::Pending);
        settle(&mut s, Err("interrupted".into()), 250_000);
        assert_eq!(s.status, Status::Failed);
        assert_eq!(s.error.as_deref(), Some("interrupted"));
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn invalid_time_and_nested_runs_are_rejected() {
        let (path, mut request) = setup();
        assert!(create(&path, request.clone(), String::new(), 1000, None, 1000).is_err());
        assert!(create(&path, request.clone(), String::new(), 2000, Some(0), 1000).is_err());
        request.parent_id = Some("parent".into());
        assert!(create(&path, request, String::new(), 2000, None, 1000).is_err());
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn cancelled_and_paused_schedules_cannot_be_claimed_from_a_stale_snapshot() {
        let (path, request) = setup();
        let saved = create(&path, request, String::new(), 2000, None, 1000).unwrap();
        assert!(claim(&path, &saved.id, 0, 1999).is_err());
        for status in [Status::Paused, Status::Cancelled] {
            update(&path, &saved.id, |s| {
                s.status = status;
                Ok(())
            })
            .unwrap();
            assert!(claim(&path, &saved.id, 0, 3000).is_err());
        }
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn recovery_uses_the_admitted_turn_and_never_replays_an_uncertain_claim() {
        let done = |status| AgentEvent::RunResult {
            run_id: "conversation".into(),
            result: serde_json::json!({"status": status}),
            ts: 1,
        };
        let events = vec![done("done"), done("cancelled"), done("done")];
        assert!(recovered_outcome(&events, 1, false)
            .unwrap_err()
            .contains("cancelled"));
        assert!(recovered_outcome(&events, 2, false).is_ok());
        assert!(recovered_outcome(&events, 2, true)
            .unwrap_err()
            .contains("confirmation"));
        assert!(recovered_outcome(&[], 0, false)
            .unwrap_err()
            .contains("interrupted"));
        let started = || AgentEvent::RunStarted {
            run_id: "conversation".into(),
            cwd: None,
            mode: super::super::types::AgentMode::Plan,
            provider: "ollama".into(),
            model: "test".into(),
            ts: 0,
        };
        let events = vec![started(), started(), done("done")];
        assert!(recovered_outcome(&events, 0, false)
            .unwrap_err()
            .contains("interrupted"));
        assert!(recovered_outcome(&events, 1, false).is_ok());
    }

    #[test]
    fn each_occurrence_has_a_fresh_run_and_keeps_its_result_after_reopening() {
        let (path, request) = setup();
        let saved = create(
            &path,
            request,
            "Review".into(),
            2000,
            Some(MIN_INTERVAL),
            1000,
        )
        .unwrap();
        assert!(saved.request.run_id.is_none());
        assert!(saved.request.conversation_history.is_none());
        let first = claim(&path, &saved.id, 0, 2000).unwrap();
        assert_ne!(first.history[0].run_id, "conversation");
        update(&path, &saved.id, |s| {
            finish_occurrence(s, Ok(()), 2500);
            Ok(())
        })
        .unwrap();
        let second = claim(&path, &saved.id, 0, 62_000).unwrap();
        assert_ne!(second.history[0].run_id, second.history[1].run_id);
        assert_eq!(second.history[0].status, Status::Completed);
        assert_eq!(second.history[0].finished_at, Some(2500));
        assert!(second.active().is_some());
        let restored = list(&path).unwrap().pop().unwrap();
        assert_eq!(restored.history.len(), 2);
        assert_eq!(restored.history[1].status, Status::Dispatching);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn cancellation_keeps_recording_the_active_occurrence_without_repeating_it() {
        let (path, request) = setup();
        let saved = create(
            &path,
            request,
            "Review".into(),
            2000,
            Some(MIN_INTERVAL),
            1000,
        )
        .unwrap();
        claim(&path, &saved.id, 0, 2000).unwrap();
        let stopped = update(&path, &saved.id, |s| {
            s.status = Status::Cancelled;
            finish_occurrence(s, Ok(()), 3000);
            Ok(())
        })
        .unwrap();
        assert_eq!(stopped.status, Status::Cancelled);
        assert_eq!(stopped.history[0].status, Status::Completed);
        assert!(stopped.active().is_none());
        assert!(claim(&path, &saved.id, 0, 100_000).is_err());
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn legacy_in_flight_schedule_keeps_its_original_run_for_recovery() {
        let (path, mut request) = setup();
        request.run_id = Some("legacy-conversation".into());
        let legacy = serde_json::json!({"id":"old", "request":request, "dueAt":2000,
            "intervalMs":null,"status":"running","fromSeq":7,"error":null});
        let migrated = decode(&legacy.to_string()).unwrap();
        assert_eq!(migrated.active().unwrap().run_id, "legacy-conversation");
        assert_eq!(migrated.from_seq, 7);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn manual_occurrence_keeps_a_future_repeat_due_and_refuses_overlap() {
        let (path, request) = setup();
        let saved = create(
            &path,
            request,
            "Review".into(),
            100_000,
            Some(MIN_INTERVAL),
            1000,
        )
        .unwrap();
        update(&path, &saved.id, |s| {
            s.run_now = true;
            Ok(())
        })
        .unwrap();
        let manual = claim(&path, &saved.id, 0, 2000).unwrap();
        assert_eq!(manual.history[0].scheduled_at, 2000);
        assert_eq!(manual.due_at, 100_000);
        assert!(claim(&path, &saved.id, 0, 100_001).is_err());
        let completed = update(&path, &saved.id, |s| {
            finish_occurrence(s, Ok(()), 3000);
            Ok(())
        })
        .unwrap();
        assert_eq!(completed.due_at, 100_000);
        assert_eq!(completed.status, Status::Pending);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn local_target_migrates_by_default_and_remote_is_never_a_local_fallback() {
        assert!(ExecutionTarget::Local.available().is_ok());
        assert!(ExecutionTarget::Remote {
            machine_id: "future-vps".into()
        }
        .available()
        .unwrap_err()
        .contains("not available"));
        let (path, request) = setup();
        let schedule = create(&path, request, "Local".into(), 2000, None, 1000).unwrap();
        assert_eq!(schedule.target, ExecutionTarget::Local);
        let claimed = claim(&path, &schedule.id, 0, 2000).unwrap();
        assert_eq!(claimed.history[0].target, ExecutionTarget::Local);
        assert!(claimed.revision > schedule.revision);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
