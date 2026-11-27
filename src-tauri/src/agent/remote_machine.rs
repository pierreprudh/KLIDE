//! Native conversations whose sole writer lives on an SSH machine. The Mac
//! stores placement, never an authoritative copy of the remote transcript.
use super::*;
use crate::pty_wire::{ChatControl, Event, Request, Response};
use std::io::BufRead;
use std::sync::OnceLock;

pub(crate) const HOST_DATA: &str = "~/.klide/run-host";

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct Binding {
    pub machine_id: String,
    pub ssh_host: String,
    pub checkout: String,
    #[serde(default)]
    pub inference: Option<crate::machine_inference::RemoteInference>,
    #[serde(default)]
    pub os: crate::remote_platform::HostOs,
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
        binary: binding.os.binary(),
        os: binding.os,
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

fn fetch(binding: &Binding, id: &str, from: u64) -> Result<Vec<AgentEvent>, String> {
    fetch_pages(from, |sequence| {
        query(
            binding,
            &Request::RemoteRead {
                run_id: id.into(),
                from_seq: sequence,
                limit: 256,
            },
        )
    })
}

fn fetch_pages(
    from: u64,
    mut page: impl FnMut(u64) -> Result<Response, String>,
) -> Result<Vec<AgentEvent>, String> {
    let mut events = Vec::new();
    loop {
        match page(from + events.len() as u64)? {
            Response::RemoteEvents {
                events: tail,
                next_seq,
                more,
            } => {
                let count = tail.len();
                if next_seq != from + (events.len() + count) as u64 {
                    return Err("Invalid remote replay sequence".into());
                }
                events.extend(tail);
                // Byte-limited pages can be short while retaining more history.
                // Stop at the captured tail rather than chasing an active stream.
                // Legacy hosts lack `more` and use exactly 256 records per page.
                if !more && count < 256 {
                    return Ok(events);
                }
                if count == 0 {
                    return Err("Remote replay did not advance".into());
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
    let from = cache()
        .lock()
        .map_err(|_| "Remote replay cache unavailable")?
        .get(id)
        .map_or(0, Vec::len);
    let events = fetch(binding, id, from as u64)?;
    let mut cache = cache()
        .lock()
        .map_err(|_| "Remote replay cache unavailable")?;
    let stored = cache.entry(id.into()).or_default();
    merge_tail(stored, from, events)?;
    Ok(stored.clone())
}

fn merge_tail(
    stored: &mut Vec<AgentEvent>,
    from: usize,
    tail: Vec<AgentEvent>,
) -> Result<(), String> {
    // The stream can advance while this incremental snapshot is in flight.
    // Keep its existing prefix and append only events not received live yet.
    let overlap = stored
        .len()
        .checked_sub(from)
        .ok_or("Remote replay cache was invalidated")?;
    stored.extend(tail.into_iter().skip(overlap));
    Ok(())
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
    let id = request
        .run_id
        .as_deref()
        .ok_or("A remote conversation needs a stable id")?;
    validate_run_id(id)?;
    let dispatch = dispatch_cancel::Dispatch::register(id).map_err(|_| run_host::busy(id))?;
    let cancel = dispatch.cancel.clone();
    let _storage_guard = crate::storage::RUN_STORAGE_GATE.lock().await;
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::blocking::run(move || {
        let _storage_lease = crate::process_lock::exclusive(&base.join("run-storage.lock"))?;
        let id = request.run_id.clone().ok_or("A remote conversation needs a stable id")?;
        validate_run_id(&id)?;
        validate_request(&request)?;
        if cancel.is_cancelled() { return Err("Cancelled before remote setup".into()); }
        let lock_dir = base.join("remote-runs");
        std::fs::create_dir_all(&lock_dir).map_err(|e| e.to_string())?;
        let _lock = crate::process_lock::exclusive(&lock_dir.join(format!("{id}.lock")))?;
        let binding = match binding(&base, &id)? {
            Some(binding) => {
                if machine_id.as_deref().is_some_and(|m| m != binding.machine_id) { return Err("This conversation already belongs to another machine".into()); }
                binding
            }
            None => {
                ensure_no_local_history(&app_runs_dir(&app)?, &id)?;
                if app.state::<AgentSupervisorState>().runs.lock().map_err(|_| "Agent state unavailable")?.contains_key(&id)
                    || daemon_client::statuses(&app)?.contains_key(&id) { return Err(run_host::busy(&id)); }
                let machine = crate::machines::get(machine_id.as_deref().ok_or("No remote machine selected")?).ok_or("Remote machine is no longer configured")?;
                let root = request.workspace_root.as_deref().ok_or("Open a project before starting a remote task")?;
                let binding = Binding { os: crate::machine_install::detect_target(&machine.ssh_host)?.os, machine_id: machine.id.clone(), ssh_host: machine.ssh_host.clone(), checkout: machine.remote_checkout(root), inference: None };
                // Persist before sending: a dropped start response must never
                // allow a later retry to silently create a local writer.
                crate::durable::write_atomic_private(&binding_path(&base, &id)?, &serde_json::to_vec(&binding).map_err(|e| e.to_string())?)?;
                binding
            }
        };
        // Only a conversation bound under the old machine-wide model keeps it;
        // every other run uses the agent and model its composer chose.
        if let Some(inference) = &binding.inference {
            request.model = inference.selected_model()?;
        }
        match query(&binding, &Request::Ping)? {
            Response::Pong { version, protocol, .. } if crate::pty_wire::remote_host_compatible(&version, protocol) => {},
            _ => return Err("Install the matching Run host in Settings → Machines before launching this task".into()),
        }
        if matches!(query(&binding, &Request::ChatStatus { run_id: id.clone() })?, Response::ChatStatus { status: Some(_), .. }) { return Err(run_host::busy(&id)); }
        let reader = crate::pty_client::subscribe_on(&transport(&binding))?;
        // Optional local helper models and CLI resume ids must not cross
        // machines. The destination uses its own Claude login and transcript.
        request.naming = None; request.eyes = None; request.preferred_models.clear();
        request.delegate_session = None; request.command_allowlist.clear();
        if cancel.is_cancelled() { return Err("Cancelled before the remote task started".into()); }
        let kit = request.provider != crate::machines::REMOTE_PROVIDER;
        let from = match query(&binding, &Request::RemoteStart { request: Box::new(request), checkout: binding.checkout.clone() }) {
            Ok(Response::ChatStarted { from_seq }) => from_seq,
            Ok(_) => return Err("Unexpected remote start response".into()),
            // A host from before `remote-api` refuses anything but Claude Code.
            Err(error) if kit && error.contains("standalone Claude Code conversations only") => return Err("Update the Run host in Settings → Machines to run Kit on this machine".into()),
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

fn replay_snapshot(
    events: Vec<AgentEvent>,
    next: &mut u64,
    deliver: &impl Fn(AgentEvent, u64),
) -> bool {
    for (seq, event) in events.into_iter().enumerate().skip(*next as usize) {
        let done = terminal(&event);
        deliver(event, seq as u64);
        *next = seq as u64 + 1;
        if done {
            return true;
        }
    }
    false
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
                if replay_snapshot(events, &mut next, &deliver) {
                    return Ok(());
                }
                if matches!(
                    query(&binding, &Request::ChatStatus { run_id: id.clone() })?,
                    Response::ChatStatus { status: None, .. }
                ) {
                    // The task may have settled after the first snapshot.
                    // Its final event was written before owner retirement,
                    // so read that durable tail before declaring interruption.
                    let final_events = refresh(&binding, &id)?;
                    if replay_snapshot(final_events, &mut next, &deliver) {
                        return Ok(());
                    }
                    // A reachable host with no owner and no durable result
                    // after that second snapshot is an interrupted task.
                    deliver(AgentEvent::RunError { run_id: id.clone(), error: AgentError {
                        code: error_code::RUN_HOST_FAILED.into(),
                        message: "The remote host no longer owns this task and did not record a final result. Inspect its worktree before retrying.".into(),
                        detail: None, retryable: false,
                    }, ts: now_ms() }, next);
                    return Ok(());
                }
                loop {
                    let Some(line) = crate::pty_wire::read_line_capped(&mut reader).map_err(|e| e.to_string())? else {
                        return Err("SSH connection closed; reconnecting".into());
                    };
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

fn ensure_no_local_history(runs: &Path, id: &str) -> Result<(), String> {
    if transcript_path(runs, id)
        .try_exists()
        .map_err(|e| e.to_string())?
    {
        return Err("This conversation already has a local transcript. Start a new remote conversation; moving an existing conversation requires an explicit transfer.".into());
    }
    Ok(())
}

/// What a Remote machine runs: a standalone conversation, either Claude Code
/// (on the machine's login, or routed to an API source) or Kit on a hosted
/// API. Either way the API must be one a key can be authorized for.
fn validate_request(request: &StartRunRequest) -> Result<(), String> {
    let standalone = request.parent_id.is_none()
        && request.mission_id.is_none()
        && request.mission_task_id.is_none()
        && request.side_question_of.is_none();
    if !standalone || remote_api(request)?.is_none() && request.provider != crate::machines::REMOTE_PROVIDER {
        return Err("Remote tasks support standalone Claude Code or Kit-on-API conversations only".into());
    }
    if let Some(provider) = remote_api(request)? {
        if !crate::machine_inference::remote_api_provider(&provider) {
            return Err(format!("{provider} can't run on a remote machine yet — choose a hosted API like OpenRouter, Anthropic or DeepSeek"));
        }
    }
    Ok(())
}

/// The hosted API whose key this run reads on the machine: Kit's own
/// Provider, or the source a Claude Code run is routed to. None for Claude
/// Code on its login.
fn remote_api(request: &StartRunRequest) -> Result<Option<String>, String> {
    if request.provider == crate::machines::REMOTE_PROVIDER {
        return Ok(crate::harness_source::intelligence(&request.model)?.map(|source| source.provider));
    }
    Ok(crate::providers::lookup(&request.provider)
        .filter(|entry| entry.group == crate::providers::ProviderGroup::Hosted)
        .map(|entry| entry.id.to_string()))
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
    if let Some(provider) = remote_api(&request)? {
        if crate::machine_inference::configured_key_for(&provider)?.is_none() {
            let label = crate::providers::lookup(&provider).map_or(provider.as_str(), |e| e.label);
            return Err(format!("Authorize a {label} API key for this machine in Settings → Machines"));
        }
    }

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
        if root.join(".git").exists() {
            // A prior setup may have created the worktree but failed before
            // publishing placement. Recover only an unstarted worktree from
            // this exact repository; never reinterpret existing Run history.
            if transcript_path(&runs, &id).exists() {
                return Err("Remote placement is missing for an existing transcript; restore it before continuing".into());
            }
            let common = |dir: &Path| -> Result<PathBuf, String> {
                let output = crate::git::cmd::git_in(dir)?
                    .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
                    .output()
                    .map_err(|e| e.to_string())?;
                if !output.status.success() {
                    return Err("Could not verify the existing remote worktree".into());
                }
                PathBuf::from(String::from_utf8_lossy(&output.stdout).trim())
                    .canonicalize()
                    .map_err(|e| e.to_string())
            };
            if common(&root)? != common(&checkout)? {
                return Err(
                    "The existing worktree belongs to a different remote repository".into(),
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
    host.start_remote(request, runs)
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
        #[cfg(unix)]
        let path = { use std::os::unix::ffi::OsStrExt; std::ffi::OsStr::from_bytes(path) };
        #[cfg(windows)]
        let path = std::ffi::OsStr::new(std::str::from_utf8(path).map_err(|_|"Git returned an invalid Windows path")?);
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
                if cfg!(windows) { "NUL" } else { "/dev/null" },
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
) -> Result<(Vec<AgentEvent>, u64, bool), String> {
    validate_run_id(id)?;
    let events = read_events(&data.join("runs"), id)?;
    let start = usize::try_from(from).map_err(|_| "Invalid remote sequence")?;
    if start > events.len() {
        return Err("Remote transcript is shorter than the requested sequence".into());
    }
    let total = events.len();
    let mut page = Vec::new();
    let mut bytes = 0;
    // Reserve framing space, including the response tag, cursor and newline.
    let maximum = crate::pty_wire::MAX_WIRE_LINE.saturating_sub(1024);
    let budget = maximum / 2;
    for event in events.into_iter().skip(start).take(limit.clamp(1, 256)) {
        let size = serde_json::to_vec(&event).map_err(|e| e.to_string())?.len() + 1;
        if size > maximum {
            return Err("A remote transcript record exceeds the replay transport limit".into());
        }
        if !page.is_empty() && bytes + size > budget {
            break;
        }
        bytes += size;
        page.push(event);
    }
    let events = page;
    let next = from + events.len() as u64;
    Ok((events, next, next < total as u64))
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

    fn delta(text: &str) -> AgentEvent {
        AgentEvent::AssistantDelta {
            run_id: "convo".into(),
            message_id: "message".into(),
            text: text.into(),
            thinking: None,
            ts: 0,
        }
    }

    #[test]
    fn completion_between_snapshot_and_owner_check_is_replayed_as_success() {
        let seen = Mutex::new(Vec::new());
        let deliver = |event, seq| seen.lock().unwrap().push((seq, event));
        let mut next = 1;
        assert!(!replay_snapshot(
            vec![delta("old"), delta("current")],
            &mut next,
            &deliver
        ));
        // The owner retires only after writing this result. The second read
        // must include it even though the earlier snapshot did not.
        assert!(replay_snapshot(
            vec![
                delta("old"),
                delta("current"),
                AgentEvent::RunResult {
                    run_id: "convo".into(),
                    result: serde_json::json!({"status":"done"}),
                    ts: 1,
                }
            ],
            &mut next,
            &deliver
        ));
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert!(matches!(seen[1], (2, AgentEvent::RunResult { .. })));
        assert_eq!(next, 3);
    }

    #[test]
    fn incremental_replay_keeps_events_received_while_the_request_was_in_flight() {
        let mut stored = vec![delta("old"), delta("live")];
        merge_tail(&mut stored, 1, vec![delta("live"), delta("missed")]).unwrap();
        assert_eq!(stored.len(), 3);
        assert!(matches!(&stored[2], AgentEvent::AssistantDelta { text, .. } if text == "missed"));
        merge_tail(&mut stored, 1, vec![delta("live")]).unwrap();
        assert_eq!(
            stored.len(),
            3,
            "an older reply cannot truncate the live tail"
        );
    }

    #[test]
    fn a_local_conversation_cannot_be_implicitly_placed_on_a_second_host() {
        let runs = directory("local-owner");
        assert!(ensure_no_local_history(&runs, "convo").is_ok());
        std::fs::write(transcript_path(&runs, "convo"), "existing transcript").unwrap();
        assert!(ensure_no_local_history(&runs, "convo").is_err());
        std::fs::remove_dir_all(runs).unwrap();
    }

    #[test]
    fn placement_survives_restart_and_corruption_is_not_a_local_fallback() {
        let base = directory("binding");
        let path = binding_path(&base, "convo").unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let placed = Binding {
            os: crate::remote_platform::HostOs::Linux,
            machine_id: "box".into(),
            ssh_host: "my-box".into(),
            checkout: "~/code/project".into(),
            inference: None,
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
        let (page, next, more) = read_on_host(&data, "convo", 0, usize::MAX).unwrap();
        assert_eq!((page.len(), next, more), (256, 256, true));
        let (page, next, more) = read_on_host(&data, "convo", next, 256).unwrap();
        assert_eq!((page.len(), next, more), (4, 260, false));
        assert!(read_on_host(&data, "convo", 261, 256).is_err());
        assert!(read_on_host(&data, "../private", 0, 256).is_err());
        std::fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn byte_bounded_replay_pages_do_not_truncate_the_durable_history() {
        let data = directory("large-replay");
        let runs = data.join("runs");
        std::fs::create_dir_all(&runs).unwrap();
        let text = "x".repeat(crate::pty_wire::MAX_WIRE_LINE / 3);
        for seq in 0..3 {
            append_event(&runs, "convo", seq, &delta(&text)).unwrap();
        }
        let mut calls = 0;
        let events = fetch_pages(0, |from| {
            calls += 1;
            let (events, next_seq, more) = read_on_host(&data, "convo", from, 256)?;
            assert!(events.len() <= 1, "A page must stop at the byte budget");
            let reply = Response::RemoteEvents {
                events,
                next_seq,
                more,
            };
            assert!(serde_json::to_vec(&reply).unwrap().len() < crate::pty_wire::MAX_WIRE_LINE);
            Ok(reply)
        })
        .unwrap();
        assert_eq!(
            (events.len(), calls),
            (3, 3),
            "Short pages are not the end of history"
        );
        std::fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn replay_returns_at_the_snapshot_tail_while_a_task_keeps_streaming() {
        let mut calls = 0;
        let events = fetch_pages(0, |from| {
            calls += 1;
            assert_eq!(calls, 1, "Do not chase new output forever");
            Ok(Response::RemoteEvents {
                events: vec![delta("live")],
                next_seq: from + 1,
                more: false,
            })
        })
        .unwrap();
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn remote_admission_accepts_openrouter_without_changing_the_agent() {
        let mut request: StartRunRequest = serde_json::from_value(serde_json::json!({
            "runId": "convo", "workspaceRoot": "/project", "mode": "goal", "provider": "claude-code", "model": "default", "initialText": "work", "context": null, "systemPrompt": null
        })).unwrap();
        request.model = crate::machine_inference::RemoteInference::default().selected_model().unwrap();
        assert!(validate_request(&request).is_ok());
        request.model = r#"harness-source:{"provider":"openai","model":"gpt-4.1"}"#.into();
        assert!(validate_request(&request).is_ok());
        request.model = r#"harness-source:{"provider":"ollama","model":"qwen3"}"#.into();
        assert!(validate_request(&request).is_err());
    }

    #[test]
    fn kit_runs_remotely_on_a_hosted_api_but_not_on_a_local_server() {
        let mut request: StartRunRequest = serde_json::from_value(serde_json::json!({
            "runId": "convo", "workspaceRoot": "/project", "mode": "goal", "provider": "deepseek", "model": "deepseek-chat", "initialText": "work", "context": null, "systemPrompt": null
        })).unwrap();
        assert!(validate_request(&request).is_ok());
        assert_eq!(remote_api(&request).unwrap().as_deref(), Some("deepseek"));
        request.provider = "ollama".into();
        assert!(validate_request(&request).is_err());
        request.provider = "codex".into();
        assert!(validate_request(&request).is_err());
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
        request.provider = "codex".into();
        assert!(validate_request(&request).is_err());
    }
}
