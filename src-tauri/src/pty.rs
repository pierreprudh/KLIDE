use crate::delegate::{self, shell_quote};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};

/// Max bytes of TUI output we retain per delegate session for replay on
/// reattach. 256 KB comfortably holds a full screen plus scrollback for any
/// CLI agent; older bytes are dropped from the front.
const SCROLLBACK_CAP: usize = 256 * 1024;
const IDLE_SESSION_MS: i64 = 60_000;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Per-session replay state: the retained bytes and the count of chunks they
/// represent, mutated together under one lock so a snapshot can read both
/// atomically. `seq` is the high-water mark stamped on each emitted chunk.
#[derive(Default)]
struct Scrollback {
    buf: VecDeque<u8>,
    seq: u64,
}

impl Scrollback {
    /// Append a chunk, trim to the cap, advance the sequence, and return the
    /// new chunk's seq for stamping the live event.
    fn push(&mut self, bytes: &[u8]) -> u64 {
        self.buf.extend(bytes);
        let overflow = self.buf.len().saturating_sub(SCROLLBACK_CAP);
        if overflow > 0 {
            self.buf.drain(..overflow);
        }
        self.seq += 1;
        self.seq
    }
}

pub struct PtyState {
    pub writer: Mutex<Option<Box<dyn Write + Send>>>,
    pub cwd: Mutex<Option<String>>,
}

pub struct DelegatePtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    cwd: Option<String>,
    provider: String,
    /// Capped replay buffer + chunk sequence, shared with the reader thread.
    /// Lets a remounting (or freshly opened) terminal repaint history instead
    /// of coming back blank, and lets it drop live chunks already in the
    /// snapshot. See [`Scrollback`].
    scrollback: Arc<Mutex<Scrollback>>,
    /// The CLI's first prompt, kept for auto-titling the live-session list in
    /// Mission Control (à la Unpeel). `None` for a bare resume with no task.
    task: Option<String>,
    /// Model the delegate was launched with, for the live-session list.
    model: Option<String>,
    /// When this session was spawned (epoch ms), for "running for N min".
    started_ms: i64,
    /// Last observed PTY activity (input or output), used by Mission Control
    /// to distinguish active streaming sessions from quiet live sessions.
    updated_ms: Arc<AtomicI64>,
}

pub struct DelegatePtyState {
    pub sessions: Mutex<HashMap<String, DelegatePtySession>>,
}

