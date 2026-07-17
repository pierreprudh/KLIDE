//! The detached delegate session host — Slice 3 of
//! docs/delegate-session-replay.md ("hosted PTY, the window is just a
//! client", after Unpeel).
//!
//! `klide ptyd --data-dir <dir>` runs this instead of the GUI: a small server
//! that owns a [`SessionHost`] and speaks **newline-delimited JSON** over a
//! Unix domain socket at `{data_dir}/ptyd.sock`. Because the daemon is its
//! own process, the CLIs it hosts keep running when the app quits; a
//! restarted app reconnects, lists the still-live sessions, and replays
//! their scrollback.
//!
//! Wire model, deliberately minimal:
//! - A client connection is request/response: one JSON [`Request`] per line,
//!   one JSON [`Response`] line back.
//! - A connection that sends `subscribe` is upgraded to an event stream: it
//!   receives every [`Event`] (output chunks, exits, detected session ids)
//!   from then on, and nothing else.
//! - The app process is the only intended client. Every connection must send
//!   an `auth` line first, carrying the per-data-dir token from
//!   [`token_path`] — the socket lives in the shared temp dir, so possession
//!   of the token (readable only via the app's own data dir, mode 0600) is
//!   what proves a client is us. `nc -U` still works for debugging if you
//!   paste the auth line first.
//!
//! Unix-only (macOS today): the socket, and the daemon's survival across the
//! parent exiting, both lean on Unix process semantics. Windows would need a
//! named-pipe transport — out of scope for this slice.

#![cfg(unix)]

use crate::pty_host::{
    LiveSessionRow, PtyEventSink, RecentDelegateSession, SessionHost, SessionSnapshot, SpawnSpec,
};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// With no live sessions and no attached clients for this long, the daemon
/// exits. It is respawned on demand by the app, so an idle daemon is pure
/// leftover.
const IDLE_EXIT_MS: i64 = 15 * 60 * 1000;
const IDLE_CHECK_EVERY: std::time::Duration = std::time::Duration::from_secs(60);

const LOG_FILE: &str = "ptyd.log";

/// Where the daemon for `data_dir` listens. NOT inside `data_dir`: Unix
/// socket paths are capped at ~104 bytes (`SUN_LEN`) on macOS, and
/// `~/Library/Application Support/...` can exceed that. Instead — the tmux
/// approach — a short per-user directory under the system temp dir, with the
/// data dir folded into the filename as a hash so different data dirs (dev
/// vs prod, tests) get distinct daemons.
pub fn socket_path(data_dir: &Path) -> PathBuf {
    // FNV-1a, inlined: `DefaultHasher` is randomly seeded per process, so it
    // cannot name a rendezvous point two processes must agree on.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in data_dir.as_os_str().as_encoded_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    let uid = std::fs::metadata(std::env::var("HOME").unwrap_or_else(|_| "/".into()))
        .map(|m| std::os::unix::fs::MetadataExt::uid(&m))
        .unwrap_or(0);
    std::env::temp_dir()
        .join(format!("klide-{uid}"))
        .join(format!("ptyd-{hash:016x}.sock"))
}

/// The shared secret a client must present as its first request line. Lives
/// inside the app data dir (not the world-readable temp dir where the socket
/// sits), mode 0600 — being able to read it is the proof of identity.
pub fn token_path(data_dir: &Path) -> PathBuf {
    data_dir.join("ptyd.token")
}

/// Read the existing token, or mint one from OS randomness and persist it
/// 0600. Reusing the file keeps a restarting daemon compatible with clients
/// that read it moments earlier.
pub fn ensure_token(data_dir: &Path) -> Result<String, String> {
    let path = token_path(data_dir);
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let existing = existing.trim().to_string();
        if !existing.is_empty() {
            return Ok(existing);
        }
    }
    use base64::Engine;
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("OS RNG unavailable: {e}"))?;
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&path)
        .map_err(|e| format!("write ptyd token: {e}"))?;
    write!(file, "{token}").map_err(|e| format!("write ptyd token: {e}"))?;
    Ok(token)
}

