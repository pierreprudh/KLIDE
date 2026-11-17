//! Native conversations whose sole writer lives on an SSH machine. The Mac
//! stores placement, never an authoritative copy of the remote transcript.
use super::*;
use crate::pty_wire::{ChatControl, Event, Request, Response};
use std::io::BufRead;
use std::sync::OnceLock;

pub(crate) const HOST_BINARY: &str = "~/.klide/bin/klide";
pub(crate) const HOST_DATA: &str = "~/.klide/run-host";

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct Binding {
    pub machine_id: String,
    pub ssh_host: String,
    pub checkout: String,
}

fn binding_path(base: &Path, id: &str) -> Result<PathBuf, String> {
    validate_run_id(id)?;
    Ok(base.join("remote-runs").join(format!("{id}.json")))
}

pub(crate) fn binding(base: &Path, id: &str) -> Result<Option<Binding>, String> {
    match std::fs::read(binding_path(base, id)?) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| format!("Remote Run placement cannot be read: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn transport(binding: &Binding) -> crate::pty_transport::Ssh<'_> {
    crate::pty_transport::Ssh {
        host: &binding.ssh_host,
        binary: HOST_BINARY,
        data_dir: HOST_DATA,
    }
}

fn query(binding: &Binding, request: &Request) -> Result<Response, String> {
    match crate::pty_client::request_on(&transport(binding), request)? {
        Response::Err { message } => Err(message),
        response => Ok(response),
    }
}

pub(crate) fn control(binding: &Binding, id: &str, control: ChatControl) -> Result<bool, String> {
    match query(
        binding,
        &Request::ChatControl {
            run_id: id.into(),
            control,
        },
    )? {
        Response::ChatControlled { answered } => Ok(answered),
        _ => Err("Unexpected remote control response".into()),
    }
}

type Cache = Mutex<HashMap<String, Vec<AgentEvent>>>;
static CACHE: OnceLock<Cache> = OnceLock::new();
fn cache() -> &'static Cache {
    CACHE.get_or_init(Default::default)
}
static WATCHED: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
fn watched() -> &'static Mutex<HashMap<String, u64>> {
    WATCHED.get_or_init(Default::default)
}

fn fetch(binding: &Binding, id: &str) -> Result<Vec<AgentEvent>, String> {
    let mut events = Vec::new();
    loop {
        match query(
            binding,
            &Request::RemoteRead {
                run_id: id.into(),
                from_seq: events.len() as u64,
                limit: 256,
            },
        )? {
            Response::RemoteEvents {
                events: page,
                next_seq,
            } => {
                let count = page.len();
                if next_seq != (events.len() + count) as u64 {
                    return Err("Invalid remote replay sequence".into());
                }
                events.extend(page);
                if count < 256 {
                    return Ok(events);
                }
            }
            _ => return Err(
                "Remote host does not support transcript replay. Install the matching Run host."
                    .into(),
            ),
        }
    }
}

fn refresh(binding: &Binding, id: &str) -> Result<Vec<AgentEvent>, String> {
    let events = fetch(binding, id)?;
    let mut cache = cache()
        .lock()
        .map_err(|_| "Remote replay cache unavailable")?;
    let stored = cache.entry(id.into()).or_default();
    // An in-flight snapshot may finish after a newer live event. Never lose
    // the already-received tail of the same append-only transcript.
    if events.len() > stored.len() {
        *stored = events;
    }
    Ok(stored.clone())
}

pub(crate) fn read_all(binding: &Binding, id: &str) -> Result<Vec<AgentEvent>, String> {
    if let Some(events) = cache()
        .lock()
        .map_err(|_| "Remote replay cache unavailable")?
        .get(id)
        .cloned()
    {
        return Ok(events);
    }
    refresh(binding, id)
}

