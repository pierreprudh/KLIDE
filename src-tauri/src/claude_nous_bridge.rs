//! Managed Hermes proxy + loopback Anthropic adapter. No subscription tokens
//! cross IPC, live in Klide files, or appear in the Claude launch envelope.
#[cfg(test)]
use crate::anthropic_bridge_wire as wire;
#[cfg(test)]
use serde_json::json;
use serde_json::Value;
#[cfg(test)]
use std::io::BufReader;
use std::io::{Read, Write};
use std::net::TcpListener;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
#[cfg(test)]
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
#[cfg(test)]
use tiny_http::{Header, Response, Server};

struct ManagedProxy {
    child: Child,
    base: String,
}
impl Drop for ManagedProxy {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.child.id() as i32), libc::SIGKILL);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
static BRIDGE: OnceLock<Mutex<Option<ManagedProxy>>> = OnceLock::new();
fn state() -> &'static Mutex<Option<ManagedProxy>> {
    BRIDGE.get_or_init(|| Mutex::new(None))
}
pub fn shutdown() {
    if let Some(state) = BRIDGE.get() {
        if let Ok(mut bridge) = state.lock() {
            bridge.take();
        }
    }
}
fn client(seconds: u64) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(seconds))
        .build()
        .map_err(|e| e.to_string())
}
fn start_proxy() -> Result<ManagedProxy, String> {
    let socket = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = socket.local_addr().map_err(|e| e.to_string())?.port();
    let cli = crate::cli::resolve_command("hermes")?;
    drop(socket);
    let mut command = Command::new(cli);
    #[cfg(unix)]
    command.process_group(0);
    let child = command
        .args([
            "proxy",
            "start",
            "--provider",
            "nous",
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Cannot start Hermes subscription proxy: {e}"))?;
    let mut proxy = ManagedProxy {
        child,
        base: format!("http://127.0.0.1:{port}/v1"),
    };
    let deadline = Instant::now() + Duration::from_secs(30);
    // Readiness checks never mint a model response or consume inference credits.
    let http = client(4)?;
    while Instant::now() < deadline {
        if proxy.child.try_wait().map_err(|e| e.to_string())?.is_some() {
            return Err("Hermes subscription proxy could not start. Sign in to Nous Portal; if already signed in, check `hermes proxy start --provider nous` in Klide's terminal (Hermes needs proxy support and aiohttp).".into());
        }
        if let Ok(response) = http
            .get(format!("{}/models", proxy.base))
            .bearer_auth("klide-proxy")
            .send()
        {
            if response.status().is_success() {
                return Ok(proxy);
            }
            if response.status().as_u16() == 401 || response.status().as_u16() == 403 {
                return Err("Nous Portal authentication needs attention. Sign in again.".into());
            }
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    Err(
        "Hermes proxy did not become ready. Check your Nous Portal login and network connection."
            .into(),
    )
}
fn ensure() -> Result<String, String> {
    let mut state = state()
        .lock()
        .map_err(|_| "Subscription proxy lock failed.")?;
    if let Some(proxy) = state.as_mut() {
        if proxy.child.try_wait().map_err(|e| e.to_string())?.is_none() {
            return Ok(proxy.base.clone());
        }
    }
    state.take();
    let proxy = start_proxy()?;
    let base = proxy.base.clone();
    *state = Some(proxy);
    Ok(base)
}
pub fn proxy_endpoint() -> Result<String, String> {
    ensure()
}
pub fn claude_env(base: String, token: String, model: &str) -> Vec<(String, String)> {
    vec![
        ("ANTHROPIC_BASE_URL".into(), base),
        ("ANTHROPIC_AUTH_TOKEN".into(), token.clone()),
        ("ANTHROPIC_API_KEY".into(), token),
        ("ANTHROPIC_DEFAULT_OPUS_MODEL".into(), model.into()),
        ("ANTHROPIC_DEFAULT_SONNET_MODEL".into(), model.into()),
        ("ANTHROPIC_DEFAULT_HAIKU_MODEL".into(), model.into()),
        ("CLAUDE_CODE_SUBAGENT_MODEL".into(), model.into()),
        (
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".into(),
            "1".into(),
        ),
        ("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS".into(), "1".into()),
        ("MAX_THINKING_TOKENS".into(), "0".into()),
        ("CLAUDE_CODE_USE_BEDROCK".into(), "0".into()),
        ("CLAUDE_CODE_USE_VERTEX".into(), "0".into()),
        ("CLAUDE_CODE_USE_FOUNDRY".into(), "0".into()),
        ("ENABLE_TOOL_SEARCH".into(), "false".into()),
        ("ANTHROPIC_DEFAULT_FABLE_MODEL".into(), model.into()),
        ("ANTHROPIC_DEFAULT_MYTHOS_MODEL".into(), model.into()),
    ]
}
pub fn models(claude_only: bool) -> Result<Vec<String>, String> {
    let proxy = ensure()?;
    let response = client(30)?
        .get(format!("{proxy}/models"))
        .bearer_auth("klide-proxy")
        .send()
        .map_err(|_| "Could not read the Nous model catalog.")?;
    if !response.status().is_success() {
        return Err(format!(
            "Nous model catalog returned HTTP {}. Check your subscription.",
            response.status().as_u16()
        ));
    }
    let value: Value = response.json().map_err(|_| "Invalid Nous model catalog.")?;
    let mut models: Vec<_> = value["data"]
        .as_array()
        .ok_or("Missing Nous model catalog.")?
        .iter()
        .filter_map(|row| row["id"].as_str())
        .filter(|id| !claude_only || crate::harness_source::is_claude(id))
        .map(str::to_string)
        .collect();
    models.sort();
    models.dedup();
    if models.is_empty() {
        return Err("No compatible models are available in your Nous Portal catalog.".into());
    }
    Ok(models)
}
pub fn login() -> Result<(), String> {
    let cli = crate::cli::resolve_command("hermes")?;
    let mut child = Command::new(cli)
        .args(["auth", "add", "nous", "--type", "oauth", "--label", "Klide"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(300);
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            if status.success() {
                return Ok(());
            }
            return Err("Nous Portal login did not complete. Run `hermes auth add nous --type oauth` in Klide's terminal to see the login instructions.".into());
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Nous Portal login timed out. Try signing in again.".into());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}
#[cfg(test)]
fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name, value).expect("static HTTP header")
}
#[cfg(test)]
fn fail(request: tiny_http::Request, status: u16, kind: &str, message: &str) {
    let _ = request.respond(
        Response::from_string(
            json!({"type":"error","error":{"type":kind,"message":message}}).to_string(),
        )
        .with_status_code(status)
        .with_header(header("Content-Type", "application/json")),
    );
}
#[cfg(test)]
fn authenticated(request: &tiny_http::Request, token: &str) -> bool {
    if request.headers().iter().any(|h| h.field.equiv("Origin")) {
        return false;
    }
    request.headers().iter().any(|h| {
        (h.field.equiv("x-api-key") && h.value.as_str() == token)
            || (h.field.equiv("Authorization")
                && h.value.as_str().strip_prefix("Bearer ") == Some(token))
    })
}
#[cfg(test)]
fn serve(
    server: Server,
    upstream: String,
    token: String,
    stop: Arc<AtomicBool>,
) -> Result<(), String> {
    let http = client(600)?;
    std::thread::Builder::new()
        .name("claude-nous-bridge".into())
        .spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                let Ok(Some(request)) = server.recv_timeout(Duration::from_millis(200)) else {
                    continue;
                };
                if !authenticated(&request, &token) {
                    fail(
                        request,
                        401,
                        "authentication_error",
                        "Invalid Klide bridge credential.",
                    );
                    continue;
                }
                let http = http.clone();
                let upstream = upstream.clone();
                std::thread::spawn(move || handle(request, &http, &upstream));
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[cfg(test)]
fn handle(mut request: tiny_http::Request, http: &reqwest::blocking::Client, upstream: &str) {
    let path = request.url().split('?').next().unwrap_or("").to_string();
    if request.method().as_str() != "POST"
        || !matches!(path.as_str(), "/v1/messages" | "/v1/messages/count_tokens")
    {
        fail(
            request,
            404,
            "not_found_error",
            "This bridge only serves the Messages API.",
        );
        return;
    }
    let mut bytes = Vec::new();
    if request
        .as_reader()
        .take(32 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() > 32 * 1024 * 1024
    {
        fail(
            request,
            413,
            "invalid_request_error",
            "Request is too large or incomplete.",
        );
        return;
    }
    let input: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => {
            fail(
                request,
                400,
                "invalid_request_error",
                "Invalid JSON request.",
            );
            return;
        }
    };
    if path.ends_with("/count_tokens") {
        // Portal provides no tokenizer API. An unsupported response lets the
        // CLI apply its own fallback instead of reporting an invented count.
        fail(
            request,
            501,
            "api_error",
            "Nous Portal does not expose exact Anthropic token counting.",
        );
        return;
    }
    let outgoing = match wire::request(&input) {
        Ok(value) => value,
        Err(error) => {
            fail(request, 400, "invalid_request_error", &error);
            return;
        }
    };
    let response = match http
        .post(format!("{upstream}/chat/completions"))
        .bearer_auth("klide-proxy")
        .json(&outgoing)
        .send()
    {
        Ok(response) => response,
        Err(_) => {
            fail(
                request,
                502,
                "api_error",
                "Hermes subscription proxy is unavailable or timed out.",
            );
            return;
        }
    };
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let kind = match status {
            401 => "authentication_error",
            403 => "permission_error",
            429 => "rate_limit_error",
            _ => "api_error",
        };
        // Don't echo upstream credentials, bodies or account details.
        fail(request, status, kind, &format!("Nous Portal returned HTTP {status}. Check authentication, subscription allowance, and model availability."));
        return;
    }
    let model = input["model"].as_str().unwrap_or("");
    if input["stream"] == true {
        let body = wire::StreamReader::new(BufReader::new(response), model);
        // tiny_http's default response encoder buffers 8 KiB. Flush each SSE
        // fragment so small coding responses type out instead of arriving at EOF.
        let _ = write_stream(request, body);
    } else {
        let converted = response
            .json::<Value>()
            .map_err(|_| "Invalid Nous response.".to_string())
            .and_then(|v| wire::response(&v, model));
        match converted {
            Ok(value) => {
                let _ = request.respond(
                    Response::from_string(value.to_string())
                        .with_header(header("Content-Type", "application/json")),
                );
            }
            Err(error) => fail(request, 502, "api_error", &error),
        }
    }
}

pub(crate) fn write_stream(
    request: tiny_http::Request,
    mut body: impl Read,
) -> std::io::Result<()> {
    let mut writer = request.into_writer();
    writer.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n")?;
    writer.flush()?;
    let mut buffer = [0; 8192];
    loop {
        let count = body.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        write!(writer, "{count:x}\r\n")?;
        writer.write_all(&buffer[..count])?;
        writer.write_all(b"\r\n")?;
        writer.flush()?;
    }
    writer.write_all(b"0\r\n\r\n")?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn test_gateway() -> (String, Arc<AtomicBool>, std::sync::mpsc::Receiver<Value>) {
        let upstream = Server::http("127.0.0.1:0").unwrap();
        let upstream_url = format!("http://{}/v1", upstream.server_addr());
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut turn = 0;
            while let Ok(Some(mut request)) = upstream.recv_timeout(Duration::from_secs(15)) {
                let mut body = String::new();
                request.as_reader().read_to_string(&mut body).unwrap();
                let value: Value = serde_json::from_str(&body).unwrap();
                sender.send(value).unwrap();
                let (delta, finish) = if turn == 0 {
                    (
                        json!({"tool_calls":[{"index":0,"id":"call_read","type":"function","function":{"name":"Read","arguments":"{\"file_path\":\"fixture.txt\"}"}}]}),
                        "tool_calls",
                    )
                } else {
                    (json!({"content":"Bridge verified."}), "stop")
                };
                turn += 1;
                let body = format!(
                    "data: {}\n\ndata: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                    json!({"id":"upstream-test","choices":[{"delta":delta,"finish_reason":null}]}),
                    json!({"choices":[{"delta":{},"finish_reason":finish}]}),
                    json!({"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20}})
                );
                let _ = request.respond(
                    Response::from_string(body)
                        .with_header(header("Content-Type", "text/event-stream")),
                );
                if turn >= 2 {
                    break;
                }
            }
        });
        let server = Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}", server.server_addr());
        let stop = Arc::new(AtomicBool::new(false));
        serve(server, upstream_url, "test-only-token".into(), stop.clone()).unwrap();
        (url, stop, receiver)
    }
    #[test]
    fn http_bridge_streams_a_real_tool_roundtrip_and_rejects_unauthenticated_requests() {
        let (base, stop, received) = test_gateway();
        let http = client(15).unwrap();
        let request = json!({"model":"anthropic/claude-test","stream":true,"max_tokens":128,"messages":[{"role":"user","content":"Read fixture"}],"tools":[{"name":"Read","input_schema":{"type":"object"}}]});
        let unauthorized = http
            .post(format!("{base}/v1/messages"))
            .json(&request)
            .send()
            .unwrap();
        assert_eq!(unauthorized.status().as_u16(), 401);
        let first = http
            .post(format!("{base}/v1/messages?beta=true"))
            .bearer_auth("test-only-token")
            .json(&request)
            .send()
            .unwrap()
            .text()
            .unwrap();
        assert!(first.contains("\"name\":\"Read\""));
        assert!(first.contains("\"stop_reason\":\"tool_use\""));
        let _ = received.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut second = request.clone();
        second["messages"] = json!([{"role":"assistant","content":[{"type":"tool_use","id":"call_read","name":"Read","input":{"file_path":"fixture.txt"}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_read","content":"fixture content"}]}]);
        let answer = http
            .post(format!("{base}/v1/messages"))
            .header("x-api-key", "test-only-token")
            .json(&second)
            .send()
            .unwrap()
            .text()
            .unwrap();
        assert!(answer.contains("Bridge verified."));
        let outgoing = received.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(outgoing["messages"][1]["content"], "fixture content");
        stop.store(true, Ordering::Relaxed);
    }
    #[test]
    fn sse_fragments_arrive_before_the_turn_finishes() {
        struct DelayedBody {
            first: std::io::Cursor<Vec<u8>>,
            gate: std::sync::mpsc::Receiver<()>,
            done: bool,
        }
        impl Read for DelayedBody {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                let n = self.first.read(buf)?;
                if n > 0 {
                    return Ok(n);
                }
                if !self.done {
                    self.gate.recv_timeout(Duration::from_secs(5)).unwrap();
                    self.done = true;
                }
                Ok(0)
            }
        }
        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}", server.server_addr());
        let (release, gate) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            write_stream(
                server.recv().unwrap(),
                DelayedBody {
                    first: std::io::Cursor::new(b"data: first\n\n".to_vec()),
                    gate,
                    done: false,
                },
            )
            .unwrap();
        });
        let response = client(3).unwrap().get(&base).send().unwrap();
        let mut reader = BufReader::new(response);
        let mut line = String::new();
        std::io::BufRead::read_line(&mut reader, &mut line).unwrap();
        assert_eq!(line, "data: first\n");
        release.send(()).unwrap();
        worker.join().unwrap();
    }
    #[test]
    #[ignore = "opt-in: invokes installed Claude Code against a mock subscription endpoint, no billing"]
    fn installed_claude_runs_read_tool_through_the_bridge() {
        let (base, stop, received) = test_gateway();
        let dir =
            std::env::temp_dir().join(format!("klide-claude-nous-smoke-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("config")).unwrap();
        std::fs::write(dir.join("fixture.txt"), "bridge-fixture-verified").unwrap();
        let cli = crate::cli::resolve_command("claude").unwrap();
        let mut child = Command::new(cli)
            .current_dir(&dir)
            .args([
                "-p",
                "Read fixture.txt and report its content.",
                "--model",
                "anthropic/claude-test",
                "--permission-mode",
                "acceptEdits",
                "--tools",
                "Read",
                "--max-turns",
                "3",
            ])
            .env("CLAUDE_CONFIG_DIR", dir.join("config"))
            .env("ANTHROPIC_BASE_URL", &base)
            .env("ANTHROPIC_AUTH_TOKEN", "test-only-token")
            .env("ANTHROPIC_API_KEY", "test-only-token")
            .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
            .env("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "1")
            .env("MAX_THINKING_TOKENS", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(60);
        while child.try_wait().unwrap().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
        if child.try_wait().unwrap().is_none() {
            let _ = child.kill();
        }
        let output = child.wait_with_output().unwrap();
        stop.store(true, Ordering::Relaxed);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            output.status.success(),
            "Claude smoke failed: {stdout}\n{stderr}"
        );
        assert!(
            stdout.contains("Bridge verified."),
            "Unexpected response: {stdout}\n{stderr}"
        );
        let requests: Vec<_> = received.try_iter().collect();
        assert!(
            requests.iter().any(
                |v| v["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|m| m["role"] == "tool"
                        && m["content"]
                            .as_str()
                            .unwrap_or("")
                            .contains("bridge-fixture-verified"))
            ),
            "Claude did not execute the requested Read tool"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
