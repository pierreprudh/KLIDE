//! Tauri glue for terminals: the native shell PTY (`PtyState`) and the thin
//! command layer over the delegate session host. All delegate session
//! mechanics — scrollback, disk persistence, reader loops — live in
//! [`crate::pty_host`], which is Tauri-free so the same code can run inside
//! the detached `klide ptyd` daemon (Slice 3 of
//! docs/delegate-session-replay.md). This file owns what is genuinely
//! app-side: provider/adapter knowledge, status hooks, webview event emits,
//! and the parent-run mapping.

use crate::delegate::{self, shell_quote};
use crate::pty_client;
use crate::pty_daemon::{
    Event as DaemonEvent, Request as DaemonRequest, Response as DaemonResponse,
};
use crate::pty_host::{
    self, DelegateMissionLink, LiveSessionRow, PtyEventSink, PtyExitOutcome, SessionHost, SpawnSpec,
};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};

pub use crate::pty_host::{RecentDelegateSession, SessionSnapshot as DelegatePtySnapshot};

const IDLE_SESSION_MS: i64 = 60_000;

// ── Daemon bridge (Slice 3c) ─────────────────────────────────────────────────
// When "persistent delegate sessions" is enabled, NEW delegate PTYs are
// spawned inside the detached `klide ptyd` daemon instead of this process, so
// they survive an app restart. Both hosts stay first-class: every command
// below answers for in-process sessions first (they may pre-date the toggle),
// then asks the daemon. Events from daemon sessions arrive over a subscribed
// socket and re-enter the exact same path as in-process ones (`TauriSink`).

const PTYD_CONFIG_FILE: &str = "ptyd-config.json";

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct PtydConfig {
    enabled: bool,
}

/// App-side daemon state: the persisted toggle plus a guard so only one
/// subscriber thread ever runs.
#[derive(Default)]
pub struct DaemonBridge {
    enabled: AtomicBool,
    subscriber_running: AtomicBool,
}

fn app_data_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok()
}

fn ptyd_config_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app_data_dir(app).map(|d| d.join(PTYD_CONFIG_FILE))
}

fn daemon_enabled(app: &tauri::AppHandle) -> bool {
    app.state::<DaemonBridge>().enabled.load(Ordering::Relaxed)
}

/// Load the persisted toggle at app start; when on, bring the daemon up and
/// start listening so pre-restart sessions surface immediately. Called from
/// lib.rs setup, off the main thread (daemon startup shouldn't delay boot —
/// see memory: sync commands on the main thread have frozen the UI before).
pub fn init_daemon_bridge(app: tauri::AppHandle) {
    let enabled = ptyd_config_path(&app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|text| serde_json::from_str::<PtydConfig>(&text).ok())
        .map(|c| c.enabled)
        .unwrap_or(false);
    if !enabled {
        return;
    }
    app.state::<DaemonBridge>()
        .enabled
        .store(true, Ordering::Relaxed);
    std::thread::spawn(move || {
        if let Some(dir) = app_data_dir(&app) {
            if let Err(e) = pty_client::ensure_daemon(&dir) {
                eprintln!("ptyd startup: {e}");
                return;
            }
        }
        start_daemon_subscriber(app);
    });
}

/// Forward daemon events into the app exactly as if the sessions were local:
/// the same `TauriSink` the in-process host uses. Reconnects with a small
/// backoff for as long as the toggle stays on.
fn start_daemon_subscriber(app: tauri::AppHandle) {
    if app
        .state::<DaemonBridge>()
        .subscriber_running
        .swap(true, Ordering::SeqCst)
    {
        return;
    }
    std::thread::spawn(move || {
        let sink = TauriSink { app: app.clone() };
        loop {
            if !daemon_enabled(&app) {
                std::thread::sleep(std::time::Duration::from_secs(5));
                continue;
            }
            let Some(dir) = app_data_dir(&app) else {
                break;
            };
            if let Ok(reader) = pty_client::subscribe(&dir) {
                for line in reader.lines() {
                    let Ok(line) = line else { break };
                    if line.trim().is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<DaemonEvent>(&line) {
                        Ok(DaemonEvent::Chunk {
                            session_id,
                            data,
                            seq,
                        }) => sink.chunk(&session_id, &data, seq),
                        Ok(DaemonEvent::Exit {
                            session_id,
                            outcome,
                        }) => sink.exit(&session_id, &outcome),
                        Ok(DaemonEvent::ExternalId {
                            session_id,
                            external_id,
                        }) => sink.external_id(&session_id, &external_id),
                        Err(_) => {}
                    }
                }
            }
            // Stream ended (daemon idle-exited or restarted) — retry shortly.
            std::thread::sleep(std::time::Duration::from_secs(3));
        }
    });
}

