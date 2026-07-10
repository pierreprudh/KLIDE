use crate::delegate::{self, shell_quote};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};

/// Max bytes of TUI output we retain per delegate session for replay on
/// reattach. 256 KB comfortably holds a full screen plus scrollback for any
/// CLI agent; older bytes are dropped from the front.
const SCROLLBACK_CAP: usize = 256 * 1024;
/// Max bytes the on-disk scrollback log may grow to before it is compacted
/// back down to the in-memory ring (the newest `SCROLLBACK_CAP` bytes). The
/// log is a bounded superset of the ring: same tail, plus older history —
/// including bytes written before an app restart.
const SCROLLBACK_DISK_CAP: usize = 4 * SCROLLBACK_CAP;
/// Persisted scrollback older than this is pruned (checked at spawn time).
const SCROLLBACK_KEEP_MS: u128 = 14 * 24 * 60 * 60 * 1000;
const IDLE_SESSION_MS: i64 = 60_000;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The write-through disk half of a session's scrollback, so replay survives
/// an app restart (the PTY process itself does not — see
/// docs/delegate-session-replay.md). Best-effort throughout: a failed write
/// drops persistence for the session, never the session itself.
struct ScrollbackSink {
    file: fs::File,
    path: PathBuf,
    len: u64,
}

/// Per-session replay state: the retained bytes and the count of chunks they
/// represent, mutated together under one lock so a snapshot can read both
/// atomically. `seq` is the high-water mark stamped on each emitted chunk.
#[derive(Default)]
struct Scrollback {
    buf: VecDeque<u8>,
    seq: u64,
    /// Disk write-through (`delegate-scrollback/{id}.log`). `None` when the
    /// data dir is unavailable or a write failed.
    sink: Option<ScrollbackSink>,
}

impl Scrollback {
    fn new(sink: Option<ScrollbackSink>) -> Self {
        Self {
            buf: VecDeque::new(),
            seq: 0,
            sink,
        }
    }

    /// Append a chunk, trim to the cap, advance the sequence, and return the
    /// new chunk's seq for stamping the live event. The same bytes are
    /// appended to the disk sink under this same lock, so the log is always a
    /// superset of the ring.
    fn push(&mut self, bytes: &[u8]) -> u64 {
        self.buf.extend(bytes);
        let overflow = self.buf.len().saturating_sub(SCROLLBACK_CAP);
        if overflow > 0 {
            self.buf.drain(..overflow);
        }
        self.seq += 1;
        self.persist(bytes);
        self.seq
    }

    /// Mirror a chunk to the disk log; compact the log back down to the ring
    /// contents once it outgrows `SCROLLBACK_DISK_CAP`.
    fn persist(&mut self, bytes: &[u8]) {
        let Some(sink) = self.sink.as_mut() else {
            return;
        };
        if sink.file.write_all(bytes).is_err() {
            self.sink = None;
            return;
        }
        sink.len += bytes.len() as u64;
        if sink.len as usize <= SCROLLBACK_DISK_CAP {
            return;
        }
        let tail: Vec<u8> = self.buf.iter().copied().collect();
        let path = sink.path.clone();
        self.sink = fs::File::create(&path).ok().and_then(|mut file| {
            file.write_all(&tail).ok()?;
            Some(ScrollbackSink {
                file,
                path,
                len: tail.len() as u64,
            })
        });
    }
}

// ── Scrollback persistence (survives app restart) ────────────────────────────
// One `.log` (raw PTY bytes) + one `.meta.json` (spawn facts) per session id
// under `{app_data_dir}/delegate-scrollback/`. Because a conversation's PTY
// session id is deterministic (`{convoId}:{provider}`), history accumulates
// across respawns of the same conversation — including across app restarts.

/// Spawn-time facts about a persisted session, so an ended session can be
/// listed and reopened after a restart.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollbackMeta {
    session_id: String,
    provider: String,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    task: Option<String>,
    #[serde(default)]
    model: Option<String>,
    /// The CLI's own session id when known (the `--resume` arg the spawn was
    /// given, or an id detected from the CLI's output) — lets a reopen after
    /// restart resume the CLI session, not just repaint its history.
    #[serde(default)]
    resume_session_id: Option<String>,
    started_ms: i64,
    /// Stamped when the CLI exits cleanly. A session killed by the app
    /// quitting never gets one — readers fall back to the log's mtime.
    #[serde(default)]
    ended_ms: Option<i64>,
}

