//! The other half of the MCP story: Klide as a **client**.
//!
//! `mcp_server.rs` is what a Delegate CLI starts to reach *into* Klide. This
//! module is the reverse — Klide talking to someone else's MCP server (GitHub,
//! Linear, Notion, a Postgres reader, a repo's own `.mcp.json` entry): start or
//! reach it, complete the handshake, list its tools, call one.
//!
//! One [`Session`] is one live connection. It speaks two transports behind the
//! same four methods, because a connector is either a program Klide starts
//! (stdio) or a URL it posts to (Streamable HTTP — GitHub's own server is one).
//! A [`probe`] is a session opened and dropped: the Connectors page's "does this
//! start, and what can it do?" question. The long-lived sessions a Run calls
//! through are owned by `connector_pool.rs`, not here — this module is
//! transport and framing only, and knows nothing of Runs, permissions or where
//! a token came from (`connectors.rs` resolves `${VAR}` references before a
//! spec reaches this file).
//!
//! Hand-rolled JSON-RPC for the same reason the server is: `initialize`,
//! `notifications/initialized`, `tools/list` and `tools/call` do not earn a
//! dependency, and the two halves stay readable side by side.
//!
//! Safety notes worth keeping:
//!
//! * The binary is resolved through [`crate::cli::resolve_command`], which
//!   never interprets shell syntax — a connector command is a program plus
//!   argv, never a string a shell expands. A Finder-launched app has a minimal
//!   PATH, so this also resolves `npx` the way the rest of Klide does.
//! * Every read is bounded, in time and in bytes. A server that starts and
//!   then says nothing must fail, not hang the blocking pool: the stdio reader
//!   lives on its own thread and the caller waits on a channel with a
//!   deadline; an HTTP request carries the same deadline as its timeout.
//! * A session that failed at the transport level is marked broken and never
//!   reused, so the pool reconnects instead of writing into a dead pipe.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// The newest revision Klide speaks as a client. A server that prefers an
/// older one answers with its own; we record what it said rather than insist.
const PROTOCOL_VERSION: &str = "2025-06-18";

/// How long one probe may take end to end — spawn, initialize, tools/list.
/// Generous because the first `npx -y <package>` of a connector downloads it.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(60);

/// The most a single reply may weigh before it is refused. A tool result is
/// text for a model; anything past this is a runaway, not an answer.
const MAX_REPLY_BYTES: u64 = 8 * 1024 * 1024;

/// A server that pages its tool list gets this many pages, then we stop. A
/// cursor that never ends must not spin a blocking thread forever.
const MAX_TOOL_PAGES: usize = 20;

/// How a connector is reached. Untagged so the stdio shape stored before the
/// HTTP transport existed (`{command, args, env}`) still reads unchanged: an
/// entry with a `url` is remote, anything with a `command` is a program.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(untagged)]
pub enum ServerSpec {
    Http(HttpServer),
    Stdio(StdioServer),
}

impl Default for ServerSpec {
    fn default() -> Self {
        ServerSpec::Stdio(StdioServer::default())
    }
}

impl ServerSpec {
    /// True when there is nothing to start or reach.
    pub fn is_blank(&self) -> bool {
        match self {
            ServerSpec::Stdio(s) => s.command.trim().is_empty(),
            ServerSpec::Http(h) => h.url.trim().is_empty(),
        }
    }

    /// What the server is, for an error message — the program or the URL.
    fn describe(&self) -> &str {
        match self {
            ServerSpec::Stdio(s) => &s.command,
            ServerSpec::Http(h) => &h.url,
        }
    }
}

/// A program Klide starts and talks to over stdin/stdout.
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

/// A remote server reached over Streamable HTTP: one URL that takes JSON-RPC
/// POSTs and answers with JSON or a server-sent-event stream.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HttpServer {
    pub url: String,
    /// Sent on every request — `Authorization`, and server options such as
    /// GitHub's `X-MCP-Toolsets`. Stored values may be `${VAR}` references;
    /// by the time a spec reaches this module they are resolved.
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
}

