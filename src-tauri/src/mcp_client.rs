//! The other half of the MCP story: Klide as a **client**.
//!
//! `mcp_server.rs` is what a Delegate CLI starts to reach *into* Klide. This
//! module is the reverse — Klide starting someone else's stdio MCP server
//! (Linear, Notion, a Postgres reader, a repo's own `.mcp.json` entry) and
//! asking what it can do. One connector, one child process, one probe.
//!
//! Deliberately a *probe*, not a session. Slice 1 answers the only question
//! the Connectors page asks — "does this thing start, and what tools does it
//! have?" — then kills the child. Nothing here is wired into the Harness tool
//! registry yet, so a connector cannot act; holding a long-lived child per
//! connector is the next slice's problem, with its own lifecycle and failure
//! modes.
//!
//! Hand-rolled JSON-RPC for the same reason the server is: four methods
//! (`initialize`, `notifications/initialized`, `tools/list`) do not earn a
//! dependency, and the two halves stay readable side by side.
//!
//! Two safety notes worth keeping:
//!
//! * The binary is resolved through [`crate::cli::resolve_command`], which
//!   never interprets shell syntax — a connector command is a program plus
//!   argv, never a string a shell expands. A Finder-launched app has a minimal
//!   PATH, so this also resolves `npx` the way the rest of Klide does.
//! * Every read is bounded. A server that starts and then says nothing must
//!   fail the probe, not hang the blocking pool, so the reader lives on its own
//!   thread and the caller waits on a channel with a deadline.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// The newest revision Klide speaks as a client. A server that prefers an
/// older one answers with its own; we record what it said rather than insist.
const PROTOCOL_VERSION: &str = "2025-06-18";

/// How long one probe may take end to end — spawn, initialize, tools/list.
/// Generous because the first `npx -y <package>` of a connector downloads it.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(60);

/// How a connector is launched. Stdio only for now; an HTTP/SSE transport is a
/// second variant here when remote connectors land, not a second module.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StdioServer {
    /// Program name or path — `npx`, `uvx`, `/usr/local/bin/my-server`.
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Extra environment for the child. An MCP client hands a stdio server a
    /// filtered environment, so a connector's token lives here, not in the
    /// ambient shell.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Working directory for the child. Workspace-rooted for a connector that
    /// came from a project's own `.mcp.json`.
    #[serde(default)]
    pub cwd: Option<String>,
}

/// One tool a connector advertises. A thin projection of the MCP `Tool` shape:
/// what the Connectors page shows, plus the one annotation that decides how a
/// future Harness would gate it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default)]
    pub description: String,
    /// `annotations.readOnlyHint`. `None` means the server didn't say — which
    /// a permission gate must read as "assume it writes", never as read-only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_only: Option<bool>,
}

/// What a successful probe learned.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    /// The server's own name from `serverInfo` — not the label the user gave
    /// the connector, so a mislabelled row is visible.
    pub server_name: String,
    #[serde(default)]
    pub server_version: String,
    /// The protocol revision the *server* chose.
    #[serde(default)]
    pub protocol_version: String,
    /// The server's `instructions` block, when it sent one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    pub tools: Vec<McpTool>,
    /// Wall-clock milliseconds the probe took. The page shows it because a
    /// 40-second `npx` cold start reads as "broken" without it.
    pub elapsed_ms: u64,
}

/// A child that is killed when this goes out of scope, however the probe ended.
/// A connector that fails mid-handshake must not leave a process behind.
struct Reaped(Child);