/// Live session ids the daemon is hosting (empty when off/unreachable) — for
/// merged live/recent listings.
fn daemon_live_rows(app: &tauri::AppHandle) -> Vec<LiveSessionRow> {
    if !daemon_enabled(app) {
        return Vec::new();
    }
    let Some(dir) = app_data_dir(app) else {
        return Vec::new();
    };
    match pty_client::request(&dir, &DaemonRequest::LiveRows) {
        Ok(DaemonResponse::LiveRows { rows }) => rows,
        _ => Vec::new(),
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatus {
    enabled: bool,
    reachable: bool,
    version: Option<String>,
    live_sessions: usize,
}

#[tauri::command]
pub fn delegate_daemon_status(app: tauri::AppHandle) -> DaemonStatus {
    let enabled = daemon_enabled(&app);
    let ping = app_data_dir(&app)
        .map(|dir| pty_client::request(&dir, &DaemonRequest::Ping));
    match ping {
        Some(Ok(DaemonResponse::Pong { version, .. })) => DaemonStatus {
            enabled,
            reachable: true,
            version: Some(version),
            live_sessions: daemon_live_rows(&app).len(),
        },
        _ => DaemonStatus {
            enabled,
            reachable: false,
            version: None,
            live_sessions: 0,
        },
    }
}

#[tauri::command]
pub fn delegate_daemon_set_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    app.state::<DaemonBridge>()
        .enabled
        .store(enabled, Ordering::Relaxed);
    if let Some(path) = ptyd_config_path(&app) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let json = serde_json::to_string_pretty(&PtydConfig { enabled })
            .map_err(|e| e.to_string())?;
        std::fs::write(&path, json).map_err(|e| e.to_string())?;
    }
    if enabled {
        let dir = app_data_dir(&app).ok_or("no app data dir")?;
        pty_client::ensure_daemon(&dir)?;
        start_daemon_subscriber(app);
    }
    // Disabling routes NEW spawns in-process. The daemon keeps hosting what
    // it already has (its sessions are the user's work) and idle-exits once
    // they finish; the subscriber thread keeps draining until then.
    Ok(())
}

pub struct PtyState {
    pub writer: Mutex<Option<Box<dyn Write + Send>>>,
    pub cwd: Mutex<Option<String>>,
}

#[derive(Default)]
pub struct DelegatePtyState {
    pub host: SessionHost,
}

impl DelegatePtyState {
    /// Is a delegate PTY for `provider` currently live? Used by account
    /// switching to refuse swapping a CLI's credentials out from under a
    /// running session. Only covers Klide-spawned PTYs — a CLI running in an
    /// external terminal is invisible to us.
    pub fn has_live_session(&self, provider: &str) -> bool {
        self.host.has_live_session(provider)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DelegateAttemptRecovery {
    Live,
    Settled(PtyExitOutcome),
    Missing,
}

/// Durable recovery evidence for a Mission-linked Delegate attempt. A live
/// session may be hosted in-process or by `ptyd`; a settled outcome comes from
/// the write-through scrollback metadata. Anything else is ambiguous and must
/// become an interrupted attempt rather than being replayed.
pub(crate) fn delegate_attempt_recovery(
    app: &tauri::AppHandle,
    session_id: &str,
) -> DelegateAttemptRecovery {
    let local_live = app
        .state::<DelegatePtyState>()
        .host
        .live_ids()
        .contains(session_id);
    let daemon_live = daemon_live_rows(app)
        .iter()
        .any(|row| row.session_id == session_id);
    if local_live || daemon_live {
        return DelegateAttemptRecovery::Live;
    }
    scrollback_dir(app)
        .and_then(|dir| pty_host::read_scrollback_meta(&dir, session_id))
        .and_then(|meta| meta.exit_outcome)
        .map(DelegateAttemptRecovery::Settled)
        .unwrap_or(DelegateAttemptRecovery::Missing)
}

fn scrollback_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("delegate-scrollback"))
}

