# Remote machines

Design note, started 2026-11-03. Nothing is built in Klide yet. The machine
setup exists (`scripts/remote-host/`) but has not been run on a real server.
Terms in **bold** are defined in `CONTEXT.md`.

## The idea

A Run's loop, shell and files can live on another computer. The Klide app
stays on this Mac and becomes a window onto that Run: it streams the events,
answers approvals, and reviews the diff. Close the Mac, and the Run keeps
going; open it again, and Klide replays what was missed.

Klide already does this between two processes on one Mac: `klide ptyd` keeps
background subscription conversations alive after the app quits
(`docs/BACKGROUND_CONVERSATIONS.md`). A **Remote machine** is the same
`klide ptyd`, on a Linux computer reached over SSH.

## Everyday words → Klide's words

| You might say | Klide says | What it is |
|---|---|---|
| VPS, cloud, server, the box | **Remote machine** | A Linux computer Klide reaches over SSH |
| This machine, local | this Mac | Where the app always runs |
| Where it runs | **Machine** | This Mac or a Remote machine |
| The helper, the daemon | **Run host** (`klide ptyd`) | The process that keeps a Run alive |
| The diary, the log | Transcript | Every event of a Run, written to disk in order |
| Catch up | Replay | Reading the Transcript from where the window left off |
| The copy of the code | **Remote checkout** | The repo, cloned once on the Remote machine |
| Scratch copy | worktree | One per Run, inside the Remote checkout |
| Logins, keys | **Machine login** | Credentials that stay on the Machine using them |

## How it compares

| | Provider cloud (Codex cloud, Claude Code on the web…) | Klide Remote machine |
|---|---|---|
| Whose computer | Theirs, a fresh container per task | Yours, one machine you keep |
| Code | Cloned from GitHub for each task | Cloned once; a worktree per Run |
| Setup | Their setup script / environment | `scripts/remote-host/` once, then the project's worktree recipe |
| Logins | Their account plus secrets you store with them | Logged in on the machine itself |
| Results | A branch, a PR, or a diff to apply | A branch from the worktree, reviewed in Klide |
| Unsaved work on your Mac | Not seen | Not seen |

## What already exists

- `klide ptyd` hosts Runs that outlive the app (Unix, subscription CLIs).
- `agent/run_host.rs` decides once where a Run lives (`placement`: app or ptyd)
  and holds the one admission and failure-budget judgement.
- `agent/remote.rs` connects to ptyd over a local unix socket, forwards events,
  and replays a durable gap after a reconnect.
- `launch_readiness.rs` answers "can this start here now" (ready / unsupported
  / needs login / offline / unknown). A Remote machine should report in that
  same shape.
- Worktree-per-Run isolation and Merge/Discard already exist locally.

## Decided

- **Cloud first** (2026-11-03): the first Remote machine is a rented server,
  so it can be recreated from files. A spare PC uses the same script (`--home`).
- **Ubuntu Server 24.04 LTS**, created with `cloud-init.yaml`, prepared with
  `bootstrap.sh`.
- **SSH only through Tailscale.** Public SSH is closed after setup.
- **Machine logins stay on the machine.** Klide never copies a key or a CLI
  login to it.
- **Remote checkout cloned once, a worktree per Run.**
- **One Remote machine** for the first slice.

## Proposed, awaiting Pierre

- **Claude Code** as the one CLI of the first slice. It is the best-verified
  Delegate for background recovery.

## Open questions for the first slice

1. **Transport.** How the app reaches the remote ptyd: forward its unix socket
   over SSH (`ssh -L local.sock:remote.sock`) so `agent/remote.rs` barely
   changes, or run a stdio relay (`ssh klide-box klide ptyd connect`).
2. **Installing ptyd.** How `klide ptyd` gets onto the machine and stays at a
   protocol version the app speaks. The app already handles an older local
   ptyd (`chat-host/` companion).
3. **Where the Transcript lives.** On the machine, as the source of truth, with
   the app replaying from it, or mirrored to this Mac as well.
4. **Review.** Diffs are approved on this Mac and applied on the machine; files
   are read through the machine, never as local paths. What does the
   Workspace-rooted invariant become? Probably a (Machine, path) pair.
5. **Readiness.** The minimum remote checks: reachable, ptyd version, CLI
   installed and logged in, Remote checkout present and clean.
6. **Choosing the Machine in the UI.** Per Conversation, or per project? Shown
   where?
7. **Naming in code.** Rename `agent/remote.rs`, which means the local daemon
   today, before "remote" starts meaning another computer.

## Machine setup

See `scripts/remote-host/README.md`: make a key, create the server with
`cloud-init.yaml`, run `bootstrap.sh`, log in, then close public SSH with
`bootstrap.sh --tailscale-only`.
