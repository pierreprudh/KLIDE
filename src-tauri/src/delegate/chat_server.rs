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

/// What one CLI's server needs to be told, and how its events read.
/// Implemented by the adapter; the transport here knows none of it.
pub(crate) trait ChatServer: Send + Sync {
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
    command: TokioCommand,
    prompt: String,
    label: &str,
    cwd: &str,
    session_key: Option<&str>,
    emitted: &AtomicBool,
    on_chunk: &Channel<StreamChunk>,
) -> ServerTurn {
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
    let response = reqwest::Client::new()
        .get(server.events_url(&url))
        .basic_auth(server.username(), Some(&password))
        .send()
        .await
        .and_then(|r| r.error_for_status());
    let mut response = match response {
        Ok(r) => r,
        Err(e) => return ServerTurn::Unavailable(format!("{label}'s event stream: {e}")),
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

    // 3 · The run itself, attached to that server.
    let mut run = spawnable(
        args.iter()
            .map(|a| a.to_string_lossy().into_owned())
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
                        for item in adapter.parse_stream_line(&line) {
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
        if !status.success() {
            let mut stderr_text = String::new();
            let mut stderr_lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = stderr_lines.next_line().await {
                stderr_text.push_str(&line);
                stderr_text.push('\n');
            }
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
        let command = adapter.chat_stream_invocation(cwd, &spec).unwrap().unwrap();
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
            command,
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