fn scrollback_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("delegate-scrollback"))
}

/// Session ids contain `:` (and whatever a convo id holds) — flatten to a
/// filesystem-safe stem.
fn scrollback_stem(session_id: &str) -> String {
    session_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn scrollback_log_path(dir: &Path, session_id: &str) -> PathBuf {
    dir.join(format!("{}.log", scrollback_stem(session_id)))
}

fn scrollback_meta_path(dir: &Path, session_id: &str) -> PathBuf {
    dir.join(format!("{}.meta.json", scrollback_stem(session_id)))
}

fn read_scrollback_meta(dir: &Path, session_id: &str) -> Option<ScrollbackMeta> {
    let text = fs::read_to_string(scrollback_meta_path(dir, session_id)).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_scrollback_meta(dir: &Path, meta: &ScrollbackMeta) {
    if let Ok(json) = serde_json::to_string_pretty(meta) {
        let _ = fs::write(scrollback_meta_path(dir, &meta.session_id), json);
    }
}

/// Record spawn facts, merging with any earlier run of the same conversation:
/// the original start survives, a known resume id is never forgotten, and the
/// ended stamp is cleared (the session is live again).
fn upsert_scrollback_meta(dir: &Path, meta: ScrollbackMeta) {
    let merged = match read_scrollback_meta(dir, &meta.session_id) {
        Some(prev) => ScrollbackMeta {
            session_id: meta.session_id,
            provider: meta.provider,
            cwd: meta.cwd,
            task: meta.task,
            model: meta.model,
            resume_session_id: meta.resume_session_id.or(prev.resume_session_id),
            started_ms: prev.started_ms.min(meta.started_ms),
            ended_ms: None,
        },
        None => meta,
    };
    write_scrollback_meta(dir, &merged);
}

fn stamp_scrollback_ended(dir: &Path, session_id: &str) {
    if let Some(mut meta) = read_scrollback_meta(dir, session_id) {
        meta.ended_ms = Some(now_ms());
        write_scrollback_meta(dir, &meta);
    }
}

fn update_scrollback_resume_id(dir: &Path, session_id: &str, resume_id: &str) {
    if let Some(mut meta) = read_scrollback_meta(dir, session_id) {
        meta.resume_session_id = Some(resume_id.to_string());
        write_scrollback_meta(dir, &meta);
    }
}

/// Open the disk sink for a session, trimming an oversized log from earlier
/// runs down to its newest `SCROLLBACK_CAP` bytes before appending.
fn open_scrollback_sink(dir: &Path, session_id: &str) -> Option<ScrollbackSink> {
    fs::create_dir_all(dir).ok()?;
    let path = scrollback_log_path(dir, session_id);
    if let Ok(existing_meta) = fs::metadata(&path) {
        if existing_meta.len() as usize > SCROLLBACK_DISK_CAP {
            if let Ok(existing) = fs::read(&path) {
                let keep = existing.len().saturating_sub(SCROLLBACK_CAP);
                let _ = fs::write(&path, &existing[keep..]);
            }
        }
    }
    let file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok()?;
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    Some(ScrollbackSink { file, path, len })
}

/// Drop persisted scrollback older than `SCROLLBACK_KEEP_MS` (by mtime).
/// Called at spawn time — cheap, the dir holds a handful of files.
fn prune_scrollback(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.elapsed().ok())
            .map(|age| age.as_millis() > SCROLLBACK_KEEP_MS)
            .unwrap_or(false);
        if stale {
            let _ = fs::remove_file(entry.path());
        }
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
    status_state: State<crate::delegate::status::DelegateStatusState>,
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
    // behind the Delegate seam. Runtime custom CLIs use the same PTY plumbing
    // with a user-authored shell template.
    let adapter = delegate::lookup(&provider);
    let command = if let Some(adapter) = adapter {
        adapter.spawn_command(
            task.as_deref(),
            model.as_deref(),
            resume_session_id.as_deref(),
        )
    } else if let Some(custom) = crate::custom_cli::get(&provider) {
        custom.spawn_command(
            task.as_deref(),
            model.as_deref(),
            resume_session_id.as_deref(),
        )
    } else {
        return Err(format!("No delegate PTY command for provider: {provider}"));
    };
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(shell);
    cmd.arg("-lc");
    cmd.arg(command);
    if let Some(path) = cwd.as_deref() {
        cmd.cwd(path);
    }
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
    if let Some(url) = status_state.hook_url_for(&app, &session_id) {
        cmd.env("KLIDE_HOOK_URL", url);
    }
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let master = pair.master;
    let mut reader = master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = master.take_writer().map_err(|e| e.to_string())?;
    let started_ms = now_ms();
    // Persist scrollback write-through so this session's history survives an
    // app restart (the PTY itself does not — reopening spawns a fresh CLI, but
    // the terminal repaints everything from before the restart).
    let scroll_dir = scrollback_dir(&app);
    if let Some(dir) = scroll_dir.as_deref() {
        prune_scrollback(dir);
        upsert_scrollback_meta(
            dir,
            ScrollbackMeta {
                session_id: session_id.clone(),
                provider: provider.clone(),
                cwd: cwd.clone(),
                task: task.clone(),
                model: model.clone(),
                resume_session_id: resume_session_id.clone(),
                started_ms,
                ended_ms: None,
            },
        );
    }
    let sink = scroll_dir
        .as_deref()
        .and_then(|dir| open_scrollback_sink(dir, &session_id));
    let scrollback: Arc<Mutex<Scrollback>> = Arc::new(Mutex::new(Scrollback::new(sink)));
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
                if let Some(capt) = adapter.and_then(|d| d.extract_session_id(&chunk)) {
                    let _ = set_delegate_external_id(&app, &session_id, &capt);
                    // Remember it in the persisted meta too, so reopening this
                    // session after an app restart can `--resume` the CLI.
                    if let Some(dir) = scrollback_dir(&app) {
                        update_scrollback_resume_id(&dir, &session_id, &capt);
                    }
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
        // The CLI exited (finished, crashed, or was stopped). Drop our handle,
        // forget its hook status, and tell the frontend so boards can flip the
        // run from running → done.
        app.state::<DelegatePtyState>()
            .sessions
            .lock()
            .unwrap()
            .remove(&session_id);
        app.state::<crate::delegate::status::DelegateStatusState>()
            .statuses
            .lock()
            .unwrap()
            .remove(&session_id);
        // Stamp the persisted meta so the recent-sessions list can show a
        // truthful "ended N ago" (sessions killed by the app quitting have no
        // stamp and fall back to the log's mtime).
        if let Some(dir) = scrollback_dir(&app) {
            stamp_scrollback_ended(&dir, &session_id);
        }
        let _ = app.emit("delegate-pty:exit", DelegatePtyExit { session_id });
    });

    Ok(())
}

