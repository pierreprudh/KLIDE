//! App-side client for the `klide ptyd` daemon (Slice 3c of
//! docs/delegate-session-replay.md). Framing and local host lifecycle: connect
//! through `pty_transport`, start a local daemon when needed, one round-trip
//! per call, and the subscribe upgrade. What to DO with responses and events
//! stays in pty.rs, next to the in-process host it mirrors.

use crate::pty_wire::{Request, Response};
use std::io::BufRead;
use std::path::Path;

use crate::pty_transport::{Local, Transport};
use std::io::{BufReader, Write};
use std::time::Duration;

/// One request → one response over a fresh authenticated connection.
pub fn request(data_dir: &Path, request: &Request) -> Result<Response, String> {
    request_on(&Local(data_dir), request)
}

pub(crate) fn request_on(transport: &impl Transport, request: &Request) -> Result<Response, String> {
    let mut connection = transport.connect()?;
    let line = serde_json::to_string(request).map_err(|e| e.to_string())?;
    writeln!(connection, "{line}").map_err(|e| format!("send: {e}"))?;
    let mut reply = String::new();
    BufReader::new(connection)
        .read_line(&mut reply)
        .map_err(|e| format!("recv: {e}"))?;
    serde_json::from_str(&reply).map_err(|e| format!("bad response: {e}"))
}

/// All locations are stable across desktop restarts. The companion is used
/// when a legacy terminal host cannot speak the chat protocol; scheduled Runs
/// have a dedicated persistent host. Locate existing Runs across all three
/// before starting or controlling a turn.
pub(crate) fn chat_host_dirs(data_dir: &Path) -> [std::path::PathBuf; 3] {
    [data_dir.to_path_buf(), data_dir.join("chat-host"), data_dir.join("scheduled-host")]
}

/// `strict` also requires the very same binary. Chats need it: the daemon
/// runs their Harness loop, and a rebuild keeps the package version. Terminals
/// only need the wire, and must not be refused after every dev rebuild.
fn compatible(version: &str, protocol: u32, build: &str, strict: bool) -> bool {
    version == env!("CARGO_PKG_VERSION")
        && protocol == crate::pty_wire::PROTOCOL_VERSION
        && (!strict || build == crate::pty_wire::build_id())
}

pub(crate) fn chat_host_dir(data_dir: &Path) -> Result<std::path::PathBuf, String> {
    select_chat_host(data_dir, |dir| request(dir, &Request::Ping))
}

fn select_chat_host(
    data_dir: &Path,
    ping: impl Fn(&Path) -> Result<Response, String>,
) -> Result<std::path::PathBuf, String> {
    let [primary, companion, _scheduled] = chat_host_dirs(data_dir);
    // Keep using an already-launched companion, including after its terminal
    // predecessor goes away. ensure_daemon still validates compatibility.
    match ping(&companion) {
        Ok(Response::Pong { .. }) => return Ok(companion),
        Err(error) if error.starts_with("connect:") => {},
        Err(error) => return Err(error),
        Ok(Response::Err { message }) => return Err(message),
        _ => return Err("Unexpected response from the background chat host".into()),
    }
    match ping(&primary) {
        Ok(Response::Pong { version, protocol, build, .. }) if compatible(&version, protocol, &build, true) => Ok(primary),
        // Never stop or upgrade the old host to start a chat. It may still own
        // terminals, even when its LiveRows shape is too old for us to decode.
        Ok(Response::Pong { .. }) => Ok(companion),
        Err(error) if error.starts_with("connect:") => Ok(primary),
        Err(error) => Err(error),
        Ok(Response::Err { message }) => Err(message),
        _ => Err("Unexpected response from the background host".into()),
    }
}

/// Ensure a compatible daemon is serving. An idle older host is replaced;
/// an older host with active work is left running and the new start is refused.
/// Both the package version and protocol revision participate in compatibility.
pub fn ensure_daemon(data_dir: &Path) -> Result<(), String> {
    ensure(data_dir, false)
}

/// [`ensure_daemon`] for a background chat host: the same binary as this app.
pub fn ensure_chat_daemon(data_dir: &Path) -> Result<(), String> {
    ensure(data_dir, true)
}

