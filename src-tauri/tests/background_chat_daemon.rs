//! The real ptyd binary + a deterministic local OpenCode stand-in. No model,
//! account, or network service is used. All client connections disappear while
//! the CLI is working, just as when the desktop process exits.
#![cfg(unix)]
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::{fs::PermissionsExt, net::UnixStream, process::CommandExt};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

struct Daemon {
    dir: PathBuf,
    child: Child,
}
impl Daemon {
    fn connect(&self) -> BufReader<UnixStream> {
        let stream = UnixStream::connect(klide_lib::pty_daemon::socket_path(&self.dir)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
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
        reader.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }
    fn wait(&self, predicate: impl Fn() -> bool) {
        let end = Instant::now() + Duration::from_secs(15);
        while !predicate() {
            assert!(
                Instant::now() < end,
                "background run timed out; log: {:?}",
                std::fs::read_to_string(self.dir.join("ptyd.log"))
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

#[test]
fn background_chat_survives_all_clients_disconnecting_and_finishes_once() {
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
    std::fs::write(&script, r##"#!/bin/sh
printf '%s\n' "$@" > args.txt
cat > prompt.txt
printf '%s\n' '{"type":"step_start","sessionID":"ses_background_fixture","part":{"id":"start","type":"step-start"}}'
printf '%s\n' '{"type":"text","sessionID":"ses_background_fixture","part":{"id":"first","type":"text","text":"Started. "}}'
i=0
while [ ! -f finish ] && [ "$i" -lt 200 ]; do sleep 0.05; i=$((i + 1)); done
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
    let daemon = Daemon { dir, child };
    daemon.wait(|| daemon.dir.join("ptyd.token").exists());
    let runs = daemon.dir.join("runs");
    let mut observer = daemon.connect();
    writeln!(observer.get_mut(), "{}", json!({"type":"subscribe"})).unwrap();
    let mut ack = String::new();
    observer.read_line(&mut ack).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&ack).unwrap()["type"],
        "subscribed"
    );
    let start = json!({"type":"chat_start", "runs_dir":runs, "request":{
        "runId":"conversation", "workspaceRoot":daemon.dir, "provider":"opencode", "model":"default", "mode":"chat", "initialText":"Do the fixture work"
    }});
    assert_eq!(daemon.request(start.clone())["type"], "chat_started");
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
    let response = daemon.request(start);
    assert_eq!(response["type"], "chat_started");
    assert_eq!(response["from_seq"], events.len());
    daemon.wait(|| {
        daemon.request(json!({"type":"chat_status","run_id":"conversation"}))["status"].is_null()
    });
    assert!(std::fs::read_to_string(daemon.dir.join("args.txt"))
        .unwrap()
        .contains("ses_background_fixture"));
}
