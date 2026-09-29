//! GUI-side proxy for durable subscription conversations. Socket disconnects
//! detach observers; only an explicit Stop cancels the daemon's run.
use super::*;
use crate::pty_wire::{ChatControl, Request, Response};
use std::io::BufRead;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

pub(super) fn eligible(request: &StartRunRequest) -> bool {
    crate::providers::is_subscription_provider(&request.provider)
        && request.parent_id.is_none()
        && request.mission_id.is_none()
        && request.mission_task_id.is_none()
}

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

static WATCHED: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
fn watched() -> &'static Mutex<HashMap<String, u64>> {
    WATCHED.get_or_init(Default::default)
}
static NEXT_WATCH: AtomicU64 = AtomicU64::new(1);

fn query_status(dir: &Path, id: &str) -> Result<(Option<String>, u64), String> {
    match crate::pty_client::request(dir, &Request::ChatStatus { run_id: id.into() }) {
        Ok(Response::ChatStatus { status, from_seq }) => Ok((status, from_seq)),
        // No daemon means no remote owner. Never start one merely to ask.
        Err(e) if e.starts_with("connect:") => Ok((None, 0)),
        Ok(Response::Err { message }) if message.starts_with("bad request:") => Ok((None, 0)),
        Ok(Response::Err { message }) => Err(message),
        Err(e) => Err(e),
        _ => Err("Background host does not support chat runs. Finish existing terminals and restart the background host.".into()),
    }
}

fn owner(data_dir: &Path, id: &str) -> Result<Option<(PathBuf, String, u64)>, String> {
    find_owner(data_dir, |dir| query_status(dir, id))
}

fn find_owner(
    data_dir: &Path,
    query: impl Fn(&Path) -> Result<(Option<String>, u64), String>,
) -> Result<Option<(PathBuf, String, u64)>, String> {
    let mut failure = None;
    for dir in crate::pty_client::chat_host_dirs(data_dir) {
        match query(&dir) {
            Ok((Some(status), from)) => return Ok(Some((dir, status, from))),
            Ok((None, _)) => {}
            Err(error) => {
                failure.get_or_insert(error);
            }
        }
    }
    match failure {
        Some(error) => Err(error),
        None => Ok(None),
    }
}

pub(super) async fn status(app: &tauri::AppHandle, id: &str) -> Result<Option<String>, String> {
    Ok(state(app, id).await?.status)
}

pub(super) async fn state(app: &tauri::AppHandle, id: &str) -> Result<RunState, String> {
    #[cfg(not(unix))]
    {
        let _ = (app, id);
        return Ok(RunState {
            status: None,
            from_seq: None,
        });
    }
    #[cfg(unix)]
    {
        let app = app.clone();
        let id = id.to_string();
        crate::blocking::run(move || match owner(&data_dir(&app)?, &id)? {
            Some((dir, status, from)) => {
                ensure_watch(app, id, dir, None, None, from)?;
                Ok(RunState {
                    status: Some(status),
                    from_seq: Some(from),
                })
            }
            None => Ok(RunState {
                status: None,
                from_seq: None,
            }),
        })
        .await
    }
}

pub(crate) fn statuses(app: &tauri::AppHandle) -> Result<HashMap<String, String>, String> {
    #[cfg(not(unix))]
    {
        let _ = app;
        return Ok(HashMap::new());
    }
    #[cfg(unix)]
    {
        let mut active = HashMap::new();
        for dir in crate::pty_client::chat_host_dirs(&data_dir(app)?) {
            match crate::pty_client::request(&dir, &Request::ChatList) {
                Ok(Response::ChatList { runs }) => active.extend(runs),
                Err(e) if e.starts_with("connect:") => {}
                Ok(Response::Err { message }) if message.starts_with("bad request:") => {}
                Ok(Response::Err { message }) => return Err(message),
                Err(e) => return Err(e),
                _ => return Err("Background host cannot report chat runs".into()),
            }
        }
        Ok(active)
    }
}