/// One tool a connector advertises. A thin projection of the MCP `Tool` shape:
/// what the Connectors page shows, plus what a Run needs to call it and the one
/// annotation that decides how the Harness gates it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
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
    /// The JSON Schema of the tool's arguments. Kept for the Run that fetches
    /// it on demand; never sent to the page, which only lists tools.
    #[serde(default, skip_serializing)]
    pub input_schema: Value,
}

/// What a handshake learned.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
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
    /// Wall-clock milliseconds the handshake took. The page shows it because a
    /// 40-second `npx` cold start reads as "broken" without it.
    pub elapsed_ms: u64,
}

/// What one `tools/call` produced, flattened to the text a model reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallResult {
    /// The server's own `isError` — the tool ran and reported failure. Distinct
    /// from a transport or protocol error, which is an `Err`.
    pub is_error: bool,
    pub text: String,
}

/// What an HTTP server that forgot our `Mcp-Session-Id` makes a call return.
const SESSION_ENDED: &str = "The server ended this session";

/// True for the one failure that is safe to retry on a fresh session: the
/// server rejected the request before running it.
pub fn is_session_ended(error: &str) -> bool {
    error == SESSION_ENDED
}

/// A child that is killed when this goes out of scope, however the session
/// ended. A connector that fails mid-handshake must not leave a process behind.
struct Reaped(Child);

impl Drop for Reaped {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// One live connection to one server.
pub struct Session {
    transport: Transport,
    next_id: i64,
    /// Set by the first transport-level failure. A broken session answers
    /// nothing again; the owner drops it and connects afresh.
    broken: bool,
    /// What the handshake learned, tools included.
    pub info: Probe,
}

enum Transport {
    Stdio(StdioPipe),
    Http(HttpPipe),
}

struct StdioPipe {
    child: Reaped,
    stdin: ChildStdin,
    rx: mpsc::Receiver<Value>,
    stderr: mpsc::Receiver<String>,
}

struct HttpPipe {
    client: reqwest::blocking::Client,
    url: String,
    headers: BTreeMap<String, String>,
    /// `Mcp-Session-Id` from the initialize reply, echoed on every later
    /// request. Stateless servers never send one.
    session_id: Option<String>,
    /// The revision the server chose, sent as `MCP-Protocol-Version` after the
    /// handshake as the spec asks.
    protocol: Option<String>,
}

/// Why a request failed. Only `Transport` breaks the session — a refusal is a
/// clean answer and the connection is still good.
enum Failure {
    /// The server answered with a JSON-RPC error.
    Refused(String),
    /// Anything else: timeout, dead pipe, HTTP failure, unparseable reply.
    Transport(String),
}

impl Failure {
    fn message(self) -> String {
        match self {
            Failure::Refused(m) | Failure::Transport(m) => m,
        }
    }
}

/// Connect, list its tools, disconnect.
///
/// Blocking on purpose — callers reach it through [`crate::blocking::run`].
pub fn probe(server: &ServerSpec, timeout: Duration) -> Result<Probe, String> {
    Session::connect(server, timeout).map(|session| session.info)
}

impl Session {
    /// Start or reach the server, complete the MCP handshake, and read its
    /// whole tool list. Blocking.
    pub fn connect(server: &ServerSpec, timeout: Duration) -> Result<Session, String> {
        let started = Instant::now();
        let deadline = started + timeout;
        let transport = match server {
            ServerSpec::Stdio(stdio) => Transport::Stdio(StdioPipe::spawn(stdio)?),
            ServerSpec::Http(http) => Transport::Http(HttpPipe::new(http)?),
        };
        let mut session = Session {
            transport,
            next_id: 1,
            broken: false,
            info: Probe {
                server_name: String::new(),
                server_version: String::new(),
                protocol_version: String::new(),
                instructions: None,
                tools: Vec::new(),
                elapsed_ms: 0,
            },
        };

        // The handshake, in the order the spec asks for it.
        let initialized = session
            .request(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": { "name": "Klide", "version": env!("CARGO_PKG_VERSION") },
                }),
                deadline,
            )
            .map_err(Failure::message)?;
        let protocol = string(Some(&initialized), "protocolVersion");
        if let Transport::Http(http) = &mut session.transport {
            http.protocol = Some(if protocol.is_empty() { PROTOCOL_VERSION.to_string() } else { protocol.clone() });
        }
        session.notify("notifications/initialized", deadline)?;

        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MAX_TOOL_PAGES {
            let params = match &cursor {
                Some(cursor) => json!({ "cursor": cursor }),
                None => json!({}),
            };
            let listed = session.request("tools/list", params, deadline).map_err(Failure::message)?;
            tools.extend(parse_tools(&listed));
            cursor = listed
                .get("nextCursor")
                .and_then(Value::as_str)
                .filter(|c| !c.is_empty())
                .map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }

        let info = initialized.get("serverInfo");
        session.info = Probe {
            server_name: {
                let name = string(info, "name");
                if name.is_empty() {
                    server.describe().to_string()
                } else {
                    name
                }
            },
            server_version: string(info, "version"),
            protocol_version: protocol,
            instructions: initialized
                .get("instructions")
                .and_then(Value::as_str)
                .map(str::to_string)
                .filter(|s| !s.trim().is_empty()),
            tools,
            elapsed_ms: started.elapsed().as_millis() as u64,
        };
        Ok(session)
    }

    /// False once a transport failure made this connection unusable, or the
    /// child process has exited.
    pub fn usable(&mut self) -> bool {
        if self.broken {
            return false;
        }
        if let Transport::Stdio(pipe) = &mut self.transport {
            if !matches!(pipe.child.0.try_wait(), Ok(None)) {
                self.broken = true;
            }
        }
        !self.broken
    }

    /// Call one tool. `Err` is a failure to get an answer at all (or a JSON-RPC
    /// refusal); a tool that ran and failed is `Ok` with `is_error` set.
    pub fn call_tool(&mut self, name: &str, arguments: Value, timeout: Duration) -> Result<CallResult, String> {
        let deadline = Instant::now() + timeout;
        let result = self
            .request("tools/call", json!({ "name": name, "arguments": arguments }), deadline)
            .map_err(Failure::message)?;
        Ok(call_result(&result))
    }

    fn request(&mut self, method: &str, params: Value, deadline: Instant) -> Result<Value, Failure> {
        if self.broken {
            return Err(Failure::Transport("The connection to this server was lost".to_string()));
        }
        let id = self.next_id;
        self.next_id += 1;
        let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let outcome = match &mut self.transport {
            Transport::Stdio(pipe) => pipe.request(&message, id, deadline),
            Transport::Http(pipe) => pipe.request(&message, id, deadline),
        };
        if matches!(outcome, Err(Failure::Transport(_))) {
            self.broken = true;
        }
        outcome
    }

    fn notify(&mut self, method: &str, deadline: Instant) -> Result<(), String> {
        let message = json!({ "jsonrpc": "2.0", "method": method });
        let outcome = match &mut self.transport {
            Transport::Stdio(pipe) => pipe.send(&message),
            Transport::Http(pipe) => pipe.post(&message, None, deadline).map(|_| ()),
        };
        outcome.map_err(|failure| {
            self.broken = true;
            failure.message()
        })
    }
}

/* ------------------------------------------------------------------ stdio --*/

