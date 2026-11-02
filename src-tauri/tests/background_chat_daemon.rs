//! The real ptyd binary + a deterministic local OpenCode stand-in. No model,
//! account, or network service is used. All client connections disappear while
//! the CLI is working, just as when the desktop process exits.
#![cfg(unix)]
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::{fs::PermissionsExt, net::UnixStream, process::CommandExt};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// One daemon at a time. Each test spawns a real ptyd and a CLI stand-in; three
/// at once on a loaded macOS runner made `chat_start` fail or hang up (main CI,
/// 2026-11-01). The guard lives in the `Daemon`, so it is released only after
/// that daemon has been killed and its directory removed.
static SERIAL: Mutex<()> = Mutex::new(());

struct Daemon {
    dir: PathBuf,
    child: Child,
    _serial: MutexGuard<'static, ()>,
}
impl Daemon {
    fn log(&self) -> String {
        std::fs::read_to_string(self.dir.join("ptyd.log")).unwrap_or_default()
    }
    fn connect(&self) -> BufReader<UnixStream> {
        let stream = UnixStream::connect(klide_lib::pty_daemon::socket_path(&self.dir)).unwrap();
        stream
            // The same patience as `wait`: a busy macOS runner has taken
            // longer than 5 s to answer the first `chat_start`.
            .set_read_timeout(Some(Duration::from_secs(15)))
            .unwrap();
        let mut reader = BufReader::new(stream);
        let token = std::fs::read_to_string(self.dir.join("ptyd.token")).unwrap();
        writeln!(
            reader.get_mut(),
            "{}",
            json!({"type":"auth","token":token.trim()})
        )
        .unwrap();
        reader
    }
    fn request(&self, value: Value) -> Value {
        let mut reader = self.connect();
        writeln!(reader.get_mut(), "{value}").unwrap();
        let mut line = String::new();
        if let Err(e) = reader.read_line(&mut line) {
            panic!("no answer to {}: {e}; log: {:?}", value["type"], self.log());
        }
        serde_json::from_str(&line).unwrap_or_else(|e| {
            panic!(
                "unreadable answer to {} ({e}): {line:?}; log: {:?}",
                value["type"],
                self.log()
            )
        })
    }
    /// Start the fixture chat; on refusal, say why — the reply and the log.
    fn start_chat(&self, request: Value) -> Value {
        let response = self.request(request);
        assert_eq!(
            response["type"],
            "chat_started",
            "chat_start refused: {response}; log: {:?}",
            self.log()
        );
        response
    }
    fn wait(&self, predicate: impl Fn() -> bool) {
        let end = Instant::now() + Duration::from_secs(15);
        while !predicate() {
            assert!(
                Instant::now() < end,
                "background run timed out; log: {:?}",
                self.log()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = std::fs::write(self.dir.join("finish"), "");
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(klide_lib::pty_daemon::socket_path(&self.dir));
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn fixture() -> Daemon {
    // A failed test poisons the lock; the next one must still run.
    let serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let dir = std::env::temp_dir().join(format!(
        "klide-chat-process-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(dir.join("bin")).unwrap();
    let script = dir.join("bin/opencode");
    // The fixture is the CLI's stdout shape only. Asked to `serve` (the
    // adapter tries its event stream first, since #136) it refuses at once, so
    // the turn falls back to a plain `run` without waiting out SERVE_READY —
    // on a slow runner that wait alone exceeded this test's 15 s patience.
    std::fs::write(&script, r##"#!/bin/sh
case "$1" in
  --version) echo "1.19.0"; exit 0;;
  serve) echo "fixture has no server" >&2; exit 1;;
esac
printf '%s\n' "$@" > args.txt
cat > prompt.txt
printf '%s\n' '{"type":"step_start","sessionID":"ses_background_fixture","part":{"id":"start","type":"step-start"}}'
printf '%s\n' '{"type":"text","sessionID":"ses_background_fixture","part":{"id":"first","type":"text","text":"Started. "}}'
i=0
while [ ! -f finish ] && [ "$i" -lt 600 ]; do sleep 0.05; i=$((i + 1)); done
printf '%s\n' '{"type":"text","sessionID":"ses_background_fixture","part":{"id":"last","type":"text","text":"Finished while closed."}}'
"##).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_klide"))
        .args(["ptyd", "--data-dir"])
        .arg(&dir)
        .env(
            "PATH",
            format!("{}:/usr/bin:/bin", dir.join("bin").display()),
        )
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .unwrap();
    let daemon = Daemon {
        dir,
        child,
        _serial: serial,
    };
    daemon.wait(|| daemon.dir.join("ptyd.token").exists());
    daemon
}

fn start(daemon: &Daemon) -> Value {
    json!({"type":"chat_start", "runs_dir":daemon.dir.join("runs"), "request":{
        "runId":"conversation", "workspaceRoot":daemon.dir, "provider":"opencode", "model":"default", "mode":"chat", "initialText":"Do the fixture work"
    }})
}

fn events(daemon: &Daemon) -> Vec<Value> {
    std::fs::read_to_string(daemon.dir.join("runs/conversation.jsonl"))
        .unwrap_or_default()
        // A live stream append may be in flight; only complete JSONL records
        // are replayable. A malformed complete record must still fail the test.
        .split_inclusive('\n')
        .filter(|line| line.ends_with('\n'))
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[test]
fn background_chat_survives_all_clients_disconnecting_and_finishes_once() {
    let daemon = fixture();
    let runs = daemon.dir.join("runs");
    let mut observer = daemon.connect();
    writeln!(observer.get_mut(), "{}", json!({"type":"subscribe"})).unwrap();
    let mut ack = String::new();
    observer.read_line(&mut ack).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&ack).unwrap()["type"],
        "subscribed"
    );
    let start = start(&daemon);
    daemon.start_chat(start.clone());
    let transcript = runs.join("conversation.jsonl");
    daemon.wait(|| std::fs::read_to_string(&transcript).is_ok_and(|s| s.contains("Started.")));
    drop(observer); // no request channel, event observer, or GUI remains
    assert_eq!(
        daemon.request(json!({"type":"chat_status","run_id":"conversation"}))["status"],
        "running"
    );
    assert_eq!(
        daemon.request(start.clone())["type"],
        "err",
        "reopening must not start a duplicate"
    );
    std::fs::write(daemon.dir.join("finish"), "").unwrap();
    daemon.wait(|| {
        daemon.request(json!({"type":"chat_status","run_id":"conversation"}))["status"].is_null()
    });
    let events: Vec<Value> = std::fs::read_to_string(&transcript)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect();
    assert_eq!(events.last().unwrap()["event"]["type"], "run_result");
    assert_eq!(
        events
            .iter()
            .filter(|e| e["event"]["type"] == "user_message")
            .count(),
        1
    );
    assert!(events
        .iter()
        .any(|e| e["event"]["type"] == "assistant_message"
            && e.to_string().contains("Finished while closed.")));
    for (seq, event) in events.iter().enumerate() {
        assert_eq!(event["seq"], seq);
    }
    // A follow-up starts after the previous terminal event, even if it finishes
    // before the start response reaches the UI. It resumes the CLI session.
    let response = daemon.start_chat(start);
    assert_eq!(response["from_seq"], events.len());
    daemon.wait(|| {
        daemon.request(json!({"type":"chat_status","run_id":"conversation"}))["status"].is_null()
    });
    assert!(std::fs::read_to_string(daemon.dir.join("args.txt"))
        .unwrap()
        .contains("ses_background_fixture"));
}

// Exercise the real authenticated permission bridge while the CLI stand-in
// holds its turn open. No desktop observer is connected when the prompt arrives.
fn request_permission(daemon: &Daemon) -> std::thread::JoinHandle<Value> {
    let endpoint: Value = serde_json::from_str(
        &std::fs::read_to_string(daemon.dir.join("chat-coordination-endpoint.json")).unwrap(),
    )
    .unwrap();
    let secret =
        std::fs::read_to_string(daemon.dir.join("chat-mcp/conversation-opencode.secret")).unwrap();
    std::thread::spawn(move || {
        reqwest::blocking::Client::new()
            .post(format!(
                "http://127.0.0.1:{}/coord/{}/conversation:opencode",
                endpoint["port"].as_u64().unwrap(),
                endpoint["token"].as_str().unwrap()
            ))
            .header("X-Klide-Session-Secret", secret.trim())
            .timeout(Duration::from_secs(15))
            .json(&json!({"op":"permission", "toolName":"Bash",
                "input":{"command":"printf background-approved"}, "toolUseId":"detached-command"}))
            .send()
            .unwrap()
            .json()
            .unwrap()
    })
}

fn waiting_for_permission() -> (Daemon, std::thread::JoinHandle<Value>) {
    let daemon = fixture();
    daemon.start_chat(start(&daemon));
    daemon.wait(|| {
        events(&daemon)
            .iter()
            .any(|e| e.to_string().contains("Started."))
    });
    let reply = request_permission(&daemon);
    daemon.wait(|| {
        events(&daemon)
            .iter()
            .any(|e| e["event"]["type"] == "permission_requested")
    });
    assert_eq!(
        daemon.request(json!({"type":"chat_status", "run_id":"conversation"}))["status"],
        "waiting_for_permission"
    );
    (daemon, reply)
}

#[test]
fn approval_raised_without_a_desktop_can_be_recovered_and_answered_once() {
    let (daemon, reply) = waiting_for_permission();
    // A fresh client recovers the pending card from the durable transcript.
    let before = events(&daemon);
    assert_eq!(
        before
            .iter()
            .filter(|e| e["event"]["type"] == "permission_requested")
            .count(),
        1
    );
    assert!(!before
        .iter()
        .any(|e| e["event"]["type"] == "permission_resolved"));
    let answer = json!({"type":"chat_control", "run_id":"conversation", "control":{
        "type":"permission", "decision":{"behavior":"allow", "scope":"once"}
    }});
    assert_eq!(daemon.request(answer.clone())["answered"], true);
    assert_eq!(
        daemon.request(answer)["type"],
        "err",
        "a second click must not answer twice"
    );
    let response = reply.join().unwrap();
    assert_eq!(response["ok"], true);
    let decision: Value =
        serde_json::from_str(response["value"]["text"].as_str().unwrap()).unwrap();
    assert_eq!(decision["behavior"], "allow");
    std::fs::write(daemon.dir.join("finish"), "").unwrap();
    daemon.wait(|| {
        daemon.request(json!({"type":"chat_status","run_id":"conversation"}))["status"].is_null()
    });
    let after = events(&daemon);
    assert_eq!(
        after
            .iter()
            .filter(|e| e["event"]["type"] == "permission_resolved")
            .count(),
        1
    );
    assert_eq!(after.last().unwrap()["event"]["type"], "run_result");
    for (seq, event) in after.iter().enumerate() {
        assert_eq!(event["seq"], seq);
    }
}

#[test]
fn stop_after_reconnecting_denies_a_pending_approval_and_settles_the_run() {
    let (daemon, reply) = waiting_for_permission();
    assert_eq!(
        daemon.request(json!({"type":"chat_control", "run_id":"conversation",
        "control":{"type":"stop"}}))["type"],
        "chat_controlled"
    );
    daemon.wait(|| {
        daemon.request(json!({"type":"chat_status","run_id":"conversation"}))["status"].is_null()
    });
    let response = reply.join().unwrap();
    let decision: Value =
        serde_json::from_str(response["value"]["text"].as_str().unwrap()).unwrap();
    assert_eq!(
        decision["behavior"], "deny",
        "Stop must never approve the command"
    );
    let replay = events(&daemon);
    assert!(replay
        .iter()
        .any(|e| e["event"]["type"] == "run_error" && e["event"]["error"]["code"] == "aborted"));
    assert!(!replay.iter().any(|e| e["event"]["type"] == "run_result"));
    assert_eq!(
        replay
            .iter()
            .filter(|e| e["event"]["type"] == "permission_resolved")
            .count(),
        1
    );
    for (seq, event) in replay.iter().enumerate() {
        assert_eq!(event["seq"], seq);
    }
}
