//! One process module for every command a Run starts — foreground or
//! background.
//!
//! Before this, the two paths each owned half the answer. A foreground
//! `run_command` sat on `wait_with_output`, which buffers without a bound,
//! waits for *every* holder of the pipes (a backgrounded grandchild kept a
//! finished command "running" until the timer), and never looked at the Run's
//! cancellation — Stop did nothing until the command ended on its own. The
//! background registry killed process groups, but forked `/bin/kill` to do it
//! and gated the exit on the pipe readers, so a grandchild that escaped the
//! group held the shell at "still running" forever.
//!
//! Here there is one lifecycle:
//!
//! - `spawn` starts `sh -c` in its own process group (unix) with stdin closed.
//! - Output lands in bounded rings — the oldest bytes go, and how many is
//!   counted, never silently lost.
//! - Exit is recorded from `wait()` on the leader, not from the pipes closing.
//!   The readers get [`DRAIN_DEADLINE`] to hand over what the command already
//!   wrote; past it they are abandoned, and whatever is still in the group is
//!   killed. The exit is published either way.
//! - `wait_until` is the foreground door: it returns on exit, on the timer, or
//!   on the Run's cancellation, and the last two stop the process first.
//! - The group is only ever signalled while its leader is unreaped (or, after
//!   the drain, only while a probe says the group still exists), so a pid the
//!   kernel has recycled is never the one hit.
//!
//! Tauri-free on purpose, like `background.rs` above it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::sync::{oneshot, watch};
use tokio_util::sync::CancellationToken;

/// How long the pipe readers may keep going after the leader exits. Long
/// enough for a finished command's last write to land; short enough that a
/// grandchild holding the pipe open cannot keep the command "running".
pub const DRAIN_DEADLINE: Duration = Duration::from_secs(1);

/// How the output is kept.
#[derive(Clone, Copy, Debug)]
pub enum Capture {
    /// stdout and stderr interleaved into one ring, in arrival order — what a
    /// background shell's log is.
    Merged { cap: usize },
    /// Two rings, so a foreground result can keep printing stderr under its
    /// own heading.
    Split { cap_each: usize },
}

pub struct SpawnSpec<'a> {
    pub command: &'a str,
    pub cwd: &'a std::path::Path,
    pub capture: Capture,
    /// What the command may write and reach. `None` runs it with the app's
    /// own reach, as every command did before `sandbox.rs`.
    pub sandbox: Option<&'a super::sandbox::Sandbox>,
}

/// How a process ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exit {
    Code(i32),
    /// Ended on a signal — including the one a kill sent — or the wait itself
    /// failed, which leaves no code to report.
    Signalled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Finished {
    pub exit: Exit,
    pub ended_ms: u64,
}

/// What `wait_until` saw first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Waited {
    Exited(Finished),
    /// The timer ran out; the process was stopped before this returned.
    TimedOut,
    /// The Run was cancelled; the process was stopped before this returned.
    Cancelled,
}

/// A bounded byte log with absolute offsets, so a reader can tell "nothing
/// new" from "what you had not read yet aged out".
pub struct Ring {
    cap: usize,
    /// Everything still held, oldest first.
    buffer: String,
    /// Absolute byte offset of `buffer[0]` — i.e. how much was dropped.
    start: u64,
}

impl Ring {
    fn new(cap: usize) -> Self {
        Ring { cap, buffer: String::new(), start: 0 }
    }

    pub fn push(&mut self, text: &str) {
        self.buffer.push_str(text);
        if self.buffer.len() > self.cap {
            let overflow = self.buffer.len() - self.cap;
            // Drop whole characters — a String sliced mid-codepoint panics.
            let cut = (overflow..self.buffer.len())
                .find(|i| self.buffer.is_char_boundary(*i))
                .unwrap_or(self.buffer.len());
            self.buffer.drain(..cut);
            self.start += cut as u64;
        }
    }

    /// Bytes that aged out of the ring.
    pub fn dropped(&self) -> u64 {
        self.start
    }

    /// Absolute offset one past the newest byte.
    pub fn end(&self) -> u64 {
        self.start + self.buffer.len() as u64
    }

    /// Everything from `cursor` on, how much of what `cursor` still owed had
    /// already aged out, and the cursor to pass next time.
    pub fn since(&self, cursor: u64) -> (String, u64, u64) {
        let dropped = self.start.saturating_sub(cursor);
        let from = (cursor.max(self.start) - self.start) as usize;
        let mut from = from.min(self.buffer.len());
        while !self.buffer.is_char_boundary(from) {
            from += 1;
        }
        (self.buffer[from..].to_string(), dropped, self.end())
    }