/// The app-process event sink: forwards host events to the webview and keeps
/// app-side state (hook statuses, run mappings) in step with session life.
struct TauriSink {
    app: tauri::AppHandle,
}

impl PtyEventSink for TauriSink {
    fn chunk(&self, session_id: &str, data: &str, seq: u64) {
        let _ = self.app.emit(
            "delegate-pty:data",
            DelegatePtyChunk {
                session_id: session_id.to_string(),
                data: data.to_string(),
                seq,
            },
        );
    }

    fn exit(&self, session_id: &str, outcome: &PtyExitOutcome) {
        // Forget its hook status and tell the frontend so boards can flip the
        // run from running → done.
        self.app
            .state::<crate::delegate::status::DelegateStatusState>()
            .statuses
            .lock()
            .unwrap()
            .remove(session_id);
        let _ = self.app.emit(
            "delegate-pty:exit",
            DelegatePtyExit {
                session_id: session_id.to_string(),
                outcome: outcome.clone(),
            },
        );
        if let Some(dir) = scrollback_dir(&self.app) {
            if let Some(meta) = pty_host::read_scrollback_meta(&dir, session_id) {
                if let Err(error) =
                    crate::missions::record_linked_delegate_attempt_settlement(&self.app, &meta)
                {
                    eprintln!("mission could not record Delegate settlement: {error}");
                }
            }
        }
    }

    fn external_id(&self, session_id: &str, external_id: &str) {
        let _ = set_delegate_external_id(&self.app, session_id, external_id);
    }
}

#[tauri::command]
pub fn pty_spawn(
    app: tauri::AppHandle,
    state: State<PtyState>,
    workspace_root: Option<String>,
) -> Result<(), String> {
    let cwd = workspace_root
        .filter(|path| !path.trim().is_empty())
        .map(|path| {
            let dir = std::path::Path::new(&path);
            if dir.is_dir() {
                Ok(path)
            } else {
                Err(format!("Terminal cwd is not a directory: {path}"))
            }
        })
        .transpose()?;

    if let Some(w) = state.writer.lock().unwrap().as_mut() {
        let mut current = state.cwd.lock().unwrap();
        if cwd.is_some() && *current != cwd {
            let command = format!("cd {}\n", shell_quote(cwd.as_deref().unwrap()));
            w.write_all(command.as_bytes()).map_err(|e| e.to_string())?;
            *current = cwd;
        }
        return Ok(());
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 30,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(shell);
    if let Some(path) = cwd.as_deref() {
        cmd.cwd(path);
    }
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    *state.writer.lock().unwrap() = Some(writer);
    *state.cwd.lock().unwrap() = cwd;

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
            let _ = app.emit("pty:data", chunk);
        }
        let _ = child.wait();
    });

    Ok(())
}