fn ensure(data_dir: &Path, strict: bool) -> Result<(), String> {
    match request(data_dir, &Request::Ping) {
        Ok(Response::Pong { version, protocol, build, .. })
            if compatible(&version, protocol, &build, strict) => return Ok(()),
        Ok(Response::Pong { version, protocol, .. }) => {
            // An upgrade must never kill work merely to obtain a newer wire.
            match request(data_dir, &Request::LiveRows) {
                Ok(Response::LiveRows { rows }) if rows.is_empty() => {},
                _ => return Err("The background host needs an update. Finish its active terminal sessions before starting a new background chat.".into()),
            }
            if protocol >= 2 && !matches!(request(data_dir, &Request::ChatList), Ok(Response::ChatList { runs }) if runs.is_empty()) {
                return Err("The background host needs an update. Finish its active conversations first.".into());
            }
            let _ = request(data_dir, &Request::Shutdown);
            eprintln!(
                "ptyd: replacing v{version} with v{}",
                env!("CARGO_PKG_VERSION")
            );
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
        if matches!(request(data_dir, &Request::Ping), Ok(Response::Pong { version, protocol, build, .. }) if compatible(&version, protocol, &build, strict)) {
            return Ok(());
        }
        delay *= 2;
    }
    Err("ptyd did not come up".to_string())
}

/// Launch `klide ptyd` detached: own process group so a Ctrl-C aimed at a
/// terminal-launched dev app doesn't take the daemon (and its sessions) down
/// with it, and no inherited stdio so it cannot hold the app's pipes open.
#[cfg(unix)]
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

#[cfg(windows)]
fn spawn_daemon(data_dir: &Path) -> Result<(),String> {
    use std::os::windows::process::CommandExt;
    // Modern Windows OpenSSH permits job breakaway. Refuse rather than
    // silently start a host that will die with the SSH session if it does not.
    std::process::Command::new(std::env::current_exe().map_err(|e|e.to_string())?)
        .arg("ptyd").arg("--data-dir").arg(data_dir)
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .creation_flags(0x01000000 | 0x00000200 | 0x00000008)
        .spawn().map_err(|e|format!("Cannot detach the Run host from Windows OpenSSH. Ensure the SSH server allows job breakaway: {e}"))?;
    Ok(())
}

/// Open the event stream: a connection upgraded with `subscribe`, handed back
/// as a line reader once the daemon acks. The caller owns the read loop; EOF
/// or an error there means "reconnect if you still care".
pub fn subscribe(data_dir: &Path) -> Result<Box<dyn BufRead + Send>, String> {
    subscribe_on(&Local(data_dir))
}

pub(crate) fn subscribe_on(transport: &impl Transport) -> Result<Box<dyn BufRead + Send>, String> {
    let mut connection = transport.connect()?;
    let line = serde_json::to_string(&Request::Subscribe).map_err(|e| e.to_string())?;
    writeln!(connection, "{line}").map_err(|e| format!("send: {e}"))?;
    let mut reader = BufReader::new(connection);
    let mut ack = String::new();
    reader.read_line(&mut ack).map_err(|e| format!("recv: {e}"))?;
    match serde_json::from_str::<Response>(&ack) {
        Ok(Response::Subscribed) => {
            // Events are pushed at the session's pace — an idle session may be
            // silent for hours. No read timeout from here on.
            reader.get_ref().streaming()?;
            Ok(Box::new(reader))
        }
        Ok(Response::Err { message }) => Err(message),
        _ => Err("unexpected subscribe ack".to_string()),
    }
}

#[cfg(all(unix, test))]
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
    fn chat_host_selection_bypasses_a_legacy_terminal_host() {
        let base = Path::new("/test/klide");
        let selected = select_chat_host(base, |dir| {
            if dir == base {
                // The pre-chat daemon's Ping has no protocol field on the wire.
                Ok(Response::Pong { version: env!("CARGO_PKG_VERSION").into(), protocol: 0, pid: 1, build: String::new() })
            } else { Err("connect: no socket".into()) }
        }).unwrap();
        assert_eq!(selected, base.join("chat-host"));
    }

    #[test]
    fn chat_host_selection_reuses_fresh_and_compatible_hosts() {
        let base = Path::new("/test/klide");
        for present in [false, true] {
            let selected = select_chat_host(base, |dir| {
                if present && dir == base {
                    Ok(Response::Pong { version: env!("CARGO_PKG_VERSION").into(), protocol: crate::pty_wire::PROTOCOL_VERSION, pid: 1, build: crate::pty_wire::build_id().into() })
                } else { Err("connect: no socket".into()) }
            }).unwrap();
            assert_eq!(selected, base);
        }
    }

    #[test]
    fn chat_host_selection_keeps_the_companion_after_the_old_host_exits() {
        let base = Path::new("/test/klide");
        let selected = select_chat_host(base, |dir| {
            assert_eq!(dir, base.join("chat-host"));
            Ok(Response::Pong { version: env!("CARGO_PKG_VERSION").into(), protocol: crate::pty_wire::PROTOCOL_VERSION, pid: 2, build: crate::pty_wire::build_id().into() })
        }).unwrap();
        assert_eq!(selected, base.join("chat-host"));
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
        // `subscribe` returns only after the daemon's `Subscribed` ack has been
        // read off the connection, so success here *is* the ack. The reader is
        // boxed as `dyn BufRead` so the same signature can carry a
        // `cfg(not(unix))` stub — what arrives on the stream from here on is
        // covered end to end by `pty_daemon`'s
        // `spawn_streams_chunks_to_subscribers`.
        let reader = subscribe(&dir).expect("subscribed");

        // The first subscriber must not wedge the server: a second connection
        // still gets served.
        let second = subscribe(&dir).expect("a second subscriber is accepted");

        drop(reader);
        drop(second);
        let _ = std::fs::remove_file(crate::pty_daemon::socket_path(&dir));
        let _ = std::fs::remove_dir_all(dir);
    }
}

