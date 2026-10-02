//! The `ptyd` wire vocabulary: one [`Request`] per line in, one [`Response`]
//! line back, and [`Event`]s pushed to subscribed connections.
//!
//! This is deliberately **not** behind `#![cfg(unix)]`, even though the daemon
//! and its client are. The transport is Unix-only — a domain socket, and a
//! daemon that outlives its parent — but these three enums are pure serde over
//! types that already live in the portable [`crate::pty_host`]. They were
//! unix-gated only by living in the same file as the socket code, and that had
//! a real cost: `pty.rs` imports them unconditionally, so on any non-unix
//! target the imports failed to resolve and the whole delegate layer stopped
//! compiling. Splitting them out is what lets a `cfg(not(unix))` client stub
//! typecheck.
//!
//! Note both enums are hand-maintained lists of the same operations
//! `pty_host::SessionHost` exposes as methods. Keeping them in step is manual;
//! `Recent` is the evidence — it is served but never sent.

pub const PROTOCOL_VERSION: u32 = 2;

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


#[cfg(test)]
mod tests {
    //! The fence these types were behind, pinned.
    //!
    //! `pty_daemon.rs` and `pty_client.rs` carry `#![cfg(unix)]`, and an inner
    //! file-level cfg *empties* a module rather than removing it — so on a
    //! non-unix target the modules still existed, and every name inside them
    //! stopped resolving. `pty.rs` imports the wire enums and calls the client
    //! unconditionally, so the entire delegate layer failed to compile off unix.
    //!
    //! Only the host target is installed here, so these read the source rather
    //! than cross-compiling. They cannot prove a Windows build succeeds; they do
    //! fail if the split is undone.

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
    fn the_client_answers_on_every_target() {
        let src = include_str!("pty_client.rs");
        assert!(
            !is_module_gated(src),
            "pty_client is imported unconditionally by pty.rs; it must present \
             its three calls on every target"
        );
        // A stub per public entry point, so `pty.rs` keeps compiling and simply
        // falls back to the in-process host.
        for call in ["pub fn request(", "pub fn ensure_daemon(", "pub fn subscribe("] {
            assert_eq!(
                src.matches(call).count(),
                2,
                "{call} needs a unix implementation and a cfg(not(unix)) stub"
            );
        }
    }
}