impl Drop for Reaped {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Start the server, complete the MCP handshake, list its tools, kill it.
///
/// Blocking on purpose — callers reach it through [`crate::blocking::run`].
pub fn probe(server: &StdioServer, timeout: Duration) -> Result<Probe, String> {
    let started = Instant::now();
    let deadline = started + timeout;
    let binary = crate::cli::resolve_command(&server.command)
        .map_err(|e| format!("{}: {e}", server.command))?;

    let mut command = Command::new(&binary);
    command
        .args(&server.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in &server.env {
        command.env(key, value);
    }
    if let Some(cwd) = server.cwd.as_deref().filter(|c| !c.is_empty()) {
        command.current_dir(cwd);
    }
    let mut child = Reaped(
        command
            .spawn()
            .map_err(|e| format!("Could not start {}: {e}", server.command))?,
    );

    let mut stdin = child
        .0
        .stdin
        .take()
        .ok_or_else(|| "The server gave us no stdin".to_string())?;
    let stdout = child
        .0
        .stdout
        .take()
        .ok_or_else(|| "The server gave us no stdout".to_string())?;
    // stderr is where a failing server explains itself ("package not found").
    // Drained on its own thread so a chatty server can never fill the pipe and
    // block, and kept so a timeout can quote it instead of saying nothing.
    let stderr = child.0.stderr.take();
    let (err_tx, err_rx) = mpsc::channel::<String>();
    if let Some(stderr) = stderr {
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if err_tx.send(line).is_err() {
                    return;
                }
            }
        });
    }

    let (tx, rx) = mpsc::channel::<Value>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if tx.send(message).is_err() {
                return;
            }
        }
    });

    let mut send = |message: Value| -> Result<(), String> {
        writeln!(stdin, "{message}").map_err(|e| format!("Could not write to the server: {e}"))?;
        stdin
            .flush()
            .map_err(|e| format!("Could not write to the server: {e}"))
    };

    // The handshake, in the order the spec asks for it.
    send(json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "Klide", "version": env!("CARGO_PKG_VERSION") },
        },
    }))?;
    let initialized = await_response(&rx, 1, deadline, &err_rx)?;
    send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))?;

    send(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }))?;
    let listed = await_response(&rx, 2, deadline, &err_rx)?;

    let info = initialized.get("serverInfo");
    let string = |value: Option<&Value>, key: &str| {
        value
            .and_then(|v| v.get(key))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    Ok(Probe {
        server_name: {
            let name = string(info, "name");
            if name.is_empty() {
                server.command.clone()
            } else {
                name
            }
        },
        server_version: string(info, "version"),
        protocol_version: string(Some(&initialized), "protocolVersion"),
        instructions: initialized
            .get("instructions")
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|s| !s.trim().is_empty()),
        tools: parse_tools(&listed),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// Read messages until the reply to `id` arrives, the server errors, or the
/// deadline passes. Notifications and other ids are skipped, not treated as a
/// protocol violation — a server may log while it answers.
fn await_response(
    rx: &mpsc::Receiver<Value>,
    id: i64,
    deadline: Instant,
    stderr: &mpsc::Receiver<String>,
) -> Result<Value, String> {
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| timed_out(stderr))?;
        let message = match rx.recv_timeout(remaining) {
            Ok(message) => message,
            Err(mpsc::RecvTimeoutError::Timeout) => return Err(timed_out(stderr)),
            // The reader thread ended: the child closed stdout or died.
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(match last_error(stderr) {
                    Some(line) => format!("The server stopped: {line}"),
                    None => "The server stopped before it answered".to_string(),
                })
            }
        };
        // A response, and the one we asked for. `method` marks a request or a
        // notification the server sent us — a server that echoes our own line
        // back (or talks over us) must not be read as having answered.
        if message.get("method").is_some() || message.get("id").and_then(Value::as_i64) != Some(id) {
            continue;
        }
        if let Some(error) = message.get("error") {
            let text = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            return Err(format!("The server refused: {text}"));
        }
        return match message.get("result") {
            Some(result) => Ok(result.clone()),
            // Neither `result` nor `error`: not an MCP response at all.
            None => Err("The server sent something that is not a reply".to_string()),
        };
    }
}

fn timed_out(stderr: &mpsc::Receiver<String>) -> String {
    match last_error(stderr) {
        Some(line) => format!("The server did not answer in time: {line}"),
        None => "The server did not answer in time".to_string(),
    }
}

/// The most recent thing the server said on stderr, if anything. Drained
/// without blocking — this only ever runs on a path that is already failing.
fn last_error(stderr: &mpsc::Receiver<String>) -> Option<String> {
    let mut last = None;
    while let Ok(line) = stderr.try_recv() {
        let line = line.trim().to_string();
        if !line.is_empty() {
            last = Some(line);
        }
    }
    last.map(|line| line.chars().take(300).collect())
}