impl DelegatePtyState {
    /// Is a delegate PTY for `provider` currently live? Used by account
    /// switching to refuse swapping a CLI's credentials out from under a
    /// running session (it would refresh its token and write back to the
    /// store we're replacing). Only covers Klide-spawned PTYs — a CLI running
    /// in an external terminal is invisible to us.
    pub fn has_live_session(&self, provider: &str) -> bool {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .any(|s| s.provider == provider)
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
    session_id: String,
    provider: String,
    workspace_root: Option<String>,
    task: Option<String>,
    model: Option<String>,
    resume_session_id: Option<String>,
    parent_run_id: Option<String>,
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

    if let Some(session) = state.sessions.lock().unwrap().get_mut(&session_id) {
        if session.cwd != cwd {
            if let Some(path) = cwd.as_deref() {
                let cd = format!("cd {}\n", shell_quote(path));
                session
                    .writer
                    .write_all(cd.as_bytes())
                    .map_err(|e| e.to_string())?;
                session.cwd = cwd;
            }
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

    // All per-CLI knowledge (spawn syntax, resume flags, model flags) lives
    // behind the Delegate seam — this command only does PTY plumbing.
    let adapter = delegate::lookup(&provider)
        .ok_or_else(|| format!("No delegate PTY command for provider: {provider}"))?;
    let command = adapter.spawn_command(
        task.as_deref(),
        model.as_deref(),
        resume_session_id.as_deref(),
    );
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(shell);
    cmd.arg("-lc");
    cmd.arg(command);
    if let Some(path) = cwd.as_deref() {
        cmd.cwd(path);
    }
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let master = pair.master;
    let mut reader = master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = master.take_writer().map_err(|e| e.to_string())?;
    let scrollback: Arc<Mutex<Scrollback>> = Arc::new(Mutex::new(Scrollback::default()));
    let started_ms = now_ms();
    let updated_ms = Arc::new(AtomicI64::new(started_ms));
    state.sessions.lock().unwrap().insert(
        session_id.clone(),
        DelegatePtySession {
            writer,
            master,
            cwd,
            provider: provider.clone(),
            scrollback: scrollback.clone(),
            task: task.clone(),
            model: model.clone(),
            started_ms,
            updated_ms: updated_ms.clone(),
        },
    );

    std::thread::spawn(move || {
        // Rate-limit output events: TUI agents (claude's spinner especially)
        // redraw constantly, and every emit crosses the Rust → webview IPC
        // bridge — an unthrottled session floods the UI thread. Sleeping
        // briefly after each emit lets bursts pile up in the kernel's PTY
        // buffer, so the next (large) read drains them as one event. Caps
        // traffic at ~60 events/s per session; nothing is ever left stuck.
        let mut buf = [0u8; 65536];
        let mut matched_external_id = false;
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            updated_ms.store(now_ms(), Ordering::Relaxed);
            let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
            // Try to detect the CLI's own session ID from startup output
            // (only OpenCode announces one today).
            if !matched_external_id {
                if let Some(capt) = adapter.extract_session_id(&chunk) {
                    let _ = set_delegate_external_id(&app, &session_id, &capt);
                    matched_external_id = true;
                }
            }
            // Append to the replay buffer and stamp this chunk's sequence
            // number atomically, so a reattaching terminal can paint history
            // then drop any live chunk it already saw.
            let chunk_seq = scrollback.lock().unwrap().push(chunk.as_bytes());
            let _ = app.emit(
                "delegate-pty:data",
                DelegatePtyChunk {
                    session_id: session_id.clone(),
                    data: chunk,
                    seq: chunk_seq,
                },
            );
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
        let _ = child.wait();
        // The CLI exited (finished, crashed, or was stopped). Drop our handle
        // and tell the frontend so boards can flip the run from running → done.
        app.state::<DelegatePtyState>()
            .sessions
            .lock()
            .unwrap()
            .remove(&session_id);
        let _ = app.emit("delegate-pty:exit", DelegatePtyExit { session_id });
    });

    Ok(())
}

#[tauri::command]
pub fn delegate_pty_write(
    state: State<DelegatePtyState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    if let Some(session) = state.sessions.lock().unwrap().get_mut(&session_id) {
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        session.updated_ms.store(now_ms(), Ordering::Relaxed);
    }
    Ok(())
}

/// Replay buffer for a delegate session: the retained TUI bytes plus the
/// sequence number of the last chunk they include. The frontend paints `data`,
/// then drops any live `delegate-pty:data` event whose `seq <= seq` here.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegatePtySnapshot {
    data: String,
    seq: u64,
    /// False when no session by this ID is live (nothing to replay).
    live: bool,
}

#[tauri::command]
pub fn delegate_pty_snapshot(
    state: State<DelegatePtyState>,
    session_id: String,
) -> DelegatePtySnapshot {
    if let Some(session) = state.sessions.lock().unwrap().get(&session_id) {
        // Read bytes and seq under one lock so they always agree: every byte in
        // `data` is accounted for by `seq`, and the next live chunk gets seq+1.
        let sb = session.scrollback.lock().unwrap();
        let bytes: Vec<u8> = sb.buf.iter().copied().collect();
        DelegatePtySnapshot {
            data: String::from_utf8_lossy(&bytes).to_string(),
            seq: sb.seq,
            live: true,
        }
    } else {
        DelegatePtySnapshot {
            data: String::new(),
            seq: 0,
            live: false,
        }
    }
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
    /// `"running"` while output/input is fresh, `"idle"` when the PTY is still
    /// live but has been quiet long enough that it needs human attention.
    status: String,
    /// Bytes of replay buffer currently retained — a cheap "has output" signal.
    buffered_bytes: usize,
}

#[tauri::command]
pub fn delegate_pty_live_sessions(state: State<DelegatePtyState>) -> Vec<LiveDelegateSession> {
    let sessions = state.sessions.lock().unwrap();
    let now = now_ms();
    let mut out: Vec<LiveDelegateSession> = sessions
        .iter()
        .map(|(session_id, s)| {
            // `session_id` is `{convoId}:{provider}`; strip the known provider
            // suffix to recover the conversation id. Fall back to the whole id
            // if the shape is unexpected.
            let suffix = format!(":{}", s.provider);
            let convo_id = session_id
                .strip_suffix(&suffix)
                .unwrap_or(session_id)
                .to_string();
            let updated_ms = s.updated_ms.load(Ordering::Relaxed);
            LiveDelegateSession {
                session_id: session_id.clone(),
                convo_id,
                provider: s.provider.clone(),
                cwd: s.cwd.clone(),
                task: s.task.clone(),
                model: s.model.clone(),
                started_ms: s.started_ms,
                updated_ms,
                status: if now - updated_ms >= IDLE_SESSION_MS {
                    "idle".to_string()
                } else {
                    "running".to_string()
                },
                buffered_bytes: s.scrollback.lock().unwrap().buf.len(),
            }
        })
        .collect();
    // Most recently active first, so the freshest agent is at the top.
    out.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms));
    out
}