#[tauri::command]
pub fn delegate_pty_write(
    state: State<DelegatePtyState>,
    status_state: State<crate::delegate::status::DelegateStatusState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    if let Some(session) = state.sessions.lock().unwrap().get_mut(&session_id) {
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        session.updated_ms.store(now_ms(), Ordering::Relaxed);
        // Typing into the TUI answers whatever the agent was waiting on, so
        // "Needs input" / "Turn done" no longer describe the session. Forget
        // the hook status; the next hook (or the activity timer) re-derives
        // it. This is also what flips Codex back to Active — its notify
        // program has no turn-start event. Housekeeping the TUI asked the
        // terminal to report (focus in/out on every panel switch, mouse
        // wheel scrolls) is NOT the user answering — see `is_user_input` —
        // or a freshly finished turn would flip back to Active the moment
        // the panel changes focus.
        if is_user_input(&data) {
            status_state.statuses.lock().unwrap().remove(&session_id);
        }
    }
    Ok(())
}

/// Does a PTY input chunk contain something the user actually did (keys,
/// enter, paste, arrows) rather than terminal reports the TUI subscribed to?
/// Focus reports (`ESC[I`/`ESC[O`) fire on every panel switch and SGR mouse
/// reports (`ESC[<…M/m`) on every wheel notch; cursor-position (`…R`) and
/// device-attribute (`…c`) replies answer the TUI's own queries. None of
/// those mean "the user responded".
fn is_user_input(data: &str) -> bool {
    let bytes = data.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        // Anything that isn't a CSI escape sequence is typing.
        if bytes[i] != 0x1b {
            return true;
        }
        if i + 1 >= bytes.len() || bytes[i + 1] != b'[' {
            return true; // bare ESC key or an alt-modified key
        }
        // Scan to the CSI final byte (0x40..=0x7E) and classify by it.
        let mut j = i + 2;
        while j < bytes.len() && !(0x40..=0x7e).contains(&bytes[j]) {
            j += 1;
        }
        let Some(&fin) = bytes.get(j) else {
            // Sequence split across chunks — err on not clearing; a real
            // key will follow if the user is actually here.
            return false;
        };
        let params = &bytes[i + 2..j];
        let is_report = match fin {
            b'I' | b'O' => params.is_empty(),             // focus in/out
            b'M' | b'm' => params.first() == Some(&b'<'), // SGR mouse
            b'R' | b'c' | b'n' => true,                   // CPR / DA / DSR replies
            _ => false, // arrows (A–D), keys (~), kitty (u)… — the user
        };
        if !is_report {
            return true;
        }
        i = j + 1;
    }
    false
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
    app: tauri::AppHandle,
    state: State<DelegatePtyState>,
    session_id: String,
) -> DelegatePtySnapshot {
    if let Some(session) = state.sessions.lock().unwrap().get(&session_id) {
        // Read bytes and seq under one lock so they always agree: every byte in
        // `data` is accounted for by `seq`, and the next live chunk gets seq+1.
        // Prefer the disk log — it's a bounded superset of the in-memory ring
        // that also holds history from before an app restart with the same
        // session id; the ring is the fallback when persistence is off.
        let sb = session.scrollback.lock().unwrap();
        let bytes = sb
            .sink
            .as_ref()
            .and_then(|sink| fs::read(&sink.path).ok())
            .unwrap_or_else(|| sb.buf.iter().copied().collect());
        DelegatePtySnapshot {
            data: String::from_utf8_lossy(&bytes).to_string(),
            seq: sb.seq,
            live: true,
        }
    } else {
        // No live PTY (the app or the CLI restarted since) — serve the
        // persisted scrollback so the terminal can still repaint history.
        let bytes = scrollback_dir(&app)
            .map(|dir| scrollback_log_path(&dir, &session_id))
            .and_then(|path| fs::read(path).ok())
            .unwrap_or_default();
        DelegatePtySnapshot {
            data: String::from_utf8_lossy(&bytes).to_string(),
            seq: 0,
            live: false,
        }
    }
}