impl StdioPipe {
    fn spawn(server: &StdioServer) -> Result<StdioPipe, String> {
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

        let stdin = child
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
        let (err_tx, err_rx) = mpsc::channel::<String>();
        if let Some(stderr) = child.0.stderr.take() {
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
        Ok(StdioPipe { child, stdin, rx, stderr: err_rx })
    }

    fn send(&mut self, message: &Value) -> Result<(), Failure> {
        let write = |stdin: &mut ChildStdin| -> std::io::Result<()> {
            writeln!(stdin, "{message}")?;
            stdin.flush()
        };
        write(&mut self.stdin).map_err(|e| Failure::Transport(format!("Could not write to the server: {e}")))
    }

    fn request(&mut self, outgoing: &Value, id: i64, deadline: Instant) -> Result<Value, Failure> {
        self.send(outgoing)?;
        loop {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or_else(|| Failure::Transport(timed_out(&self.stderr)))?;
            let message = match self.rx.recv_timeout(remaining) {
                Ok(message) => message,
                Err(mpsc::RecvTimeoutError::Timeout) => return Err(Failure::Transport(timed_out(&self.stderr))),
                // The reader thread ended: the child closed stdout or died.
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(Failure::Transport(match last_error(&self.stderr) {
                        Some(line) => format!("The server stopped: {line}"),
                        None => "The server stopped before it answered".to_string(),
                    }))
                }
            };
            // Our own line coming back (a server that echoes) is neither a
            // request to answer nor a reply.
            if &message == outgoing {
                continue;
            }
            // A request the server sends us while we wait. `ping` gets the empty
            // answer the spec asks for; anything else is a capability we never
            // declared, refused rather than left hanging.
            if let (Some(method), Some(their_id)) = (message.get("method").and_then(Value::as_str), message.get("id")) {
                let reply = if method == "ping" {
                    json!({ "jsonrpc": "2.0", "id": their_id, "result": {} })
                } else {
                    json!({ "jsonrpc": "2.0", "id": their_id, "error": { "code": -32601, "message": "Not supported by Klide" } })
                };
                self.send(&reply)?;
                continue;
            }
            if let Some(answer) = response_for(&message, id) {
                return answer;
            }
        }
    }
}

/* ------------------------------------------------------------------- http --*/

impl HttpPipe {
    fn new(server: &HttpServer) -> Result<HttpPipe, String> {
        let url = reqwest::Url::parse(server.url.trim()).map_err(|e| format!("{}: {e}", server.url))?;
        if !matches!(url.scheme(), "https" | "http") {
            return Err(format!("{} is not an http(s) URL", server.url));
        }
        let client = reqwest::blocking::Client::builder()
            .user_agent(concat!("Klide/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(HttpPipe {
            client,
            url: url.to_string(),
            headers: server.headers.clone(),
            session_id: None,
            protocol: None,
        })
    }

    fn request(&mut self, message: &Value, id: i64, deadline: Instant) -> Result<Value, Failure> {
        match self.post(message, Some(id), deadline)? {
            Some(answer) => answer,
            None => Err(Failure::Transport("The server answered without a reply".to_string())),
        }
    }

    /// POST one message. For a request (`id` set) returns its response; for a
    /// notification, `None` once the server accepted it.
    fn post(&mut self, message: &Value, id: Option<i64>, deadline: Instant) -> Result<Option<Result<Value, Failure>>, Failure> {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| Failure::Transport("The server did not answer in time".to_string()))?;
        let mut request = self
            .client
            .post(&self.url)
            .timeout(remaining)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream");
        for (key, value) in &self.headers {
            request = request.header(key.as_str(), value.as_str());
        }
        if let Some(session) = &self.session_id {
            request = request.header("Mcp-Session-Id", session.as_str());
        }
        if let Some(protocol) = &self.protocol {
            request = request.header("MCP-Protocol-Version", protocol.as_str());
        }
        let response = request.body(message.to_string()).send().map_err(|e| {
            Failure::Transport(if e.is_timeout() {
                "The server did not answer in time".to_string()
            } else {
                format!("Could not reach the server: {e}")
            })
        })?;