pub(super) async fn start(
    app: tauri::AppHandle,
    mut request: StartRunRequest,
    channel: Channel<AgentEvent>,
    machine_id: Option<String>,
) -> Result<StartRunResponse, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::blocking::run(move || {
        let id = request.run_id.clone().ok_or("A remote conversation needs a stable id")?;
        validate_run_id(&id)?;
        validate_request(&request)?;
        let lock_dir = base.join("remote-runs");
        std::fs::create_dir_all(&lock_dir).map_err(|e| e.to_string())?;
        let _lock = crate::process_lock::exclusive(&lock_dir.join(format!("{id}.lock")))?;
        let binding = match binding(&base, &id)? {
            Some(binding) => {
                if machine_id.as_deref().is_some_and(|m| m != binding.machine_id) { return Err("This conversation already belongs to another machine".into()); }
                binding
            }
            None => {
                let machine = crate::machines::get(machine_id.as_deref().ok_or("No remote machine selected")?).ok_or("Remote machine is no longer configured")?;
                let root = request.workspace_root.as_deref().ok_or("Open a project before starting a remote task")?;
                let binding = Binding { machine_id: machine.id.clone(), ssh_host: machine.ssh_host.clone(), checkout: machine.remote_checkout(root) };
                // Persist before sending: a dropped start response must never
                // allow a later retry to silently create a local writer.
                crate::durable::write_atomic_private(&binding_path(&base, &id)?, &serde_json::to_vec(&binding).map_err(|e| e.to_string())?)?;
                binding
            }
        };
        match query(&binding, &Request::Ping)? {
            Response::Pong { version, protocol, .. } if version == env!("CARGO_PKG_VERSION") && protocol == crate::pty_wire::PROTOCOL_VERSION => {},
            _ => return Err("Install the matching Run host in Settings → Machines before launching this task".into()),
        }
        if !matches!(query(&binding, &Request::RemoteIdentity)?, Response::RemoteIdentity { source } if source == env!("KLIDE_SOURCE_COMMIT")) {
            return Err("Update the Run host in Settings → Machines to match this app revision before launching a new task".into());
        }
        if matches!(query(&binding, &Request::ChatStatus { run_id: id.clone() })?, Response::ChatStatus { status: Some(_), .. }) { return Err(run_host::busy(&id)); }
        let reader = crate::pty_client::subscribe_on(&transport(&binding))?;
        // Optional local helper models and CLI resume ids must not cross
        // machines. The destination uses its own Claude login and transcript.
        request.naming = None; request.eyes = None; request.preferred_models.clear();
        request.delegate_session = None; request.command_allowlist.clear();
        let from = match query(&binding, &Request::RemoteStart { request: Box::new(request), checkout: binding.checkout.clone() }) {
            Ok(Response::ChatStarted { from_seq }) => from_seq,
            Ok(_) => return Err("Unexpected remote start response".into()),
            Err(error) => return Err(format!("Could not confirm remote task start: {error}. Reopen this conversation to check before retrying.")),
        };
        ensure_watch(app, id.clone(), binding, Some(channel), Some(reader), from)?;
        Ok(StartRunResponse { run_id: id })
    }).await
}

pub(super) async fn state(
    app: &tauri::AppHandle,
    id: &str,
    binding: Binding,
) -> Result<RunState, String> {
    let app = app.clone();
    let id = id.to_string();
    crate::blocking::run(move || {
        match query(&binding, &Request::ChatStatus { run_id: id.clone() })? {
            Response::ChatStatus { status, from_seq } => {
                if status.is_some() {
                    ensure_watch(app, id, binding, None, None, from_seq)?;
                } else {
                    refresh(&binding, &id)?;
                }
                Ok(RunState {
                    status,
                    from_seq: Some(from_seq),
                })
            }
            _ => Err("Unexpected remote status response".into()),
        }
    })
    .await
}

fn terminal(event: &AgentEvent) -> bool {
    matches!(
        event,
        AgentEvent::RunResult { .. } | AgentEvent::RunError { .. }
    )
}

