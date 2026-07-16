//! App-side client for the `klide ptyd` daemon (Slice 3c of
//! docs/delegate-session-replay.md). Transport only: connect to the socket,
//! start the daemon when it isn't running, one request/response round-trip
//! per call, and the subscribe upgrade. What to DO with responses and events
//! stays in pty.rs, next to the in-process host it mirrors.

#![cfg(unix)]

use crate::pty_daemon::{socket_path, Request, Response};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// One request → one response over a fresh connection. Unix-socket connects
/// are microseconds; a connection per call keeps every call independent and
/// immune to a wedged predecessor.
pub fn request(data_dir: &Path, request: &Request) -> Result<Response, String> {
    let mut stream =
        UnixStream::connect(socket_path(data_dir)).map_err(|e| format!("connect: {e}"))?;
    stream
        .set_read_timeout(Some(REQUEST_TIMEOUT))
        .map_err(|e| e.to_string())?;
    let line = serde_json::to_string(request).map_err(|e| e.to_string())?;
    writeln!(stream, "{line}").map_err(|e| format!("send: {e}"))?;
    let mut reply = String::new();
    BufReader::new(stream)
        .read_line(&mut reply)
        .map_err(|e| format!("recv: {e}"))?;
    serde_json::from_str(&reply).map_err(|e| format!("bad response: {e}"))
}

/// Make sure a daemon of OUR version is serving, starting or replacing one as
/// needed. A version mismatch (app was upgraded while a daemon from the old
/// binary kept running) gets a polite `shutdown` and a fresh spawn — its
/// sessions die, which is the honest option: the old binary may host
/// sessions the new protocol misreads.
pub fn ensure_daemon(data_dir: &Path) -> Result<(), String> {
    match request(data_dir, &Request::Ping) {
        Ok(Response::Pong { version, .. }) if version == env!("CARGO_PKG_VERSION") => {
            return Ok(())
        }
        Ok(Response::Pong { version, .. }) => {
            let _ = request(data_dir, &Request::Shutdown);
            eprintln!("ptyd: replacing v{version} with v{}", env!("CARGO_PKG_VERSION"));
            // Give it a beat to release the socket before rebinding.
            std::thread::sleep(Duration::from_millis(200));
        }
        _ => {}
    }
    spawn_daemon(data_dir)?;
    // The daemon needs a moment to bind before the first real request.
    let mut delay = Duration::from_millis(50);
    for _ in 0..6 {
        std::thread::sleep(delay);
        if matches!(request(data_dir, &Request::Ping), Ok(Response::Pong { .. })) {
            return Ok(());
        }
        delay *= 2;
    }
    Err("ptyd did not come up".to_string())
}

/// Launch `klide ptyd` detached: own process group so a Ctrl-C aimed at a
/// terminal-launched dev app doesn't take the daemon (and its sessions) down
/// with it, and no inherited stdio so it cannot hold the app's pipes open.
fn spawn_daemon(data_dir: &Path) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    std::process::Command::new(exe)
        .arg("ptyd")
        .arg("--data-dir")
        .arg(data_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|e| format!("spawn ptyd: {e}"))?;
    Ok(())
}

/// Open the event stream: a connection upgraded with `subscribe`, handed back
/// as a line reader once the daemon acks. The caller owns the read loop; EOF
/// or an error there means "reconnect if you still care".
pub fn subscribe(data_dir: &Path) -> Result<BufReader<UnixStream>, String> {
    let mut stream =
        UnixStream::connect(socket_path(data_dir)).map_err(|e| format!("connect: {e}"))?;
    stream
        .set_read_timeout(Some(REQUEST_TIMEOUT))
        .map_err(|e| e.to_string())?;
    let line = serde_json::to_string(&Request::Subscribe).map_err(|e| e.to_string())?;
    writeln!(stream, "{line}").map_err(|e| format!("send: {e}"))?;
    let mut reader = BufReader::new(stream);
    let mut ack = String::new();
    reader.read_line(&mut ack).map_err(|e| format!("recv: {e}"))?;
    match serde_json::from_str::<Response>(&ack) {
        Ok(Response::Subscribed) => {
            // Events are pushed at the session's pace — an idle session may be
            // silent for hours. No read timeout from here on.
            reader
                .get_ref()
                .set_read_timeout(None)
                .map_err(|e| e.to_string())?;
            Ok(reader)
        }
        Ok(Response::Err { message }) => Err(message),
        _ => Err("unexpected subscribe ack".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty_daemon;

    /// Serve a real daemon state on a temp socket inside this process — the
    /// client transport doesn't care that it isn't a separate process.
    fn start_server(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "klide-ptyc-{name}-{}-{}",
            std::process::id(),
            crate::pty_host::now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let listener = pty_daemon::bind_socket(&dir).expect("bind");
        let state = pty_daemon::test_state(dir.clone());
        std::thread::spawn(move || pty_daemon::serve(listener, state));
        dir
    }

    #[test]
    fn request_round_trips_through_the_socket() {
        let dir = start_server("roundtrip");
        match request(&dir, &Request::Ping) {
            Ok(Response::Pong { version, .. }) => {
                assert_eq!(version, env!("CARGO_PKG_VERSION"))
            }
            other => panic!("expected pong, got {other:?}"),
        }
        let _ = std::fs::remove_file(crate::pty_daemon::socket_path(&dir));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn request_fails_fast_when_no_daemon_listens() {
        let dir = std::env::temp_dir().join(format!(
            "klide-ptyc-none-{}-{}",
            std::process::id(),
            crate::pty_host::now_ms()
        ));
        let err = request(&dir, &Request::Ping).expect_err("no daemon");
        assert!(err.starts_with("connect:"), "{err}");
    }

    #[test]
    fn subscribe_acks_and_hands_back_the_stream() {
        let dir = start_server("subscribe");
        let reader = subscribe(&dir).expect("subscribed");
        // The ack was consumed; the stream is now event-only and open.
        assert!(reader.get_ref().peer_addr().is_ok());
        let _ = std::fs::remove_file(crate::pty_daemon::socket_path(&dir));
        let _ = std::fs::remove_dir_all(dir);
    }
}