/// `tools/list` → the projection the page shows. A malformed entry is dropped
/// rather than failing the probe: one bad tool must not hide the other twenty.
fn parse_tools(result: &Value) -> Vec<McpTool> {
    result
        .get("tools")
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| {
                    let name = tool.get("name").and_then(Value::as_str)?.to_string();
                    Some(McpTool {
                        name,
                        title: tool
                            .get("title")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .filter(|s| !s.is_empty()),
                        description: tool
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        read_only: tool
                            .get("annotations")
                            .and_then(|a| a.get("readOnlyHint"))
                            .and_then(Value::as_bool),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scripted server: reads our three handshake lines and answers with a
    /// fixed initialize result and one tool. Deterministic, no network, no
    /// package download — and still the real transport, framing and parse path.
    #[cfg(unix)]
    fn scripted(script: &str) -> StdioServer {
        StdioServer {
            command: "sh".to_string(),
            args: vec!["-c".to_string(), script.to_string()],
            ..StdioServer::default()
        }
    }

    #[test]
    fn a_missing_binary_fails_before_anything_is_spawned() {
        let server = StdioServer {
            command: "klide-no-such-connector".to_string(),
            ..StdioServer::default()
        };
        let error = probe(&server, Duration::from_secs(5)).unwrap_err();
        assert!(error.contains("klide-no-such-connector"), "{error}");
    }

    #[test]
    fn a_command_is_argv_never_a_shell_string() {
        let server = StdioServer {
            command: "true; touch /tmp/klide-connector-injection".to_string(),
            ..StdioServer::default()
        };
        assert!(probe(&server, Duration::from_secs(5)).is_err());
        assert!(!std::path::Path::new("/tmp/klide-connector-injection").exists());
    }

    #[test]
    #[cfg(unix)]
    fn a_server_that_never_answers_times_out_instead_of_hanging() {
        let server = scripted("sleep 30");
        let started = Instant::now();
        let error = probe(&server, Duration::from_millis(400)).unwrap_err();
        assert!(error.contains("did not answer in time"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    #[cfg(unix)]
    fn a_handshake_reports_the_servers_own_identity_and_tools() {
        let server = scripted(
            r#"read _init
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","serverInfo":{"name":"fixture","version":"1.2.3"},"instructions":"read only"}}'
read _initialized
read _list
printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"search","description":"Find things","annotations":{"readOnlyHint":true}},{"name":"write","description":"Change things"}]}}'
"#,
        );
        let probe = probe(&server, Duration::from_secs(10)).expect("handshake");
        assert_eq!(probe.server_name, "fixture");
        assert_eq!(probe.server_version, "1.2.3");
        // The server's chosen revision, not the one Klide asked for.
        assert_eq!(probe.protocol_version, "2024-11-05");
        assert_eq!(probe.instructions.as_deref(), Some("read only"));
        assert_eq!(probe.tools.len(), 2);
        assert_eq!(probe.tools[0].read_only, Some(true));
        // Unannotated stays `None` — a gate must not read silence as read-only.
        assert_eq!(probe.tools[1].read_only, None);
    }

    #[test]
    #[cfg(unix)]
    fn an_echo_server_is_not_mistaken_for_an_answer() {
        // `cat` returns our own `{"id":1,...}` line. It carries the id we are
        // waiting on, so only the request/response distinction rejects it.
        let server = StdioServer {
            command: "cat".to_string(),
            ..StdioServer::default()
        };
        let error = probe(&server, Duration::from_millis(600)).unwrap_err();
        assert!(error.contains("did not answer in time"), "{error}");
    }

    #[test]
    #[cfg(unix)]
    fn a_server_that_refuses_says_why() {
        let server = scripted(
            r#"read _init
printf '%s\n' '{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"missing LINEAR_API_KEY"}}'
"#,
        );
        let error = probe(&server, Duration::from_secs(10)).unwrap_err();
        assert!(error.contains("missing LINEAR_API_KEY"), "{error}");
    }

    #[test]
    #[cfg(unix)]
    fn a_server_that_dies_quotes_its_last_words() {
        let server = scripted("echo 'npm ERR! 404 not found' >&2; exit 1");
        let error = probe(&server, Duration::from_secs(10)).unwrap_err();
        assert!(error.contains("404 not found"), "{error}");
    }
}
