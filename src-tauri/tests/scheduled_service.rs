//! Real headless binary, isolated app data, and a loopback model stand-in.
//! No GUI, real model, user credential, or production schedule is involved.
#![cfg(unix)]
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::{fs::PermissionsExt, net::UnixStream, process::CommandExt};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

struct Api {
    address: String,
    calls: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Api {
    fn start(ask_permission: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}/v1", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let thread = std::thread::spawn(move || {
            let mut requests = Vec::new();
            while !stopping.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let counter = counter.clone();
                        requests.push(std::thread::spawn(move || {
                            respond_api(stream, ask_permission, &counter)
                        }));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10))
                    }
                    Err(e) => panic!("fixture listener: {e}"),
                }
            }
            for request in requests {
                let _ = request.join();
            }
        });
        Self {
            address,
            calls,
            stop,
            thread: Some(thread),
        }
    }
}
impl Drop for Api {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.thread.take().unwrap().join();
    }
}

fn respond_api(mut stream: TcpStream, ask_permission: bool, calls: &AtomicUsize) {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut start = String::new();
    if !reader.read_line(&mut start).is_ok_and(|n| n > 0) {
        return;
    }
    let mut length = 0;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() {
            return;
        }
        if line == "\r\n" || line.is_empty() {
            break;
        }
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            length = value.trim().parse::<usize>().unwrap();
        }
    }
    assert!(length < 2_000_000);
    if reader.read_exact(&mut vec![0; length]).is_err() {
        return;
    }
    if !start.starts_with("POST ") {
        let body = r#"{"object":"list","data":[{"id":"fixture"}]}"#;
        let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        return;
    }
    let call = calls.fetch_add(1, Ordering::SeqCst);
    let delta = if ask_permission && call == 0 {
        json!({"tool_calls":[{"index":0,"id":"approval-command","type":"function","function":{"name":"run_command","arguments":"{\"command\":\"printf scheduled-approval\"}"}}]})
    } else {
        json!({"content":"Completed while Klide was closed."})
    };
    let finish = if ask_permission && call == 0 {
        "tool_calls"
    } else {
        "stop"
    };
    let body = format!(
        "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
        json!({"choices":[{"index":0,"delta":delta}]}),
        json!({"choices":[{"index":0,"delta":{},"finish_reason":finish}],"usage":{"prompt_tokens":100,"completion_tokens":10}})
    );
    let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
}