/// One request line from a client. Field names/shapes mirror the Tauri
/// commands in pty.rs so the app-side proxy (Slice 3c) is a straight
/// translation. `spawn.command` arrives prebuilt: all provider knowledge
/// (adapter spawn syntax, status-hook env) stays in the app; the daemon only
/// runs what it is given.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    /// Must be the first line on every connection, carrying the token from
    /// [`token_path`]. No ack on success — the next request's response is
    /// the ack. A wrong or missing token gets one `Err` line and a closed
    /// connection.
    Auth { token: String },
    /// Liveness + version check. A client seeing a version mismatch after an
    /// app upgrade asks the daemon to shut down and starts a fresh one.
    Ping,
    /// Upgrade this connection to an event stream.
    Subscribe,
    /// Ask the daemon to exit once this response is written. Sessions die
    /// with it — the client is expected to have drained/warned first.
    Shutdown,
    ReuseOrCd {
        session_id: String,
        cwd: Option<String>,
    },
    Spawn {
        session_id: String,
        provider: String,
        cwd: Option<String>,
        command: String,
        env: Vec<(String, String)>,
        task: Option<String>,
        model: Option<String>,
        resume_session_id: Option<String>,
        /// Whether the daemon should watch output for the CLI announcing its
        /// own session id (`delegate::lookup(provider)` — the daemon links
        /// the same crate, so the detector runs in-process here too).
        detect_session_id: bool,
    },
    Write {
        session_id: String,
        data: String,
    },
    Resize {
        session_id: String,
        rows: u16,
        cols: u16,
    },
    Stop {
        session_id: String,
    },
    Snapshot {
        session_id: String,
    },
    LiveRows,
    Recent,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Response {
    Pong { version: String, pid: u32 },
    Subscribed,
    Ok,
    Err { message: String },
    Reused { reused: bool },
    Wrote { wrote: bool },
    Snapshot(SessionSnapshot),
    LiveRows { rows: Vec<LiveSessionRow> },
    Recent { sessions: Vec<RecentDelegateSession> },
}

/// Pushed to subscribed connections — the socket twin of the app's
/// `delegate-pty:*` Tauri events plus the external-id detection callback.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    Chunk {
        session_id: String,
        data: String,
        seq: u64,
    },
    Exit {
        session_id: String,
    },
    ExternalId {
        session_id: String,
        external_id: String,
    },
}

pub struct DaemonState {
    host: SessionHost,
    /// Event-stream connections, keyed by a client id so a dead writer can be
    /// dropped from inside the broadcast loop.
    subscribers: Mutex<HashMap<u64, UnixStream>>,
    next_client: AtomicU64,
    /// Last request or event, for the idle-exit check.
    active_ms: AtomicI64,
    data_dir: PathBuf,
    /// The connection secret every client must present first (see
    /// [`ensure_token`]).
    token: String,
}

impl DaemonState {
    fn touch(&self) {
        self.active_ms
            .store(crate::pty_host::now_ms(), Ordering::Relaxed);
    }

    fn scroll_dir(&self) -> PathBuf {
        self.data_dir.join("delegate-scrollback")
    }

    fn log(&self, line: &str) {
        log_line(&self.data_dir, line);
    }

    /// Send one event line to every subscriber; a failed write means the
    /// client is gone and its entry is dropped.
    fn broadcast(&self, event: &Event) {
        let Ok(line) = serde_json::to_string(event) else {
            return;
        };
        let mut subs = self.subscribers.lock().unwrap();
        subs.retain(|_, stream| writeln!(stream, "{line}").is_ok());
    }
}

/// Best-effort daemon log next to the socket — the only window into a
/// process with no terminal.
fn log_line(data_dir: &Path, line: &str) {
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir.join(LOG_FILE))
    {
        let _ = writeln!(f, "[{}] {line}", crate::pty_host::now_ms());
    }
}

/// The daemon's [`PtyEventSink`]: fan session events out to every subscribed
/// client. Mirrors `TauriSink` in pty.rs, with the socket in place of the
/// webview bridge.
struct BroadcastSink {
    state: Arc<DaemonState>,
}

impl PtyEventSink for BroadcastSink {
    fn chunk(&self, session_id: &str, data: &str, seq: u64) {
        self.state.touch();
        self.state.broadcast(&Event::Chunk {
            session_id: session_id.to_string(),
            data: data.to_string(),
            seq,
        });
    }

