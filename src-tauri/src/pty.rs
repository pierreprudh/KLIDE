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
}

pub struct DelegatePtyState {
    pub sessions: Mutex<HashMap<String, DelegatePtySession>>,
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

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
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

    let base = delegate_command(&provider)?;
    // A task turns `claude` into `claude '<prompt>'` — the CLI opens its normal
    // interactive UI with the mission already submitted as the first message,
    // so the run is observable and the user can take over by typing.
    let command = match task.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => format!("{base} {}", shell_quote(t)),
        None => base.to_string(),
    };
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
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
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

fn delegate_command(provider: &str) -> Result<&'static str, String> {
    match provider {
        "claude-code" => Ok("claude"),
        "codex" => Ok("codex"),
        "opencode" => Ok("opencode"),
        _ => Err(format!("No delegate PTY command for provider: {provider}")),
    }
}
