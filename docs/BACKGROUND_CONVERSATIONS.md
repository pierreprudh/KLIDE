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

- `agent/daemon.rs` implements the existing `RunSupervisor` seam. It admits one
  active turn per conversation and retains that ownership through settlement.
- `agent/remote.rs` subscribes before dispatch, forwards events to the existing
  request/global channels, and replays a durable gap after a socket reconnect.
- Every daemon event, including streamed text and observed tool activity, uses
  the same monotonic transcript sequence. Reopening reads the existing transcript;
  it does not resend the prompt or spawn another CLI.
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
and CLI session reuse. It needs permission to bind local sockets. No real model
or account is used.

The desktop UI still needs a manual quit/relaunch check against an installed CLI
before release. The automated process test exercises the background ownership,
wire protocol, and transcript recovery, not the native window lifecycle.

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