/// A persisted-but-not-live delegate session: its PTY died (CLI finished, or
/// the app restarted) but its scrollback + spawn facts survive on disk.
/// Reopening one repaints the history and — when `resume_session_id` is known
/// — resumes the CLI session itself.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentDelegateSession {
    session_id: String,
    /// The AI-panel conversation id (`session_id` minus `:provider`).
    convo_id: String,
    provider: String,
    cwd: Option<String>,
    task: Option<String>,
    model: Option<String>,
    resume_session_id: Option<String>,
    started_ms: i64,
    /// Clean-exit stamp, or the log's mtime for sessions the app quit killed.
    ended_ms: Option<i64>,
    buffered_bytes: u64,
}

/// Pure scan over the scrollback dir — separated from the command so it can be
/// tested against a temp dir without a Tauri app.
fn scan_recent_sessions(dir: &Path, live_ids: &HashSet<String>) -> Vec<RecentDelegateSession> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let is_meta = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.ends_with(".meta.json"))
            .unwrap_or(false);
        if !is_meta {
            continue;
        }
        let Some(meta) = fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<ScrollbackMeta>(&text).ok())
        else {
            continue;
        };
        if live_ids.contains(&meta.session_id) {
            continue;
        }
        let log = scrollback_log_path(dir, &meta.session_id);
        let (buffered_bytes, log_mtime_ms) = fs::metadata(&log)
            .map(|m| {
                let mtime = m
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64);
                (m.len(), mtime)
            })
            .unwrap_or((0, None));
        if buffered_bytes == 0 {
            continue; // nothing to replay
        }
        let suffix = format!(":{}", meta.provider);
        let convo_id = meta
            .session_id
            .strip_suffix(&suffix)
            .unwrap_or(&meta.session_id)
            .to_string();
        out.push(RecentDelegateSession {
            session_id: meta.session_id,
            convo_id,
            provider: meta.provider,
            cwd: meta.cwd,
            task: meta.task,
            model: meta.model,
            resume_session_id: meta.resume_session_id,
            started_ms: meta.started_ms,
            ended_ms: meta.ended_ms.or(log_mtime_ms),
            buffered_bytes,
        });
    }
    out.sort_by(|a, b| {
        b.ended_ms
            .unwrap_or(b.started_ms)
            .cmp(&a.ended_ms.unwrap_or(a.started_ms))
    });
    out.truncate(8);
    out
}