fn ensure_watch(
    app: tauri::AppHandle,
    id: String,
    binding: Binding,
    channel: Option<Channel<AgentEvent>>,
    reader: Option<Box<dyn BufRead + Send>>,
    from: u64,
) -> Result<(), String> {
    let mut guard = watched().lock().map_err(|_| "Remote watcher unavailable")?;
    if reader.is_none() && guard.contains_key(&id) {
        return Ok(());
    }
    let generation = GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    guard.insert(id.clone(), generation);
    std::thread::spawn(move || {
        let deliver = |event: AgentEvent, seq: u64| {
            attention::emit(&app, &id, seq, &event);
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
        let connection = |connected: bool, error: Option<String>| {
            let _ = app.emit(
                &format!("remote-run-connection:{id}"),
                serde_json::json!({ "connected": connected, "error": error }),
            );
        };
        let mut ready = reader;
        let mut next = from;
        'reconnect: loop {
            let attempt = (|| -> Result<(), String> {
                let mut reader = match ready.take() {
                    Some(reader) => reader,
                    None => crate::pty_client::subscribe_on(&transport(&binding))?,
                };
                // Subscribe before snapshot: events arriving during replay
                // remain buffered; sequence numbers remove the overlap.
                let events = refresh(&binding, &id)?;
                connection(true, None);
                for (seq, event) in events.into_iter().enumerate().skip(next as usize) {
                    let done = terminal(&event);
                    deliver(event, seq as u64);
                    next = seq as u64 + 1;
                    if done {
                        return Ok(());
                    }
                }
                if matches!(
                    query(&binding, &Request::ChatStatus { run_id: id.clone() })?,
                    Response::ChatStatus { status: None, .. }
                ) {
                    // Reachable host + no owner + no terminal transcript is
                    // an interrupted task, not merely a network disconnect.
                    deliver(AgentEvent::RunError { run_id: id.clone(), error: AgentError {
                        code: error_code::RUN_HOST_FAILED.into(),
                        message: "The remote host no longer owns this task and did not record a final result. Inspect its worktree before retrying.".into(),
                        detail: None, retryable: false,
                    }, ts: now_ms() }, next);
                    return Ok(());
                }
                let mut line = String::new();
                loop {
                    line.clear();
                    if reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
                        return Err("SSH connection closed; reconnecting".into());
                    }
                    if let Ok(Event::Chat { run_id, seq, event }) = serde_json::from_str(&line) {
                        if run_id != id || seq < next {
                            continue;
                        }
                        if seq != next {
                            return Err("Remote stream gap; replaying".into());
                        }
                        {
                            let mut cache =
                                cache().lock().map_err(|_| "Replay cache unavailable")?;
                            let stored = cache.entry(id.clone()).or_default();
                            if stored.len() == seq as usize {
                                stored.push(event.clone());
                            }
                        }
                        next = seq + 1;
                        let done = terminal(&event);
                        deliver(event, seq);
                        if done {
                            return Ok(());
                        }
                    }
                }
            })();
            match attempt {
                Ok(()) => break 'reconnect,
                Err(error) => {
                    connection(false, Some(error));
                    std::thread::sleep(std::time::Duration::from_secs(3));
                }
            }
        }
        let mut guard = watched().lock().unwrap();
        if guard.get(&id) == Some(&generation) {
            guard.remove(&id);
        }
    });
    Ok(())
}

fn validate_request(request: &StartRunRequest) -> Result<(), String> {
    if request.provider != crate::machines::REMOTE_PROVIDER
        || !run_host::background_eligible(request)
        || request.side_question_of.is_some()
    {
        return Err(
            "Remote tasks currently support standalone Claude Code conversations only".into(),
        );
    }
    if crate::harness_source::intelligence(&request.model)?.is_some() {
        return Err("Remote Claude Code currently uses its own machine login, without a routed intelligence source".into());
    }
    Ok(())
}