    fn exit(&self, session_id: &str) {
        self.state.touch();
        self.state.log(&format!("session exited: {session_id}"));
        self.state.broadcast(&Event::Exit {
            session_id: session_id.to_string(),
        });
    }

    fn external_id(&self, session_id: &str, external_id: &str) {
        self.state.broadcast(&Event::ExternalId {
            session_id: session_id.to_string(),
            external_id: external_id.to_string(),
        });
    }
}

/// Bind the daemon socket, reclaiming a stale socket file (daemon crashed or
/// was SIGKILLed — the file outlives the listener). Errs when another daemon
/// genuinely answers on it.
pub fn bind_socket(data_dir: &Path) -> Result<UnixListener, String> {
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let path = socket_path(data_dir);
    if let Some(parent) = path.parent() {
        // 0700: the socket rendezvous dir is per-user, like tmux's.
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let _ = std::fs::set_permissions(
            parent,
            std::os::unix::fs::PermissionsExt::from_mode(0o700),
        );
    }
    let restrict = |listener: UnixListener| {
        // 0600 on the socket file itself — connect() checks write permission,
        // so this is a second fence in front of the token handshake.
        let _ = std::fs::set_permissions(
            &path,
            std::os::unix::fs::PermissionsExt::from_mode(0o600),
        );
        listener
    };
    match UnixListener::bind(&path) {
        Ok(listener) => Ok(restrict(listener)),
        Err(bind_err) => {
            // The file exists. A live daemon accepts connections; a stale
            // file refuses them and is safe to remove and rebind.
            if UnixStream::connect(&path).is_ok() {
                return Err(format!("another ptyd is already serving {path:?}"));
            }
            let _ = std::fs::remove_file(&path);
            UnixListener::bind(&path)
                .map(restrict)
                .map_err(|_| bind_err.to_string())
        }
    }
}

/// Entry point for `klide ptyd --data-dir <dir>`. Never returns: serves until
/// idle-exit, `shutdown`, or a fatal bind error.
pub fn daemon_main(data_dir: PathBuf) -> ! {
    let listener = match bind_socket(&data_dir) {
        Ok(l) => l,
        Err(e) => {
            log_line(&data_dir, &format!("bind failed: {e}"));
            // A daemon already serving is a success for the caller's purpose.
            std::process::exit(if e.contains("already serving") { 0 } else { 1 });
        }
    };
    // After the bind: the bind is the daemon-uniqueness mutex, so only the
    // winning daemon (re)writes the token file.
    let token = match ensure_token(&data_dir) {
        Ok(t) => t,
        Err(e) => {
            log_line(&data_dir, &format!("token setup failed: {e}"));
            std::process::exit(1);
        }
    };
    let state = Arc::new(DaemonState {
        host: SessionHost::default(),
        subscribers: Mutex::new(HashMap::new()),
        next_client: AtomicU64::new(1),
        active_ms: AtomicI64::new(crate::pty_host::now_ms()),
        data_dir: data_dir.clone(),
        token,
    });
    state.log(&format!(
        "ptyd v{} listening (pid {})",
        env!("CARGO_PKG_VERSION"),
        std::process::id()
    ));

    // Idle exit: with nothing hosted and nobody attached for IDLE_EXIT_MS,
    // remove the socket and leave. The app respawns us on demand.
    {
        let state = state.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(IDLE_CHECK_EVERY);
            let busy = !state.host.live_ids().is_empty()
                || !state.subscribers.lock().unwrap().is_empty();
            if busy {
                state.touch();
                continue;
            }
            let idle_for = crate::pty_host::now_ms() - state.active_ms.load(Ordering::Relaxed);
            if idle_for >= IDLE_EXIT_MS {
                state.log("idle — exiting");
                let _ = std::fs::remove_file(socket_path(&state.data_dir));
                std::process::exit(0);
            }
        });
    }

    serve(listener, state);
    unreachable!("serve loops forever");
}

/// Accept loop, separated from [`daemon_main`] so tests can serve on a temp
/// socket inside the test process.
pub fn serve(listener: UnixListener, state: Arc<DaemonState>) {
    for conn in listener.incoming() {
        let Ok(stream) = conn else { continue };
        let state = state.clone();
        std::thread::spawn(move || handle_client(stream, state));
    }
}