#[tauri::command]
pub fn pty_write(state: State<PtyState>, data: String) -> Result<(), String> {
    if let Some(w) = state.writer.lock().unwrap().as_mut() {
        w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn delegate_pty_spawn(
    app: tauri::AppHandle,
    state: State<DelegatePtyState>,
    status_state: State<crate::delegate::status::DelegateStatusState>,
    session_id: String,
    provider: String,
    workspace_root: Option<String>,
    task: Option<String>,
    model: Option<String>,
    resume_session_id: Option<String>,
    parent_run_id: Option<String>,
    mission_id: Option<String>,
    mission_task_id: Option<String>,
    one_shot: Option<bool>,
) -> Result<(), String> {
    let cwd = workspace_root
        .filter(|path| !path.trim().is_empty())
        .map(|path| {
            let dir = std::path::Path::new(&path);
            if dir.is_dir() {
                Ok(path)
            } else {
                Err(format!("Delegate cwd is not a directory: {path}"))
            }
        })
        .transpose()?;

    // Record parent → child mapping so Mission Control can build the tree
    if let Some(parent_id) = parent_run_id.as_ref() {
        let _ = record_delegate_parent(&app, &session_id, parent_id, &provider);
    }

    // Spawn is idempotent per session id: a live session is reused (cd'ing it
    // when the workspace changed) instead of spawning a second CLI — wherever
    // it lives. In-process first (it may pre-date the daemon toggle), then
    // the daemon.
    if state.host.reuse_or_cd(&session_id, cwd.as_deref())? {
        return Ok(());
    }
    if daemon_enabled(&app) {
        if let Some(dir) = app_data_dir(&app) {
            if let Ok(DaemonResponse::Reused { reused: true }) = pty_client::request(
                &dir,
                &DaemonRequest::ReuseOrCd {
                    session_id: session_id.clone(),
                    cwd: cwd.clone(),
                },
            ) {
                return Ok(());
            }
        }
    }

    // All per-CLI knowledge (spawn syntax, resume flags, model flags) lives
    // behind the Delegate seam. Runtime custom CLIs use the same PTY plumbing
    // with a user-authored shell template.
    let adapter = delegate::lookup(&provider);
    let one_shot = one_shot.unwrap_or(false);
    let command = if let Some(adapter) = adapter {
        if one_shot {
            adapter.mission_command(task.as_deref(), model.as_deref())?
        } else {
            adapter.spawn_command(
                task.as_deref(),
                model.as_deref(),
                resume_session_id.as_deref(),
            )
        }
    } else if let Some(custom) = crate::custom_cli::get(&provider) {
        if one_shot {
            return Err("Custom Delegate CLIs are not yet supported for durable Missions.".into());
        }
        custom.spawn_command(
            task.as_deref(),
            model.as_deref(),
            resume_session_id.as_deref(),
        )
    } else {
        return Err(format!("No delegate PTY command for provider: {provider}"));
    };
    let mission_link = match (mission_id, mission_task_id) {
        (Some(mission_id), Some(task_id)) => {
            let workspace_root = cwd.clone().ok_or_else(|| {
                "A durable Delegate Mission attempt requires a workspace.".to_string()
            })?;
            Some(DelegateMissionLink {
                workspace_root,
                mission_id,
                task_id,
            })
        }
        (None, None) => None,
        _ => {
            return Err(
                "Delegate Mission linkage requires both missionId and missionTaskId.".to_string(),
            )
        }
    };
    // Status hooks (see delegate/status.rs): refresh the CLI's env-guarded
    // lifecycle hooks and hand this session its private callback URL through
    // the PTY env. Both warn-only — a delegate without status hooks still
    // runs, its status just falls back to the idle-timer heuristic. Custom
    // CLIs (no adapter) have no hook installer but still get the URL, so a
    // user-authored wrapper can post its own status.
    if let (Some(adapter), Ok(home)) = (adapter, std::env::var("HOME")) {
        if let Err(e) = adapter.ensure_status_hooks(&home) {
            eprintln!("status hooks for {provider}: {e}");
        }
    }
    let mut env = Vec::new();
    if let Some(url) = status_state.hook_url_for(&app, &session_id) {
        env.push(("KLIDE_HOOK_URL".to_string(), url));
    }

    // Daemon route: the CLI runs inside `klide ptyd` and survives an app
    // restart. Any failure here falls back to a plain in-process session —
    // the user's task always starts; only persistence is lost.
    if daemon_enabled(&app) {
        let daemon_spawn = app_data_dir(&app)
            .ok_or_else(|| "no app data dir".to_string())
            .and_then(|dir| {
                pty_client::ensure_daemon(&dir)?;
                match pty_client::request(
                    &dir,
                    &DaemonRequest::Spawn {
                        session_id: session_id.clone(),
                        provider: provider.clone(),
                        cwd: cwd.clone(),
                        command: command.clone(),
                        env: env.clone(),
                        task: task.clone(),
                        model: model.clone(),
                        resume_session_id: resume_session_id.clone(),
                        mission_link: mission_link.clone(),
                        detect_session_id: adapter.is_some(),
                    },
                )? {
                    DaemonResponse::Ok => Ok(()),
                    DaemonResponse::Err { message } => Err(message),
                    _ => Err("unexpected daemon response to spawn".to_string()),
                }
            });
        match daemon_spawn {
            Ok(()) => {
                start_daemon_subscriber(app.clone());
                return Ok(());
            }
            Err(e) => eprintln!("ptyd spawn failed, falling back in-process: {e}"),
        }
    }

    state.host.spawn(
        SpawnSpec {
            session_id,
            provider,
            cwd,
            command,
            env,
            task,
            model,
            resume_session_id,
            mission_link,
            extract_session_id: adapter.map(|d| {
                Box::new(move |output: &str| d.extract_session_id(output))
                    as Box<dyn Fn(&str) -> Option<String> + Send>
            }),
        },
        scrollback_dir(&app),
        Arc::new(TauriSink { app: app.clone() }),
    )
}

#[tauri::command]
pub fn delegate_pty_write(
    app: tauri::AppHandle,
    state: State<DelegatePtyState>,
    status_state: State<crate::delegate::status::DelegateStatusState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let mut wrote = state.host.write(&session_id, &data)?;
    if !wrote && daemon_enabled(&app) {
        if let Some(dir) = app_data_dir(&app) {
            if let Ok(DaemonResponse::Wrote { wrote: w }) = pty_client::request(
                &dir,
                &DaemonRequest::Write {
                    session_id: session_id.clone(),
                    data: data.clone(),
                },
            ) {
                wrote = w;
            }
        }
    }
    // Typing into the TUI answers whatever the agent was waiting on, so
    // "Needs input" / "Turn done" no longer describe the session. Forget
    // the hook status; the next hook (or the activity timer) re-derives
    // it. This is also what flips Codex back to Active — its notify
    // program has no turn-start event. Housekeeping the TUI asked the
    // terminal to report (focus in/out on every panel switch, mouse
    // wheel scrolls) is NOT the user answering — see `is_user_input` —
    // or a freshly finished turn would flip back to Active the moment
    // the panel changes focus.
    if wrote && pty_host::is_user_input(&data) {
        status_state.statuses.lock().unwrap().remove(&session_id);
    }
    Ok(())
}

#[tauri::command]
pub fn delegate_pty_snapshot(
    app: tauri::AppHandle,
    state: State<DelegatePtyState>,
    session_id: String,
) -> DelegatePtySnapshot {
    // Whichever host has the session live serves its buffer; a session live
    // in the daemon must answer from there (its ring has the authoritative
    // seq for the dedup handshake). Dead sessions read the shared disk log,
    // identical from either side.
    if !state.host.live_ids().contains(&session_id) && daemon_enabled(&app) {
        if let Some(dir) = app_data_dir(&app) {
            if let Ok(DaemonResponse::Snapshot(snap)) = pty_client::request(
                &dir,
                &DaemonRequest::Snapshot {
                    session_id: session_id.clone(),
                },
            ) {
                return snap;
            }
        }
    }
    state
        .host
        .snapshot(&session_id, scrollback_dir(&app).as_deref())
}

#[tauri::command]
pub fn delegate_pty_recent_sessions(
    app: tauri::AppHandle,
    state: State<DelegatePtyState>,
) -> Vec<RecentDelegateSession> {
    let Some(dir) = scrollback_dir(&app) else {
        return Vec::new();
    };
    // "Recent" = persisted but not live ANYWHERE — a session still running in
    // the daemon must not be offered as a reopen.
    let mut live: HashSet<String> = state.host.live_ids();
    live.extend(daemon_live_rows(&app).into_iter().map(|r| r.session_id));
    pty_host::scan_recent_sessions(&dir, &live)
}

/// One live delegate session, for Mission Control's "reattach" surface. These
/// are the sessions Klide can rejoin in-process and replay (via the scrollback
/// buffer) — distinct from on-disk runs, which need a fresh `--resume` spawn.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveDelegateSession {
    /// Full PTY session id (`{convoId}:{provider}`).
    session_id: String,
    /// The AI-panel conversation id — `session_id` minus the `:provider`
    /// suffix. Reattaching opens an AI panel bound to this id so the rebuilt
    /// `DelegateTerminalSurface` lands on the same `session_id`.
    convo_id: String,
    provider: String,
    cwd: Option<String>,
    task: Option<String>,
    model: Option<String>,
    started_ms: i64,
    updated_ms: i64,
    /// Hook-reported state when the CLI has status hooks installed —
    /// `"working"` / `"blocked"` / `"waiting"` (see delegate/status.rs).
    /// Otherwise the timer heuristic: `"running"` while output/input is
    /// fresh, `"idle"` when the PTY has been quiet for a while.
    status: String,
    /// Bytes of replay buffer currently retained — a cheap "has output" signal.
    buffered_bytes: usize,
}

#[tauri::command]
pub fn delegate_pty_live_sessions(
    app: tauri::AppHandle,
    state: State<DelegatePtyState>,
    status_state: State<crate::delegate::status::DelegateStatusState>,
) -> Vec<LiveDelegateSession> {
    let hook_statuses = status_state.statuses.lock().unwrap();
    let now = pty_host::now_ms();
    // Merge both hosts; on an id collision (shouldn't happen — spawn checks
    // both before starting) the in-process row wins.
    let mut rows = state.host.live_rows();
    let local_ids: HashSet<String> = rows.iter().map(|r| r.session_id.clone()).collect();
    rows.extend(
        daemon_live_rows(&app)
            .into_iter()
            .filter(|r| !local_ids.contains(&r.session_id)),
    );
    let mut out: Vec<LiveDelegateSession> = rows
        .into_iter()
        .map(|row| {
            // `session_id` is `{convoId}:{provider}`; strip the known provider
            // suffix to recover the conversation id. Fall back to the whole id
            // if the shape is unexpected.
            let suffix = format!(":{}", row.provider);
            let convo_id = row
                .session_id
                .strip_suffix(&suffix)
                .unwrap_or(&row.session_id)
                .to_string();
            // The CLI's own hooks are the truth when present (they know
            // "blocked on a permission" from "thinking hard" — no amount
            // of PTY-quietness timing does); the timer is the fallback.
            let status = match hook_statuses.get(&row.session_id) {
                Some((hook_status, _)) => hook_status.as_str().to_string(),
                None if now - row.updated_ms >= IDLE_SESSION_MS => "idle".to_string(),
                None => "running".to_string(),
            };
            LiveDelegateSession {
                session_id: row.session_id,
                convo_id,
                provider: row.provider,
                cwd: row.cwd,
                task: row.task,
                model: row.model,
                started_ms: row.started_ms,
                updated_ms: row.updated_ms,
                status,
                buffered_bytes: row.buffered_bytes,
            }
        })
        .collect();
    // Urgency first — a session waiting on the user outranks a busy one, a
    // finished turn outranks background churn — then freshest activity.
    fn urgency(status: &str) -> u8 {
        match status {
            "blocked" => 0,
            "waiting" => 1,
            "working" | "running" => 2,
            _ => 3, // idle
        }
    }
    out.sort_by(|a, b| {
        urgency(&a.status)
            .cmp(&urgency(&b.status))
            .then(b.updated_ms.cmp(&a.updated_ms))
    });
    out
}

#[tauri::command]
pub fn delegate_pty_resize(
    app: tauri::AppHandle,
    state: State<DelegatePtyState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    // Both hosts no-op for an id they don't hold, so just tell both.
    state.host.resize(&session_id, rows, cols)?;
    if daemon_enabled(&app) {
        if let Some(dir) = app_data_dir(&app) {
            let _ = pty_client::request(
                &dir,
                &DaemonRequest::Resize {
                    session_id,
                    rows,
                    cols,
                },
            );
        }
    }
    Ok(())
}

#[tauri::command]
pub fn delegate_pty_stop(
    app: tauri::AppHandle,
    state: State<DelegatePtyState>,
    session_id: String,
) -> Result<(), String> {
    state.host.stop(&session_id);
    if daemon_enabled(&app) {
        if let Some(dir) = app_data_dir(&app) {
            let _ = pty_client::request(&dir, &DaemonRequest::Stop { session_id });
        }
    }
    Ok(())
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DelegatePtyChunk {
    session_id: String,
    data: String,
    /// Monotonic per-session chunk number; lets a reattaching terminal drop
    /// chunks already included in its snapshot.
    seq: u64,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DelegatePtyExit {
    session_id: String,
    outcome: PtyExitOutcome,
}

// ── Delegate session parent tracking ──────────────────────────────────────────
// Records delegate session → parent run ID mappings so Mission Control can
// build the sub-agent tree. The mapping is stored in a JSON file in the app
// data directory.

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct DelegateSessionMapping {
    pub delegate_id: String,
    pub parent_id: String,
    pub provider: String,
    pub created_at_ms: i64,
    /// Once we learn the external session ID (e.g. OpenCode's actual session ID),
    /// we store it here so lookups work both by Klide's internal ID and the
    /// external tool's session ID.
    pub external_id: Option<String>,
}

fn delegate_sessions_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("delegate_sessions.json")
}

pub fn read_delegate_sessions(app: &tauri::AppHandle) -> HashMap<String, DelegateSessionMapping> {
    let path = delegate_sessions_path(app);
    if let Ok(content) = std::fs::read_to_string(&path) {
        if let Ok(mappings) = serde_json::from_str::<Vec<DelegateSessionMapping>>(&content) {
            return mappings
                .into_iter()
                .map(|m| (m.delegate_id.clone(), m))
                .collect();
        }
    }
    HashMap::new()
}

/// Read sessions into TWO maps: one keyed by delegate_id, one by external_id.
/// This lets us look up parent_id by either Klide's session ID or the external
/// session ID that OpenCode/Claude Code/Codex creates internally.
pub fn read_delegate_sessions_by_id(
    app: &tauri::AppHandle,
) -> (
    HashMap<String, DelegateSessionMapping>,
    HashMap<String, DelegateSessionMapping>,
) {
    let path = delegate_sessions_path(app);
    let mut by_delegate = HashMap::new();
    let mut by_external = HashMap::new();
    if let Ok(content) = std::fs::read_to_string(&path) {
        if let Ok(mappings) = serde_json::from_str::<Vec<DelegateSessionMapping>>(&content) {
            for m in mappings {
                by_delegate.insert(m.delegate_id.clone(), m.clone());
                if let Some(ref ext) = m.external_id {
                    by_external.insert(ext.clone(), m);
                }
            }
        }
    }
    (by_delegate, by_external)
}

fn write_delegate_sessions(
    app: &tauri::AppHandle,
    mappings: &HashMap<String, DelegateSessionMapping>,
) -> Result<(), String> {
    let path = delegate_sessions_path(app);
    // Deduplicate by delegate_id before writing
    let mut seen = HashMap::new();
    for m in mappings.values() {
        seen.insert(m.delegate_id.clone(), m.clone());
    }
    let vec: Vec<DelegateSessionMapping> = seen.into_values().collect();
    let content = serde_json::to_string_pretty(&vec).map_err(|e| e.to_string())?;
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

pub fn record_delegate_parent(
    app: &tauri::AppHandle,
    delegate_id: &str,
    parent_id: &str,
    provider: &str,
) -> Result<(), String> {
    let mut mappings = read_delegate_sessions(app);
    mappings.insert(
        delegate_id.to_string(),
        DelegateSessionMapping {
            delegate_id: delegate_id.to_string(),
            parent_id: parent_id.to_string(),
            provider: provider.to_string(),
            created_at_ms: pty_host::now_ms(),
            external_id: None,
        },
    );
    write_delegate_sessions(app, &mappings)
}

/// Record the external session ID (OpenCode's actual session ID) so lookups
/// work by both Klide's internal ID and the external tool's session ID.
pub fn set_delegate_external_id(
    app: &tauri::AppHandle,
    delegate_id: &str,
    external_id: &str,
) -> Result<(), String> {
    let mut mappings = read_delegate_sessions(app);
    if let Some(m) = mappings.get_mut(delegate_id) {
        m.external_id = Some(external_id.to_string());
    }
    write_delegate_sessions(app, &mappings)
}

#[allow(dead_code)]
pub fn get_delegate_parent(app: &tauri::AppHandle, delegate_id: &str) -> Option<String> {
    read_delegate_sessions(app)
        .get(delegate_id)
        .map(|m| m.parent_id.clone())
}
