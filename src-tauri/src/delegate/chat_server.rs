//! A headless turn streamed from the CLI's own local server.
//!
//! Some CLIs only print a text part once it is finished: `opencode run
//! --format json` stays silent for the whole answer, then prints it in one
//! line, so a long answer sits on "Working" for minutes and lands at once. The
//! same CLI's server (`opencode serve`) publishes every fragment on its event
//! stream as it is written. So for such a CLI a turn runs as three pieces:
//!
//! 1. a server started for this turn alone, in the turn's directory and with
//!    the turn's environment (the MCP wiring is an env var, so a shared server
//!    could not give two conversations different coordination sessions),
//!    behind a password minted for this turn — its API can run the agent;
//! 2. the event stream, read into [`StreamItem`]s by the adapter's
//!    [`ChatServer::feed`];
//! 3. the ordinary run command pointed at that server, which sends the prompt
//!    and exits when the turn is over.
//!
//! When the server cannot be started or reached, the caller runs the turn the
//! old way, on stdout alone: slower to appear, never lost.

use std::ffi::OsString;
use std::process::Stdio;
use std::sync::atomic::AtomicBool;
use std::time::Duration;
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command as TokioCommand;
use tokio::sync::mpsc;
use tokio::time::timeout;

use super::chat::Emitter;
use super::chat_stream::StreamItem;
use super::Delegate;
use crate::providers::StreamChunk;

/// How long the server gets to say where it listens. It is ready in well
/// under a second on a warm machine; this only bounds a hung start.
const SERVE_READY: Duration = Duration::from_secs(15);

/// After the run command exits, how long the event stream may keep
/// delivering the tail of the turn before the answer is closed anyway.
const DRAIN_AFTER_EXIT: Duration = Duration::from_secs(3);

pub(crate) struct CommandTurn<'a> {
    pub url: &'a str,
    pub password: &'a str,
    pub args: &'a [String],
    pub name: &'a str,
    pub prompt: &'a str,
    pub cwd: &'a str,
    pub(super) emitter: Emitter<'a>,
    pub events: &'a mut mpsc::UnboundedReceiver<String>,
}

pub(crate) type CommandFuture<'a> = std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + 'a>>;