pub(super) async fn control(
    app: &tauri::AppHandle,
    id: String,
    control: ChatControl,
) -> Result<bool, String> {
    let base = data_dir(app)?;
    crate::blocking::run(move || {
        let (dir, _, _) = owner(&base, &id)?.ok_or_else(|| format!("No known run with id {id}"))?;
        match crate::pty_client::request(
            &dir,
            &Request::ChatControl {
                run_id: id,
                control,
            },
        ) {
            Ok(Response::ChatControlled { answered }) => Ok(answered),
            Ok(Response::Err { message }) => Err(message),
            Err(e) => Err(e),
            _ => Err("Unexpected background host response".into()),
        }
    })
    .await
}

#[cfg(unix)]
pub(super) async fn start(
    app: tauri::AppHandle,
    request: StartRunRequest,
    runs_dir: PathBuf,
    channel: Channel<AgentEvent>,
) -> Result<StartRunResponse, String> {
    let id = request.run_id.clone().ok_or("Missing conversation id")?;
    if app
        .state::<AgentSupervisorState>()
        .runs
        .lock()
        .unwrap()
        .contains_key(&id)
    {
        return Err(format!("A run is already active for this conversation ({id}). Wait for it to finish or stop it first."));
    }
    crate::blocking::run(move || {
        let base = data_dir(&app)?;
        if owner(&base, &id)?.is_some() {
            return Err(format!("A run is already active for this conversation ({id}). Wait for it to finish or stop it first."));
        }
        let dir = crate::pty_client::chat_host_dir(&base)?;
        crate::pty_client::ensure_daemon(&dir)?;
        // Subscribe before dispatch: even an immediate CLI failure must reach
        // the request channel. The socket buffers events until the reader starts.
        let reader = crate::pty_client::subscribe(&dir)?;
        let from = match crate::pty_client::request(&dir, &Request::ChatStart { request: Box::new(request), runs_dir }) {
            Ok(Response::ChatStarted { from_seq }) => from_seq,
            Ok(Response::Err { message }) => return Err(message),
            Err(e) => return Err(format!("Could not confirm background run start: {e}. Reopen the conversation to check its state before retrying.")),
            _ => return Err("Background host does not support chat runs".into()),
        };
        ensure_watch(app, id.clone(), dir, Some(channel), Some((reader, from)), from)?;
        Ok(StartRunResponse { run_id: id })
    }).await.map_err(|error| format!("Background host: {error}"))
}

fn dispatch_operation(
    app: &tauri::AppHandle,
    dir: &Path,
    operation: crate::pty_wire::ChatOperation,
    pending: &Arc<Mutex<std::collections::HashSet<String>>>,
) {
    if !pending.lock().unwrap().insert(operation.id.clone()) {
        return;
    }
    let app = app.clone();
    let dir = dir.to_path_buf();
    let pending = pending.clone();
    tauri::async_runtime::spawn(async move {
        let result = TauriSupervisor::new(app)
            .orchestrate(
                operation.workspace_root,
                operation.run_id,
                operation.request,
            )
            .await
            .unwrap_or_else(|_| Err("Mission supervisor stopped".into()));
        let id = operation.id;
        let receipt = id.clone();
        let _ = crate::blocking::run(move || {
            crate::pty_client::request(
                &dir,
                &Request::ChatOperationReply {
                    operation_id: receipt,
                    result,
                },
            )
            .map(|_| ())
        })
        .await;
        pending.lock().unwrap().remove(&id);
    });
}

