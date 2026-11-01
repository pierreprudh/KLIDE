# Background subscription conversations

On Unix (including macOS), standalone AI-panel conversations using OpenCode,
Claude Code, Codex, or Omp run in `klide ptyd`. Closing the desktop disconnects
its observer; it does not cancel the run. The daemon owns the existing Harness
loop, CLI child, cancellation token, pending approvals, and transcript writer.
This does not depend on the persistent **terminal** sessions setting.

API-provider runs, Mission attempts, nested subagents, and observer wake turns
still use the app-owned supervisor. Windows retains the existing app-owned path.
The computer must remain running; this is not a remote execution service.

## Ownership and recovery

- `agent/run_host.rs` is the one door: the app decides once whether a Run goes
  to the daemon (`placement`), judges the failure budget before that decision,
  and both hosts admit, spawn and back-stop a Run with the same code.
  `agent/daemon.rs` implements the existing `RunSupervisor` seam over that
  door; it admits one active turn per conversation and its `RunLease` releases
  the handle at settlement, after the loop's own backstop has written.
- `agent/remote.rs` is the door's ptyd adapter: it subscribes before dispatch,
  forwards events to the existing request/global channels, replays a durable
  gap after a socket reconnect, relays the daemon's coordination-journal moves
  to the app's panels, and feeds the app's failure budget with the Run's
  durable terminal event.
- Every daemon event, including streamed text and observed tool activity, uses
  the same monotonic transcript sequence: the loop's `emit`, the stream log and
  the host's backstop share one counter, seeded by admission under the lock
  that claimed the conversation. Reopening reads the existing transcript; it
  does not resend the prompt or spawn another CLI. The one event that is never
  on disk is the app's own `run_host_disconnected`, delivered one past the last
  durable index when the socket is lost for good.
- A daemon-hosted Run cannot start a persistent observer
  (`run_command(notifyOnExit)`): nothing in ptyd can start a new reply when
  the command exits, so the Tool refuses and says to use `background: true`
  with `read_command_output` instead.
- Status includes the starting sequence of the current turn, so the previous
  turn's completion cannot settle a newly accepted follow-up.
- Stop and approval responses are sent to the run's actual owner. Approvals
  remain pending while the UI is absent and are restored from the transcript.
- The daemon hosts its own authenticated coordination bridge. Approved Mission
  operations continue through the app's existing Mission supervisor; requests
  waiting while the app is closed are replayed when the conversation reconnects.
- The daemon's CLI-session cache survives desktop restarts. After the daemon
  itself exits, the existing full-history cold-start behavior applies.
- A dead daemon is not silently restarted to rerun a prompt. The unfinished
  history remains available for explicit recovery.

Daemon subscribers have bounded queues. A slow or disconnected window cannot
block the process generating its answer. A lagging subscriber reconnects and
replays from disk. Idle exit accounts for active chat runs as well as PTYs.
An incompatible daemon with active work is not replaced automatically. When the
primary host uses an older protocol, new chats use a companion under the app's
`chat-host/` data directory. Reconnect, Stop, and live-run listing search both
hosts, so a terminal host upgrade does not block chat or orphan existing work.
A compatible primary host is still reused; a fresh install needs only one host.

Changing the runs folder is refused while conversations are active so the
background writer is not left in the old directory.

## Verification

`cargo test --lib --test background_chat_daemon` covers the Harness regressions
and an isolated real daemon process with a fake OpenCode executable. The process
test disconnects all clients during generation, verifies duplicate-start rejection,
checks the completed durable answer, and confirms a follow-up's sequence cursor
and CLI session reuse. Two further process tests raise a permission through the
daemon's authenticated bridge with no desktop observer connected: a fresh client
answers it once (a repeated answer is refused), or stops the Run and receives a
deny. Both check transcript sequencing. These tests need permission to bind local
sockets. No real model or account is used.

### Desktop acceptance — 2026-11-01

The installed macOS build (`/Applications/Klide.app`, built 2026-10-30) was
exercised with the real Claude Code CLI in an empty disposable workspace:

- Started a delayed shell command, quit through the native **Quit Klide** menu,
  then reopened the workspace and recovered its completed answer.
- Started a second turn whose Python command required approval. Quit without
  answering; a process inspection confirmed the desktop had exited while the
  same ptyd and MCP child remained. Relaunched and reopened the conversation:
  the pending permission card returned and **Run** answered it once.
- Quit again while the approved command was running. The command and original
  ptyd survived. Reopened the same conversation, saw it running without
  resending the prompt, then used **Stop** and saw the conversation return idle.
- The saved transcript had two user turns, one permission request/resolution,
  one successful first turn and one `aborted` second turn, with consecutive
  sequence numbers. Local evidence: Run `mvyc1lbef24x4b`.

**Stop failure in the installed build:** Stop ended Claude's agent process and settled its Run, but
the Python command Claude had moved into a separate background process survived
as an orphan. It was cleaned up explicitly after the check. Stop is therefore
not verified as process-tree containment for Delegate-owned background commands.
Do not infer it from the passing Harness command-cancellation tests: native CLI
tools have their own execution lifecycle.

### Stop cleanup implementation — 2026-11-01

The current checkout fixes that failure through `delegate/child.rs`, shared by
plain and streaming headless CLIs, the per-turn OpenCode server/client, and
Hermes ACP. Each child starts in its own Unix process group. When a provider
future is dropped or its process is explicitly killed, macOS also traverses
the child relationships with libproc before killing/reaping the CLI. It stops
ancestors while collecting descendants, then kills descendants from the leaves
up, checking process birth times and parentage. This catches shells that changed
their process group/session without relying on executable names or affecting
other Runs. A normally reaped child is never signalled through its old PID.

Automated regressions first reproduced the orphan, then passed through both real
CLI runner paths. Their stand-in forks a child into a new session and gives it a
grandchild; cancellation ends both while an unrelated process stays alive. No
model or account is used. The existing daemon disconnect/approval tests remain
part of the automated check.

The updated native bundle still needs the live Claude Code Stop/relaunch retest;
the earlier installed-build observation above remains historical evidence of the
bug. This is process cleanup, not OS containment: descendants already reparented
away before Stop, externally hosted services, denied OS inspection/signals, and
extreme trees beyond the 16,384-process bound are outside the guarantee. Other
Unix platforms get process-group cleanup only; Windows retains immediate-child
cleanup. No process-tree claim is made for those platforms.

This verifies Claude Code on that installed build, not every supported CLI or
the current checkout's native bundle. Codex, OpenCode, and Omp still need real
desktop quit/relaunch checks. Daemon death, OS restart, and machine sleep are
outside this acceptance pass. The process tests exercise the current checkout's
background ownership and wire behavior with a stand-in CLI.

## Storage and latency follow-up

The conversation index remains in localStorage, while full Run events live in
JSONL transcripts. No database migration is part of this change. Streamed text
is merged into one transcript line per 150 ms (`agent/stream_log.rs`, a timer
writes a silent tail) and appended without waiting on the disk; the turn's
final message still goes through the synced append and supersedes it, so a
power loss costs at most the live tail. A ptyd serving chats must be the same
binary as the app (`pty_wire::build_id`), so a rebuild never leaves an older
Harness running new conversations; terminals only need the same wire.

Measure before choosing a migration: bytes per conversation, time spent flushing
stream events, localStorage serialization time, and reopen latency at increasing
history sizes. Likely next work is incremental
transcript reads, and reducing per-token snapshot rewrites. Keep the transcript
as the recovery authority and retain bounded memory for inactive conversations.

## Storage management

Settings → Storage lists saved conversations by disk usage, including transcript events,
summary metadata, checkpoints and retained tool output. The list loads on entry or Refresh
and displays 20 rows at a time. Usage is measured locally; provider-owned history is separate.

Manual deletion asks for confirmation, removes the selected saved transcript and supporting
files, and clears its cached history entry. Project files remain in place. No automatic
age-based deletion is enabled. Deletion and folder relocation require all app/daemon runs
to be idle; new app run admission is serialized with these storage operations.