/// What one CLI's server needs to be told, and how its events read.
/// Implemented by the adapter; the transport here knows none of it.
pub(crate) trait ChatServer: Send + Sync {
    /// Select the wire contract from the exact binary being launched.
    fn configure_version(&mut self, _version: &str) {}
    /// Private-server flags for the stdout fallback, when a CLI defaults to
    /// a shared service which cannot carry this turn's MCP identity.
    fn standalone_args(&self) -> Vec<String> { Vec::new() }
    fn native_commands(&self) -> bool { false }
    fn run_command<'a>(&'a mut self, _turn: CommandTurn<'a>) -> CommandFuture<'a> {
        Box::pin(async { Err("This delegate does not expose a command API".into()) })
    }
    /// Let a server adapter consume its CLI's compatibility output itself.
    fn feed_stdout(&mut self, _line: &str) -> Option<Vec<StreamItem>> { None }
    /// Durable history, when the event stream is volatile. Newest first.
    fn history_path(&self) -> Option<String> { None }
    fn set_history_boundary(&mut self, _id: Option<String>) {}
    fn history_boundary(&self) -> Option<&str> { None }
    fn recover_history(&mut self, _messages: &[serde_json::Value]) -> Vec<StreamItem> { Vec::new() }
    /// Arguments that start the server on a free loopback port.
    fn serve_args(&self) -> Vec<String>;
    /// A line of the server's stdout that names the URL it listens on.
    fn listening_url(&self, line: &str) -> Option<String>;
    /// Extra arguments that point the run command at that server.
    fn attach_args(&self, url: &str) -> Vec<String>;
    /// The event stream's URL.
    fn events_url(&self, url: &str) -> String;
    /// The basic-auth username the server expects.
    fn username(&self) -> &'static str;
    /// The environment both processes read the credentials from.
    fn auth_env(&self, password: &str) -> Vec<(&'static str, String)>;
    /// One event's `data:` payload, read into stream items.
    fn feed(&mut self, data: &str) -> Vec<StreamItem>;
    /// Whether the events have said this turn is over.
    fn settled(&self) -> bool;
}

/// Either the turn ran over the server (successfully or not), or the server
/// was never usable and nothing was sent — the caller's cue to fall back.
pub(super) enum ServerTurn {
    Ran(Result<String, String>),
    Unavailable(String),
}

/// Run one turn over the CLI's local server. `command` is the ordinary stream
/// invocation, used as the template for both processes: same program, same
/// directory, same environment.
#[allow(clippy::too_many_arguments)]
pub(super) async fn run_via_server(
    adapter: &dyn Delegate,
    mut server: Box<dyn ChatServer>,
    command: &mut TokioCommand,
    prompt: String,
    label: &str,
    cwd: &str,
    session_key: Option<&str>,
    emitted: &AtomicBool,
    on_chunk: &Channel<StreamChunk>,
) -> ServerTurn {
    // V2 uses the shell's PWD to select its location. current_dir alone does
    // not update this inherited variable, which could select Klide's launch
    // directory instead of the requested workspace (also on stdout fallback).
    if let Some(dir) = command.as_std().get_current_dir().map(|d| d.to_owned()) {
        command.env("PWD", dir);
    }
    // Probe the binary we will actually spawn, with the turn's environment.
    // No process-global version cache: a CLI can be upgraded while Klide runs.
    let template = command.as_std();
    let mut probe = TokioCommand::new(template.get_program());
    if let Some(dir) = template.get_current_dir() { probe.current_dir(dir); }
    for (key, value) in template.get_envs() { if let Some(value) = value { probe.env(key, value); } }
    probe.arg("--version").kill_on_drop(true);
    let output = match timeout(Duration::from_secs(3), probe.output()).await {
        Ok(Ok(output)) if output.status.success() => output,
        _ => return ServerTurn::Ran(Err(format!("Unable to determine {label}'s CLI version"))),
    };
    server.configure_version(&String::from_utf8_lossy(&output.stdout));
    command.args(server.standalone_args());
    let template = command.as_std();
    let program = template.get_program().to_owned();
    let args: Vec<OsString> = template.get_args().map(|a| a.to_owned()).collect();
    let envs: Vec<(OsString, OsString)> = template
        .get_envs()
        .filter_map(|(k, v)| Some((k.to_owned(), v?.to_owned())))
        .collect();
    let dir = template.get_current_dir().map(|d| d.to_owned());
    let spawnable = |extra: Vec<String>, auth: &[(&'static str, String)]| {
        let mut c = TokioCommand::new(&program);
        if let Some(dir) = &dir {
            c.current_dir(dir);
        }
        c.envs(envs.iter().map(|(k, v)| (k, v)));
        c.envs(auth.iter().map(|(k, v)| (*k, v.as_str())));
        c.args(extra);
        c.kill_on_drop(true);
        c
    };

    let password = match mint_password() {
        Ok(p) => p,
        Err(e) => return ServerTurn::Unavailable(e),
    };
    let auth = server.auth_env(&password);

    // 1 · The server, for this turn only.
    let mut serve = spawnable(server.serve_args(), &auth);
    serve.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut serve = match serve.spawn() {
        Ok(child) => child,
        Err(e) => return ServerTurn::Unavailable(format!("Unable to start {label}'s server: {e}")),
    };
    let Some(serve_out) = serve.stdout.take() else {
        return ServerTurn::Unavailable(format!("Unable to read {label}'s server"));
    };
    let mut serve_lines = BufReader::new(serve_out).lines();
    let url = timeout(SERVE_READY, async {
        while let Ok(Some(line)) = serve_lines.next_line().await {
            if let Some(url) = server.listening_url(&line) {
                return Some(url);
            }
        }
        None
    })
    .await
    .ok()
    .flatten();
    let Some(url) = url else {
        return ServerTurn::Unavailable(format!("{label}'s server did not start"));
    };
    // Keep reading what the server prints, or a full pipe would stall it.
    tokio::spawn(async move { while let Ok(Some(_)) = serve_lines.next_line().await {} });

    // 2 · The event stream, before the prompt goes out, so nothing is missed.
    let response = timeout(SERVE_READY, reqwest::Client::new()
        .get(server.events_url(&url))
        .basic_auth(server.username(), Some(&password))
        .send()).await;
    let mut response = match response {
        Ok(Ok(r)) => match r.error_for_status() {
            Ok(r) => r,
            Err(e) => return ServerTurn::Unavailable(format!("{label}'s event stream: {e}")),
        },
        Ok(Err(e)) => return ServerTurn::Unavailable(format!("{label}'s event stream: {e}")),
        Err(_) => return ServerTurn::Unavailable(format!("{label}'s event stream did not connect")),
    };
    let (tx, mut events) = mpsc::unbounded_channel::<String>();
    let reader = tokio::spawn(async move {
        let mut buf: Vec<u8> = Vec::new();
        while let Ok(Some(chunk)) = response.chunk().await {
            buf.extend_from_slice(&chunk);
            // Split on the newline byte, which never occurs inside a UTF-8
            // sequence, so a character cut across two chunks stays whole.
            while let Some(end) = buf.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = buf.drain(..=end).collect();
                let line = String::from_utf8_lossy(&line);
                if let Some(data) = line.trim_end().strip_prefix("data:") {
                    if tx.send(data.trim_start().to_string()).is_err() {
                        return;
                    }
                }
            }
        }
    });

    // V2 removed run --command. Its command admission API keeps slash
    // commands native rather than sending the command name as model prose.
    if server.native_commands() {
        if let Some(index) = args.iter().position(|a| a == "--command") {
            let Some(name) = args.get(index + 1).and_then(|a| a.to_str()) else {
                reader.abort();
                return ServerTurn::Ran(Err("Missing OpenCode command name".into()));
            };
            let args: Vec<String> = args.iter().map(|a| a.to_string_lossy().into_owned()).collect();
            let outcome = timeout(super::chat::CHAT_TURN_CEILING, server.run_command(CommandTurn {
                url: &url, password: &password, args: &args, name, prompt: &prompt,
                cwd, emitter: Emitter::new(adapter, cwd, session_key, emitted, on_chunk),
                events: &mut events,
            })).await.unwrap_or_else(|_| Err("OpenCode command timed out".into()));
            reader.abort();
            let _ = serve.kill().await;
            return ServerTurn::Ran(outcome);
        }
    }

    // Record the last durable message before submitting this turn. This
    // boundary prevents recovery from repeating an earlier resumed answer.
    let client = reqwest::Client::new();
    if let Some(path) = server.history_path() {
        let response = client.get(format!("{url}{path}"))
            .basic_auth(server.username(), Some(&password))
            .timeout(Duration::from_secs(10)).send().await;
        let baseline = match response {
            Ok(r) if r.status().is_success() => r.json::<serde_json::Value>().await.ok(),
            _ => None,
        };
        let Some(baseline) = baseline else {
            reader.abort();
            return ServerTurn::Unavailable(format!("Unable to read {label}'s session before sending the prompt"));
        };
        server.set_history_boundary(baseline.pointer("/data/0/id").and_then(|v| v.as_str()).map(str::to_string));
    }

    // 3 · The run itself, attached to that server.
    let mut run = spawnable(
        args.iter()
            .map(|a| a.to_string_lossy().into_owned())
            .filter(|a| a != "--standalone")
            .chain(server.attach_args(&url))
            .collect(),
        &auth,
    );
    run.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = match run.spawn() {
        Ok(child) => child,
        Err(e) => {
            reader.abort();
            return ServerTurn::Unavailable(format!("Unable to start {label}: {e}"));
        }
    };

    if let Some(mut stdin) = child.stdin.take() {
        if let Err(e) = stdin.write_all(prompt.as_bytes()).await {
            reader.abort();
            return ServerTurn::Ran(Err(format!("Unable to write prompt to {label}: {e}")));
        }
        // The CLI reads until EOF before it starts working.
        drop(stdin);
    }
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        reader.abort();
        return ServerTurn::Ran(Err(format!("Unable to capture {label} output")));
    };
    // Drain stderr alongside stdout: a long diagnostic must not fill its
    // pipe and prevent the CLI from reaching the turn's terminal event.
    let stderr = tokio::spawn(async move {
        let mut text = String::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            for character in line.chars() { if text.len() < 64 * 1024 { text.push(character); } }
            if text.len() < 64 * 1024 { text.push('\n'); }
        }
        text
    });

    let outcome = timeout(super::chat::CHAT_TURN_CEILING, async {
        let mut emitter = Emitter::new(adapter, cwd, session_key, emitted, on_chunk);
        let mut lines = BufReader::new(stdout).lines();
        // The run's own stdout still carries the session id; everything it
        // reports goes through the same emitter, whose per-part bookkeeping
        // keeps text that arrives on both streams from appearing twice.
        loop {
            tokio::select! {
                line = lines.next_line() => match line {
                    Ok(Some(line)) => {
                        for item in server.feed_stdout(&line).unwrap_or_else(|| adapter.parse_stream_line(&line)) {
                            emitter.handle(item);
                        }
                    }
                    _ => break,
                },
                Some(data) = events.recv() => {
                    for item in server.feed(&data) {
                        emitter.handle(item);
                    }
                }
            }
        }
        let status = child
            .wait()
            .await
            .map_err(|e| format!("Unable to read {label} exit status: {e}"))?;
        // The run exits once the server says the turn is over, but the last
        // events may still be in flight on the other connection.
        let _ = timeout(DRAIN_AFTER_EXIT, async {
            while !server.settled() {
                let Some(data) = events.recv().await else { break };
                for item in server.feed(&data) {
                    emitter.handle(item);
                }
            }
        })
        .await;
        // The CLI waited for execution to finish. Its durable projection is
        // authoritative even if our event connection dropped or overflowed.
        if let Some(path) = server.history_path() {
            let messages = recover_history(&client, &url, &path, server.username(), &password, server.history_boundary()).await?;
            for item in server.recover_history(&messages) { emitter.handle(item); }
        }
        if !status.success() {
            let stderr_text = stderr.await.unwrap_or_default();
            let stderr_text = stderr_text.trim();
            return Err(if stderr_text.is_empty() {
                format!("{label} exited with {status}")
            } else {
                format!("{label} exited with {status}: {stderr_text}")
            });
        }
        emitter.finish()
    })
    .await
    .unwrap_or_else(|_| {
        Err(format!(
            "{label} timed out after {} minutes",
            super::chat::CHAT_TURN_CEILING.as_secs() / 60
        ))
    });
    reader.abort();
    let _ = serve.kill().await;
    ServerTurn::Ran(outcome)
}

