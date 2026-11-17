//! Authenticated connections to a Run host. SSH carries the same wire as a
//! local socket; its relay reads the token on the destination, never the Mac.
use crate::pty_wire::Request;
use std::io::{self, Read, Write};
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

pub(crate) trait Transport {
    fn connect(&self) -> Result<Connection, String>;
}

pub(crate) struct Local<'a>(pub &'a Path);

impl Transport for Local<'_> {
    fn connect(&self) -> Result<Connection, String> {
        let stream = UnixStream::connect(crate::pty_daemon::socket_path(self.0))
            .map_err(|e| format!("connect: {e}"))?;
        let mut connection = Connection::new(stream, None, Duration::from_secs(5))?;
        let token = std::fs::read_to_string(crate::pty_daemon::token_path(self.0))
            .map_err(|e| format!("connect: no ptyd token: {e}"))?;
        let auth = serde_json::to_string(&Request::Auth {
            token: token.trim().into(),
        })
        .map_err(|e| e.to_string())?;
        writeln!(connection, "{auth}").map_err(|e| format!("send auth: {e}"))?;
        Ok(connection)
    }
}

pub(crate) struct Ssh<'a> {
    pub host: &'a str,
    pub binary: &'a str,
    pub data_dir: &'a str,
}

impl Ssh<'_> {
    fn command(&self) -> Result<Command, String> {
        // Keep even direct diagnostic calls from interpreting a host as an
        // SSH option. Paths are shell words on the remote side only.
        if self.host.is_empty()
            || self.host.starts_with('-')
            || !self
                .host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-@:[]".contains(c))
        {
            return Err("Invalid SSH host: use an alias or user@hostname".into());
        }
        if self.binary.is_empty() || self.data_dir.is_empty() {
            return Err("Remote binary and data directory are required".into());
        }
        let remote = format!(
            "export PATH=\"$HOME/.local/bin:$PATH\"; exec {} ptyd connect --ensure --data-dir {}",
            crate::machines::remote_path_word(self.binary),
            crate::machines::remote_path_word(self.data_dir)
        );
        let mut command = Command::new("ssh");
        command.args(crate::machines::SSH_OPTS).args([
            "-o",
            "StrictHostKeyChecking=yes",
            "-T",
            "--",
            self.host,
            &remote,
        ]);
        Ok(command)
    }
}

impl Transport for Ssh<'_> {
    fn connect(&self) -> Result<Connection, String> {
        Connection::child(self.command()?, Duration::from_secs(15))
    }
}

/// A socket pair makes child stdio obey the same timeouts as a Unix socket.
/// Owning the SSH child here also means failed handshakes and dropped event
/// readers cannot leave SSH processes behind. Killing this child only closes
/// the relay; the daemon and its Runs are independent processes.
pub(crate) struct Connection {
    stream: UnixStream,
    child: Option<Child>,
}

impl Connection {
    fn new(stream: UnixStream, child: Option<Child>, timeout: Duration) -> Result<Self, String> {
        let connection = Self { stream, child };
        connection
            .stream
            .set_read_timeout(Some(timeout))
            .map_err(|e| e.to_string())?;
        connection
            .stream
            .set_write_timeout(Some(timeout))
            .map_err(|e| e.to_string())?;
        Ok(connection)
    }

    pub(super) fn child(mut command: Command, timeout: Duration) -> Result<Self, String> {
        let (stream, peer) = UnixStream::pair().map_err(|e| format!("connect: {e}"))?;
        let input: OwnedFd = peer.try_clone().map_err(|e| e.to_string())?.into();
        let output: OwnedFd = peer.into();
        let child = command
            .stdin(Stdio::from(input))
            .stdout(Stdio::from(output))
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("connect: ssh: {e}"))?;
        Self::new(stream, Some(child), timeout)
    }

    pub(crate) fn streaming(&self) -> Result<(), String> {
        self.stream
            .set_read_timeout(None)
            .map_err(|e| e.to_string())
    }
}

impl Read for Connection {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.stream.read(bytes)
    }
}

