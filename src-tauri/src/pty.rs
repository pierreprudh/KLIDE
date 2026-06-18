use crate::delegate::{self, shell_quote};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

pub struct PtyState {
    pub writer: Mutex<Option<Box<dyn Write + Send>>>,
    pub cwd: Mutex<Option<String>>,
}

pub struct DelegatePtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    cwd: Option<String>,
    provider: String,
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
    state.sessions.lock().unwrap().insert(
        session_id.clone(),
        DelegatePtySession {
            writer,
            master,
            cwd,
            provider: provider.clone(),
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
            let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
            // Try to detect the CLI's own session ID from startup output
            // (only OpenCode announces one today).
            if !matched_external_id {
                if let Some(capt) = adapter.extract_session_id(&chunk) {
                    let _ = set_delegate_external_id(&app, &session_id, &capt);
                    matched_external_id = true;
                }
            }
            let _ = app.emit(
                "delegate-pty:data",
                DelegatePtyChunk {
                    session_id: session_id.clone(),
                    data: chunk,
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
    }
    Ok(())
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