        let status = response.status();
        if let Some(session) = response.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
            self.session_id = Some(session.to_string());
        }
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(Failure::Transport(format!(
                "The server refused the credentials (HTTP {}). Check the connector's sign-in.",
                status.as_u16()
            )));
        }
        if status.as_u16() == 404 && self.session_id.is_some() {
            return Err(Failure::Transport(SESSION_ENDED.to_string()));
        }
        if !status.is_success() {
            let body = read_capped(response).unwrap_or_default();
            let excerpt: String = String::from_utf8_lossy(&body).chars().take(300).collect();
            return Err(Failure::Transport(format!("HTTP {}: {}", status.as_u16(), excerpt.trim())));
        }
        let Some(id) = id else { return Ok(None) };

        let is_stream = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|ct| ct.contains("text/event-stream"));
        if is_stream {
            // Read events until the one that answers us; the stream may carry
            // notifications first, and may stay open after.
            let reader = BufReader::new(response.take(MAX_REPLY_BYTES));
            return match sse_response(reader, id) {
                Some(answer) => Ok(Some(answer)),
                None => Err(Failure::Transport("The server's event stream ended without a reply".to_string())),
            };
        }
        let body = read_capped(response).map_err(Failure::Transport)?;
        let value: Value = serde_json::from_slice(&body)
            .map_err(|_| Failure::Transport("The server sent something that is not JSON".to_string()))?;
        // A batch answer is an array; find ours in it.
        let messages = match value {
            Value::Array(items) => items,
            single => vec![single],
        };
        messages
            .iter()
            .find_map(|m| response_for(m, id))
            .map(Some)
            .ok_or_else(|| Failure::Transport("The server sent something that is not a reply".to_string()))
    }
}

fn read_capped(response: reqwest::blocking::Response) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    response
        .take(MAX_REPLY_BYTES)
        .read_to_end(&mut body)
        .map_err(|e| format!("Could not read the server's reply: {e}"))?;
    Ok(body)
}

/// Read a server-sent-event stream until an event carries the response to
/// `id`. `None` when the stream ends first.
fn sse_response(reader: impl BufRead, id: i64) -> Option<Result<Value, Failure>> {
    let mut data = String::new();
    let mut lines = reader.lines();
    loop {
        let line = match lines.next() {
            Some(Ok(line)) => line,
            // End of stream (or a read error): flush a last unterminated event.
            _ => {
                return serde_json::from_str::<Value>(&data).ok().and_then(|m| response_for(&m, id));
            }
        };
        if line.is_empty() {
            if let Ok(message) = serde_json::from_str::<Value>(&data) {
                if let Some(answer) = response_for(&message, id) {
                    return Some(answer);
                }
            }
            data.clear();
        } else if let Some(rest) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(rest.strip_prefix(' ').unwrap_or(rest));
        }
        // `event:`, `id:`, `retry:` and `:` comments carry nothing we need.
    }
}

/* ---------------------------------------------------------------- framing --*/

/// If `message` is the response to `id`, its result or error. Notifications,
/// requests and other ids are `None` — a server may log while it answers, and
/// one that echoes our own line back must not be read as having answered.
fn response_for(message: &Value, id: i64) -> Option<Result<Value, Failure>> {
    if message.get("method").is_some() || message.get("id").and_then(Value::as_i64) != Some(id) {
        return None;
    }
    if let Some(error) = message.get("error") {
        let text = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        return Some(Err(Failure::Refused(format!("The server refused: {text}"))));
    }
    Some(match message.get("result") {
        Some(result) => Ok(result.clone()),
        // Neither `result` nor `error`: not an MCP response at all.
        None => Err(Failure::Transport("The server sent something that is not a reply".to_string())),
    })
}

