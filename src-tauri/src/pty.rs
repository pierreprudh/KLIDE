//! Tauri glue for terminals: the native shell PTY (`PtyState`) and the thin
//! command layer over the delegate session host. All delegate session
//! mechanics — scrollback, disk persistence, reader loops — live in
//! [`crate::pty_host`], which is Tauri-free so the same code can run inside
//! the detached `klide ptyd` daemon (Slice 3 of
//! docs/delegate-session-replay.md). This file owns what is genuinely
//! app-side: status hooks, webview event emits, the parent-run mapping, and
//! the two-host choice rules. The provider knowledge a spawn needs — adapter
//! vs custom-CLI command, Mission linkage, cwd rules — is assembled into a
//! [`SpawnSpec`] by the Tauri-free [`crate::pty_spawn`] module.

use crate::delegate::{self, shell_quote};
use crate::pty_client;
// From `pty_wire`, not `pty_daemon`: the daemon module is `#![cfg(unix)]`, and
// an inner cfg *empties* a module rather than removing it — so on a non-unix
// target these three names silently stopped resolving and took the whole
// delegate layer's compilation with them.
use crate::pty_wire::{Event as DaemonEvent, Request as DaemonRequest, Response as DaemonResponse};
use crate::pty_host::{
    self, LiveSessionRow, PtyEventSink, PtyExitOutcome, SessionHost, SpawnSpec,
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

/// One round-trip to `ptyd`, or `None` when there is no daemon to ask.
///
/// Every command below had its own copy of this preamble — find the app data
/// dir, send, match the response — which is how the account switch guard ended
/// up being the one operation that never asked the daemon at all. One helper
/// means the "is there a daemon?" question is answered in a single place, and it
/// is the single place a `cfg(not(unix))` stub would go.
///
/// **This never consults the persistent-sessions toggle, and that is the rule.**
/// Turning persistence off routes *new spawns* in-process; it does not evict
/// what the daemon is already hosting, because those sessions are the user's
/// work. So every other operation — the listings, the liveness checks, and the
/// lifecycle ops — has to keep asking, or a running session becomes invisible.
///
/// There used to be two helpers here, a toggle-gated `ask_daemon` and an
/// `ask_daemon_regardless`, with each call site picking one by name. The rule
/// then drifted, because it was enforced by nothing but that choice:
/// `ReuseOrCd`, `Write` and `Snapshot` were all on the gated path. With the
/// toggle off and a session still hosted by the daemon, it showed on the Live
/// strip and could be stopped and resized, but **typing into it was silently
/// dropped** (the local write returned `false`, the daemon was never asked, and
/// the command still returned `Ok`), and its snapshot fell through to the disk
/// log with `seq: 0`, so reattach repainted history with no dedup high-water
/// mark. `ReuseOrCd` was worse than cosmetic: skipping the daemon there spawns
/// a *second* CLI for a session id the daemon already runs.
///
/// The toggle has exactly one consumer, `delegate_pty_spawn` — the one place
/// the rule says it belongs. `ask_daemon_gate_is_not_toggled` pins that.
///
/// `None` is deliberately indistinguishable from "the daemon doesn't have it":
/// every caller's fallback is the in-process host, which is also what should
/// happen when the daemon is off, unreachable, or mid-restart.
fn ask_daemon(app: &tauri::AppHandle, request: &DaemonRequest) -> Option<DaemonResponse> {
    let dir = app_data_dir(app)?;
    pty_client::request(&dir, request).ok()
}

/// Live sessions the daemon is hosting (empty when unreachable) — for merged
/// live/recent listings and the account-switch guard.
fn daemon_live_rows(app: &tauri::AppHandle) -> Vec<LiveSessionRow> {
    // Through the interface, so `LiveRows` has one speaker. The merge itself
    // stays asymmetric (in-process wins a collision), which is why this returns
    // the daemon's rows rather than walking both hosts.
    DaemonHost { app }.live_rows()
}

// ── Two-host policies ────────────────────────────────────────────────────────
// A delegate session lives in exactly one of two hosts, and every read has to
// answer for both. These are the merge rules, pulled out of the commands so
// they can be stated once and tested without an `AppHandle` — the commands
// above are Tauri glue and stay untestable until the hosts are a trait, but
// the *rules* don't have to be.

/// Both hosts' live rows, in-process first. On an id collision the in-process
/// row wins: spawn checks both hosts before starting, so a duplicate means the
/// daemon is reporting a stale row for a session we ourselves now hold.
fn merge_live_rows(local: Vec<LiveSessionRow>, daemon: Vec<LiveSessionRow>) -> Vec<LiveSessionRow> {
    let local_ids: HashSet<&str> = local.iter().map(|r| r.session_id.as_str()).collect();
    let extra: Vec<LiveSessionRow> = daemon
        .into_iter()
        .filter(|r| !local_ids.contains(r.session_id.as_str()))
        .collect();
    let mut rows = local;
    rows.extend(extra);
    rows
}

/// Every id live *anywhere*. "Recent" means persisted but not in here — a
/// session still running in the daemon must never be offered as a reopen.
fn all_live_ids(local: HashSet<String>, daemon: &[LiveSessionRow]) -> HashSet<String> {
    let mut live = local;
    live.extend(daemon.iter().map(|r| r.session_id.clone()));
    live
}

/// Is any session for `provider` live, given the in-process answer and the
/// daemon's rows? Either host counts — see `provider_has_live_session`.
fn provider_is_live(local_has: bool, daemon: &[LiveSessionRow], provider: &str) -> bool {
    local_has || daemon.iter().any(|row| row.provider == provider)
}

/// The AI-panel conversation id inside a PTY session id.
///
/// Session ids are `{convoId}:{provider}`. That format is composed in the
/// frontend and taken apart here, with no shared constructor — so this is the
/// one place the decomposition is written, and the fallback is explicit:
/// an id that doesn't carry the expected suffix is returned whole rather than
/// silently truncated.
fn convo_id_for(session_id: &str, provider: &str) -> String {
    session_id
        .strip_suffix(&format!(":{provider}"))
        .unwrap_or(session_id)
        .to_string()
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
    match ask_daemon(&app, &DaemonRequest::Ping) {
        Some(DaemonResponse::Pong { version, .. }) => DaemonStatus {
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
        let json =
            serde_json::to_string_pretty(&PtydConfig { enabled }).map_err(|e| e.to_string())?;
        crate::durable::write_atomic(&path, json.as_bytes())?;
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

/// One native shell.
pub struct Shell {
    writer: Box<dyn Write + Send>,
    /// Kept so the shell can be told the real viewport size. Without it the
    /// PTY stays at its spawn-time geometry forever and every wrap — pagers,
    /// `git log`, any TUI — happens at the wrong column. Delegate sessions
    /// already do this (`delegate_pty_resize`); the native shell didn't,
    /// which only became visible once the terminal could fill a whole view.
    master: Box<dyn portable_pty::MasterPty + Send>,
    cwd: Option<String>,
}

/// The native shells, keyed by the terminal tab that owns each one. The
/// frontend mints the ids and is the authority on which exist; Rust keeps them
/// running across panel remounts and layout changes (the workbench drawer and
/// Focus's dock attach to the same sessions, never to copies).
#[derive(Default)]
pub struct PtyState {
    pub shells: Mutex<HashMap<String, Shell>>,
}

// ── The two hosts, behind one interface ──────────────────────────────────────
// A delegate session lives in exactly one host: this process, or `ptyd`. There
// was no interface between them — `SessionHost` is a struct, the daemon's
// `Request` enum was a second hand-written copy of its method list, and every
// command picked a host by hand. That is how `Recent` ended up served but never
// sent, and how the toggle rule drifted onto `Write` and `Snapshot`.
//
// Spawn is here too, but it walks differently: it is the ONE operation that
// consults the persistence toggle (see `spawn_order`), and a host refusing to
// spawn falls through to the next instead of ending the walk.

/// What both session hosts can answer for a session id.
///
/// Every method must no-op (or report "not mine") for an id the host doesn't
/// hold — that is what makes the ordered walks below safe.
trait SessionHosting {
    /// Launch the CLI described by `spec` in this host. Unlike the id-keyed
    /// operations there is no "not mine": a host either starts the session or
    /// errors. Which hosts are even offered — and in what order — is
    /// [`spawn_order`]'s decision, not this method's.
    fn spawn(&self, spec: &SpawnSpec) -> Result<(), String>;
    /// Reuse a live session, `cd`-ing it if the workspace moved. `Ok(false)`
    /// means "not mine".
    fn reuse_or_cd(&self, id: &str, cwd: Option<&str>) -> Result<bool, String>;
    /// `Ok(false)` means "not mine" — never "dropped it".
    fn write(&self, id: &str, data: &str) -> Result<bool, String>;
    fn resize(&self, id: &str, rows: u16, cols: u16);
    fn stop(&self, id: &str);
    /// A snapshot **only** from the host that has the session live, because its
    /// ring carries the authoritative `seq` for the dedup handshake. `None`
    /// means "not mine"; the caller falls back to the shared disk log.
    fn live_snapshot(&self, id: &str) -> Option<DelegatePtySnapshot>;
    fn live_rows(&self) -> Vec<LiveSessionRow>;
}

struct LocalHost<'a> {
    app: &'a tauri::AppHandle,
    host: &'a SessionHost,
}

impl SessionHosting for LocalHost<'_> {
    fn spawn(&self, spec: &SpawnSpec) -> Result<(), String> {
        self.host.spawn(
            spec.clone(),
            scrollback_dir(self.app),
            Arc::new(TauriSink {
                app: self.app.clone(),
            }),
        )
    }
    fn reuse_or_cd(&self, id: &str, cwd: Option<&str>) -> Result<bool, String> {
        self.host.reuse_or_cd(id, cwd)
    }
    fn write(&self, id: &str, data: &str) -> Result<bool, String> {
        self.host.write(id, data)
    }
    fn resize(&self, id: &str, rows: u16, cols: u16) {
        let _ = self.host.resize(id, rows, cols);
    }
    fn stop(&self, id: &str) {
        self.host.stop(id);
    }
    fn live_snapshot(&self, id: &str) -> Option<DelegatePtySnapshot> {
        // `SessionHost::snapshot` also serves dead sessions from disk, so ask
        // about liveness first rather than reading its result.
        self.host
            .live_ids()
            .contains(id)
            .then(|| self.host.snapshot(id, None))
    }
    fn live_rows(&self) -> Vec<LiveSessionRow> {
        self.host.live_rows()
    }
}

struct DaemonHost<'a> {
    app: &'a tauri::AppHandle,
}

impl SessionHosting for DaemonHost<'_> {
    fn spawn(&self, spec: &SpawnSpec) -> Result<(), String> {
        // A daemon-hosted CLI survives an app restart. `ensure_daemon` rather
        // than `ask_daemon`: spawn is the operation that brings the daemon up
        // on demand — every other operation only asks whoever is already
        // there.
        let dir = app_data_dir(self.app).ok_or_else(|| "no app data dir".to_string())?;
        pty_client::ensure_daemon(&dir)?;
        match pty_client::request(
            &dir,
            &DaemonRequest::Spawn {
                session_id: spec.session_id.clone(),
                provider: spec.provider.clone(),
                cwd: spec.cwd.clone(),
                command: spec.command.clone(),
                env: spec.env.clone(),
                task: spec.task.clone(),
                model: spec.model.clone(),
                resume_session_id: spec.resume_session_id.clone(),
                mission_link: spec.mission_link.clone(),
                detect_session_id: spec.detect_session_id,
            },
        )? {
            DaemonResponse::Ok => {
                // Its events must reach the webview like a local session's do.
                start_daemon_subscriber(self.app.clone());
                Ok(())
            }
            DaemonResponse::Err { message } => Err(message),
            _ => Err("unexpected daemon response to spawn".to_string()),
        }
    }
    fn reuse_or_cd(&self, id: &str, cwd: Option<&str>) -> Result<bool, String> {
        match ask_daemon(
            self.app,
            &DaemonRequest::ReuseOrCd {
                session_id: id.to_string(),
                cwd: cwd.map(|c| c.to_string()),
            },
        ) {
            Some(DaemonResponse::Reused { reused }) => Ok(reused),
            _ => Ok(false),
        }
    }
    fn write(&self, id: &str, data: &str) -> Result<bool, String> {
        match ask_daemon(
            self.app,
            &DaemonRequest::Write {
                session_id: id.to_string(),
                data: data.to_string(),
            },
        ) {
            Some(DaemonResponse::Wrote { wrote }) => Ok(wrote),
            _ => Ok(false),
        }
    }
    fn resize(&self, id: &str, rows: u16, cols: u16) {
        ask_daemon(
            self.app,
            &DaemonRequest::Resize {
                session_id: id.to_string(),
                rows,
                cols,
            },
        );
    }
    fn stop(&self, id: &str) {
        ask_daemon(
            self.app,
            &DaemonRequest::Stop {
                session_id: id.to_string(),
            },
        );
    }
    fn live_snapshot(&self, id: &str) -> Option<DelegatePtySnapshot> {
        match ask_daemon(
            self.app,
            &DaemonRequest::Snapshot {
                session_id: id.to_string(),
            },
        ) {
            Some(DaemonResponse::Snapshot(snap)) if snap.live => Some(snap),
            _ => None,
        }
    }
    fn live_rows(&self) -> Vec<LiveSessionRow> {
        match ask_daemon(self.app, &DaemonRequest::LiveRows) {
            Some(DaemonResponse::LiveRows { rows }) => rows,
            _ => Vec::new(),
        }
    }
}