pub(super) async fn recover_history(
    client: &reqwest::Client, url: &str, path: &str, user: &str,
    password: &str, boundary: Option<&str>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut messages = Vec::new();
    let mut cursor: Option<String> = None;
    let mut seen = std::collections::HashSet::new();
    loop {
        let mut request = client.get(format!("{url}{path}"))
            .basic_auth(user, Some(password)).timeout(Duration::from_secs(10));
        if let Some(cursor) = &cursor {
            // The opaque cursor carries ordering; V2 forbids order+cursor.
            let mut page_url = reqwest::Url::parse(&format!("{url}{path}")).map_err(|e| e.to_string())?;
            let params: Vec<(String, String)> = page_url.query_pairs().filter(|(key, _)| key != "order").map(|(k,v)| (k.into_owned(),v.into_owned())).collect();
            page_url.set_query(None);
            page_url.query_pairs_mut().extend_pairs(params).append_pair("cursor", cursor);
            request = client.get(page_url).basic_auth(user, Some(password)).timeout(Duration::from_secs(10));
        }
        let body = request.send().await.and_then(|r| r.error_for_status())
            .map_err(|e| format!("OpenCode transcript recovery failed: {e}"))?
            .json::<serde_json::Value>().await.map_err(|e| format!("Invalid OpenCode transcript: {e}"))?;
        let page = body.get("data").and_then(|v| v.as_array()).ok_or("Invalid OpenCode transcript page")?;
        if page.is_empty() { break; }
        let mut found = false;
        for message in page {
            if message.get("id").and_then(|v| v.as_str()) == boundary && boundary.is_some() { found = true; break; }
            messages.push(message.clone());
        }
        if found { break; }
        cursor = body.pointer("/cursor/next").and_then(|v| v.as_str()).map(str::to_string);
        let Some(next) = &cursor else { break };
        if !seen.insert(next.clone()) { return Err("OpenCode transcript cursor repeated".into()); }
    }
    messages.reverse();
    Ok(messages)
}

