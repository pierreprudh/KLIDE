# Remote machines

Design note, started 2026-11-03, updated 2026-11-09. Nothing is built in Klide
yet. The first Remote machine exists and is bootstrapped (see "The first
machine"). Terms in **bold** are defined in `CONTEXT.md`.

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

## How others do it (reviewed 2026-11-09)

Three families. Sources: `docs/competitors-*.md` for Orca, Superset, Orb,
Conductor and Cursor; the editors from their public documentation.

**1. A fresh container in the provider's cloud, per task.** Codex cloud,
Claude Code on the web, Cursor cloud agents, the Copilot coding agent, Devin,
Conductor cloud workspaces. Each task clones from GitHub into a new sandbox,
runs a setup script you wrote in their settings, and returns a branch or PR.
Secrets are stored with them. You watch in their web app. Unsaved work on your
laptop is never seen. The race now is environment speed (Cursor keeps the last
successful build warm).

**2. Agent tools that run their own host on your machine.**
- *Orca*: SSH remote worktrees and a headless "Remote Orca Server".
- *Superset*: remote workspaces are the paid tier ($20/user/month), with a
  multi-region relay so a phone or desktop reaches the machine without a VPN.
  The machine stays the source of truth; their cloud gets a copy.
- *Orb*: a node program on each server, an nspawn container per workspace.
  Moving a session between machines keeps its identity, starts a new
  execution generation so two machines never both own it, and never moves a
  login — the destination uses its own.

**3. Editors over SSH.** VS Code Remote-SSH, Zed, JetBrains Gateway. The
editor copies a headless server matching its own exact version onto the
machine over SSH, then talks to it through the connection (VS Code: a
forwarded port; Zed: the SSH session's stdin/stdout). Files, terminals, git
and language servers all run remotely; only the window is local. A dropped
connection leaves the server running, and the editor reconnects to it.

**Where Klide sits.** Family 3's shape — your machine, a version-matched host
pushed over SSH, the window local — plus what the editors lack: a Run that
keeps working while nothing is connected, and replay when you come back.
Every product in families 2 and 3 keeps the record on the machine doing the
work and leaves logins there.

## What already exists

- `klide ptyd` hosts Runs that outlive the app (Unix, subscription CLIs).
  `pty_daemon.rs` and `agent/daemon.rs` are Tauri-free, but they live in the
  same crate as the app, so a Linux build currently pulls in Tauri's Linux
  dependencies (WebKitGTK).
- `agent/run_host.rs` decides once where a Run lives (`placement`: app or ptyd)
  and holds the one admission and failure-budget judgement.
- `agent/remote.rs` connects to ptyd over a local unix socket, forwards events,
  and replays a durable gap after a reconnect.
- `pty_client.rs` checks the daemon's package version, protocol revision and
  build id on every connect, and replaces an older idle daemon.
- `launch_readiness.rs` answers "can this start here now" (ready / unsupported
  / needs login / offline / unknown). A Remote machine reports in that shape.
- Worktree-per-Run isolation and Merge/Discard already exist locally.

## Decided

- **Ubuntu Server**, prepared with `scripts/remote-host/bootstrap.sh`; the same
  script serves a rented server (`cloud-init.yaml`) or a home PC (`--home`).
- **SSH only through Tailscale.** No public SSH.
- **Machine logins stay on the machine.** Klide never copies a key or a CLI
  login to it.
- **Remote checkout cloned once, a worktree per Run.**
- **One Remote machine** for the first slice.
- **Claude Code** is the one CLI of the first slice (best-verified Delegate for
  background recovery).

## The first machine (2026-11-09)

"Cloud first" (2026-11-03) gave way to what was at hand: a VirtualBox VM on
Pierre's Windows gaming PC. The script did not need to change shape.

| | |
|---|---|
| SSH alias | `klide-box` → `klide@100.92.189.16`, key `~/.ssh/klide_box` |
| System | Ubuntu 26.04 LTS, x86_64, VirtualBox NAT (reachable only over Tailscale) |
| Size | 3 vCPU, 3.2 GB RAM, 40 GB disk |
| Tailscale | Pierre's personal tailnet; the Mac switches to it (work tailnet is separate) |
| Bootstrapped | gh, Node, Claude Code installed; logins to confirm |

Ubuntu 26.04 ships `sudo-rs`; the bootstrap no longer uses `sudo -E`.
The VM only runs while Windows does: Windows sleep must be off and the VM must
autostart. 3.2 GB is enough for Claude Code, tight for Rust builds.

## Answers proposed for the open questions

1. **Transport → a stdio relay over SSH (Zed's way).** `ssh klide-box klide
   ptyd connect` bridges the session's stdin/stdout to the remote ptyd's unix
   socket. No forwarded socket files to clean up, and a dropped connection is
   just a process that exited. The client's transport becomes a trait:
   unix socket locally, SSH child process remotely; requests, events and
   replay stay the same wire (`pty_wire.rs`).
2. **Installing ptyd → pushed by the app, version-matched (VS Code's way).**
   The existing version/protocol/build check runs over the relay; on a
   mismatch the app copies the matching Linux binary to
   `~/.klide/bin/klide-<version>` and restarts the daemon, refusing while a Run
   is live (the same rule as locally). The daemon runs as a systemd user
   service so it survives reboots (linger is already on).
3. **Transcript → on the machine, the source of truth.** The app replays from
   it, exactly as it replays from the local daemon today. No mirror in the
   first slice.
4. **Review** — still open: diffs and files are read through new ptyd requests,
   addressed as (Machine, path), never as a local path.
5. **Readiness** — reachable, ptyd version, Claude Code installed and logged
   in, Remote checkout present and clean.
6. **Choosing the Machine in the UI → decided 2026-11-09** (prototype:
   `preview/machine-picker.html`). Before the first message, the Machine's
   name stands alone over the chatbox's top-left — no tab, no container, the
   Machine only (`This Mac ▾` / `klide-box ▾`). Its menu, "Where it runs",
   groups This Mac (Worktree · Checkout) and Remote machines; a machine that
   isn't ready is dimmed, says why, and opens Settings › Machines. Once the
   conversation has started the choice is fixed and shows as a quiet label at
   the bottom right of the status row under the chatbox. Add project asks for
   the Machine first, then a folder on it (or clone onto it); SSH hosts come
   from `~/.ssh/config`. Settings › Machines lists each Machine's readiness
   (Q5) as facts, each problem with the command that fixes it.
7. **Naming** — rename `agent/remote.rs` (it means the local daemon) before
   "remote" starts meaning another computer.

## Built first: the picker on tmux (2026-11-09)

Before any of the plan below, the picker shipped on a backend with no Klide
code on the machine: Claude Code in tmux over SSH.

- `~/.klide/machines.json` lists the Remote machines (`id`, `sshHost`,
  optional `checkouts` from a local workspace to its Remote checkout; default
  `~/code/<folder name>`). `src-tauri/src/machines.rs` owns the store, the
  readiness check (one SSH round trip: reached, tmux, Claude Code + login, gh,
  checkout · branch · clean) and the spawn command.
- **Where it runs** (`components/WhereItRuns.tsx`) sits over the Focus start
  composer's left edge only when a machine is configured. Picking a Remote
  machine switches the agent to Claude Code; a machine that isn't ready is
  dimmed with the command that fixes it.
- The first message places the conversation on the machine
  (`conversationMachines.ts`, fixed from then on). Such a conversation is the
  CLI's terminal in Focus too. Its PTY runs
  `ssh -t <host> 'tmux new-session -A -s klide-<convoId> -c <checkout> claude …'`,
  so quitting Klide or sleeping the Mac leaves Claude Code running, and
  reopening the conversation attaches to the same session. A quiet machine
  label sits at the right of the status row.
- What does not cross: status hooks, coordination MCP, routed intelligence
  sources and Missions are refused or skipped on a Remote machine; review is
  `git fetch <machine-remote>` then Git Review.

Steps 0–6 replace the terminal with Klide's own Run on the machine; the
picker and the per-conversation placement stay.

## Plan for the first slice

Each step is one PR and ends with something checkable on `klide-box`.

0. **Spike: ptyd on Linux, by hand.** Build `klide` on the box, start
   `klide ptyd`, confirm it binds, and run one background Claude Code
   conversation through it with a throwaway client. Decides how the Linux
   binary gets built (on the box, CI, or a Tauri-free `klide-host` binary —
   see below). No app changes.

   **Result, 2026-11-09 — the ptyd half passed.** `.github/workflows/linux-host.yml`
   (manual) built `klide` on ubuntu-latest in ~9 min (63 MB, release); the
   box got it with `gh run download` and needed only the runtime libraries
   (`libwebkit2gtk-4.1-0`, `libgtk-3-0t64`; `ldd` resolves everything). `klide
   ptyd --data-dir …` started from an SSH session, bound
   `/tmp/klide-1000/ptyd-*.sock`, answered a Python client's Auth + Ping
   (`0.6.11`, protocol 2 — the Mac's), spawned a shell session, served its
   scrollback through Snapshot, listed it in LiveRows, stopped it, and kept
   running after the SSH session closed. Then, with Claude Code logged in,
   three background conversations through `chat_start` on a scratch repo: a
   Chat turn (answered, and correctly refused to read files), a Work turn
   (observed Read tool call, answer `# spike`, 6 s, `run_result`), and a long
   Chat turn stopped mid-stream with `chat_control` Stop (settled in 1 s with
   `aborted`, no `claude` process left). Transcripts are the same JSONL the
   Mac writes. Step 0 is done.
   **Decision: build on CI.** A 3 GB box should not compile the app, and the
   Tauri-free `klide-host` binary is not needed to start — the cost of the
   whole-app build is the two runtime packages and 63 MB.
1. **Rename** `agent/remote.rs` (Q7). Pure rename, tests unchanged.
2. **One Remote machine + readiness.** `~/.klide/machines.json` holds one SSH
   alias; a Rust check over `ssh -o BatchMode=yes` reports the Q5 facts as
   `Readiness`. A Settings row shows it. No Runs yet.
3. **Transport.** `klide ptyd connect` on the remote side; a transport trait in
   `pty_client.rs`; Ping/version check over SSH. Test: the same client tests
   against a local SSH-shaped child process.
4. **Install and upgrade.** Push the matching binary, systemd user unit,
   replace-when-idle. Test: a version bump on the Mac upgrades the box.
5. **Launch, stream, stop, reattach.** A Conversation bound to (Machine,
   Remote checkout) starts a Claude Code Run on the box in its own worktree.
   Acceptance: start a task, quit Klide, reopen — the Run kept going and
   replays; Stop works after reattach.
6. **Review remote results.** File and diff requests over the wire; Merge /
   Discard on the box; validation evidence shown in Klide.
7. **Choose the Machine in the UI** (Q6) — built first, on tmux (above); this
   step moves it onto the Run host.

Out of the first slice: other CLIs, Harness Runs on API models, Missions,
transfer between machines, phone, several machines.

### The Linux binary

`klide ptyd` is the app binary, and the app crate depends on Tauri, so a Linux
build needs WebKitGTK even though the daemon never opens a window. Options,
decided by the spike:

- **Build the whole app on Linux** (on the box, or a GitHub Actions Ubuntu
  runner per release). Least code, heaviest install.
- **A Tauri-free `klide-host` binary** (Tauri behind a cargo feature). The
  right end state; `agent/mod.rs` still has ~56 Tauri references to move
  behind a seam first.

## Machine setup

See `scripts/remote-host/README.md`: make a key, create the server with
`cloud-init.yaml` (or install Ubuntu on a PC), run `bootstrap.sh`, log in, then
close public SSH with `bootstrap.sh --tailscale-only`.