    /// The newest `max_bytes` (snapped forward to a character), and how many
    /// bytes of the whole stream come before it.
    pub fn tail(&self, max_bytes: usize) -> (String, u64) {
        let mut from = self.buffer.len().saturating_sub(max_bytes);
        while !self.buffer.is_char_boundary(from) {
            from += 1;
        }
        (self.buffer[from..].to_string(), self.start + from as u64)
    }

    pub fn text(&self) -> &str {
        &self.buffer
    }
}

struct Rings {
    out: Ring,
    /// `None` when capture is merged: stderr goes to `out`.
    err: Option<Ring>,
}

/// One captured stream as a foreground result formats it.
pub struct Captured {
    pub text: String,
    pub dropped: u64,
}

/// A started command. Dropping it stops the process if it is still running —
/// the owner holds the lifetime, not a future somebody may drop.
pub struct ProcessHandle {
    pid: Option<u32>,
    rings: Arc<Mutex<Rings>>,
    exit: watch::Receiver<Option<Finished>>,
    leader_reaped: Arc<AtomicBool>,
    kill_tx: Mutex<Option<oneshot::Sender<()>>>,
}

/// Start `spec.command` under `sh -c` and return at once; the reader and
/// waiter tasks outlive the call.
///
/// The caller has already put the command through the permission gate — this
/// starts a process and asks nothing. Must be called inside a tokio runtime.
pub fn spawn(spec: SpawnSpec<'_>) -> Result<ProcessHandle, String> {
    spawn_with_setup_env(spec, None, &[])
}

/// A command in the Run's usual environment plus a few values of the
/// caller's — how a project hook learns which tool call it is about.
pub(super) fn spawn_with_env(spec: SpawnSpec<'_>, extra: &[(String, String)]) -> Result<ProcessHandle, String> {
    spawn_with_setup_env(spec, None, extra)
}

/// Approved worktree setup keeps its login shell and recipe environment,
/// while sharing command cancellation, process-group cleanup and bounded logs.
pub(super) fn spawn_setup(spec: SpawnSpec<'_>, envs: &[(String, String)]) -> Result<ProcessHandle, String> {
    spawn_with_setup_env(spec, Some(envs), &[])
}