/// Host-owned paths: the client cannot supply a transcript directory or make
/// a Mac path look local on Linux. Each conversation owns a reusable worktree.
pub(crate) fn start_on_host(
    host: &Arc<daemon::RunHost>,
    data: &Path,
    mut request: StartRunRequest,
    checkout: &str,
) -> Result<u64, String> {
    validate_request(&request)?;
    let id = request.run_id.clone().ok_or("Missing remote Run id")?;
    validate_run_id(&id)?;
    let checkout = if let Some(rest) = checkout.strip_prefix("~/") {
        crate::cli::home_dir_path()
            .ok_or("Home directory unavailable")?
            .join(rest)
    } else {
        PathBuf::from(checkout)
    };
    let checkout = checkout
        .canonicalize()
        .map_err(|e| format!("Remote checkout is unavailable: {e}"))?;
    let worktrees = data.join("worktrees");
    std::fs::create_dir_all(&worktrees).map_err(|e| e.to_string())?;
    let root = worktrees.join(&id);
    let runs = data.join("runs");
    std::fs::create_dir_all(&runs).map_err(|e| e.to_string())?;
    let placement = runs.join(format!("{id}.checkout.json"));
    if !placement.exists()
        && std::process::Command::new("tmux")
            .args([
                "has-session",
                "-t",
                &crate::machines::tmux_session_name(&id),
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    {
        return Err("This conversation still has a legacy tmux session. Finish it there and start a new native conversation.".into());
    }
    if placement.exists() {
        let original: PathBuf =
            serde_json::from_slice(&std::fs::read(&placement).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if original != checkout {
            return Err("This remote conversation belongs to a different checkout".into());
        }
        if !root.join(".git").exists() {
            return Err(
                "The conversation worktree is missing; restore it before continuing".into(),
            );
        }
    } else {
        let output = crate::git::cmd::git_in(&checkout)?
            .args(["worktree", "add", "--detach"])
            .arg(&root)
            .arg("HEAD")
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(format!(
                "Could not create remote worktree: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        let base = crate::git::cmd::git_in(&root)?
            .args(["rev-parse", "HEAD"])
            .output()
            .map_err(|e| e.to_string())?;
        if !base.status.success() {
            return Err("Could not record remote worktree base".into());
        }
        crate::durable::write_atomic_private(&runs.join(format!("{id}.base")), &base.stdout)?;
        crate::durable::write_atomic_private(
            &placement,
            &serde_json::to_vec(&checkout).map_err(|e| e.to_string())?,
        )?;
    }
    let remote_root = root.to_string_lossy().into_owned();
    if let (Some(local_root), Some(prompt)) = (&request.workspace_root, &mut request.system_prompt)
    {
        if !local_root.is_empty() {
            *prompt = prompt.replace(local_root, &remote_root);
        }
    }
    request.workspace_root = Some(remote_root);
    if let Some(context) = &mut request.context {
        context.workspace_root = request.workspace_root.clone();
        context.memory = None;
        context.lens_items.clear();
    }
    request.command_allowlist.clear();
    request.naming = None;
    request.eyes = None;
    request.delegate_session = None;
    request.preferred_models.clear();
    let clamped = run_core::clamp_attachments(std::mem::take(&mut request.attachments));
    request.attachments = clamped.kept;
    for attachment in &mut request.attachments {
        attachment.stored = None;
    }
    if let Some(history) = request.conversation_history.take() {
        conversation_search::store_history(&runs, &root, &id, history)?;
    }
    host.start(request, runs)
}

pub(crate) fn changes_on_host(data: &Path, id: &str) -> Result<(String, String, String), String> {
    validate_run_id(id)?;
    let root = data.join("worktrees").join(id);
    let base = std::fs::read_to_string(data.join("runs").join(format!("{id}.base")))
        .map_err(|e| e.to_string())?;
    // Capture new files before tracked diffs: settling can commit them while
    // this request is reading. That ordering keeps such files in at least one
    // side of the snapshot instead of briefly omitting their contents.
    let untracked = crate::git::cmd::git_in(&root)?
        .args(["ls-files", "--others", "--exclude-standard", "-z"])
        .output()
        .map_err(|e| e.to_string())?;
    if !untracked.status.success() {
        return Err("Could not list new remote files".into());
    }
    let diff = crate::git::cmd::git_in(&root)?
        .args(["diff", "--no-ext-diff", "--no-textconv", base.trim(), "--"])
        .output()
        .map_err(|e| e.to_string())?;
    let status = crate::git::cmd::git_in(&root)?
        .args(["status", "--short"])
        .output()
        .map_err(|e| e.to_string())?;
    if !diff.status.success() || !status.status.success() {
        return Err("Could not read remote changes".into());
    }
    let mut text = String::from_utf8_lossy(&diff.stdout).into_owned();
    let paths: Vec<_> = untracked
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .collect();
    for path in paths.iter().take(32) {
        use std::os::unix::ffi::OsStrExt;
        let path = std::ffi::OsStr::from_bytes(path);
        if std::fs::symlink_metadata(root.join(path))
            .map_err(|e| e.to_string())?
            .len()
            > 256_000
        {
            text.push_str(&format!(
                "\n[New file {} omitted: larger than 256 KB.]\n",
                path.to_string_lossy()
            ));
            continue;
        }
        let added = crate::git::cmd::git_in(&root)?
            .args([
                "diff",
                "--no-index",
                "--no-ext-diff",
                "--no-textconv",
                "--",
                "/dev/null",
            ])
            .arg(path)
            .output()
            .map_err(|e| e.to_string())?;
        if !matches!(added.status.code(), Some(0 | 1)) {
            return Err("Could not read a new remote file diff".into());
        }
        text.push_str(&String::from_utf8_lossy(&added.stdout));
        if text.len() > 1_000_000 {
            break;
        }
    }
    if paths.len() > 32 {
        text.push_str("\n[Only the first 32 new files are shown; inspect the full remote worktree for the rest.]\n");
    }
    if text.len() > 1_000_000 {
        let mut boundary = 1_000_000;
        while !text.is_char_boundary(boundary) {
            boundary -= 1;
        }
        text.truncate(boundary);
        text.push_str("\n[Diff truncated; inspect the full worktree on the remote machine.]\n");
    }
    Ok((
        text,
        String::from_utf8_lossy(&status.stdout).into_owned(),
        root.to_string_lossy().into_owned(),
    ))
}

#[tauri::command]
pub async fn machine_run_changes(
    app: tauri::AppHandle,
    run_id: String,
) -> Result<serde_json::Value, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::blocking::run(move || {
        let binding = binding(&base, &run_id)?.ok_or("This is not a remote conversation")?;
        match query(&binding, &Request::RemoteChanges { run_id })? {
            Response::RemoteChanges {
                diff,
                status,
                worktree,
            } => Ok(serde_json::json!({ "diff": diff, "status": status, "worktree": worktree })),
            _ => Err("Unexpected remote changes response".into()),
        }
    })
    .await
}

pub(crate) fn read_on_host(
    data: &Path,
    id: &str,
    from: u64,
    limit: usize,
) -> Result<(Vec<AgentEvent>, u64), String> {
    validate_run_id(id)?;
    let events = read_events(&data.join("runs"), id)?;
    let start = usize::try_from(from).map_err(|_| "Invalid remote sequence")?;
    if start > events.len() {
        return Err("Remote transcript is shorter than the requested sequence".into());
    }
    let events: Vec<_> = events
        .into_iter()
        .skip(start)
        .take(limit.clamp(1, 256))
        .collect();
    let next = from + events.len() as u64;
    Ok((events, next))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directory(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "klide-remote-{label}-{}-{}",
            std::process::id(),
            run_id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn placement_survives_restart_and_corruption_is_not_a_local_fallback() {
        let base = directory("binding");
        let path = binding_path(&base, "convo").unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let placed = Binding {
            machine_id: "box".into(),
            ssh_host: "my-box".into(),
            checkout: "~/code/project".into(),
        };
        crate::durable::write_atomic_private(&path, &serde_json::to_vec(&placed).unwrap()).unwrap();
        assert_eq!(binding(&base, "convo").unwrap().unwrap().ssh_host, "my-box");
        std::fs::write(path, "bad json").unwrap();
        assert!(binding(&base, "convo").is_err());
        assert!(binding(&base, "../convo").is_err());
        assert!(binding(&base, "absent").unwrap().is_none());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn replay_pages_are_bounded_and_do_not_accept_paths() {
        let data = directory("replay");
        std::fs::create_dir_all(data.join("runs")).unwrap();
        for seq in 0..260 {
            append_event(
                &data.join("runs"),
                "convo",
                seq,
                &AgentEvent::AssistantDelta {
                    run_id: "convo".into(),
                    message_id: "message".into(),
                    text: seq.to_string(),
                    thinking: None,
                    ts: seq as i64,
                },
            )
            .unwrap();
        }
        let (page, next) = read_on_host(&data, "convo", 0, usize::MAX).unwrap();
        assert_eq!((page.len(), next), (256, 256));
        let (page, next) = read_on_host(&data, "convo", next, 256).unwrap();
        assert_eq!((page.len(), next), (4, 260));
        assert!(read_on_host(&data, "convo", 261, 256).is_err());
        assert!(read_on_host(&data, "../private", 0, 256).is_err());
        std::fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn remote_admission_refuses_other_providers_and_nested_runs() {
        let mut request: StartRunRequest = serde_json::from_value(serde_json::json!({
            "runId": "convo", "workspaceRoot": "/project", "mode": "goal", "provider": "claude-code", "model": "default", "initialText": "work", "context": null, "systemPrompt": null
        })).unwrap();
        assert!(validate_request(&request).is_ok());
        request.parent_id = Some("parent".into());
        assert!(validate_request(&request).is_err());
        request.parent_id = None;
        request.provider = "openrouter".into();
        assert!(validate_request(&request).is_err());
    }
}