fn string(value: Option<&Value>, key: &str) -> String {
    value
        .and_then(|v| v.get(key))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
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

/// `tools/list` → the projection Klide keeps. A malformed entry is dropped
/// rather than failing the handshake: one bad tool must not hide the other
/// twenty. Icons and other presentation fields are not kept — GitHub's list is
/// mostly base64 PNGs.
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
                            .or_else(|| tool.get("annotations").and_then(|a| a.get("title")))
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .filter(|s| !s.is_empty()),
                        description: tool
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .trim()
                            .to_string(),
                        read_only: tool
                            .get("annotations")
                            .and_then(|a| a.get("readOnlyHint"))
                            .and_then(Value::as_bool),
                        input_schema: tool
                            .get("inputSchema")
                            .cloned()
                            .unwrap_or_else(|| json!({ "type": "object" })),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A `tools/call` result as the text a model reads. Text parts are joined;
/// anything that is not text is named rather than inlined, so an image or a
/// binary resource never floods the context. `structuredContent` is the
/// fallback when a server sends no text at all.
fn call_result(result: &Value) -> CallResult {
    let mut parts: Vec<String> = Vec::new();
    for item in result.get("content").and_then(Value::as_array).into_iter().flatten() {
        let kind = item.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "text" => {
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    parts.push(text.to_string());
                }
            }
            "resource" => {
                let resource = item.get("resource");
                match resource.and_then(|r| r.get("text")).and_then(Value::as_str) {
                    Some(text) => parts.push(text.to_string()),
                    None => parts.push(format!("[resource {}]", string(resource, "uri"))),
                }
            }
            "resource_link" => parts.push(format!("[link {} {}]", string(Some(item), "name"), string(Some(item), "uri"))),
            "image" | "audio" => parts.push(format!("[{kind} {}]", string(Some(item), "mimeType"))),
            _ => {}
        }
    }
    if parts.is_empty() {
        if let Some(structured) = result.get("structuredContent") {
            parts.push(serde_json::to_string_pretty(structured).unwrap_or_default());
        }
    }
    CallResult {
        is_error: result.get("isError").and_then(Value::as_bool) == Some(true),
        text: parts.join("\n"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scripted server: reads our three handshake lines and answers with a
    /// fixed initialize result and one tool. Deterministic, no network, no
    /// package download — and still the real transport, framing and parse path.
    #[cfg(unix)]
    fn scripted(script: &str) -> ServerSpec {
        ServerSpec::Stdio(StdioServer {
            command: "sh".to_string(),
            args: vec!["-c".to_string(), script.to_string()],
            ..StdioServer::default()
        })
    }

    fn stdio(command: &str) -> ServerSpec {
        ServerSpec::Stdio(StdioServer {
            command: command.to_string(),
            ..StdioServer::default()
        })
    }

    #[test]
    fn a_missing_binary_fails_before_anything_is_spawned() {
        let server = stdio("klide-no-such-connector");
        let error = probe(&server, Duration::from_secs(5)).unwrap_err();
        assert!(error.contains("klide-no-such-connector"), "{error}");
    }

    #[test]
    fn a_command_is_argv_never_a_shell_string() {
        let server = stdio("true; touch /tmp/klide-connector-injection");
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
        let server = stdio("cat");
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

    /// The handshake a scripted server answers before the test's own lines.
    #[cfg(unix)]
    const HANDSHAKE: &str = r#"read _init
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"fixture"}}}'
read _initialized
read _list
printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"echo","inputSchema":{"type":"object","properties":{"text":{"type":"string"}}}}]}}'
"#;

    #[test]
    #[cfg(unix)]
    fn a_session_stays_open_and_calls_a_tool() {
        let server = scripted(&format!(
            r#"{HANDSHAKE}read _call
printf '%s\n' '{{"jsonrpc":"2.0","method":"notifications/message","params":{{}}}}'
printf '%s\n' '{{"jsonrpc":"2.0","id":3,"result":{{"content":[{{"type":"text","text":"hello"}},{{"type":"image","mimeType":"image/png","data":"AAAA"}}]}}}}'
read _call2
printf '%s\n' '{{"jsonrpc":"2.0","id":4,"result":{{"isError":true,"content":[{{"type":"text","text":"no such repo"}}]}}}}'
sleep 5
"#
        ));
        let mut session = Session::connect(&server, Duration::from_secs(10)).expect("handshake");
        assert_eq!(session.info.tools[0].input_schema["properties"]["text"]["type"], "string");
        let first = session.call_tool("echo", json!({"text":"hi"}), Duration::from_secs(5)).unwrap();
        // The image is named, never inlined.
        assert_eq!(first, CallResult { is_error: false, text: "hello\n[image image/png]".to_string() });
        let second = session.call_tool("echo", json!({}), Duration::from_secs(5)).unwrap();
        assert!(second.is_error);
        assert_eq!(second.text, "no such repo");
        assert!(session.usable());
    }

    #[test]
    #[cfg(unix)]
    fn a_ping_while_we_wait_is_answered_not_mistaken_for_a_reply() {
        let server = scripted(&format!(
            r#"{HANDSHAKE}read _call
printf '%s\n' '{{"jsonrpc":"2.0","id":"p1","method":"ping"}}'
read pong
case "$pong" in *'"id":"p1"'*'"result"'*) text=pong ;; *) text=nopong ;; esac
printf '{{"jsonrpc":"2.0","id":3,"result":{{"content":[{{"type":"text","text":"%s"}}]}}}}\n' "$text"
sleep 5
"#
        ));
        let mut session = Session::connect(&server, Duration::from_secs(10)).expect("handshake");
        let result = session.call_tool("echo", json!({}), Duration::from_secs(5)).unwrap();
        assert_eq!(result.text, "pong");
    }

    #[test]
    #[cfg(unix)]
    fn a_timed_out_call_breaks_the_session_so_it_is_not_reused() {
        let server = scripted(&format!("{HANDSHAKE}sleep 30\n"));
        let mut session = Session::connect(&server, Duration::from_secs(10)).expect("handshake");
        assert!(session.call_tool("echo", json!({}), Duration::from_millis(300)).is_err());
        assert!(!session.usable());
        let again = session.call_tool("echo", json!({}), Duration::from_secs(1)).unwrap_err();
        assert!(again.contains("lost"), "{again}");
    }

    #[test]
    #[cfg(unix)]
    fn a_refusal_leaves_the_session_usable() {
        let server = scripted(&format!(
            r#"{HANDSHAKE}read _call
printf '%s\n' '{{"jsonrpc":"2.0","id":3,"error":{{"code":-32602,"message":"bad arguments"}}}}'
sleep 5
"#
        ));
        let mut session = Session::connect(&server, Duration::from_secs(10)).expect("handshake");
        let error = session.call_tool("echo", json!({}), Duration::from_secs(5)).unwrap_err();
        assert!(error.contains("bad arguments"), "{error}");
        assert!(session.usable());
    }

    #[test]
    fn an_event_stream_is_read_until_our_reply() {
        let stream = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\n: keep-alive\nevent: message\ndata: {\"jsonrpc\":\"2.0\",\n";
        let stream = format!("{stream}data: \"id\":7,\"result\":{{\"ok\":true}}}}\n\n");
        let answer = sse_response(std::io::Cursor::new(stream), 7).expect("found").ok().expect("result");
        assert_eq!(answer["ok"], true);
        // A stream that ends without our id is `None`, not a hang or a guess.
        let other = "data: {\"jsonrpc\":\"2.0\",\"id\":8,\"result\":{}}\n\n";
        assert!(sse_response(std::io::Cursor::new(other), 7).is_none());
    }

    #[test]
    fn a_stored_stdio_spec_still_reads_and_a_url_is_remote() {
        let old: ServerSpec = serde_json::from_str(r#"{"command":"npx","args":["-y","x"],"env":{}}"#).unwrap();
        assert!(matches!(old, ServerSpec::Stdio(ref s) if s.command == "npx"));
        let remote: ServerSpec =
            serde_json::from_str(r#"{"url":"https://api.githubcopilot.com/mcp/","headers":{"X-MCP-Toolsets":"repos"}}"#).unwrap();
        assert!(matches!(remote, ServerSpec::Http(ref h) if h.headers["X-MCP-Toolsets"] == "repos"));
    }

    #[test]
    fn an_http_spec_must_be_a_web_url() {
        let spec = ServerSpec::Http(HttpServer { url: "file:///etc/passwd".to_string(), headers: BTreeMap::new() });
        let error = probe(&spec, Duration::from_secs(1)).unwrap_err();
        assert!(error.contains("not an http"), "{error}");
    }

    #[test]
    fn structured_content_is_the_fallback_when_no_text_came_back() {
        let result = call_result(&json!({"content": [], "structuredContent": {"n": 1}}));
        assert!(result.text.contains("\"n\": 1"), "{}", result.text);
    }
}
