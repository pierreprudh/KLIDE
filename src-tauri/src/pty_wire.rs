//! The `ptyd` wire vocabulary: one [`Request`] per line in, one [`Response`]
//! line back, and [`Event`]s pushed to subscribed connections.
//!
//! Shared by Unix domain sockets, private Windows filesystem sockets,
//! and SSH stdio relays. Keeping the vocabulary portable lets clients replay
//! the same durable transcript regardless of the host operating system.

pub const PROTOCOL_VERSION: u32 = 3;

/// Which binary a process is running, captured once at start: the executable's
/// length and modification time. The package version alone does not change on
/// a rebuild, so without this a daemon started before `cargo build` would keep
/// running the old Harness for every background chat that follows.
pub fn build_id() -> &'static str {
    static BUILD: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    BUILD.get_or_init(|| {
        std::env::current_exe()
            .and_then(std::fs::metadata)
            .map(|meta| {
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_nanos());
                format!("{}-{modified}", meta.len())
            })
            .unwrap_or_default()
    })
}

use crate::pty_host::{
    DelegateMissionLink, LiveSessionRow, PtyExitOutcome, SessionSnapshot,
};

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    /// Must be the first line on every connection, carrying the token from
    /// [`token_path`]. No ack on success — the next request's response is
    /// the ack. A wrong or missing token gets one `Err` line and a closed
    /// connection.
    Auth {
        token: String,
    },
    /// Liveness + version check. A client seeing a version mismatch after an
    /// app upgrade asks the daemon to shut down and starts a fresh one.
    Ping,
    /// Upgrade this connection to an event stream.
    Subscribe,
    /// Ask the daemon to exit once this response is written. Sessions die
    /// with it — the client is expected to have drained/warned first.
    Shutdown,
    PrepareUpgrade,
    RemoteIdentity,
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
        mission_link: Option<DelegateMissionLink>,
        /// Whether the daemon should watch output for the CLI announcing its
        /// own session id (`delegate::lookup(provider)` — the daemon links
        /// the same crate, so the detector runs in-process here too).
        detect_session_id: bool,
        /// sha256 of the session's bridge secret, for its scrollback meta.
        /// Defaulted so an older app talking to a newer daemon still spawns.
        #[serde(default)]
        coord_secret_sha256: Option<String>,
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
    ChatStart {
        request: Box<crate::agent::types::StartRunRequest>,
        runs_dir: std::path::PathBuf,
    },
    RemoteStart { request: Box<crate::agent::types::StartRunRequest>, checkout: String },
    RemoteRead { run_id: String, from_seq: u64, limit: usize },
    RemoteChanges { run_id: String },
    ChatStatus { run_id: String },
    ChatList,
    ChatOperations { run_id: String },
    ChatOperationReply { operation_id: String, result: Result<serde_json::Value, String> },
    ChatControl { run_id: String, control: ChatControl },
    // NOTE: there is deliberately no `Recent` here. It existed, and was served,
    // but `pty.rs` never sent it — `delegate_pty_recent_sessions` scans the
    // shared scrollback dir directly, which is identical from either host. It
    // was an artefact of maintaining this list by hand alongside
    // `SessionHost`'s methods rather than deriving one from the other.
}

/// An approved Mission operation still belongs to the app's Mission supervisor.
/// The daemon keeps this request pending across GUI disconnects; reopening
/// replays it through the existing idempotent Mission dispatch path.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ChatOperation {
    pub id: String,
    pub run_id: String,
    pub workspace_root: String,
    pub request: crate::missions::orchestration::Request,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatControl {
    Stop,
    Permission { decision: serde_json::Value },
    Diff { decision: serde_json::Value },
    Question { answer: String },
    CommandPolicy { auto_approve: bool },
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Response {
    RemoteIdentity { source: String },
    RemoteChanges { diff: String, status: String, worktree: String },
    RemoteEvents { events: Vec<crate::agent::types::AgentEvent>, next_seq: u64 },
    ChatStarted { from_seq: u64 },
    ChatOperations { operations: Vec<ChatOperation> },
    Pong {
        version: String,
        pid: u32,
        #[serde(default)]
        protocol: u32,
        /// [`build_id`] of the serving binary; empty from older daemons.
        #[serde(default)]
        build: String,
    },
    ChatStatus { status: Option<String>, from_seq: u64 },
    ChatList { runs: std::collections::HashMap<String, String> },
    ChatControlled { answered: bool },
    Subscribed,
    Ok,
    Err {
        message: String,
    },
    Reused {
        reused: bool,
    },
    Wrote {
        wrote: bool,
    },
    Snapshot(SessionSnapshot),
    LiveRows {
        rows: Vec<LiveSessionRow>,
    },
}

/// Pushed to subscribed connections — the socket twin of the app's
/// `delegate-pty:*` Tauri events plus the external-id detection callback.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    ChatOperation { operation: ChatOperation },
    Chat { run_id: String, seq: u64, event: crate::agent::types::AgentEvent },
    /// A Run this host owns moved the Workspace's coordination journal; the
    /// app relays it to its panels as the app's own supervisor would.
    CoordinationChanged { workspace_root: String, seq: u64 },
    Chunk {
        session_id: String,
        data: String,
        seq: u64,
    },
    Exit {
        session_id: String,
        outcome: PtyExitOutcome,
    },
    ExternalId {
        session_id: String,
        external_id: String,
    },
}

/// Largest line accepted on the ptyd wire, in either direction. Events can
/// carry tool output, but a line with no newline must not grow without bound:
/// a peer — or anything that can sit inside the connection — could otherwise
/// OOM the process, on the daemon side before auth is even checked.
pub const MAX_WIRE_LINE: usize = 8 * 1024 * 1024;