#[tauri::command]
pub fn delegate_pty_resize(
    state: State<DelegatePtyState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    if rows == 0 || cols == 0 {
        return Ok(());
    }
    if let Some(session) = state.sessions.lock().unwrap().get_mut(&session_id) {
        session
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
pub fn delegate_pty_stop(state: State<DelegatePtyState>, session_id: String) -> Result<(), String> {
    if let Some(mut session) = state.sessions.lock().unwrap().remove(&session_id) {
        let _ = session.writer.write_all(b"\x03exit\n");
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
            created_at_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(sb: &Scrollback) -> String {
        String::from_utf8_lossy(&sb.buf.iter().copied().collect::<Vec<u8>>()).to_string()
    }

    #[test]
    fn push_returns_monotonic_seq() {
        let mut sb = Scrollback::default();
        assert_eq!(sb.push(b"a"), 1);
        assert_eq!(sb.push(b"b"), 2);
        assert_eq!(sb.push(b"c"), 3);
        assert_eq!(sb.seq, 3);
        assert_eq!(bytes(&sb), "abc");
    }

    #[test]
    fn buffer_is_capped_to_scrollback_cap_dropping_oldest() {
        let mut sb = Scrollback::default();
        // Write 10 KB more than the cap; only the newest SCROLLBACK_CAP bytes
        // should survive, and seq still counts every chunk.
        let chunk = vec![b'x'; 10 * 1024];
        let mut chunks = 0u64;
        let mut total = 0usize;
        while total < SCROLLBACK_CAP + 10 * 1024 {
            sb.push(&chunk);
            chunks += 1;
            total += chunk.len();
        }
        assert_eq!(sb.seq, chunks, "seq counts every chunk, even dropped ones");
        assert!(
            sb.buf.len() <= SCROLLBACK_CAP,
            "buffer never exceeds the cap"
        );
    }

    #[test]
    fn cap_keeps_the_newest_bytes() {
        let mut sb = Scrollback::default();
        // Fill exactly to the cap with 'a', then push one 'b' — the oldest 'a'
        // is dropped and 'b' lands at the end.
        sb.push(&vec![b'a'; SCROLLBACK_CAP]);
        sb.push(b"b");
        assert_eq!(sb.buf.len(), SCROLLBACK_CAP);
        assert_eq!(*sb.buf.back().unwrap(), b'b');
        assert_eq!(*sb.buf.front().unwrap(), b'a');
    }
}