fn handle_client(stream: UnixStream, state: Arc<DaemonState>) {
    let Ok(read_half) = stream.try_clone() else {
        return;
    };
    let mut writer = stream;
    let reader = BufReader::new(read_half);
    let mut authed = false;
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        state.touch();
        let request = match serde_json::from_str::<Request>(&line) {
            Ok(r) => r,
            Err(e) => {
                let _ = respond(&mut writer, &Response::Err {
                    message: format!("bad request: {e}"),
                });
                continue;
            }
        };
        // The handshake gate: nothing is served until this connection has
        // presented the data-dir token. One Err line, then hang up — an
        // unauthorized peer gets no second guess on the same connection.
        if let Request::Auth { token } = &request {
            if *token == state.token {
                authed = true;
                continue;
            }
            state.log("refused connection: bad token");
            let _ = respond(&mut writer, &Response::Err {
                message: "unauthorized".to_string(),
            });
            return;
        }
        if !authed {
            state.log("refused connection: no auth line");
            let _ = respond(&mut writer, &Response::Err {
                message: "unauthorized: send auth first".to_string(),
            });
            return;
        }
        match request {
            Request::Subscribe => {
                let id = state.next_client.fetch_add(1, Ordering::Relaxed);
                if let Ok(event_half) = writer.try_clone() {
                    // Ack THEN register, both under the broadcast lock: a
                    // session streaming at full tilt broadcasts every ~15ms,
                    // and a chunk slipping out between registration and the
                    // ack reaches the client as its "ack" — it treats the
                    // subscribe as failed, retries, and loses this race
                    // forever while anything is streaming. Holding the lock
                    // serializes us against broadcast(), so the ack is
                    // always the first line and no event can precede it.
                    {
                        let mut subs = state.subscribers.lock().unwrap();
                        if respond(&mut writer, &Response::Subscribed).is_err() {
                            return;
                        }
                        subs.insert(id, event_half);
                    }
                    // Keep reading only to notice the disconnect: an event
                    // stream client sends nothing more.
                    let mut drain = BufReader::new(writer);
                    let mut scratch = String::new();
                    while matches!(drain.read_line(&mut scratch), Ok(n) if n > 0) {
                        scratch.clear();
                    }
                    state.subscribers.lock().unwrap().remove(&id);
                } else {
                    let _ = respond(&mut writer, &Response::Err {
                        message: "could not clone stream for events".to_string(),
                    });
                }
                return;
            }
            Request::Shutdown => {
                state.log("shutdown requested");
                let _ = respond(&mut writer, &Response::Ok);
                let _ = std::fs::remove_file(socket_path(&state.data_dir));
                std::process::exit(0);
            }
            other => {
                let response = handle_request(other, &state);
                if respond(&mut writer, &response).is_err() {
                    break;
                }
            }
        }
    }
}

fn respond(writer: &mut UnixStream, response: &Response) -> std::io::Result<()> {
    let line = serde_json::to_string(response).unwrap_or_else(|e| {
        format!("{{\"type\":\"err\",\"message\":\"serialize: {e}\"}}")
    });
    writeln!(writer, "{line}")
}