/// Both hosts, in the order every operation must consult them: **in-process
/// first**. It may hold sessions that pre-date the daemon toggle, and a session
/// it holds is definitively not the daemon's.
fn both_hosts<'a>(
    app: &'a tauri::AppHandle,
    local: &'a SessionHost,
) -> [Box<dyn SessionHosting + 'a>; 2] {
    [
        Box::new(LocalHost { app, host: local }),
        Box::new(DaemonHost { app }),
    ]
}

/// Which hosts a FRESH spawn may use, in order. **Spawn is the one
/// toggle-gated operation** (see `ask_daemon` for why everything else must
/// keep asking): with persistent sessions on, the daemon comes first so the
/// CLI survives an app restart; with it off, the daemon is never offered a
/// new session — what it already hosts stays reachable through the ungated
/// operations above.
///
/// Generic so the rule is testable with fakes; production passes the two
/// boxed hosts.
fn spawn_order<H>(daemon_on: bool, local: H, daemon: H) -> Vec<H> {
    if daemon_on {
        vec![daemon, local]
    } else {
        vec![local]
    }
}

/// Spawn on the first host that accepts. A refusal from any host but the last
/// falls through with a note — the user's task always starts; only persistence
/// is lost. Mirrors `first_host_that_claims`, except spawn has no "not mine":
/// only success, or an error worth falling back on.
fn first_host_that_spawns(
    hosts: &[Box<dyn SessionHosting + '_>],
    spec: &SpawnSpec,
) -> Result<(), String> {
    let last = hosts.len().saturating_sub(1);
    for (i, host) in hosts.iter().enumerate() {
        match host.spawn(spec) {
            Ok(()) => return Ok(()),
            Err(e) if i < last => {
                eprintln!("delegate spawn failed, falling back to the next host: {e}")
            }
            Err(e) => return Err(e),
        }
    }
    Err("no session host available to spawn".to_string())
}

/// Hand the operation to each host in order and stop at the first that claims
/// the session. An error from a host is the caller's error — "not mine" is
/// `Ok(false)`, never an `Err`.
fn first_host_that_claims<'a>(
    app: &'a tauri::AppHandle,
    local: &'a SessionHost,
    mut op: impl FnMut(&dyn SessionHosting) -> Result<bool, String>,
) -> Result<bool, String> {
    for host in both_hosts(app, local) {
        if op(host.as_ref())? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// For operations where a host that doesn't hold the id simply does nothing, so
/// there is no ownership question to answer: tell both.
fn tell_every_host<'a>(
    app: &'a tauri::AppHandle,
    local: &'a SessionHost,
    mut op: impl FnMut(&dyn SessionHosting),
) {
    for host in both_hosts(app, local) {
        op(host.as_ref());
    }
}

/// Is a delegate PTY for `provider` live in **either** host?
///
/// Account switching refuses to swap a CLI's credentials while one of its
/// sessions is running, because the CLI refreshes its token and writes back to
/// the store being replaced. That guard used to ask only the in-process
/// `SessionHost`, so a `ptyd`-hosted session — the whole point of which is to
/// outlive the app — sailed straight through it. Every other operation in this
/// file already unions the two hosts; this was the one that didn't.
///
/// Only covers Klide-spawned PTYs either way: a CLI the user started in their
/// own terminal is invisible to us.
pub(crate) fn provider_has_live_session(app: &tauri::AppHandle, provider: &str) -> bool {
    let local = app
        .state::<SessionHost>()
        .has_live_session(provider);
    provider_is_live(local, &daemon_live_rows(app), provider)
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
        .state::<SessionHost>()
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

/// Translate the hosting vocabulary into the historical board's wire status.
/// A completed live turn remains available in the green Live strip, while its
/// transcript row is settled. Only a real blocked hook becomes board
/// `waiting`, whose established meaning is "cannot proceed without you".
fn historical_board_status(
    live: bool,
    hook: Option<crate::delegate::status::AgentStatus>,
    outcome: Option<&PtyExitOutcome>,
) -> &'static str {
    if live {
        return match hook {
            Some(crate::delegate::status::AgentStatus::Blocked) => "waiting",
            Some(crate::delegate::status::AgentStatus::Waiting) => "done",
            Some(crate::delegate::status::AgentStatus::Working) | None => "running",
        };
    }
    match outcome {
        Some(outcome) if outcome.exit_code != 0 && !outcome.stop_requested => "error",
        _ => "done",
    }
}

/// Provider transcript id → authoritative status for sessions Klide hosted.
///
/// The adapter parsers still cover CLI sessions launched in another terminal.
/// For Klide-owned PTYs this index wins: live hook state distinguishes blocked
/// from working, and durable exit metadata settles the row immediately instead
/// of waiting for a transcript-mtime timeout. Multiple PTYs may have resumed
/// the same CLI thread; the newest spawn is the relevant one.
pub(crate) fn historical_delegate_statuses(
    app: &tauri::AppHandle,
) -> HashMap<(String, String), String> {
    let Some(dir) = scrollback_dir(app) else {
        return HashMap::new();
    };
    let daemon = daemon_live_rows(app);
    let live_ids = all_live_ids(app.state::<SessionHost>().live_ids(), &daemon);
    let hooks = app
        .state::<crate::delegate::status::DelegateStatusState>()
        .statuses
        .lock()
        .unwrap()
        .clone();
    let mut newest: HashMap<(String, String), (i64, String)> = HashMap::new();
    for meta in pty_host::scan_scrollback_metas(&dir) {
        let Some(external_id) = meta
            .resume_session_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        let status = historical_board_status(
            live_ids.contains(&meta.session_id),
            hooks.get(&meta.session_id).map(|(status, _)| *status),
            meta.exit_outcome.as_ref(),
        )
        .to_string();
        let key = (meta.provider.clone(), external_id.to_string());
        match newest.get(&key) {
            Some((started_ms, _)) if *started_ms > meta.started_ms => {}
            _ => {
                newest.insert(key, (meta.started_ms, status));
            }
        }
    }
    newest
        .into_iter()
        .map(|(key, (_, status))| (key, status))
        .collect()
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
        // Settle the coordination Run (done / failed / cancelled) and drop the
        // session's bridge identity — a dead PTY acts as nobody.
        if let Err(error) = crate::coordination_bridge::settle_delegate(
            self.app.state::<crate::coordination::CoordinationStoreState>().inner(),
            &bridge_hooks(&self.app),
            self.app.state::<crate::coordination_bridge::CoordinationBridgeState>().inner(),
            session_id,
            outcome.exit_code,
            outcome.stop_requested,
        ) {
            eprintln!("coordination could not settle Delegate {session_id}: {error}");
        }
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

/// One chunk of shell output, tagged with the session it came from. Every
/// terminal pane listens to `pty:data` and keeps only its own id.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyChunk {
    id: String,
    chunk: String,
}

/// What a terminal tab should call itself: the foreground process, or the empty
/// string when the shell itself is in the foreground (nothing is running).
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyTitle {
    id: String,
    title: String,
}

/// The command name for a pid, via `ps`. `comm` rather than the full argv on
/// purpose: argv for anything launched through a wrapper is a path salad
/// (`npm run dev` really is `node .../npm-cli.js run dev`), and a tab is one
/// word wide. Login shells report as `-zsh`, hence the leading dash trim.
fn process_name(pid: i32) -> Option<String> {
    let out = std::process::Command::new("ps")
        .args(["-o", "comm=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let name = raw
        .rsplit('/')
        .next()
        .unwrap_or(&raw)
        .trim_start_matches('-')
        .to_string();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// Watch which process holds the terminal's foreground process group and report
/// it as the tab's title. Polling is the only way to know this — a shell doesn't
/// announce what it launched — but it's cheap here: the pgid is read straight
/// from the tty, and `ps` only runs when that pgid actually changes. The thread
/// retires as soon as its shell leaves the map.
fn watch_shell_title(app: tauri::AppHandle, id: String, shell_pid: Option<u32>) {
    std::thread::spawn(move || {
        let mut last_pgid: Option<i32> = None;
        let mut last_title: Option<String> = None;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(1200));
            let Some(state) = app.try_state::<PtyState>() else {
                return;
            };
            let pgid = {
                let shells = state.shells.lock().unwrap();
                match shells.get(&id) {
                    Some(shell) => shell.master.process_group_leader(),
                    // Closed — nothing left to title.
                    None => return,
                }
            };
            if pgid == last_pgid {
                continue;
            }
            last_pgid = pgid;
            // The shell in its own foreground means the prompt is idle.
            let title = match pgid {
                Some(pid) if Some(pid as u32) != shell_pid => process_name(pid).unwrap_or_default(),
                _ => String::new(),
            };
            if last_title.as_deref() == Some(title.as_str()) {
                continue;
            }
            last_title = Some(title.clone());
            let _ = app.emit(
                "pty:title",
                PtyTitle {
                    id: id.clone(),
                    title,
                },
            );
        }
    });
}

/// Start the shell for terminal `id`, or adopt the one already running under
/// that id. Idempotent on purpose: a pane remounts (panel switch, layout
/// change, Focus ↔ workbench) far more often than a shell should restart, so a
/// second call only corrects the cwd.
#[tauri::command]
pub fn pty_spawn(
    app: tauri::AppHandle,
    state: State<PtyState>,
    id: String,
    workspace_root: Option<String>,
    rows: Option<u16>,
    cols: Option<u16>,
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

    {
        let mut shells = state.shells.lock().unwrap();
        if let Some(shell) = shells.get_mut(&id) {
            if cwd.is_some() && shell.cwd != cwd {
                let command = format!("cd {}\n", shell_quote(cwd.as_deref().unwrap()));
                shell
                    .writer
                    .write_all(command.as_bytes())
                    .map_err(|e| e.to_string())?;
                shell.cwd = cwd;
            }
            return Ok(());
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        // Spawn at the caller's real viewport when it knows it — the shell reads
        // the geometry once at startup, so guessing 30x100 and correcting after
        // makes the first prompt (and anything printed before the first resize)
        // wrap at the wrong column.
        .openpty(PtySize {
            rows: rows.filter(|r| *r > 0).unwrap_or(30),
            cols: cols.filter(|c| *c > 0).unwrap_or(100),
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
    // Captured before `child` moves into the reader thread — the watcher needs
    // it to tell "the shell is idle" from "the shell launched something".
    let shell_pid = child.process_id();

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    state.shells.lock().unwrap().insert(
        id.clone(),
        Shell {
            writer,
            master: pair.master,
            cwd,
        },
    );

    watch_shell_title(app.clone(), id.clone(), shell_pid);

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
            let _ = app.emit(
                "pty:data",
                PtyChunk {
                    id: id.clone(),
                    chunk,
                },
            );
        }
        let _ = child.wait();
        // The shell is gone (`exit`, or the user killed it). Drop it so the id
        // is free to spawn again, and tell the UI so the tab can close itself
        // instead of sitting there dead.
        if let Some(state) = app.try_state::<PtyState>() {
            state.shells.lock().unwrap().remove(&id);
        }
        let _ = app.emit("pty:exit", id);
    });

    Ok(())
}

/// Tell one shell how big its window actually is. Per session now, so a split
/// no longer has two panes fighting over a single geometry.
#[tauri::command]
pub fn pty_resize(state: State<PtyState>, id: String, rows: u16, cols: u16) -> Result<(), String> {
    if rows == 0 || cols == 0 {
        return Ok(());
    }
    if let Some(shell) = state.shells.lock().unwrap().get(&id) {
        shell
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn pty_write(state: State<PtyState>, id: String, data: String) -> Result<(), String> {
    if let Some(shell) = state.shells.lock().unwrap().get_mut(&id) {
        shell
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Close a terminal tab: drop the shell so its PTY hangs up and the child sees
/// EOF. The reader thread then emits `pty:exit` on its way out.
#[tauri::command]
pub fn pty_close(state: State<PtyState>, id: String) -> Result<(), String> {
    state.shells.lock().unwrap().remove(&id);
    Ok(())
}

#[tauri::command]
pub fn delegate_pty_spawn(
    app: tauri::AppHandle,
    host: State<SessionHost>,
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
    let cwd = crate::pty_spawn::validated_cwd(workspace_root)?;

    // Record parent → child mapping so Mission Control can build the tree
    if let Some(parent_id) = parent_run_id.as_ref() {
        let _ = record_delegate_parent(&app, &session_id, parent_id, &provider);
    }

    // Spawn is idempotent per session id: a live session is reused (cd'ing it
    // when the workspace changed) instead of spawning a second CLI — wherever
    // it lives. In-process first (it may pre-date the daemon toggle), then
    // the daemon.
    if first_host_that_claims(&app, &host, |h| h.reuse_or_cd(&session_id, cwd.as_deref()))? {
        return Ok(());
    }

    // Status hooks (see delegate/status.rs): refresh the CLI's env-guarded
    // lifecycle hooks and hand this session its private callback URL through
    // the spec's env. Both warn-only — a delegate without status hooks still
    // runs, its status just falls back to the idle-timer heuristic. Custom
    // CLIs (no adapter) have no hook installer but still get the URL, so a
    // user-authored wrapper can post its own status.
    let adapter = delegate::lookup(&provider);
    if let (Some(adapter), Ok(home)) = (adapter, std::env::var("HOME")) {
        if let Err(e) = adapter.ensure_status_hooks(&home) {
            eprintln!("status hooks for {provider}: {e}");
        }
    }
    let hook_url = status_state.hook_url_for(&app, &session_id);

    // Coordination (coordination_bridge.rs): register the Delegate as a Run
    // its peers can address, bind this session to that identity, and hand the
    // CLI Klide's MCP server. Warn-only, like the status hooks — a Delegate
    // that cannot be wired still runs, it just has no `agent_*` tools.
    let (bridge_url, mcp) = match (adapter, cwd.as_deref()) {
        (Some(adapter), Some(root)) => wire_coordination(
            &app,
            adapter,
            &session_id,
            &provider,
            root,
            task.as_deref(),
            parent_run_id.as_deref(),
            mission_id.as_deref(),
            mission_task_id.as_deref(),
        ),
        _ => (None, None),
    };

    // Everything decidable without an AppHandle — the adapter-vs-custom-CLI
    // command, the one-shot Mission branch, and the Mission-link validation —
    // is `spawn_spec_for`'s job (and tested there, not here).
    let spec = crate::pty_spawn::spawn_spec_for(crate::pty_spawn::SpawnRequest {
        session_id,
        provider: provider.clone(),
        cwd,
        task,
        model,
        resume_session_id,
        mission_id,
        mission_task_id,
        one_shot: one_shot.unwrap_or(false),
        hook_url,
        custom_cli: if adapter.is_none() {
            crate::custom_cli::get(&provider)
        } else {
            None
        },
        bridge_url,
        mcp,
    })?;

    let hosts = spawn_order(
        daemon_enabled(&app),
        Box::new(LocalHost {
            app: &app,
            host: &host,
        }) as Box<dyn SessionHosting + '_>,
        Box::new(DaemonHost { app: &app }) as _,
    );
    first_host_that_spawns(&hosts, &spec)
}

/// The app-side closures the coordination bridge needs: announce a journal
/// change the way every other writer does, and answer "is this Run around?"
/// for both kinds of worker — a Harness Run holds a live handle, a Delegate
/// holds a bound bridge session.
fn bridge_hooks(app: &tauri::AppHandle) -> crate::coordination_bridge::BridgeHooks {
    let emit_app = app.clone();
    let live_app = app.clone();
    crate::coordination_bridge::BridgeHooks {
        on_change: Box::new(move |root, outcome| {
            crate::coordination::emit_coordination_changed(&emit_app, root, outcome);
        }),
        is_live: Box::new(move |run_id| {
            let harness = live_app
                .state::<crate::agent::AgentSupervisorState>()
                .runs
                .lock()
                .map(|runs| runs.contains_key(run_id))
                .unwrap_or(false);
            harness
                || live_app
                    .state::<crate::coordination_bridge::CoordinationBridgeState>()
                    .is_bound_run(run_id)
        }),
    }
}

/// A Delegate's coordination Run id is its conversation id — the same id the
/// AI panel, the stored-conversation index, and the peer link UI already use
/// for a thread (`delegateSessionId` in src/ipc/delegatePty.ts is the other
/// half of this rule).
pub(crate) fn delegate_run_id(session_id: &str, provider: &str) -> String {
    convo_id_for(session_id, provider)
}

/// Register the Delegate as a coordination Run, bind its session at the
/// bridge, and compute the adapter's MCP wiring (writing any config file it
/// asks for). Returns `(None, None)` — and logs why — when any step fails, so
/// the spawn itself never depends on coordination.
#[allow(clippy::too_many_arguments)]
pub(crate) fn wire_coordination(
    app: &tauri::AppHandle,
    adapter: &dyn delegate::Delegate,
    session_id: &str,
    provider: &str,
    workspace_root: &str,
    task: Option<&str>,
    parent_run_id: Option<&str>,
    mission_id: Option<&str>,
    mission_task_id: Option<&str>,
) -> (Option<String>, Option<delegate::McpWiring>) {
    let store = app.state::<crate::coordination::CoordinationStoreState>();
    let bridge = app.state::<crate::coordination_bridge::CoordinationBridgeState>();
    let run_id = delegate_run_id(session_id, provider);
    if let Err(error) = crate::coordination_bridge::register_delegate(
        store.inner(),
        &bridge_hooks(app),
        bridge.inner(),
        crate::coordination_bridge::DelegateRegistration {
            session_id,
            run_id: &run_id,
            workspace_root,
            task,
            parent_run_id,
            mission_id,
            mission_task_id,
        },
    ) {
        wiring_failed(app, session_id, format!("could not register the Run: {error}"));
        return (None, None);
    }
    let Some(bridge_url) =
        bridge.bridge_url_for(session_id, store.inner().clone(), bridge_hooks(app))
    else {
        wiring_failed(app, session_id, "the coordination bridge could not start".to_string());
        return (None, None);
    };
    let wiring = match mcp_wiring_for(app, adapter, session_id, &bridge_url) {
        Ok(wiring) => wiring,
        Err(reason) => {
            wiring_failed(app, session_id, reason);
            None
        }
    };
    (Some(bridge_url), wiring)
}

/// A Delegate that starts without its coordination tools is a silent
/// failure the user would only discover by asking the CLI — so it is said
/// once, on the toast bus (src/delegateStatusNotify.ts listens) and in the
/// dev log, and the session still runs.
fn wiring_failed(app: &tauri::AppHandle, session_id: &str, reason: String) {
    eprintln!("coordination could not wire Delegate {session_id}: {reason}");
    let _ = app.emit(
        "coordination:wiring-failed",
        serde_json::json!({ "sessionId": session_id, "reason": reason }),
    );
}

/// Ask the adapter how its CLI learns about `klide mcp coordination`, then
/// write the files it needs under the app data dir. The server command is
/// this very executable — the `klide ptyd` pattern, nothing to bundle.
fn mcp_wiring_for(
    app: &tauri::AppHandle,
    adapter: &dyn delegate::Delegate,
    session_id: &str,
    bridge_url: &str,
) -> Result<Option<delegate::McpWiring>, String> {
    let exe = std::env::current_exe().map_err(|e| format!("no path to the Klide binary: {e}"))?;
    let config_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("delegate-mcp");
    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("could not create the MCP config dir: {e}"))?;
    let file_stem: String = session_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let Some(wiring) = adapter.mcp_wiring(&delegate::McpServerSpec {
        command: exe.to_string_lossy().to_string(),
        args: vec!["mcp".to_string(), "coordination".to_string()],
        bridge_url: bridge_url.to_string(),
        config_dir: config_dir.to_string_lossy().to_string(),
        file_stem,
    }) else {
        // This CLI has no MCP client Klide configures (omp): not a failure.
        return Ok(None);
    };
    for (path, content) in &wiring.files {
        std::fs::write(path, content).map_err(|e| format!("could not write {path}: {e}"))?;
    }
    Ok(Some(wiring))
}

/// A Delegate status hook (`working` / `blocked` / `waiting`) is also the
/// Run's coordination state; called from the status server's change callback.
pub(crate) fn note_delegate_coordination_status(
    app: &tauri::AppHandle,
    session_id: &str,
    status: &str,
) {
    if let Err(error) = crate::coordination_bridge::note_delegate_status(
        app.state::<crate::coordination::CoordinationStoreState>().inner(),
        &bridge_hooks(app),
        app.state::<crate::coordination_bridge::CoordinationBridgeState>().inner(),
        session_id,
        status,
    ) {
        eprintln!("coordination could not note Delegate status for {session_id}: {error}");
    }
}

#[tauri::command]
pub fn delegate_pty_write(
    app: tauri::AppHandle,
    host: State<SessionHost>,
    status_state: State<crate::delegate::status::DelegateStatusState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let wrote = first_host_that_claims(&app, &host, |h| h.write(&session_id, &data))?;
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
pub async fn delegate_pty_snapshot(
    app: tauri::AppHandle,
    host: State<'_, SessionHost>,
    session_id: String,
) -> Result<DelegatePtySnapshot, String> {
    let host = host.inner().clone();
    // A daemon socket round-trip plus up to 1 MB of disk log — off the main
    // thread (blocking.rs).
    crate::blocking::run(move || {
        // Whichever host has the session live serves its buffer — its ring has
        // the authoritative seq for the dedup handshake.
        for h in both_hosts(&app, &host) {
            if let Some(snap) = h.live_snapshot(&session_id) {
                return Ok(snap);
            }
        }
        // Neither hosts it: the shared disk log, identical from either side.
        Ok(host.snapshot(&session_id, scrollback_dir(&app).as_deref()))
    })
    .await
}

#[tauri::command]
pub async fn delegate_pty_recent_sessions(
    app: tauri::AppHandle,
    host: State<'_, SessionHost>,
) -> Result<Vec<RecentDelegateSession>, String> {
    let host = host.inner().clone();
    // Polled every 2.5 s by Mission Control: a daemon round-trip plus a
    // read_dir + one JSON parse per persisted session — off the main thread.
    crate::blocking::run(move || {
        let Some(dir) = scrollback_dir(&app) else {
            return Ok(Vec::new());
        };
        // "Recent" = persisted but not live ANYWHERE — a session still running
        // in the daemon must not be offered as a reopen.
        let live = all_live_ids(host.live_ids(), &daemon_live_rows(&app));
        Ok(pty_host::scan_recent_sessions(&dir, &live))
    })
    .await
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
    host: State<SessionHost>,
    status_state: State<crate::delegate::status::DelegateStatusState>,
) -> Vec<LiveDelegateSession> {
    let hook_statuses = status_state.statuses.lock().unwrap();
    let now = pty_host::now_ms();
    // Merge both hosts; on an id collision (shouldn't happen — spawn checks
    // both before starting) the in-process row wins.
    let rows = merge_live_rows(host.live_rows(), daemon_live_rows(&app));
    let mut out: Vec<LiveDelegateSession> = rows
        .into_iter()
        .map(|row| {
            // `session_id` is `{convoId}:{provider}`; strip the known provider
            // suffix to recover the conversation id. Fall back to the whole id
            // if the shape is unexpected.
            let convo_id = convo_id_for(&row.session_id, &row.provider);
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
    host: State<SessionHost>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    // Both hosts no-op for an id they don't hold, so there is no ownership
    // question — and the daemon may still be hosting the session the user is
    // looking at, which would otherwise keep the old geometry forever.
    tell_every_host(&app, &host, |h| h.resize(&session_id, rows, cols));
    Ok(())
}

#[tauri::command]
pub fn delegate_pty_stop(
    app: tauri::AppHandle,
    host: State<SessionHost>,
    session_id: String,
) -> Result<(), String> {
    // Both, or turning persistence off would leave the sessions the daemon
    // already hosts with no way to be stopped from the UI.
    tell_every_host(&app, &host, |h| h.stop(&session_id));
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
    // Atomic: two threads write this file (the PTY session-id detector and the
    // hook server), so a truncating write can be observed half-done.
    crate::durable::write_atomic(&path, content.as_bytes())
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
    // This link is useful even when the session has no parent-run mapping:
    // recent-session resume and historical lifecycle enrichment both read the
    // durable PTY metadata.
    if let Some(dir) = scrollback_dir(app) {
        pty_host::update_scrollback_resume_id(&dir, delegate_id, external_id);
    }
    let mut mappings = read_delegate_sessions(app);
    if let Some(m) = mappings.get_mut(delegate_id) {
        if m.external_id.as_deref() != Some(external_id) {
            m.external_id = Some(external_id.to_string());
            write_delegate_sessions(app, &mappings)?;
        }
    }
    Ok(())
}

#[allow(dead_code)]
pub fn get_delegate_parent(app: &tauri::AppHandle, delegate_id: &str) -> Option<String> {
    read_delegate_sessions(app)
        .get(delegate_id)
        .map(|m| m.parent_id.clone())
}

#[cfg(test)]
mod tests {
    //! The two-host merge rules. The commands around them are Tauri glue and
    //! need an `AppHandle`, which is why this file carried no tests at all —
    //! but the rules themselves are data in, data out, and they are where the
    //! bugs were: the account-switch guard asked only the in-process host, and
    //! stop/resize skipped the daemon whenever the persistence toggle was off.
    use super::*;

    fn row(session_id: &str, provider: &str) -> LiveSessionRow {
        LiveSessionRow {
            session_id: session_id.to_string(),
            provider: provider.to_string(),
            cwd: None,
            task: None,
            model: None,
            started_ms: 0,
            updated_ms: 0,
            buffered_bytes: 0,
        }
    }

    #[test]
    fn hosted_lifecycle_overrides_transcript_recency_for_the_board() {
        use crate::delegate::status::AgentStatus;

        assert_eq!(
            historical_board_status(true, Some(AgentStatus::Working), None),
            "running"
        );
        assert_eq!(
            historical_board_status(true, Some(AgentStatus::Blocked), None),
            "waiting"
        );
        assert_eq!(
            historical_board_status(true, Some(AgentStatus::Waiting), None),
            "done",
            "turn-complete waiting stays green in the Live strip; the transcript is settled"
        );
        let failed = PtyExitOutcome {
            exit_code: 1,
            signal: None,
            stop_requested: false,
        };
        assert_eq!(historical_board_status(false, None, Some(&failed)), "error");
        let stopped = PtyExitOutcome {
            stop_requested: true,
            ..failed
        };
        assert_eq!(historical_board_status(false, None, Some(&stopped)), "done");
    }

    #[test]
    fn merge_live_rows_keeps_both_hosts_and_prefers_in_process() {
        let local = vec![row("a:claude-code", "claude-code")];
        let daemon = vec![row("b:codex", "codex")];
        let merged = merge_live_rows(local, daemon);
        assert_eq!(
            merged
                .iter()
                .map(|r| r.session_id.as_str())
                .collect::<Vec<_>>(),
            ["a:claude-code", "b:codex"],
            "in-process rows come first"
        );

        // A collision means the daemon is reporting a session we now hold
        // ourselves. Taking both would double the row on the board.
        let mut stale = row("a:claude-code", "claude-code");
        stale.task = Some("stale".into());
        let merged = merge_live_rows(vec![row("a:claude-code", "claude-code")], vec![stale]);
        assert_eq!(merged.len(), 1);
        assert!(merged[0].task.is_none(), "the in-process row won");
    }

    #[test]
    fn recent_excludes_sessions_live_in_either_host() {
        let live = all_live_ids(
            HashSet::from(["a:claude-code".to_string()]),
            &[row("b:codex", "codex")],
        );
        assert!(live.contains("a:claude-code"));
        // The one that matters: a session running in the daemon must not be
        // offered as a "reopen", or clicking it spawns a second CLI.
        assert!(live.contains("b:codex"));
        assert!(!live.contains("c:opencode"));
    }

    #[test]
    fn a_daemon_hosted_session_blocks_an_account_switch() {
        let daemon = [row("a:claude-code", "claude-code")];

        // The bug this replaced: the guard consulted only the in-process host,
        // so a ptyd-hosted session — the whole point of which is to outlive the
        // app — let the switch through, and the running CLI then wrote its
        // refreshed token back into the store that had just been replaced.
        assert!(provider_is_live(false, &daemon, "claude-code"));
        // A different CLI is unaffected.
        assert!(!provider_is_live(false, &daemon, "codex"));
        // In-process alone still counts, with no daemon rows at all.
        assert!(provider_is_live(true, &[], "claude-code"));
        assert!(!provider_is_live(false, &[], "claude-code"));
    }

    #[test]
    fn convo_id_strips_only_the_matching_provider_suffix() {
        assert_eq!(convo_id_for("run-7:claude-code", "claude-code"), "run-7");
        // Colons are legal inside a conversation id, so only the trailing
        // `:provider` comes off.
        assert_eq!(convo_id_for("a:b:codex", "codex"), "a:b");
        // Unexpected shape: return the id whole rather than truncate it, or
        // reattach would bind an AI panel to a conversation that doesn't exist.
        assert_eq!(convo_id_for("run-7", "claude-code"), "run-7");
        assert_eq!(convo_id_for("run-7:codex", "claude-code"), "run-7:codex");
    }

    // ── Routing over the two hosts ──────────────────────────────────────────
    // `first_host_that_claims` / `tell_every_host` take `&dyn SessionHosting`,
    // so the ordering and the stop-at-first rules can be driven with fakes.
    // Neither real adapter is reachable from here — `LocalHost` needs a live
    // PTY and `DaemonHost` an `AppHandle` — which is exactly why the rules are
    // separated from them.

    #[derive(Default)]
    struct FakeHost {
        name: &'static str,
        holds: Option<&'static str>,
        log: Arc<Mutex<Vec<String>>>,
        fail: bool,
    }

    impl SessionHosting for FakeHost {
        fn spawn(&self, spec: &SpawnSpec) -> Result<(), String> {
            self.record("spawn", &spec.session_id);
            if self.fail {
                return Err(format!("{} exploded", self.name));
            }
            Ok(())
        }
        fn reuse_or_cd(&self, id: &str, _cwd: Option<&str>) -> Result<bool, String> {
            self.record("reuse", id);
            self.claim(id)
        }
        fn write(&self, id: &str, _data: &str) -> Result<bool, String> {
            self.record("write", id);
            self.claim(id)
        }
        fn resize(&self, id: &str, _rows: u16, _cols: u16) {
            self.record("resize", id);
        }
        fn stop(&self, id: &str) {
            self.record("stop", id);
        }
        fn live_snapshot(&self, id: &str) -> Option<DelegatePtySnapshot> {
            self.record("snapshot", id);
            None
        }
        fn live_rows(&self) -> Vec<LiveSessionRow> {
            Vec::new()
        }
    }

    impl FakeHost {
        fn record(&self, op: &str, id: &str) {
            self.log
                .lock()
                .unwrap()
                .push(format!("{}:{op}:{id}", self.name));
        }
        fn claim(&self, id: &str) -> Result<bool, String> {
            if self.fail {
                return Err(format!("{} exploded", self.name));
            }
            Ok(self.holds == Some(id))
        }
    }

    /// The same walk `first_host_that_claims` performs, over injected hosts.
    fn walk_claiming(
        hosts: &[&dyn SessionHosting],
        mut op: impl FnMut(&dyn SessionHosting) -> Result<bool, String>,
    ) -> Result<bool, String> {
        for h in hosts {
            if op(*h)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    #[test]
    fn the_first_host_that_claims_a_session_ends_the_walk() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let local = FakeHost {
            name: "local",
            holds: Some("a:codex"),
            log: log.clone(),
            fail: false,
        };
        let daemon = FakeHost {
            name: "daemon",
            holds: Some("a:codex"),
            log: log.clone(),
            fail: false,
        };

        let wrote = walk_claiming(&[&local, &daemon], |h| h.write("a:codex", "hi")).unwrap();
        assert!(wrote);
        // In-process is asked first and the daemon is never troubled — a session
        // the local host holds is definitively not the daemon's.
        assert_eq!(*log.lock().unwrap(), ["local:write:a:codex"]);
    }

    #[test]
    fn a_session_the_local_host_does_not_hold_falls_through_to_the_daemon() {
        // The regression this shape prevents: keystrokes for a ptyd-hosted
        // session used to be dropped, and the command still returned Ok.
        let log = Arc::new(Mutex::new(Vec::new()));
        let local = FakeHost {
            name: "local",
            holds: None,
            log: log.clone(),
            fail: false,
        };
        let daemon = FakeHost {
            name: "daemon",
            holds: Some("b:claude-code"),
            log: log.clone(),
            fail: false,
        };

        let wrote = walk_claiming(&[&local, &daemon], |h| h.write("b:claude-code", "hi")).unwrap();
        assert!(wrote, "the daemon must get the keystrokes");
        assert_eq!(
            *log.lock().unwrap(),
            ["local:write:b:claude-code", "daemon:write:b:claude-code"]
        );
    }

    #[test]
    fn no_host_claiming_is_ok_false_not_an_error() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let local = FakeHost {
            name: "local",
            holds: None,
            log: log.clone(),
            fail: false,
        };
        let daemon = FakeHost {
            name: "daemon",
            holds: None,
            log: log.clone(),
            fail: false,
        };
        // "Nobody holds this id" is a normal answer — the snapshot path turns it
        // into a read of the shared disk log.
        assert!(!walk_claiming(&[&local, &daemon], |h| h.write("gone", "hi")).unwrap());
        assert_eq!(log.lock().unwrap().len(), 2, "both were asked");
    }

    #[test]
    fn a_host_error_stops_the_walk_and_propagates() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let local = FakeHost {
            name: "local",
            holds: None,
            log: log.clone(),
            fail: true,
        };
        let daemon = FakeHost {
            name: "daemon",
            holds: Some("a:codex"),
            log: log.clone(),
            fail: false,
        };
        let err = walk_claiming(&[&local, &daemon], |h| h.write("a:codex", "hi")).unwrap_err();
        assert_eq!(err, "local exploded");
        assert_eq!(log.lock().unwrap().len(), 1, "the daemon was not asked");
    }

    #[test]
    fn resize_and_stop_go_to_both_hosts_regardless_of_ownership() {
        // These no-op for an id a host doesn't hold, so there is no ownership
        // question — and skipping the daemon would leave a session it hosts
        // stuck at the old geometry, or unstoppable from the UI.
        let log = Arc::new(Mutex::new(Vec::new()));
        let local = FakeHost {
            name: "local",
            holds: None,
            log: log.clone(),
            fail: false,
        };
        let daemon = FakeHost {
            name: "daemon",
            holds: Some("a:codex"),
            log: log.clone(),
            fail: false,
        };

        for h in [&local as &dyn SessionHosting, &daemon] {
            h.resize("a:codex", 40, 120);
        }
        for h in [&local as &dyn SessionHosting, &daemon] {
            h.stop("a:codex");
        }
        assert_eq!(
            *log.lock().unwrap(),
            [
                "local:resize:a:codex",
                "daemon:resize:a:codex",
                "local:stop:a:codex",
                "daemon:stop:a:codex",
            ]
        );
    }

    // ── Spawn routing ────────────────────────────────────────────────────
    // Spawn walks the REAL helpers (`spawn_order` + `first_host_that_spawns`),
    // driven with fakes — unlike the id-keyed walks above, no re-statement of
    // the rule is needed, because the helpers take any `SessionHosting`.

    fn spawn_spec(id: &str) -> SpawnSpec {
        SpawnSpec {
            session_id: id.to_string(),
            provider: "codex".to_string(),
            cwd: None,
            command: "codex".to_string(),
            env: Vec::new(),
            task: None,
            model: None,
            resume_session_id: None,
            mission_link: None,
            detect_session_id: true,
        }
    }

    fn boxed(name: &'static str, fail: bool, log: &Arc<Mutex<Vec<String>>>) -> Box<dyn SessionHosting> {
        Box::new(FakeHost {
            name,
            holds: None,
            log: log.clone(),
            fail,
        })
    }

    #[test]
    fn spawn_is_the_one_operation_that_consults_the_toggle() {
        // Toggle off: the daemon is never even offered a new session. Every
        // other operation keeps asking it regardless (`ask_daemon`, and the
        // walks above) — `ask_daemon_gate_is_not_toggled` pins that half.
        assert_eq!(spawn_order(false, "local", "daemon"), ["local"]);
        // Toggle on: the daemon comes FIRST, so the CLI survives an app
        // restart; in-process is the fallback, not a peer.
        assert_eq!(spawn_order(true, "local", "daemon"), ["daemon", "local"]);
    }

    #[test]
    fn a_daemon_spawn_failure_falls_back_in_process() {
        // The user's task always starts; only persistence is lost.
        let log = Arc::new(Mutex::new(Vec::new()));
        let hosts = spawn_order(true, boxed("local", false, &log), boxed("daemon", true, &log));
        first_host_that_spawns(&hosts, &spawn_spec("a:codex")).unwrap();
        assert_eq!(
            *log.lock().unwrap(),
            ["daemon:spawn:a:codex", "local:spawn:a:codex"]
        );
    }

    #[test]
    fn a_successful_daemon_spawn_never_troubles_the_local_host() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let hosts = spawn_order(true, boxed("local", false, &log), boxed("daemon", false, &log));
        first_host_that_spawns(&hosts, &spawn_spec("a:codex")).unwrap();
        assert_eq!(*log.lock().unwrap(), ["daemon:spawn:a:codex"]);
    }

    #[test]
    fn with_the_toggle_off_a_local_failure_is_the_callers_error() {
        // No silent fallback INTO the daemon: routing a new session there
        // against the toggle would strand it in a host the user turned off.
        let log = Arc::new(Mutex::new(Vec::new()));
        let hosts = spawn_order(false, boxed("local", true, &log), boxed("daemon", false, &log));
        let err = first_host_that_spawns(&hosts, &spawn_spec("a:codex")).unwrap_err();
        assert_eq!(err, "local exploded");
        assert_eq!(*log.lock().unwrap(), ["local:spawn:a:codex"]);
    }

    #[test]
    fn ask_daemon_gate_is_not_toggled() {
        // The persistent-sessions toggle routes NEW SPAWNS to the daemon. It
        // never hides sessions the daemon already hosts. That rule used to be
        // encoded only in which of two identically-shaped helpers a call site
        // happened to name — and it drifted: `Write`, `Snapshot` and
        // `ReuseOrCd` all sat on the gated path, so with the toggle off a live
        // daemon session silently swallowed keystrokes, snapshotted from disk
        // with `seq: 0`, and could be duplicated by a second spawn.
        //
        // There is now one helper, and the toggle has one consumer. Read this
        // file's own source to keep that true — the commands themselves need an
        // `AppHandle` and cannot be driven from here.
        // Production half only — this test names the very strings it counts.
        let whole = include_str!("pty.rs");
        let src = &whole[..whole
            .find("#[cfg(test)]")
            .expect("test module marker in pty.rs")];

        let gate_sites = src.matches("daemon_enabled(&app)").count()
            + src.matches("daemon_enabled(app)").count();
        assert_eq!(
            gate_sites, 3,
            "expected exactly 3 reads of the toggle: the subscriber's \
             re-subscribe pause, `delegate_daemon_status` reporting it, and \
             `delegate_pty_spawn` gating the spawn route. Found {gate_sites} — \
             if a read or lifecycle op started consulting the toggle, a live \
             daemon session just became invisible to it."
        );

        // And the shared round-trip helper must never be one of them.
        let start = src
            .find("fn ask_daemon(")
            .expect("ask_daemon is the one round-trip helper");
        let body = &src[start..];
        let end = body.find("\n}").expect("end of ask_daemon");
        assert!(
            !body[..end].contains("daemon_enabled"),
            "ask_daemon must not consult the toggle — every listing, liveness \
             check and lifecycle op goes through it"
        );
    }
}