struct Service {
    data: PathBuf,
    home: PathBuf,
    child: Option<Child>,
}
impl Service {
    fn new(api: &Api, name: &str) -> Self {
        let data = std::env::temp_dir().join(format!(
            "klide-scheduled-{name}-{}-{}",
            std::process::id(),
            now()
        ));
        let home = data.join("home");
        std::fs::create_dir_all(home.join(".klide")).unwrap();
        std::fs::create_dir_all(data.join("workspace")).unwrap();
        std::fs::write(home.join(".klide/custom_providers.json"), json!([{
            "id":"custom:scheduled-fixture","label":"Fixture","baseUrl":api.address,"defaultModel":"fixture"
        }]).to_string()).unwrap();
        let db = Connection::open(data.join("schedules.sqlite3")).unwrap();
        db.execute_batch("CREATE TABLE schedules (id TEXT PRIMARY KEY, body TEXT NOT NULL)")
            .unwrap();
        Self {
            data,
            home,
            child: None,
        }
    }
    fn seed(&self, id: &str, due_at: i64, mode: &str) {
        let body = json!({"id":id,"name":"Fixture schedule","request":{
            "workspaceRoot":self.data.join("workspace"),"provider":"custom:scheduled-fixture","model":"fixture", "mode":mode,
            "initialText":"Run the fixture work", "attachments":[], "requireDiffReview":true
        },"dueAt":due_at,"intervalMs":null,"status":"pending","fromSeq":0,"error":null,
        "target":{"kind":"local"},"history":[]});
        Connection::open(self.data.join("schedules.sqlite3"))
            .unwrap()
            .execute(
                "INSERT INTO schedules VALUES (?1, ?2)",
                params![id, body.to_string()],
            )
            .unwrap();
    }
    fn start(&mut self) {
        self.child = Some(
            Command::new(env!("CARGO_BIN_EXE_klide"))
                .args(["scheduled", "--data-dir"])
                .arg(&self.data)
                .env("HOME", &self.home)
                .env(
                    "PATH",
                    format!(
                        "{}:/usr/bin:/bin:/usr/sbin:/sbin",
                        self.data.join("bin").display()
                    ),
                )
                .current_dir(&self.data)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::from(
                    std::fs::File::create(self.data.join("service-test.stderr")).unwrap(),
                ))
                .process_group(0)
                .spawn()
                .unwrap(),
        );
        self.wait(|| self.data.join("scheduled-host/ptyd.token").exists());
    }
    fn kill(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    fn row(&self, id: &str) -> Value {
        let db = Connection::open(self.data.join("schedules.sqlite3")).unwrap();
        db.busy_timeout(Duration::from_secs(5)).unwrap();
        let body: String = db
            .query_row("SELECT body FROM schedules WHERE id=?1", [id], |r| r.get(0))
            .unwrap();
        serde_json::from_str(&body).unwrap()
    }
    fn events(&self, id: &str) -> Vec<Value> {
        std::fs::read_to_string(self.data.join("runs").join(format!("{id}.jsonl")))
            .unwrap_or_default()
            .split_inclusive('\n')
            .filter(|line| line.ends_with('\n'))
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    #[track_caller]
    fn wait(&self, condition: impl Fn() -> bool) {
        let until = Instant::now() + Duration::from_secs(30);
        while !condition() {
            assert!(
                Instant::now() < until,
                "service timed out; stderr: {}; launchd stderr: {}; service log: {}",
                std::fs::read_to_string(self.data.join("service-test.stderr")).unwrap_or_default(),
                std::fs::read_to_string(self.data.join("scheduled-host/service.stderr.log"))
                    .unwrap_or_default(),
                std::fs::read_to_string(self.data.join("scheduled-host/ptyd.log"))
                    .unwrap_or_default()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    fn request(&self, request: Value) -> Value {
        let dir = self.data.join("scheduled-host");
        let stream = UnixStream::connect(klide_lib::pty_daemon::socket_path(&dir)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let mut reader = BufReader::new(stream);
        let token = std::fs::read_to_string(dir.join("ptyd.token")).unwrap();
        writeln!(
            reader.get_mut(),
            "{}",
            json!({"type":"auth","token":token.trim()})
        )
        .unwrap();
        writeln!(reader.get_mut(), "{request}").unwrap();
        let mut response = String::new();
        reader.read_line(&mut response).unwrap();
        serde_json::from_str(&response).unwrap()
    }
    fn use_cli_fixture(&self, id: &str) {
        std::fs::create_dir_all(self.data.join("bin")).unwrap();
        let executable = self.data.join("bin/opencode");
        std::fs::write(&executable, r##"#!/bin/sh
case "$1" in
  --version) echo "1.19.0"; exit 0;;
  serve) exit 1;;
esac
cat >/dev/null
printf '%s\n' '{"type":"step_start","sessionID":"scheduled_fixture","part":{"id":"start","type":"step-start"}}'
printf '%s\n' '{"type":"text","sessionID":"scheduled_fixture","part":{"id":"text","type":"text","text":"CLI completed with the app closed."}}'
"##).unwrap();
        std::fs::set_permissions(executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut row = self.row(id);
        row["request"]["provider"] = json!("opencode");
        row["request"]["model"] = json!("default");
        Connection::open(self.data.join("schedules.sqlite3"))
            .unwrap()
            .execute(
                "UPDATE schedules SET body=?2 WHERE id=?1",
                params![id, row.to_string()],
            )
            .unwrap();
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.kill();
        let _ = std::fs::remove_file(klide_lib::pty_daemon::socket_path(
            &self.data.join("scheduled-host"),
        ));
        let _ = std::fs::remove_dir_all(&self.data);
    }
}

#[test]
fn due_work_starts_without_an_app_and_restart_does_not_replay_it() {
    let api = Api::start(false);
    let mut service = Service::new(&api, "closed");
    service.seed("review", now() + 700, "plan");
    service.start();
    // No desktop, request channel or event-stream client ever connects.
    service.wait(|| service.row("review")["status"] == "completed");
    let row = service.row("review");
    assert_eq!(row["history"].as_array().unwrap().len(), 1);
    assert_eq!(row["history"][0]["target"]["kind"], "local");
    assert_eq!(api.calls.load(Ordering::SeqCst), 1);
    let id = row["history"][0]["runId"].as_str().unwrap();
    let events = service.events(id);
    assert_eq!(
        events
            .iter()
            .filter(|e| e["event"]["type"] == "user_message")
            .count(),
        1
    );
    assert_eq!(events.last().unwrap()["event"]["type"], "run_result");
    assert!(events
        .iter()
        .any(|e| e.to_string().contains("Completed while Klide was closed.")));
    let first_pid = service.request(json!({"type":"ping"}))["pid"].clone();
    let mut duplicate = Command::new(env!("CARGO_BIN_EXE_klide"))
        .args(["scheduled", "--data-dir"])
        .arg(&service.data)
        .env("HOME", &service.home)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    let duplicate_status = loop {
        if let Some(status) = duplicate.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= until {
            let _ = duplicate.kill();
            let _ = duplicate.wait();
            panic!("a duplicate scheduler must exit without replacing the owner");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(duplicate_status.success());
    assert_eq!(service.request(json!({"type":"ping"}))["pid"], first_pid);
    service.kill();
    service.seed("next", now() + 200, "plan");
    service.start();
    service.wait(|| service.row("next")["status"] == "completed");
    assert_eq!(
        service.row("review")["history"].as_array().unwrap().len(),
        1
    );
    assert_eq!(
        api.calls.load(Ordering::SeqCst),
        2,
        "only the new schedule should call the model after restart"
    );
}

#[test]
fn a_native_scheduled_run_waits_for_approval_until_a_client_reconnects() {
    let api = Api::start(true);
    let mut service = Service::new(&api, "approval");
    service.seed("approval", now() + 200, "goal");
    service.start();
    service.wait(|| {
        service
            .events("approval-occurrence-1")
            .iter()
            .any(|e| e["event"]["type"] == "permission_requested")
    });
    let status = service.request(json!({"type":"chat_status","run_id":"approval-occurrence-1"}));
    assert_eq!(status["status"], "waiting_for_permission");
    assert_eq!(
        api.calls.load(Ordering::SeqCst),
        1,
        "no approval may be synthesized while the desktop is absent"
    );
    assert_eq!(service.row("approval")["status"], "running");
    let answer = json!({"type":"chat_control","run_id":"approval-occurrence-1","control":{"type":"permission","decision":{"behavior":"allow","scope":"once"}}});
    assert_eq!(service.request(answer)["answered"], true);
    service.wait(|| service.row("approval")["status"] == "completed");
    let events = service.events("approval-occurrence-1");
    assert_eq!(
        events
            .iter()
            .filter(|e| e["event"]["type"] == "permission_resolved")
            .count(),
        1
    );
    assert_eq!(events.last().unwrap()["event"]["type"], "run_result");
}

#[test]
fn a_subscription_agent_is_launched_by_the_same_persistent_clock() {
    let api = Api::start(false);
    let mut service = Service::new(&api, "cli");
    service.seed("cli", now() + 200, "chat");
    service.use_cli_fixture("cli");
    service.start();
    service.wait(|| service.row("cli")["status"] == "completed");
    assert_eq!(api.calls.load(Ordering::SeqCst), 0);
    assert!(service.events("cli-occurrence-1").iter().any(|event| event
        .to_string()
        .contains("CLI completed with the app closed.")));
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "requires a macOS GUI login and permission to register an isolated temporary launchd job"]
fn launchd_restarts_the_local_service_after_it_exits() {
    let api = Api::start(false);
    let service = Service::new(&api, "launchd");
    service.seed("launchd", now() + 200, "chat");
    service.use_cli_fixture("launchd");
    let executable = PathBuf::from(env!("CARGO_BIN_EXE_klide"));
    let path = format!(
        "{}:/usr/bin:/bin:/usr/sbin:/sbin",
        service.data.join("bin").display()
    );
    let (label, document) =
        klide_lib::pty_daemon::scheduled_launch_agent(&service.data, &executable, &path);
    // Isolate this test's HOME too; production inherits the logged-in user's
    // home, but the fixture must never read their keys or storage settings.
    let home = service
        .home
        .to_string_lossy()
        .replace('&', "&amp;")
        .replace('<', "&lt;");
    let document = document.replace(
        "<key>EnvironmentVariables</key><dict>",
        &format!("<key>EnvironmentVariables</key><dict><key>HOME</key><string>{home}</string>"),
    );
    std::fs::create_dir_all(service.data.join("scheduled-host")).unwrap();
    let plist = service.data.join("service.plist");
    std::fs::write(&plist, document).unwrap();
    let domain = format!("gui/{}", unsafe { libc::geteuid() });
    let job = format!("{domain}/{label}");
    struct Registration(String);
    impl Drop for Registration {
        fn drop(&mut self) {
            let _ = Command::new("/bin/launchctl")
                .args(["bootout", &self.0])
                .output();
        }
    }
    let output = Command::new("/bin/launchctl")
        .args(["bootstrap", &domain])
        .arg(&plist)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let _registration = Registration(job);
    service.wait(|| service.data.join("scheduled-host/ptyd.token").exists());
    service.wait(|| service.row("launchd")["status"] == "completed");
    let first = service.request(json!({"type":"ping"}))["pid"]
        .as_u64()
        .unwrap();
    assert_eq!(service.request(json!({"type":"shutdown"}))["type"], "ok");
    service.wait(|| {
        !klide_lib::pty_daemon::socket_path(&service.data.join("scheduled-host")).exists()
    });
    // launchd's production ThrottleInterval is ten seconds.
    service.wait(|| {
        let dir = service.data.join("scheduled-host");
        UnixStream::connect(klide_lib::pty_daemon::socket_path(&dir)).is_ok()
    });
    let second = service.request(json!({"type":"ping"}))["pid"]
        .as_u64()
        .unwrap();
    assert_ne!(first, second, "launchd should replace the exited process");
    assert_eq!(
        service.row("launchd")["history"].as_array().unwrap().len(),
        1
    );
}