fn handle_request(request: Request, state: &Arc<DaemonState>) -> Response {
    match request {
        Request::Ping => Response::Pong {
            version: env!("CARGO_PKG_VERSION").to_string(),
            pid: std::process::id(),
        },
        Request::ReuseOrCd { session_id, cwd } => {
            match state.host.reuse_or_cd(&session_id, cwd.as_deref()) {
                Ok(reused) => Response::Reused { reused },
                Err(message) => Response::Err { message },
            }
        }
        Request::Spawn {
            session_id,
            provider,
            cwd,
            command,
            env,
            task,
            model,
            resume_session_id,
            detect_session_id,
        } => {
            state.log(&format!("spawn {session_id} ({provider})"));
            let extract = if detect_session_id {
                crate::delegate::lookup(&provider).map(|d| {
                    Box::new(move |output: &str| d.extract_session_id(output))
                        as Box<dyn Fn(&str) -> Option<String> + Send>
                })
            } else {
                None
            };
            let result = state.host.spawn(
                SpawnSpec {
                    session_id,
                    provider,
                    cwd,
                    command,
                    env,
                    task,
                    model,
                    resume_session_id,
                    extract_session_id: extract,
                },
                Some(state.scroll_dir()),
                Arc::new(BroadcastSink {
                    state: state.clone(),
                }),
            );
            match result {
                Ok(()) => Response::Ok,
                Err(message) => Response::Err { message },
            }
        }
        Request::Write { session_id, data } => match state.host.write(&session_id, &data) {
            Ok(wrote) => Response::Wrote { wrote },
            Err(message) => Response::Err { message },
        },
        Request::Resize {
            session_id,
            rows,
            cols,
        } => match state.host.resize(&session_id, rows, cols) {
            Ok(()) => Response::Ok,
            Err(message) => Response::Err { message },
        },
        Request::Stop { session_id } => {
            state.host.stop(&session_id);
            Response::Ok
        }
        Request::Snapshot { session_id } => Response::Snapshot(
            state
                .host
                .snapshot(&session_id, Some(state.scroll_dir()).as_deref()),
        ),
        Request::LiveRows => Response::LiveRows {
            rows: state.host.live_rows(),
        },
        Request::Recent => Response::Recent {
            sessions: state.host.recent_sessions(&state.scroll_dir()),
        },
        // Handled in handle_client before reaching here (they own the
        // connection's lifecycle, not just a response).
        Request::Auth { .. } | Request::Subscribe | Request::Shutdown => unreachable!(),
    }
}