#[tauri::command]
pub fn delegate_pty_recent_sessions(
    app: tauri::AppHandle,
    state: State<DelegatePtyState>,
) -> Vec<RecentDelegateSession> {
    let Some(dir) = scrollback_dir(&app) else {
        return Vec::new();
    };
    let live_ids: HashSet<String> = state.sessions.lock().unwrap().keys().cloned().collect();
    scan_recent_sessions(&dir, &live_ids)
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
    state: State<DelegatePtyState>,
    status_state: State<crate::delegate::status::DelegateStatusState>,
) -> Vec<LiveDelegateSession> {
    let sessions = state.sessions.lock().unwrap();
    let hook_statuses = status_state.statuses.lock().unwrap();
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
                // The CLI's own hooks are the truth when present (they know
                // "blocked on a permission" from "thinking hard" — no amount
                // of PTY-quietness timing does); the timer is the fallback.
                status: match hook_statuses.get(session_id) {
                    Some((hook_status, _)) => hook_status.as_str().to_string(),
                    None if now - updated_ms >= IDLE_SESSION_MS => "idle".to_string(),
                    None => "running".to_string(),
                },
                buffered_bytes: s.scrollback.lock().unwrap().buf.len(),
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
    fn user_input_ignores_terminal_reports_but_keeps_real_keys() {
        // Housekeeping that must NOT clear a waiting/blocked status:
        assert!(!is_user_input("\x1b[I"), "focus in");
        assert!(!is_user_input("\x1b[O"), "focus out");
        assert!(
            !is_user_input("\x1b[I\x1b[O\x1b[I"),
            "focus churn on panel switches"
        );
        assert!(!is_user_input("\x1b[<65;10;5M"), "mouse wheel (SGR)");
        assert!(!is_user_input("\x1b[<0;3;7m"), "mouse release (SGR)");
        assert!(!is_user_input("\x1b[24;80R"), "cursor position report");
        assert!(!is_user_input("\x1b[?1;2c"), "device attributes reply");
        assert!(!is_user_input("\x1b[<65;10"), "report split across chunks");
        assert!(!is_user_input(""), "empty chunk");
        // Real interaction that must clear it:
        assert!(is_user_input("y"));
        assert!(is_user_input("\r"), "enter");
        assert!(is_user_input("\x1b[A"), "arrow key");
        assert!(is_user_input("\x1b[5~"), "page up");
        assert!(is_user_input("\x1b"), "bare escape key");
        assert!(is_user_input("\x1b[Iy"), "typing after a focus report");
        assert!(is_user_input("\x1b[200~hello\x1b[201~"), "bracketed paste");
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

    // ── Scrollback persistence ────────────────────────────────────────────

    fn temp_scroll_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "klide-scrollback-{name}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn meta_for(dir: &Path, session_id: &str) -> ScrollbackMeta {
        read_scrollback_meta(dir, session_id).expect("meta on disk")
    }

    fn spawn_meta(session_id: &str, provider: &str, started_ms: i64) -> ScrollbackMeta {
        ScrollbackMeta {
            session_id: session_id.to_string(),
            provider: provider.to_string(),
            cwd: Some("/tmp/ws".to_string()),
            task: Some("fix the tests".to_string()),
            model: None,
            resume_session_id: None,
            started_ms,
            ended_ms: None,
        }
    }

    #[test]
    fn sink_mirrors_pushed_bytes_to_disk() {
        let dir = temp_scroll_dir("mirror");
        let sid = "convo-1:claude-code";
        let mut sb = Scrollback::new(open_scrollback_sink(&dir, sid));
        sb.push(b"hello ");
        sb.push(b"world");
        let log = fs::read(scrollback_log_path(&dir, sid)).unwrap();
        assert_eq!(log, b"hello world");
        assert_eq!(sb.seq, 2, "persistence never affects the seq contract");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn disk_log_compacts_to_the_ring_once_past_the_disk_cap() {
        let dir = temp_scroll_dir("compact");
        let sid = "convo-2:codex";
        let mut sb = Scrollback::new(open_scrollback_sink(&dir, sid));
        let chunk = vec![b'x'; 64 * 1024];
        let mut written = 0usize;
        while written <= SCROLLBACK_DISK_CAP {
            sb.push(&chunk);
            written += chunk.len();
        }
        let log = fs::read(scrollback_log_path(&dir, sid)).unwrap();
        assert!(
            log.len() <= SCROLLBACK_DISK_CAP,
            "log stays bounded ({} bytes)",
            log.len()
        );
        let ring: Vec<u8> = sb.buf.iter().copied().collect();
        assert!(
            log.len() >= ring.len(),
            "log remains a superset of the ring"
        );
        assert_eq!(
            &log[log.len() - ring.len()..],
            ring.as_slice(),
            "log tail equals the ring"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn reopening_an_oversized_log_trims_it_to_the_newest_tail() {
        let dir = temp_scroll_dir("reopen");
        let sid = "convo-3:opencode";
        let path = scrollback_log_path(&dir, sid);
        // A log left oversized by a previous run (e.g. compaction never fired
        // because the app was killed mid-session).
        let mut oversized = vec![b'o'; SCROLLBACK_DISK_CAP + 8 * 1024];
        let tail_marker = b"NEWEST";
        oversized.extend_from_slice(tail_marker);
        fs::write(&path, &oversized).unwrap();

        let sink = open_scrollback_sink(&dir, sid).expect("sink opens");
        assert!(sink.len as usize <= SCROLLBACK_CAP);
        let trimmed = fs::read(&path).unwrap();
        assert!(trimmed.ends_with(tail_marker), "newest bytes survive");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn meta_upsert_keeps_earliest_start_and_known_resume_id() {
        let dir = temp_scroll_dir("meta");
        let sid = "convo-4:claude-code";
        // First spawn of the conversation.
        upsert_scrollback_meta(&dir, spawn_meta(sid, "claude-code", 1_000));
        update_scrollback_resume_id(&dir, sid, "cli-session-uuid");
        stamp_scrollback_ended(&dir, sid);
        assert!(meta_for(&dir, sid).ended_ms.is_some());

        // Respawn (same conversation, later, no resume arg): the original
        // start and the detected resume id survive, the ended stamp clears.
        upsert_scrollback_meta(&dir, spawn_meta(sid, "claude-code", 5_000));
        let meta = meta_for(&dir, sid);
        assert_eq!(meta.started_ms, 1_000);
        assert_eq!(meta.resume_session_id.as_deref(), Some("cli-session-uuid"));
        assert!(meta.ended_ms.is_none(), "live again — no ended stamp");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn recent_sessions_skip_live_ids_and_sort_newest_first() {
        let dir = temp_scroll_dir("recent");
        for (sid, provider, started, ended) in [
            // convo-a: killed by an app quit — no clean ended stamp. Its log's
            // mtime (written just now) dates it, which also makes it newest.
            ("convo-a:claude-code", "claude-code", 1_000, None),
            ("convo-b:codex", "codex", 1_500, Some(9_000)),
            ("convo-live:claude-code", "claude-code", 3_000, None),
        ] {
            let mut meta = spawn_meta(sid, provider, started);
            meta.ended_ms = ended;
            write_scrollback_meta(&dir, &meta);
            fs::write(scrollback_log_path(&dir, sid), b"some scrollback").unwrap();
        }
        // A meta with an EMPTY log (nothing to replay) must not be listed.
        write_scrollback_meta(&dir, &spawn_meta("convo-empty:codex", "codex", 100));

        let live: HashSet<String> = ["convo-live:claude-code".to_string()].into();
        let recent = scan_recent_sessions(&dir, &live);
        let ids: Vec<&str> = recent.iter().map(|s| s.session_id.as_str()).collect();
        assert!(!ids.contains(&"convo-live:claude-code"), "live is excluded");
        assert!(!ids.contains(&"convo-empty:codex"), "empty log is excluded");
        // The app-killed session lists first: its mtime-derived end (now) is
        // newer than convo-b's clean stamp.
        assert_eq!(ids, ["convo-a:claude-code", "convo-b:codex"]);
        assert_eq!(recent[0].convo_id, "convo-a");
        assert_eq!(recent[0].buffered_bytes, 15);
        assert!(
            recent[0].ended_ms.is_some(),
            "no clean stamp — dated by the log's mtime"
        );
        let _ = fs::remove_dir_all(dir);
    }
}