/// `BufRead::lines`, capped: read one line (without the trailing newline),
/// `Ok(None)` at EOF. A line longer than [`MAX_WIRE_LINE`] is an
/// `InvalidData` error; the caller should drop the connection.
pub fn read_line_capped(
    reader: &mut impl std::io::BufRead,
) -> std::io::Result<Option<String>> {
    read_line_capped_with(reader, MAX_WIRE_LINE)
}

/// [`read_line_capped`] with an explicit cap, so tests don't need 8 MiB.
pub fn read_line_capped_with(
    reader: &mut impl std::io::BufRead,
    max: usize,
) -> std::io::Result<Option<String>> {
    use std::io::{BufRead, Read};
    let mut buf: Vec<u8> = Vec::new();
    // `take` bounds the read itself: a bare `read_until` keeps buffering
    // until a newline or EOF, so a peer that never sends one would grow the
    // buffer without limit before any length check ran.
    let limit = max as u64 + 1;
    reader.by_ref().take(limit).read_until(b'\n', &mut buf)?;
    if buf.last() == Some(&b'\n') {
        buf.pop();
        return Ok(Some(String::from_utf8_lossy(&buf).into_owned()));
    }
    if buf.len() > max {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("wire line exceeds {max} bytes"),
        ));
    }
    Ok(if buf.is_empty() {
        None
    } else {
        Some(String::from_utf8_lossy(&buf).into_owned())
    })
}


#[cfg(test)]
mod tests {
    //! The fence these types were behind, pinned.
    //!
    //! Historically `pty_daemon.rs` and `pty_client.rs` carried `#![cfg(unix)]`; an inner
    //! file-level cfg *empties* a module rather than removing it — so on a
    //! non-unix target the modules still existed, and every name inside them
    //! stopped resolving. `pty.rs` imports the wire enums and calls the client
    //! unconditionally, so the entire delegate layer failed to compile off unix.
    //!
    //! These source guards catch reintroduced module gates. Native CI builds
    //! and runtime smoke tests provide the platform acceptance separately.
    use super::*;

    /// Is `src` gated as a whole? Matches the inner attribute as its own line,
    /// so a doc comment that merely *mentions* it doesn't count.
    fn is_module_gated(src: &str) -> bool {
        src.lines().any(|l| l.trim() == "#![cfg(unix)]")
    }

    /// Everything before the test module — these tests name the very strings
    /// they search for.
    fn production_half(src: &str) -> &str {
        match src.find("#[cfg(test)]") {
            Some(i) => &src[..i],
            None => src,
        }
    }

    #[test]
    fn the_wire_vocabulary_is_not_unix_gated() {
        let src = production_half(include_str!("pty_wire.rs"));
        assert!(
            !is_module_gated(src),
            "these enums are pure serde over portable pty_host types — gating \
             them is what broke the non-unix build"
        );
        assert!(
            !src.contains("std::os::unix"),
            "nothing unix-specific belongs in the wire module"
        );
    }

    #[test]
    fn pty_takes_the_wire_types_from_here_not_from_the_daemon() {
        let src = production_half(include_str!("pty.rs"));
        assert!(
            src.contains("use crate::pty_wire::{"),
            "pty.rs must name the wire types through the portable module"
        );
        assert!(
            !src.contains("use crate::pty_daemon::{"),
            "importing them through the `#![cfg(unix)]` daemon module is the \
             exact break this split removed"
        );
    }

    #[test]
    fn read_line_capped_reads_lines_eof_and_refuses_overlong_lines() {
        use std::io::Cursor;
        let mut c = Cursor::new(b"first\nsecond\n".to_vec());
        assert_eq!(read_line_capped_with(&mut c, 64).unwrap().as_deref(), Some("first"));
        assert_eq!(read_line_capped_with(&mut c, 64).unwrap().as_deref(), Some("second"));
        assert_eq!(read_line_capped_with(&mut c, 64).unwrap(), None);
        // No newline and over the cap: an error, so the caller drops the connection.
        let mut big = Cursor::new(vec![b'x'; 100]);
        assert!(read_line_capped_with(&mut big, 64).is_err());
        // A live peer that never sends a newline: the read stops at the cap
        // instead of buffering the whole stream.
        let mut endless = std::io::BufReader::new(std::io::repeat(b'x'));
        assert!(read_line_capped_with(&mut endless, 64).is_err());
        // Exactly at the cap is still a line.
        let mut edge = Cursor::new([vec![b'y'; 64], b"\nnext\n".to_vec()].concat());
        assert_eq!(read_line_capped_with(&mut edge, 64).unwrap().map(|l| l.len()), Some(64));
        assert_eq!(read_line_capped_with(&mut edge, 64).unwrap().as_deref(), Some("next"));
        // No newline but within the cap: EOF tail is returned as-is.
        let mut tail = Cursor::new(b"tail-no-newline".to_vec());
        assert_eq!(
            read_line_capped_with(&mut tail, 64).unwrap().as_deref(),
            Some("tail-no-newline")
        );
    }

    #[test]
    fn the_client_answers_on_every_target() {
        let src = include_str!("pty_client.rs");
        assert!(
            !is_module_gated(src),
            "pty_client is imported unconditionally by pty.rs; it must present \
             its three calls on every target"
        );
        // Each entry point now has one portable implementation: both Unix sockets
        // and the Windows private local socket use the same wire.
        for call in ["pub fn request(", "pub fn ensure_daemon(", "pub fn subscribe("] {
            assert_eq!(
                src.matches(call).count(),
                1,
                "{call} must have one portable implementation"
            );
        }
    }
}