/// Test-only constructor so integration tests can serve without the process
/// lifecycle (idle exit, socket cleanup) of [`daemon_main`].
#[cfg(test)]
pub fn test_state(data_dir: PathBuf) -> Arc<DaemonState> {
    let token = ensure_token(&data_dir).expect("test token");
    Arc::new(DaemonState {
        host: SessionHost::default(),
        subscribers: Mutex::new(HashMap::new()),
        next_client: AtomicU64::new(1),
        active_ms: AtomicI64::new(crate::pty_host::now_ms()),
        data_dir,
        token,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufRead;

    struct TestServer {
        dir: PathBuf,
        state: Arc<DaemonState>,
    }

    impl TestServer {
        fn start(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "klide-ptyd-{name}-{}-{}",
                std::process::id(),
                crate::pty_host::now_ms()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let listener = bind_socket(&dir).expect("bind");
            let state = test_state(dir.clone());
            let serve_state = state.clone();
            std::thread::spawn(move || serve(listener, serve_state));
            Self { dir, state }
        }

        /// A raw connection with no auth line — for the refusal tests.
        fn connect_unauthed(&self) -> (BufReader<UnixStream>, UnixStream) {
            let stream = UnixStream::connect(socket_path(&self.dir)).expect("connect");
            (BufReader::new(stream.try_clone().unwrap()), stream)
        }

        fn connect(&self) -> (BufReader<UnixStream>, UnixStream) {
            let (reader, mut writer) = self.connect_unauthed();
            let auth = Request::Auth {
                token: ensure_token(&self.dir).unwrap(),
            };
            writeln!(writer, "{}", serde_json::to_string(&auth).unwrap()).unwrap();
            (reader, writer)
        }

        fn roundtrip(&self, request: &Request) -> Response {
            let (mut reader, mut writer) = self.connect();
            writeln!(writer, "{}", serde_json::to_string(request).unwrap()).unwrap();
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            serde_json::from_str(&line).expect("response parses")
        }
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(socket_path(&self.dir));
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn ping_reports_version_and_pid() {
        let server = TestServer::start("ping");
        match server.roundtrip(&Request::Ping) {
            Response::Pong { version, pid } => {
                assert_eq!(version, env!("CARGO_PKG_VERSION"));
                assert_eq!(pid, std::process::id());
            }
            _ => panic!("expected pong"),
        }
    }

    #[test]
    fn connections_without_the_token_are_refused_and_closed() {
        let server = TestServer::start("auth");

        // No auth line: the first real request gets an Err and EOF.
        let (mut reader, mut writer) = server.connect_unauthed();
        writeln!(writer, "{}", serde_json::to_string(&Request::Ping).unwrap()).unwrap();
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert!(matches!(
            serde_json::from_str::<Response>(&line).unwrap(),
            Response::Err { .. }
        ));
        line.clear();
        assert_eq!(reader.read_line(&mut line).unwrap(), 0, "connection closed");

        // Wrong token: same refusal.
        let (mut reader, mut writer) = server.connect_unauthed();
        let bad = Request::Auth {
            token: "not-the-token".into(),
        };
        writeln!(writer, "{}", serde_json::to_string(&bad).unwrap()).unwrap();
        line.clear();
        reader.read_line(&mut line).unwrap();
        assert!(matches!(
            serde_json::from_str::<Response>(&line).unwrap(),
            Response::Err { .. }
        ));
        line.clear();
        assert_eq!(reader.read_line(&mut line).unwrap(), 0, "connection closed");

        // The token file is private to the user.
        let mode = std::os::unix::fs::MetadataExt::mode(
            &std::fs::metadata(token_path(&server.dir)).unwrap(),
        );
        assert_eq!(mode & 0o777, 0o600, "token file is 0600");
        let sock_mode = std::os::unix::fs::MetadataExt::mode(
            &std::fs::metadata(socket_path(&server.dir)).unwrap(),
        );
        assert_eq!(sock_mode & 0o777, 0o600, "socket file is 0600");
    }

    #[test]
    fn unknown_session_operations_are_calm() {
        let server = TestServer::start("calm");
        match server.roundtrip(&Request::ReuseOrCd {
            session_id: "nope:codex".into(),
            cwd: None,
        }) {
            Response::Reused { reused } => assert!(!reused),
            _ => panic!("expected reused=false"),
        }
        match server.roundtrip(&Request::Write {
            session_id: "nope:codex".into(),
            data: "y".into(),
        }) {
            Response::Wrote { wrote } => assert!(!wrote, "write to dead session is dropped"),
            _ => panic!("expected wrote=false"),
        }
        match server.roundtrip(&Request::Snapshot {
            session_id: "nope:codex".into(),
        }) {
            Response::Snapshot(snap) => {
                assert!(!snap.live);
                assert_eq!(snap.seq, 0);
            }
            _ => panic!("expected snapshot"),
        }
        match server.roundtrip(&Request::LiveRows) {
            Response::LiveRows { rows } => assert!(rows.is_empty()),
            _ => panic!("expected live rows"),
        }
    }

    #[test]
    fn malformed_line_gets_an_err_response_and_the_connection_survives() {
        let server = TestServer::start("badline");
        let (mut reader, mut writer) = server.connect();
        writeln!(writer, "this is not json").unwrap();
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert!(matches!(
            serde_json::from_str::<Response>(&line).unwrap(),
            Response::Err { .. }
        ));
        // Same connection still answers real requests.
        line.clear();
        writeln!(writer, "{}", serde_json::to_string(&Request::Ping).unwrap()).unwrap();
        reader.read_line(&mut line).unwrap();
        assert!(matches!(
            serde_json::from_str::<Response>(&line).unwrap(),
            Response::Pong { .. }
        ));
    }

    /// The freeze bug: with a session streaming (broadcasts every ~15ms), a
    /// chunk used to slip out between subscriber registration and the ack —
    /// the client read a Chunk as its "ack", declared the subscribe failed,
    /// and lost that race on every retry. The ack must ALWAYS be the first
    /// line, no matter how hot the broadcast loop is.
    #[test]
    fn subscribe_ack_precedes_events_even_mid_stream() {
        use std::sync::atomic::AtomicBool;
        let server = TestServer::start("ackrace");
        let state = server.state.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_hammer = stop.clone();
        let hammer = std::thread::spawn(move || {
            let mut seq = 0u64;
            while !stop_hammer.load(Ordering::Relaxed) {
                seq += 1;
                state.broadcast(&Event::Chunk {
                    session_id: "hot:codex".into(),
                    data: "x".repeat(64),
                    seq,
                });
            }
        });
        for attempt in 0..20 {
            let (mut reader, mut writer) = server.connect();
            writeln!(
                writer,
                "{}",
                serde_json::to_string(&Request::Subscribe).unwrap()
            )
            .unwrap();
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert!(
                matches!(
                    serde_json::from_str::<Response>(&line),
                    Ok(Response::Subscribed)
                ),
                "attempt {attempt}: first line must be the ack, got: {line}"
            );
            // And the stream is genuinely live: the next line is an event.
            line.clear();
            reader.read_line(&mut line).unwrap();
            assert!(
                serde_json::from_str::<Event>(&line).is_ok(),
                "attempt {attempt}: expected an event after the ack, got: {line}"
            );
        }
        stop.store(true, Ordering::Relaxed);
        hammer.join().unwrap();
    }

    #[test]
    fn stale_socket_file_is_reclaimed() {
        let dir = std::env::temp_dir().join(format!(
            "klide-ptyd-stale-{}-{}",
            std::process::id(),
            crate::pty_host::now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(socket_path(&dir).parent().unwrap()).unwrap();
        // A socket file with no listener behind it (daemon was SIGKILLed).
        drop(UnixListener::bind(socket_path(&dir)).unwrap());
        assert!(socket_path(&dir).exists());
        let listener = bind_socket(&dir);
        assert!(listener.is_ok(), "stale socket is removed and rebound");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn second_daemon_refuses_when_first_is_alive() {
        let server = TestServer::start("second");
        let err = bind_socket(&server.dir).expect_err("live socket refuses rebind");
        assert!(err.contains("already serving"));
    }

    /// End-to-end: spawn a real PTY through the socket, subscribe, and watch
    /// its chunks arrive with monotonic seqs; snapshot agrees with the log.
    /// Skipped when no login shell is available (bare CI).
    #[test]
    fn spawn_streams_chunks_to_subscribers() {
        if std::env::var("SHELL").is_err() && !std::path::Path::new("/bin/zsh").exists() {
            eprintln!("skipping: no shell available");
            return;
        }
        let server = TestServer::start("spawn");
        // Subscribe first so no chunk is missed.
        let (mut event_reader, mut event_writer) = server.connect();
        writeln!(
            event_writer,
            "{}",
            serde_json::to_string(&Request::Subscribe).unwrap()
        )
        .unwrap();
        let mut line = String::new();
        event_reader.read_line(&mut line).unwrap();
        assert!(matches!(
            serde_json::from_str::<Response>(&line).unwrap(),
            Response::Subscribed
        ));

        match server.roundtrip(&Request::Spawn {
            session_id: "convo-e2e:custom".into(),
            provider: "custom".into(),
            cwd: None,
            command: "printf 'klide-ptyd-e2e'; exit 0".into(),
            env: vec![],
            task: Some("e2e".into()),
            model: None,
            resume_session_id: None,
            detect_session_id: false,
        }) {
            Response::Ok => {}
            Response::Err { message } => panic!("spawn failed: {message}"),
            _ => panic!("expected ok"),
        }

        // Collect events until the exit lands (the shell may chunk output
        // arbitrarily); a stuck test dies on the read timeout below.
        event_reader
            .get_ref()
            .set_read_timeout(Some(std::time::Duration::from_secs(15)))
            .unwrap();
        let mut output = String::new();
        let mut last_seq = 0u64;
        loop {
            line.clear();
            if event_reader.read_line(&mut line).unwrap_or(0) == 0 {
                panic!("event stream ended before exit; got so far: {output:?}");
            }
            match serde_json::from_str::<Event>(&line).expect("event parses") {
                Event::Chunk { data, seq, .. } => {
                    assert!(seq > last_seq, "seqs are monotonic");
                    last_seq = seq;
                    output.push_str(&data);
                }
                Event::Exit { session_id } => {
                    assert_eq!(session_id, "convo-e2e:custom");
                    break;
                }
                Event::ExternalId { .. } => {}
            }
        }
        assert!(
            output.contains("klide-ptyd-e2e"),
            "printf output arrived via events: {output:?}"
        );

        // After exit the session is gone but the persisted log still replays.
        match server.roundtrip(&Request::Snapshot {
            session_id: "convo-e2e:custom".into(),
        }) {
            Response::Snapshot(snap) => {
                assert!(!snap.live);
                assert!(snap.data.contains("klide-ptyd-e2e"));
            }
            _ => panic!("expected snapshot"),
        }
    }
}