fn spawn_with_setup_env(spec: SpawnSpec<'_>, envs: Option<&[(String, String)]>, extra: &[(String, String)]) -> Result<ProcessHandle, String> {
    let shell = if envs.is_some() {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
    } else { "sh".into() };
    // The sandbox goes around the shell, so everything the command starts
    // inherits it — a child cannot leave a Seatbelt profile.
    let mut cmd = match spec.sandbox.and_then(|sandbox| sandbox.wrap(&shell)) {
        Some((program, args)) => {
            let mut cmd = tokio::process::Command::new(program);
            cmd.args(args);
            cmd
        }
        None => tokio::process::Command::new(&shell),
    };
    if let Some(envs) = envs {
        cmd.arg("-l").envs(envs.iter().cloned());
    } else {
        cmd.env_clear().envs(super::command_env::env_for(spec.cwd));
    }
    cmd.envs(extra.iter().cloned());
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd
        .arg("-c")
        .arg(spec.command)
        .current_dir(spec.cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // Backstop for a runtime torn down under the waiter: at least sh dies.
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to start command: {e}"))?;

    let rings = Arc::new(Mutex::new(match spec.capture {
        Capture::Merged { cap } => Rings { out: Ring::new(cap), err: None },
        Capture::Split { cap_each } => Rings {
            out: Ring::new(cap_each),
            err: Some(Ring::new(cap_each)),
        },
    }));
    let stdout = child.stdout.take().map(|out| pump(out, rings.clone(), false));
    let stderr = child.stderr.take().map(|err| pump(err, rings.clone(), true));
    let pid = child.id();

    let (exit_tx, exit_rx) = watch::channel(None);
    let (kill_tx, kill_rx) = oneshot::channel::<()>();
    let leader_reaped = Arc::new(AtomicBool::new(false));
    let reaped = leader_reaped.clone();
    tokio::spawn(async move {
        let status = tokio::select! {
            settled = child.wait() => settled.ok(),
            // An explicit kill, or the handle dropping its sender.
            _ = kill_rx => {
                // The leader is not reaped yet (we are still waiting on it), so
                // its pid is still the group's id and still ours.
                kill_group(pid);
                let _ = child.start_kill();
                child.wait().await.ok()
            }
        };
        reaped.store(true, Ordering::SeqCst);

        // Let the readers hand over what was already written — but only for so
        // long. A grandchild holding the pipe must not hold the exit.
        let mut readers: Vec<tokio::task::JoinHandle<()>> =
            stdout.into_iter().chain(stderr).collect();
        let joined = tokio::time::timeout(DRAIN_DEADLINE, async {
            for reader in readers.iter_mut() {
                let _ = reader.await;
            }
        })
        .await;
        if joined.is_err() {
            for reader in &readers {
                reader.abort();
            }
        }
        // Descendants left in the group (a `cmd &` that outlived sh) go with
        // the command. The probe keeps this from signalling a group id that no
        // longer exists — and so one that could have been handed out again.
        if group_exists(pid) {
            kill_group(pid);
        }

        let exit = match status.and_then(|s| s.code()) {
            Some(code) => Exit::Code(code),
            None => Exit::Signalled,
        };
        let _ = exit_tx.send(Some(Finished { exit, ended_ms: now_ms() }));
    });

    Ok(ProcessHandle {
        pid,
        rings,
        exit: exit_rx,
        leader_reaped,
        kill_tx: Mutex::new(Some(kill_tx)),
    })
}

impl ProcessHandle {
    #[allow(dead_code)]
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// Ask the waiter to stop the process. Idempotent; a no-op once it ended.
    pub fn request_kill(&self) {
        if let Some(tx) = self.kill_tx.lock().ok().and_then(|mut tx| tx.take()) {
            let _ = tx.send(());
        }
    }

    /// `Some` once the exit is published (after the drain).
    pub fn finished(&self) -> Option<Finished> {
        *self.exit.borrow()
    }

    /// Wait for the exit, the timer, or the cancellation — whichever is first.
    /// The last two stop the process and wait for its exit before returning,
    /// so nothing the caller started is still running afterwards.
    pub async fn wait_until(&self, timeout: Duration, cancel: &CancellationToken) -> Waited {
        let mut exit = self.exit.clone();
        let stopped = tokio::select! {
            finished = exit.wait_for(|f| f.is_some()) => {
                return match finished {
                    Ok(f) => Waited::Exited(f.expect("wait_for guarantees Some")),
                    // The waiter vanished without publishing: the runtime is
                    // going down. Nothing is left to report.
                    Err(_) => Waited::Exited(Finished { exit: Exit::Signalled, ended_ms: now_ms() }),
                };
            }
            _ = tokio::time::sleep(timeout) => Waited::TimedOut,
            _ = cancel.cancelled() => Waited::Cancelled,
        };
        self.request_kill();
        let _ = exit.wait_for(|f| f.is_some()).await;
        stopped
    }

    /// The merged log (or stdout, when split) from `cursor` on — see
    /// [`Ring::since`].
    pub fn read_since(&self, cursor: u64) -> (String, u64, u64) {
        match self.rings.lock() {
            Ok(rings) => rings.out.since(cursor),
            Err(_) => (String::new(), 0, cursor),
        }
    }

    /// The newest `max_bytes` of the merged log (or stdout) — see [`Ring::tail`].
    pub fn tail(&self, max_bytes: usize) -> (String, u64) {
        match self.rings.lock() {
            Ok(rings) => rings.out.tail(max_bytes),
            Err(_) => (String::new(), 0),
        }
    }

    /// Release acknowledged output while preserving absolute reader offsets.
    pub fn clear_output(&self) {
        if let Ok(mut rings) = self.rings.lock() {
            let clear = |ring: &mut Ring| {
                ring.start = ring.end();
                ring.buffer.clear();
            };
            clear(&mut rings.out);
            if let Some(err) = rings.err.as_mut() { clear(err); }
        }
    }

    /// stdout and stderr as captured. Under merged capture stderr is empty.
    pub fn split_output(&self) -> (Captured, Captured) {
        let Ok(rings) = self.rings.lock() else {
            let empty = || Captured { text: String::new(), dropped: 0 };
            return (empty(), empty());
        };
        let take = |ring: &Ring| Captured { text: ring.text().to_string(), dropped: ring.dropped() };
        let out = take(&rings.out);
        let err = rings.err.as_ref().map(take).unwrap_or(Captured { text: String::new(), dropped: 0 });
        (out, err)
    }

    /// App-exit path: signal the group directly, without the waiter — the
    /// runtime may never poll it again. Skipped once the leader is reaped, when
    /// the group id may already belong to somebody else.
    pub fn kill_group_if_unreaped(&self) {
        if !self.leader_reaped.load(Ordering::SeqCst) {
            kill_group(self.pid);
        }
    }

    /// Feed the log directly — lets a test reach the overflow path without
    /// generating megabytes of output.
    #[cfg(test)]
    pub fn push_for_test(&self, text: &str) {
        self.rings.lock().unwrap().out.push(text);
    }
}

impl Drop for ProcessHandle {
    fn drop(&mut self) {
        self.request_kill();
    }
}

fn pump<R>(mut reader: R, rings: Arc<Mutex<Rings>>, is_stderr: bool) -> tokio::task::JoinHandle<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut chunk = [0u8; 4096];
        // Retain incomplete UTF-8 across reads without retaining unbounded lines.
        let mut pending = Vec::new();
        loop {
            let n = reader.read(&mut chunk).await.unwrap_or(0);
            pending.extend_from_slice(&chunk[..n]);
            let keep = match std::str::from_utf8(&pending) {
                Err(e) if e.error_len().is_none() && n > 0 => pending.len() - e.valid_up_to(),
                _ => 0,
            };
            let end = pending.len() - keep;
            if end > 0 {
                let Ok(mut rings) = rings.lock() else { return };
                let text = String::from_utf8_lossy(&pending[..end]);
                match (is_stderr, rings.err.as_mut()) {
                    (true, Some(err)) => err.push(&text),
                    _ => rings.out.push(&text),
                }
                pending.drain(..end);
            }
            if n == 0 {
                break;
            }
        }
    })
}

