//! `klide run` end to end: the real binary, an isolated HOME, and a loopback
//! model stand-in. No GUI, real model or user credential is involved.
#![cfg(unix)]
use serde_json::json;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

/// Answers every chat request in turn from `script`: a tool call, or text.
fn serve(script: Vec<serde_json::Value>) -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}/v1", listener.local_addr().unwrap());
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            respond(stream, &script, &counter);
        }
    });
    (address, calls)
}

fn respond(mut stream: TcpStream, script: &[serde_json::Value], calls: &AtomicUsize) {
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut start = String::new();
    if !reader.read_line(&mut start).is_ok_and(|n| n > 0) {
        return;
    }
    let mut length = 0;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() || line == "\r\n" || line.is_empty() {
            break;
        }
        if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            length = v.trim().parse().unwrap();
        }
    }
    let _ = reader.read_exact(&mut vec![0; length]);
    if !start.starts_with("POST ") {
        let body = r#"{"object":"list","data":[{"id":"fixture"}]}"#;
        let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        return;
    }
    let n = calls.fetch_add(1, Ordering::SeqCst);
    let delta = script.get(n).cloned().unwrap_or(json!({"content":"(script ended)"}));
    let finish = if delta.get("tool_calls").is_some() { "tool_calls" } else { "stop" };
    let body = format!(
        "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
        json!({"choices":[{"index":0,"delta":delta}]}),
        json!({"choices":[{"index":0,"delta":{},"finish_reason":finish}],"usage":{"prompt_tokens":10,"completion_tokens":5}})
    );
    let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
}

struct Sandbox {
    dir: PathBuf,
}
impl Sandbox {
    fn new(name: &str, address: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("klide-cli-run-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("home/.klide")).unwrap();
        std::fs::create_dir_all(dir.join("workspace")).unwrap();
        std::fs::write(
            dir.join("home/.klide/custom_providers.json"),
            json!([{"id":"custom:cli-fixture","label":"Fixture","baseUrl":address,"defaultModel":"fixture"}]).to_string(),
        )
        .unwrap();
        Self { dir }
    }
    fn workspace(&self) -> PathBuf {
        self.dir.join("workspace")
    }
    fn run(&self, args: &[&str]) -> Output {
        let mut child = Command::new(env!("CARGO_BIN_EXE_klide"))
            .arg("run")
            .args(args)
            .env("HOME", self.dir.join("home"))
            .env("KLIDE_DATA_DIR", self.dir.join("data"))
            .env_remove("DEEPSEEK_API_KEY")
            .current_dir(self.workspace())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        while child.try_wait().unwrap().is_none() {
            assert!(std::time::Instant::now() < deadline, "klide run did not finish");
            std::thread::sleep(Duration::from_millis(50));
        }
        child.wait_with_output().unwrap()
    }
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[test]
fn a_task_prints_the_answer_and_exits_zero() {
    let (address, calls) = serve(vec![json!({"content":"The test asserts 1 + 1 = 3."})]);
    let sandbox = Sandbox::new("answer", &address);
    let out = sandbox.run(&["--model", "custom:cli-fixture/fixture", "why does the test fail?"]);
    assert_eq!(out.status.code(), Some(0), "stderr: {}", text(&out.stderr));
    assert!(text(&out.stdout).contains("The test asserts 1 + 1 = 3."), "stdout: {}", text(&out.stdout));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn work_without_allow_commands_never_runs_a_command() {
    let marker = "klide-cli-run-marker";
    let (address, calls) = serve(vec![
        json!({"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"run_command","arguments":json!({"command":format!("touch {marker}")}).to_string()}}]}),
        json!({"content":"I could not run it."}),
    ]);
    let sandbox = Sandbox::new("no-commands", &address);
    let out = sandbox.run(&["--model", "custom:cli-fixture/fixture", "--work", "--format", "json", "touch the marker"]);
    assert_eq!(out.status.code(), Some(0), "stderr: {}", text(&out.stderr));
    assert!(!sandbox.workspace().join(marker).exists(), "a command ran without --allow-commands");
    assert_eq!(calls.load(Ordering::SeqCst), 2, "the run went on after the refusal");
    // --format json: every stdout line is one event.
    let stdout = text(&out.stdout);
    assert!(stdout.lines().filter(|l| !l.is_empty()).all(|l| serde_json::from_str::<serde_json::Value>(l).is_ok()));
    assert!(stdout.contains("\"type\":\"run_result\""));
}

#[test]
fn a_missing_key_names_the_variable_and_exits_three() {
    let (address, calls) = serve(vec![]);
    let sandbox = Sandbox::new("no-key", &address);
    let out = sandbox.run(&["--model", "deepseek/deepseek-chat", "hello"]);
    assert_eq!(out.status.code(), Some(3), "stderr: {}", text(&out.stderr));
    assert!(text(&out.stderr).contains("DEEPSEEK_API_KEY"), "stderr: {}", text(&out.stderr));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn usage_mistakes_exit_two() {
    let sandbox = Sandbox::new("usage", "http://127.0.0.1:9/v1");
    assert_eq!(sandbox.run(&["--allow-commands", "x"]).status.code(), Some(2));
    assert_eq!(sandbox.run(&[]).status.code(), Some(2));
    assert_eq!(sandbox.run(&["--help"]).status.code(), Some(0));
}