/// One observer per active conversation, never one per saved conversation.
/// Reconnect first, replay the durable gap, then consume live events; sequence
/// numbers remove overlap. A finished answer is available even if the daemon
/// has already idle-exited by the time the app reopens.
fn ensure_watch(
    app: tauri::AppHandle,
    id: String,
    dir: PathBuf,
    channel: Option<Channel<AgentEvent>>,
    ready: Option<(Box<dyn BufRead + Send>, u64)>,
    from: u64,
) -> Result<(), String> {
    let mut watchers = watched().lock().unwrap();
    if ready.is_none() && watchers.contains_key(&id) {
        return Ok(());
    }
    let (reader, from) = match ready {
        Some(value) => value,
        None => (crate::pty_client::subscribe(&dir)?, from),
    };
    let runs_dir = app_runs_dir(&app)?;
    let generation = NEXT_WATCH.fetch_add(1, Ordering::Relaxed);
    watchers.insert(id.clone(), generation);
    std::thread::spawn(move || {
        let mut next = from;
        let mut reader = reader;
        let operations = Arc::new(Mutex::new(std::collections::HashSet::new()));
        let deliver = |event: AgentEvent, seq: u64| {
            let _ = app.emit(
                &format!("agent-run:{id}"),
                RunEventEnvelope {
                    seq,
                    event: event.clone(),
                },
            );
            if let Some(channel) = &channel {
                let _ = channel.send(event);
            }
        };
        loop {
            if let Ok(Response::ChatOperations {
                operations: pending,
            }) =
                crate::pty_client::request(&dir, &Request::ChatOperations { run_id: id.clone() })
            {
                for op in pending {
                    dispatch_operation(&app, &dir, op, &operations);
                }
            }
            let mut terminal = false;
            if let Ok(events) = read_events(&runs_dir, &id) {
                for (seq, event) in events.into_iter().enumerate().skip(next as usize) {
                    terminal = matches!(
                        event,
                        AgentEvent::RunResult { .. } | AgentEvent::RunError { .. }
                    );
                    deliver(event, seq as u64);
                    next = seq as u64 + 1;
                }
            }
            if terminal {
                break;
            }
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                let event = serde_json::from_str::<crate::pty_wire::Event>(&line);
                if let Ok(crate::pty_wire::Event::ChatOperation { operation }) = &event {
                    if operation.run_id == id {
                        dispatch_operation(&app, &dir, operation.clone(), &operations);
                    }
                }
                if let Ok(crate::pty_wire::Event::Chat { run_id, seq, event }) = event {
                    if run_id != id || seq < next {
                        continue;
                    }
                    terminal = matches!(
                        event,
                        AgentEvent::RunResult { .. } | AgentEvent::RunError { .. }
                    );
                    deliver(event, seq);
                    next = seq + 1;
                    if terminal {
                        break;
                    }
                }
            }
            if terminal {
                break;
            }
            // A lost socket must not leave the panel busy forever. Reconnect
            // without spawning/restarting anything, then fill the durable gap.
            match crate::pty_client::subscribe(&dir) {
                Ok(reconnected) => reader = reconnected,
                Err(_) => {
                    if let Ok(events) = read_events(&runs_dir, &id) {
                        for (seq, event) in events.into_iter().enumerate().skip(next as usize) {
                            terminal = matches!(
                                event,
                                AgentEvent::RunResult { .. } | AgentEvent::RunError { .. }
                            );
                            deliver(event, seq as u64);
                        }
                    }
                    if !terminal {
                        deliver(AgentEvent::RunError { run_id: id.clone(), error: AgentError {
                            code: "background_disconnected".into(), message: "Lost connection to the background run. Reopen this conversation to check its state.".into(), detail: None, retryable: false,
                        }, ts: now_ms() }, next);
                    }
                    break;
                }
            }
        }
        let mut watchers = watched().lock().unwrap();
        if watchers.get(&id) == Some(&generation) {
            watchers.remove(&id);
        }
    });
    Ok(())
}

#[cfg(test)]
mod upgrade_tests {
    use super::*;

    #[test]
    fn reconnect_and_stop_find_the_original_owner_in_either_host() {
        let base = Path::new("/test/klide");
        for hosting_dir in crate::pty_client::chat_host_dirs(base) {
            let found = find_owner(base, |dir| {
                Ok(if dir == hosting_dir {
                    (Some("running".into()), 42)
                } else {
                    (None, 0)
                })
            })
            .unwrap()
            .unwrap();
            assert_eq!(found, (hosting_dir, "running".into(), 42));
        }
    }

    #[test]
    fn an_unreachable_host_is_not_evidence_that_a_turn_can_be_restarted() {
        let base = Path::new("/test/klide");
        assert!(find_owner(base, |dir| if dir == base {
            Err("recv: timeout".into())
        } else {
            Ok((None, 0))
        })
        .is_err());
    }
}