/// SIGKILL the whole group led by `pid`. A direct syscall — no fork of
/// `/bin/kill` per stop.
fn kill_group(pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pid) = pid.and_then(|p| i32::try_from(p).ok()).filter(|p| *p > 0) {
        // SAFETY: kill(2) takes plain integers and touches no memory of ours.
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    let _ = pid;
}

/// Whether any process is still in the group led by `pid` (signal 0 probes
/// without delivering anything).
fn group_exists(pid: Option<u32>) -> bool {
    #[cfg(unix)]
    if let Some(pid) = pid.and_then(|p| i32::try_from(p).ok()).filter(|p| *p > 0) {
        // SAFETY: as above.
        return unsafe { libc::kill(-pid, 0) } == 0;
    }
    let _ = pid;
    false
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    /// Every test's hard ceiling: a regression fails the test, it never hangs
    /// the suite.
    const HARD: Duration = Duration::from_secs(20);

    fn start(command: &str, capture: Capture) -> ProcessHandle {
        spawn(SpawnSpec { command, cwd: std::path::Path::new("."), capture, sandbox: None }).unwrap()
    }

    #[tokio::test]
    async fn clearing_acknowledged_output_preserves_reader_offsets() {
        let handle = start("printf hello; printf error >&2", Capture::Split { cap_each: 1024 });
        wait(&handle, Duration::from_secs(5), &CancellationToken::new()).await;
        let (_, _, cursor) = handle.read_since(0);
        assert_eq!(cursor, 5);
        handle.clear_output();
        assert_eq!(handle.read_since(cursor), (String::new(), 0, cursor));
        let (out, err) = handle.split_output();
        assert!(out.text.is_empty() && err.text.is_empty());
        assert_eq!((out.dropped, err.dropped), (5, 5));
    }

    #[cfg(target_os = "macos")]
    async fn run_sandboxed(command: &str, cwd: &std::path::Path, sandbox: &super::super::sandbox::Sandbox) -> (Exit, String) {
        let handle = spawn(SpawnSpec { command, cwd, capture: Capture::Merged { cap: 64 * 1024 }, sandbox: Some(sandbox) }).unwrap();
        wait(&handle, Duration::from_secs(15), &CancellationToken::new()).await;
        (handle.finished().expect("the command ended").exit, handle.tail(64 * 1024).0)
    }

    #[cfg(target_os = "macos")]
    fn sandbox_dirs(name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let base = std::env::temp_dir().join(format!("klide-sandbox-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (inside, outside) = (base.join("workspace"), base.join("elsewhere"));
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        (inside, outside)
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn a_sandboxed_command_writes_only_where_it_was_allowed() {
        if !super::super::sandbox::usable_here() {
            return;
        }
        let (inside, outside) = sandbox_dirs("writes");
        let sandbox = super::super::sandbox::Sandbox { writable: vec![inside.clone()], network: true, ..Default::default() };
        let escape = outside.join("escape.txt");
        // The child a command starts is inside the same profile.
        let command = format!(
            "echo kept > kept.txt && echo quiet > /dev/null && sh -c 'echo out > \"{}\"'",
            escape.display()
        );
        let (exit, output) = run_sandboxed(&command, &inside, &sandbox).await;
        assert_eq!(std::fs::read_to_string(inside.join("kept.txt")).unwrap(), "kept\n");
        assert!(!escape.exists(), "a write outside the allowed folder must not land");
        assert_ne!(exit, Exit::Code(0));
        assert!(output.contains("Operation not permitted"), "the denial is what the model reads: {output}");
        let _ = std::fs::remove_dir_all(inside.parent().unwrap());
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn the_same_command_without_a_sandbox_is_unchanged() {
        let (inside, outside) = sandbox_dirs("unsandboxed");
        let target = outside.join("written.txt");
        let handle = spawn(SpawnSpec {
            command: &format!("echo out > \"{}\"", target.display()),
            cwd: &inside,
            capture: Capture::Merged { cap: 1024 },
            sandbox: None,
        })
        .unwrap();
        wait(&handle, Duration::from_secs(15), &CancellationToken::new()).await;
        assert_eq!(handle.finished().unwrap().exit, Exit::Code(0));
        assert!(target.exists());
        let _ = std::fs::remove_dir_all(inside.parent().unwrap());
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn network_off_keeps_loopback_and_closes_the_rest() {
        if !super::super::sandbox::usable_here() {
            return;
        }
        let (inside, _) = sandbox_dirs("network");
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let sandbox = super::super::sandbox::Sandbox { writable: vec![inside.clone()], ..Default::default() };
        // `nc -z` only opens the connection. 192.0.2.1 is documentation
        // address space: with the network on, the attempt would sit out its
        // whole 8 s timer and never be refused at once — so a fast failure
        // here is the profile, not the route.
        let command = format!(
            "nc -z -w 8 127.0.0.1 {port} && echo loopback-open; nc -z -w 8 192.0.2.1 80 || echo outside-closed"
        );
        let started = Instant::now();
        let (_, output) = run_sandboxed(&command, &inside, &sandbox).await;
        assert!(output.contains("loopback-open"), "{output}");
        assert!(output.contains("outside-closed"), "{output}");
        assert!(started.elapsed() < Duration::from_secs(5), "a denial is immediate, a route failure waits out the timer");
        drop(listener);
        let _ = std::fs::remove_dir_all(inside.parent().unwrap());
    }

    async fn wait(handle: &ProcessHandle, timeout: Duration, cancel: &CancellationToken) -> Waited {
        tokio::time::timeout(HARD, handle.wait_until(timeout, cancel))
            .await
            .expect("wait_until must return well inside the hard ceiling")
    }

    #[cfg(unix)]
    fn alive(pid: u32) -> bool {
        // SAFETY: signal 0 probes only.
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    #[cfg(unix)]
    fn gone_or_zombie(pid: u32) -> bool {
        let out = std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
            .unwrap();
        let state = String::from_utf8_lossy(&out.stdout);
        state.trim().is_empty() || state.trim().starts_with('Z')
    }

    #[tokio::test]
    async fn exit_code_and_split_output_are_reported() {
        let handle = start("echo out; echo err 1>&2; exit 4", Capture::Split { cap_each: 1024 });
        let waited = wait(&handle, Duration::from_secs(10), &CancellationToken::new()).await;
        assert!(matches!(waited, Waited::Exited(Finished { exit: Exit::Code(4), .. })));
        let (out, err) = handle.split_output();
        assert_eq!(out.text.trim(), "out");
        assert_eq!(err.text.trim(), "err");
    }

    #[tokio::test]
    async fn cancel_mid_sleep_returns_promptly() {
        let handle = start("sleep 60", Capture::Split { cap_each: 1024 });
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            trigger.cancel();
        });
        let began = Instant::now();
        let waited = wait(&handle, Duration::from_secs(60), &cancel).await;
        assert_eq!(waited, Waited::Cancelled);
        assert!(began.elapsed() < Duration::from_secs(3), "Stop took {:?}", began.elapsed());
        assert!(handle.finished().is_some(), "a cancelled command is stopped, not abandoned");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_kills_grandchild() {
        let handle = start("sleep 30 & echo $!; wait", Capture::Split { cap_each: 1024 });
        let waited = wait(&handle, Duration::from_millis(500), &CancellationToken::new()).await;
        assert_eq!(waited, Waited::TimedOut);
        let pid: u32 = handle.split_output().0.text.trim().parse().expect("grandchild pid printed");
        for _ in 0..100 {
            if gone_or_zombie(pid) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("grandchild {pid} survived the timeout");
    }

    #[tokio::test]
    async fn output_is_bounded() {
        let cap = 1024 * 1024;
        let handle = start("yes | head -c 50000000", Capture::Split { cap_each: cap });
        let waited = wait(&handle, Duration::from_secs(15), &CancellationToken::new()).await;
        assert!(matches!(waited, Waited::Exited(Finished { exit: Exit::Code(0), .. })));
        let (out, _) = handle.split_output();
        assert!(out.text.len() <= cap, "ring held {} bytes", out.text.len());
        assert_eq!(out.dropped + out.text.len() as u64, 50_000_000, "every byte is kept or counted");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn exit_publishes_despite_grandchild_holding_stdout() {
        // perl leaves the group (the pause lets it get there before sh exits),
        // so no group kill reaches it, and it keeps the inherited stdout open
        // for 30s. The exit must not wait on that pipe.
        let handle = start(
            "perl -e 'setpgrp(0,0); sleep 30' & echo $!; sleep 0.3; printf started",
            Capture::Merged { cap: 4096 },
        );
        let began = Instant::now();
        let waited = wait(&handle, Duration::from_secs(15), &CancellationToken::new()).await;
        assert!(matches!(waited, Waited::Exited(Finished { exit: Exit::Code(0), .. })), "{waited:?}");
        assert!(
            began.elapsed() < DRAIN_DEADLINE + Duration::from_secs(2),
            "exit waited {:?} on a pipe",
            began.elapsed()
        );
        let text = handle.split_output().0.text;
        assert!(text.contains("started"), "output written before exit survives the drain: {text}");
        if let Some(pid) = text.lines().next().and_then(|l| l.trim().parse::<i32>().ok()) {
            // SAFETY: plain signal to the test's own orphan.
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shutdown_skips_reaped_leader() {
        let handle = start("exit 0", Capture::Merged { cap: 64 });
        let waited = wait(&handle, Duration::from_secs(10), &CancellationToken::new()).await;
        assert!(matches!(waited, Waited::Exited(_)));
        assert!(handle.leader_reaped.load(Ordering::SeqCst));
        // A reaped leader's id is free for reuse, so the shutdown path must not
        // signal it. The guard is the flag; the call must be a no-op.
        handle.kill_group_if_unreaped();
        assert!(alive(std::process::id()));
    }

    #[tokio::test]
    async fn dropping_the_handle_stops_the_process() {
        let handle = start("sleep 30 & echo $!; wait", Capture::Merged { cap: 1024 });
        let mut pid = None;
        for _ in 0..200 {
            if let Ok(p) = handle.read_since(0).0.trim().parse::<u32>() {
                pid = Some(p);
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let pid = pid.expect("pid printed");
        drop(handle);
        #[cfg(unix)]
        for _ in 0..100 {
            if gone_or_zombie(pid) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        #[cfg(unix)]
        panic!("dropped handle left {pid} running");
    }

    #[test]
    fn ring_reports_what_aged_out() {
        let mut ring = Ring::new(8);
        ring.push("abcdef");
        let (text, dropped, cursor) = ring.since(0);
        assert_eq!((text.as_str(), dropped, cursor), ("abcdef", 0, 6));
        ring.push("ghijkl");
        let (text, dropped, _) = ring.since(cursor);
        assert_eq!(text, "ghijkl");
        assert_eq!(dropped, 0, "nothing this cursor owed was lost");
        let (_, dropped, _) = ring.since(0);
        assert_eq!(dropped, 4);
        assert_eq!(ring.tail(3), ("jkl".to_string(), 9));
    }

    #[test]
    fn ring_never_splits_a_character() {
        let mut ring = Ring::new(5);
        ring.push("ééé"); // 6 bytes
        assert!(ring.text().len() <= 5);
        assert!(ring.text().chars().all(|c| c == 'é'));
        assert_eq!(ring.dropped() + ring.text().len() as u64, 6);
    }
}