impl Write for Connection {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.stream.write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.stream.flush()
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        let _ = self.stream.shutdown(std::net::Shutdown::Both);
        if let Some(child) = &mut self.child {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Forward an authenticated local socket to this SSH session's stdio. No
/// daemon is launched or replaced here: a missing host must fail explicitly.
pub(crate) fn relay(data_dir: &Path) -> Result<(), String> {
    let connection = Local(data_dir).connect()?;
    relay_io(connection, io::stdin(), &mut io::stdout().lock())
}

fn relay_io(
    connection: Connection,
    mut source: impl Read + Send + 'static,
    target: &mut impl Write,
) -> Result<(), String> {
    let mut input = connection.stream.try_clone().map_err(|e| e.to_string())?;
    input.set_write_timeout(None).map_err(|e| e.to_string())?;
    connection.streaming()?;
    std::thread::spawn(move || {
        let _ = io::copy(&mut source, &mut input);
        // Preserve replies already in flight when stdin closes. The daemon
        // also watches this EOF to remove event subscriptions.
        let _ = input.shutdown(std::net::Shutdown::Write);
    });
    io::copy(&mut &connection.stream, target).map_err(|e| format!("relay: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty_wire::Response;
    use std::io::{BufRead, BufReader};

    struct ChildTransport(&'static str, Duration);
    impl Transport for ChildTransport {
        fn connect(&self) -> Result<Connection, String> {
            let mut command = Command::new("sh");
            command.args(["-c", self.0]);
            Connection::child(command, self.1)
        }
    }

    #[test]
    fn requests_and_subscriptions_use_child_stdio_without_local_auth() {
        let transport = ChildTransport(
            "IFS= read -r line; case $line in *ping*) printf '%s\\n' '{\"type\":\"pong\",\"version\":\"test\",\"protocol\":2,\"pid\":42,\"build\":\"test\"}';; *) exit 1;; esac",
            Duration::from_secs(2),
        );
        assert!(matches!(
            crate::pty_client::request_on(&transport, &Request::Ping),
            Ok(Response::Pong { pid: 42, .. })
        ));
        let transport = ChildTransport(
            "IFS= read -r line; case $line in *subscribe*) printf '%s\\n' '{\"type\":\"subscribed\"}' '{\"type\":\"test_event\"}';; *) exit 1;; esac",
            Duration::from_secs(2),
        );
        let mut reader = crate::pty_client::subscribe_on(&transport).unwrap();
        let mut event = String::new();
        reader.read_line(&mut event).unwrap();
        assert_eq!(event.trim(), "{\"type\":\"test_event\"}");
    }

    #[test]
    fn stalled_child_times_out_and_is_reaped_on_drop() {
        let transport = ChildTransport("exec sleep 30", Duration::from_millis(100));
        let start = std::time::Instant::now();
        assert!(crate::pty_client::request_on(&transport, &Request::Ping)
            .unwrap_err()
            .starts_with("recv:"));
        assert!(start.elapsed() < Duration::from_secs(5));
        let mut connection = transport.connect().unwrap();
        let mut child = connection.child.take().unwrap();
        assert!(child.try_wait().unwrap().is_none());
        connection.child = Some(child);
        // Drop must wait for the child: no zombie or hanging SSH after detach.
        drop(connection);
    }

    #[test]
    fn relay_authenticates_on_host_and_disconnect_does_not_stop_daemon() {
        let dir = std::env::temp_dir().join(format!(
            "klide-relay-{}-{}",
            std::process::id(),
            crate::pty_host::now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let listener = crate::pty_daemon::bind_socket(&dir).unwrap();
        let state = crate::pty_daemon::test_state(dir.clone());
        std::thread::spawn(move || crate::pty_daemon::serve(listener, state));
        let (mut client, relay) = UnixStream::pair().unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let connection = Local(&dir).connect().unwrap();
        let source = relay.try_clone().unwrap();
        let thread = std::thread::spawn(move || relay_io(connection, source, &mut &relay));
        // Only Ping goes over this channel; the relay supplies Auth locally.
        writeln!(client, "{{\"type\":\"ping\"}}").unwrap();
        let mut reader = BufReader::new(client);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert!(matches!(
            serde_json::from_str::<Response>(&line),
            Ok(Response::Pong { .. })
        ));
        let spawn = Request::Spawn {
            session_id: "relay-survival".into(),
            provider: "custom".into(),
            cwd: None,
            command: "sleep 30".into(),
            env: vec![],
            task: None,
            model: None,
            resume_session_id: None,
            mission_link: None,
            detect_session_id: false,
            coord_secret_sha256: None,
        };
        writeln!(
            reader.get_mut(),
            "{}",
            serde_json::to_string(&spawn).unwrap()
        )
        .unwrap();
        line.clear();
        reader.read_line(&mut line).unwrap();
        assert!(
            matches!(serde_json::from_str::<Response>(&line), Ok(Response::Ok)),
            "{line}"
        );
        reader.get_ref().shutdown(std::net::Shutdown::Both).unwrap();
        thread.join().unwrap().unwrap();
        // A live session must survive closing the relay, not just the daemon.
        match crate::pty_client::request(&dir, &Request::LiveRows).unwrap() {
            Response::LiveRows { rows } => {
                assert!(rows.iter().any(|r| r.session_id == "relay-survival"))
            }
            other => panic!("expected live rows: {other:?}"),
        }
        assert!(matches!(
            crate::pty_client::request(
                &dir,
                &Request::Stop {
                    session_id: "relay-survival".into()
                }
            ),
            Ok(Response::Ok)
        ));

        // Piped requests may close stdin before their reply arrives. Their
        // half-close must drain stdout, including the final response.
        let mut reply = Vec::new();
        relay_io(
            Local(&dir).connect().unwrap(),
            io::Cursor::new(b"{\"type\":\"ping\"}\n"),
            &mut reply,
        )
        .unwrap();
        assert!(matches!(
            serde_json::from_slice::<Response>(&reply),
            Ok(Response::Pong { .. })
        ));
        let _ = std::fs::remove_file(crate::pty_daemon::socket_path(&dir));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn ssh_uses_no_tty_or_prompts_and_quotes_remote_paths() {
        let ssh = Ssh {
            host: "klide-box",
            binary: "~/bin/it's klide",
            data_dir: "~/data/$(touch nope)",
        };
        let command = ssh.command().unwrap();
        let args: Vec<_> = command.get_args().map(|a| a.to_str().unwrap()).collect();
        assert!(args.contains(&"-T"));
        assert!(args.contains(&"BatchMode=yes"));
        assert!(args.contains(&"StrictHostKeyChecking=yes"));
        let mut shell = Command::new("sh");
        // Replace exec with a shell function to inspect the remote argv,
        // without executing a path or expanding shell metacharacters in it.
        shell.args([
            "-c",
            &format!(
                "capture() {{ for arg; do printf '%s\\n' \"$arg\"; done; }}; {}",
                args.last().unwrap().replacen("exec ", "capture ", 1)
            ),
        ]);
        let output = shell.output().unwrap();
        assert!(output.status.success());
        let home = std::env::var("HOME").unwrap();
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!(
                "{home}/bin/it's klide\nptyd\nconnect\n--ensure\n--data-dir\n{home}/data/$(touch nope)\n"
            )
        );
        assert!(Ssh {
            host: "-oProxyCommand=oops",
            ..ssh
        }
        .command()
        .is_err());
    }
}