/// A password for one server's lifetime.
fn mint_password() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| format!("OS RNG unavailable: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    #[tokio::test]
    async fn recovery_pages_back_to_the_resumed_turn_boundary() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let service = tokio::spawn(async move {
            for page in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut buf = [0u8; 8192];
                let size = stream.read(&mut buf).await.unwrap();
                let request = String::from_utf8_lossy(&buf[..size]);
                assert!(request.to_ascii_lowercase().contains("authorization: basic "));
                if page == 0 { assert!(request.contains("order=desc")); }
                else { assert!(!request.contains("order=")); assert!(request.contains("cursor=next")); }
                let body = if page == 0 {
                    serde_json::json!({"data": [{"id":"newest"}],"cursor":{"next":"next"}})
                } else {
                    serde_json::json!({"data": [{"id":"first"},{"id":"boundary"},{"id":"older"}],"cursor":{"next":"unused"}})
                }.to_string();
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            }
        });
        let recovered = recover_history(&reqwest::Client::new(), &url, "/api/session/ses_test/message?order=desc&limit=100", "opencode", "test", Some("boundary")).await.unwrap();
        service.await.unwrap();
        assert_eq!(recovered, vec![serde_json::json!({"id":"first"}),serde_json::json!({"id":"newest"})]);
    }

    /// Isolated V2 smoke test, with a local mock model returning this exact
    /// phrase. The caller supplies an official binary and disposable config.
    #[tokio::test]
    #[ignore]
    async fn v2_mock_streams_resumes_and_runs_a_native_command() {
        mock_turns(true).await;
    }

    #[tokio::test]
    #[ignore]
    async fn v1_mock_streams_resumes_and_runs_a_native_command() {
        mock_turns(false).await;
    }

    async fn mock_turns(v2: bool) {
        let binary = std::env::var("KLIDE_OPENCODE_TEST_BINARY").expect("test binary");
        let root = std::env::var("KLIDE_OPENCODE_TEST_ROOT").expect("disposable test root");
        let adapter = super::super::lookup("opencode").unwrap();
        super::super::status::install_opencode_hooks(&std::path::Path::new(&root).join("config/opencode/plugin")).unwrap();
        let states: Arc<Mutex<Vec<(String, Option<String>)>>> = Arc::default();
        let sink = states.clone();
        let hooks = super::super::status::start_hook_server(Arc::default(),Box::new(move |signal| {
            sink.lock().unwrap().push((signal.status,signal.external_id));
        })).unwrap();
        let hook_url = format!("http://127.0.0.1:{}/hook/{}/smoke",hooks.port,hooks.token);
        let mut resume: Option<String> = None;
        for turn in 0..3 {
            let first_state = states.lock().unwrap().len();
            let spec = super::super::ChatSpec { model:"mock/mock",effort:None,resume:resume.as_deref(),mcp:None,allowed_commands:&[] };
            let mut command = TokioCommand::new(&binary);
            command.current_dir(&root).args(adapter.chat_stream_args(&root,&spec).unwrap());
            command.env("KLIDE_HOOK_URL",&hook_url);
            for (name, dir) in [("XDG_DATA_HOME","data"),("XDG_CONFIG_HOME","config"),("XDG_STATE_HOME","state"),("XDG_CACHE_HOME","cache")] { command.env(name,format!("{root}/{dir}")); }
            if turn == 2 { command.args(["--command","review"]); }
            let chunks: Arc<Mutex<Vec<String>>> = Arc::default();
            let sink = chunks.clone();
            let channel: Channel<StreamChunk> = Channel::new(move |body| {
                if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
                    if let Some(text) = value.get("content").and_then(|v| v.as_str()) { sink.lock().unwrap().push(text.into()); }
                }
                Ok(())
            });
            let emitted = AtomicBool::new(false);
            let result = run_via_server(adapter,adapter.chat_server(&spec).unwrap(),&mut command,"hello".into(),"OpenCode",&root,None,&emitted,&channel).await;
            let answer = match result { ServerTurn::Ran(answer) => answer.unwrap(), ServerTurn::Unavailable(why) => panic!("{why}") };
            assert_eq!(answer,"Hello from V2.","turn {turn}");
            assert_eq!(chunks.lock().unwrap().concat(),answer);
            assert!(chunks.lock().unwrap().len() >= 3,"turn {turn} did not stream: {:?}", chunks.lock().unwrap());
            let db = rusqlite::Connection::open_with_flags(format!("{root}/data/opencode/opencode.db"),rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            let table = if v2 { "session_v2" } else { "session" };
            let session: String = db.query_row(&format!("SELECT id FROM {table} ORDER BY time_created DESC LIMIT 1"),[],|row| row.get(0)).unwrap();
            let directory: String = db.query_row(&format!("SELECT directory FROM {table} WHERE id=?1"),[&session],|row| row.get(0)).unwrap();
            assert_eq!(std::fs::canonicalize(&directory).unwrap(),std::fs::canonicalize(&root).unwrap(),"turn ran outside its requested workspace");
            if let Some(previous) = &resume { assert_eq!(previous,&session); }
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                let recorded = states.lock().unwrap();
                let changes = &recorded[first_state..];
                if changes.iter().any(|(state,_)| state == "working") && changes.iter().any(|(state,_)| state == "waiting") {
                    if v2 { assert!(changes.iter().any(|(_,id)| id.as_deref() == Some(&session))); }
                    break;
                }
                assert!(Instant::now() < deadline,"status plugin did not report this turn: {changes:?}");
                drop(recorded);
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            resume = Some(session);
        }
    }

    /// A real turn against the installed `opencode`: the answer must arrive
    /// as many chunks spread over time, not one at the end. Needs the CLI and
    /// a working model, so it is opt-in:
    /// `KLIDE_OPENCODE_MODEL=provider/model cargo test --lib -- --ignored streams_a_real_opencode_turn`
    #[tokio::test]
    #[ignore]
    async fn streams_a_real_opencode_turn() {
        let adapter = super::super::lookup("opencode").expect("opencode adapter");
        let model = std::env::var("KLIDE_OPENCODE_MODEL").unwrap_or_default();
        let spec = super::super::ChatSpec {
            model: &model,
            effort: None,
            resume: None,
            mcp: None,
            allowed_commands: &[],
        };
        let cwd = std::env::temp_dir();
        let cwd = cwd.to_str().unwrap();
        let mut command = adapter.chat_stream_invocation(cwd, &spec).unwrap().unwrap();
        let arrivals: Arc<Mutex<Vec<(Duration, usize)>>> = Arc::default();
        let start = Instant::now();
        let sink = arrivals.clone();
        let channel: Channel<StreamChunk> = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                sink.lock().unwrap().push((start.elapsed(), json.len()));
            }
            Ok(())
        });
        let emitted = AtomicBool::new(false);
        let turn = run_via_server(
            adapter,
            adapter.chat_server(&spec).unwrap(),
            &mut command,
            "Write a 120-word paragraph about rivers. No tools.".into(),
            "OpenCode",
            cwd,
            None,
            &emitted,
            &channel,
        )
        .await;
        let answer = match turn {
            ServerTurn::Ran(r) => r.expect("turn failed"),
            ServerTurn::Unavailable(why) => panic!("server unavailable: {why}"),
        };
        let arrivals = arrivals.lock().unwrap();
        eprintln!("{} chunks; first at {:?}, last at {:?}; answer {} chars", arrivals.len(), arrivals.first(), arrivals.last(), answer.len());
        assert!(answer.split_whitespace().count() > 50, "answer: {answer}");
        assert!(arrivals.len() > 5, "the answer arrived in {} chunks", arrivals.len());
    }
}
