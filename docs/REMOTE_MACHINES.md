# Remote machines

Design note, started 2026-11-03, updated 2026-11-18. Native remote
conversations now launch through the SSH Run host, stream into Klide, replay
missed activity and reconnect after a network interruption. The implementation
has controlled-process and browser acceptance; live Linux acceptance on
`klide-box` remains pending because SSH timed out. Terms in **bold** are defined
in `CONTEXT.md`.

## Use it

1. Enable SSH on the destination and connect it to your network or VPN.
   On a Mac mini, enable **System Settings › General › Sharing › Remote
   Login**. On Windows, enable the native **OpenSSH Server** capability and
   service ([Microsoft setup](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse)).
   Use an SSH alias for custom keys and ports.
2. In Focus, open **Where it runs › + Add a machine**. Choose Tailscale,
   another VPN or Direct SSH, then choose a device or enter `user@hostname`.
   Klide shows a fingerprint confirmation and password or key-passphrase field when needed.
   Background connections need an unlocked key or SSH agent.
   Use the destination account's username, which can differ from this Mac's.
   Enter it in **Remote username**, beside **SSH host**. IP addresses cannot
   continue with an empty username; configured SSH aliases can use their own
   account. Pasting `user@hostname` fills both fields.
   If connection fails, edit **SSH host** in the same setup view and retry.
   A Mac's Remote Login must allow that account; a reachable Tailscale device
   does not establish SSH access. The popup keeps a fixed frame, with longer
   device lists split into pages instead of a scrolling setup window.
   For a Mac or Linux machine that has not authorized this Mac, choose
   **Enable background access** and enter the remote account's password in
   the password field. Klide authorizes an existing default public SSH
   key, or creates an Ed25519 identity when none exists, without replacing
   existing keys or remote access. It then reconnects; unlock an encrypted
   key if asked. Private keys stay on this Mac; SSH handles the password
   without Klide storing it.
3. Continue through **Install**, **Sign in** and **Project**. Klide detects
   the destination OS and processor, then copies the matching helper with SFTP.
   A Mac destination with the same processor can use this app's own executable
   after checking its exact version, protocol and source identity. Other
   targets download a checksum-verified helper from `host-<source>` releases,
   named after the trees the helper is built from
   (`scripts/remote-host/source-paths`), so a frontend or docs change reuses
   the last published helper.
   No GitHub CLI is needed on the Mac for helper installation. Advanced setup accepts a matching
   downloaded binary. The helper checks the exact package/protocol/source
   signature and refuses to replace a host with active work. Once installed,
   a helper is reused across desktop rebuilds with the same package version
   and wire protocol; a different source commit alone does not require an update.
4. Sign in to Claude Code on the destination and choose or clone its Git
   checkout. Claude login remains on that machine. Local unsaved files are not
   automatically copied. Settings › Machines manages saved machines.
   **Browse folders** opens the destination's folders over SSH, with Home,
   Up and New folder. For cloning, choose a parent such as Documents;
   **Clone project here** creates a subfolder named after the repository and
   previews its full destination. Selecting that named project folder directly
   reuses it rather than nesting another copy. Existing nonempty destinations
   are refused by Git; their contents are kept. **Use this folder** still selects
   an existing checkout directly.
   Repository-only access keeps Git restricted: the guard accepts only Klide's
   exact managed SSH command and an empty credential-helper reset. These settings
   do not grant folder trust; arbitrary commands, filters and hooks remain blocked
   until the person trusts the folder explicitly.
   For private GitHub repos, **Repository access** registers a deploy key using
   this Mac's GitHub account (repository admin access required). Personal
   GitHub credentials are not copied or signed in on the remote machine.
   Read-only access is the default; pushing requires an explicit choice.
   Disconnect any earlier personal `gh` login using the named account action
   in that step. Git author identity and the SSH command are saved with
   `git config --local` in the chosen checkout. Other people sharing that OS
   account can use the repo key, but it grants no access to other repositories
   or personal GitHub API operations. Public repositories can clone anonymously.
5. Select the machine above the Focus composer and launch a Claude Code
   task. Quit Klide or turn off the Mac, leaving the remote machine on.
   Reopen the conversation to replay missed output and resume live
   streaming. Approvals, questions and Stop route back to its owning host.
6. **Remote changes** reads the task worktree's diff, including its commits.
   Local rollback and artifact actions do not operate on remote paths.
   Remote Merge/Discard and opening individual artifacts remain follow-ups.

You can save setup while the machine is off. Choose its system under
**Machine system**, then **Prepare setup files on this Mac** to cache the
correct helper. Once it is reachable, installation detects the actual system
again rather than trusting that offline selection.

### Native host targets

| Destination | Helper | Preparation |
|---|---|---|
| Linux x86_64 | `klide-linux-x86_64` | Ubuntu 24.04+ / Debian 13+ packages, including WebKitGTK 4.1 |
| macOS Apple silicon | `klide-macos-aarch64` | Git from Apple Command Line Tools; optional GitHub CLI via existing Homebrew |
| macOS Intel | `klide-macos-x86_64` | Same macOS setup |
| Native Windows x86_64 | `klide-windows-x86_64.exe` | OpenSSH Server; PowerShell setup; Git and GitHub CLI via winget when available |

Windows uses native Claude Code and Git, without WSL. Windows ARM64 and Linux
ARM64 helpers are not published yet. Claude installation follows the official
[platform installers](https://code.claude.com/docs/en/setup). If winget or Apple
Command Line Tools are unavailable in an SSH session, setup explains what to
install on the destination before retrying.

Unix hosts use private domain sockets. Windows uses native filesystem sockets
and a token under directories restricted to the current Windows identity. No
TCP port is exposed for local host IPC. The
host requests OpenSSH job breakaway and disconnects all inherited stdio. An
older server that refuses breakaway fails setup explicitly. Each Windows
Claude process starts suspended, enters its own kill-on-close job, then
resumes; Stop owns that process tree without killing unrelated applications.

The **Native host binaries** workflow builds and smoke-tests every target.
Windows helpers use the `remote-host` Cargo feature for console stdio and a
static CRT in release builds. Only helpers that passed their own target's
checks are published; a failed target cannot suppress the successful ones.
Each merge to main builds and publishes matching
release helpers automatically; manual dispatch can publish a development
revision too. Desktop app signing/notarization is a separate
release task; these are SSH helpers, not desktop installers.

Keep the destination awake. SSH disconnects do not stop a task; remote sleep
pauses progress, and a reboot or host crash interrupts execution. Transcripts
remain available for replay, but interrupted tasks do not restart themselves.
The Run host is not installed as a Windows boot service. Real Claude login,
client power-off and host sleep/reboot acceptance on physical machines remain
on the deployment checklist.

## The idea

A Run's loop, shell and files can live on another computer. The Klide app
stays on this Mac and becomes a window onto that Run: it streams the events,
answers approvals, and reviews the diff. Close the Mac, and the Run keeps
going; open it again, and Klide replays what was missed.

Klide already does this between two processes on one Mac: `klide ptyd` keeps
background subscription conversations alive after the app quits
(`docs/BACKGROUND_CONVERSATIONS.md`). A **Remote machine** is the same
`klide ptyd`, on another computer reached over SSH.

## Everyday words → Klide's words

| You might say | Klide says | What it is |
|---|---|---|
| VPS, cloud, server, the box | **Remote machine** | A computer Klide reaches over SSH |
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
- `agent/daemon_client.rs` connects to ptyd over a local unix socket, forwards events,
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
- **Machine logins stay on the machine.** Klide never copies a private key or a CLI
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
4. **Review** — remote diffs are read through a host request scoped to the
   conversation worktree. Individual files and Merge/Discard remain follow-ups.
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
7. **Naming** — completed 2026-11-17: `agent/remote.rs` became
   `agent/daemon_client.rs`; it connects to the local background daemon.

## Built first: the picker on tmux (2026-11-09)

Before any of the plan below, the picker shipped on a backend with no Klide
code on the machine: Claude Code in tmux over SSH.

- `~/.klide/machines.json` lists the Remote machines (`id`, `sshHost`,
  optional `checkouts` from a local workspace to its Remote checkout; default
  `~/code/<folder name>`). `src-tauri/src/machines.rs` owns the store, the
  readiness check (one SSH round trip: reached, tmux, Claude Code + login, gh,
  checkout · branch · clean) and the spawn command.
- **Where it runs** (`components/WhereItRuns.tsx`, a hook feeding InlineMenu) sits over the Focus start
  composer's left edge only when a machine is configured. Picking a Remote
  machine switches the agent to Claude Code. The menu is Focus's own InlineMenu
  (the agent picker's dropdown): This Mac, then each machine, the chosen row
  highlighted. One that isn't ready is dimmed; picking it raises a toast with
  the reason and a Copy fix action instead of choosing it. It behaves like the Claude / Codex
  apps' environment switch: readiness is fetched in the background when the
  start stage appears (`machineStatus.ts`), the menu opens instantly, nothing
  waits on a check before a pick, and each project remembers the Machine it
  last started on.
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

This section records the original tmux implementation. Since 2026-11-17,
new remote conversations use the native Run host. An existing tmux session is
not silently migrated or driven by a second writer: finish it there and start
a new native conversation.

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
1. **Rename** `agent/remote.rs` to `agent/daemon_client.rs` (Q7).
   Completed 2026-11-17; behavior unchanged.
2. **Machine + readiness — implemented.** Settings manages the SSH alias
   and checkout mapping. Facts report the matching native Run host, Claude
   installation/login and checkout; tmux is no longer needed for new tasks.
3. **Transport — implemented.** `pty_transport.rs` shares authenticated local
   socket and SSH-child connections. `ptyd connect --ensure` starts the
   matching detached daemon when needed; credentials stay on the host.
   Protocol 3 adds bounded remote replay, remote identity, isolated starts,
   diff reads and idle-upgrade reservation. SSH has no TTY or login prompts.
4. **Install and upgrade — implemented.** Explicit Settings action downloads
   the public helper for this app's source commit (or takes a selected binary),
   validates the staged binary remotely, refuses active work and replaces
   the idle host. New starts cannot race the upgrade reservation. A detached
   host is started on demand; no always-on systemd service is required for
   the Mac-disconnection guarantee. The machine must remain running.
5. **Launch, stream, stop, reattach — implemented.** Backend placement is
   persisted before dispatch and cannot fall back to local execution. The
   host owns its transcript and reuses one worktree per conversation. The Mac
   caches only received events in memory. Subscribe-before-replay and
   sequence checks close gaps and remove overlap. A lost SSH child reconnects
   and replays; a confirmed lost host owner is reported as interrupted.
6. **Review remote results — partial.** Remote changes compares the worktree
   against its recorded starting commit, including task commits. Paths are
   never treated as Mac paths. Merge/Discard, individual artifact opening and
   remote checkpoint management remain outside this implementation.
7. **Choose the Machine in the UI — implemented.** The existing picker and
   conversation placement now dispatch native Runs, in Focus and restored
   conversation surfaces. Legacy tmux sessions keep their old terminal path.

Out of the first slice: other CLIs, Harness Runs on API models, Missions,
transfer between machines, phone, several machines.

### Verification and remaining acceptance

`python3 tests/remote-machine-smoke.py` uses a real detached host and a
controlled Claude CLI, with no model calls. It verifies launch, isolated
worktree placement, every client disconnecting mid-turn, replay, ordered live
stream resumption, completion recovery, follow-up transcript reuse, Stop and
active-upgrade refusal. Rust tests cover replay bounds, immutable placement,
corrupt-placement refusal, transport framing, quoting, timeouts and detach.
Browser checks cover Settings installation/errors and native remote
conversation replay plus Remote changes without a terminal surface.

Live Linux SSH acceptance is still owed: `klide-box` timed out twice on
2026-11-17. Once reachable, install the matching CI binary, launch a real
Claude task in Klide, quit/reopen, then sleep/wake the Mac and confirm resumed
streaming and Stop. These checks must not be called passed based on the
controlled-process fixture.

Readiness, transport checks and new remote tasks share the same package-version
and wire-protocol compatibility rule. Source identity remains diagnostic and is
validated exactly when selecting and installing a replacement artifact. Changes
that require a new remote runtime must bump the package version; incompatible
wire changes must bump the protocol. Existing local strict build checks still
use binary size/mtime so a dev rebuild cannot leave the local daemon on stale code.

Manual transport check after installation:

```bash
/path/to/klide ptyd ping --ssh klide-box \
  --binary '~/.klide/bin/klide' --data-dir '~/.klide/run-host'
```

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

## Managing machines in Settings

Settings › Machines manages the SSH machines in `~/.klide/machines.json`.
Focus always shows its “Where it runs” picker, even with no saved machines.
“Add a machine” opens a dedicated dialog. First choose Tailscale, another
VPN, or direct SSH; then select a listed device or use “+ Add a machine” for
manual entry. Connection and installation show animated progress. Machine management stays in
Settings. An unavailable machine offers “Set up machine”.
Tailscale discovery reads `tailscale status --json` from the local client
(with `TAILSCALE_BE_CLI=1` for the macOS app). Other VPNs use saved machines
and literal Host aliases from `~/.ssh/config`; Klide does not scan those
networks or configure the VPN. Device online status is not SSH readiness.
Unsupported remote operating systems remain visible with an explanation.
Enter an SSH alias or `user@hostname`; the display name is optional and Klide
creates the stable ID. Setup can be saved while the machine is switched off.
Cloud servers and self-hosted Linux computers use the same SSH connection.

Continue setup guides connection → installation → remote Claude sign-in →
project → readiness. Setup runs in the background. Host fingerprints,
passwords, key passphrases and common confirmations use form controls; Claude
and GitHub sign-in offer a browser button and code field. **Show details**
opens read-only logs. An unrecognized interactive prompt offers an explicit
**Open interactive prompt** action; it never opens a terminal automatically. Klide uses `~/.ssh/config` and an unlocked
key/agent for unattended connections; it does not store SSH passwords or copy
Mac logins. Changed host keys are never accepted automatically.

The popup and Settings use the same setup controls. Completed steps remain
clickable on a ready machine, so connection details, installation, sign-in and
the project can be revisited. Later steps remain unavailable until their
prerequisites are verified. Switching steps saves the current connection or
project edit, and **Save for later** saves before closing. Settings uses the
same separate SSH host and remote username fields, follows popup saves, and
preserves unfinished edits when another machine changes. Rename, advanced
details and removing saved machines remain in Settings.

A logo checklist shows SSH, the Klide helper, Claude Code, GitHub and the
project. Remote checks refresh during connected setup actions, distinguishing
installed tools from validated sign-ins. GitHub is optional and does not block
Claude tasks. A running installer or sign-in keeps its current panel while
checklist facts update, so a successful intermediate check cannot cancel it.
An animated marker follows the current step along the checklist rail and
respects reduced-motion preferences.

The Ubuntu 24.04+ / Debian 13+ x86_64 preparation action installs Git, curl, GitHub CLI,
WebKitGTK runtime libraries and the official Claude native installer. It then
downloads the matching Klide helper from public GitHub release assets, validates
its SHA-256 and installs it over SSH. The Mac needs no GitHub CLI or login.
The Linux workflow publishes source-specific `host-<source>` prerelease assets
only after the remote replay and installer smoke tests pass, and skips the
build when that source already has all four helpers published. Development builds
without published assets can choose an extracted matching binary under Details.
“Prepare setup files on this Mac” downloads to the Mac cache without contacting
the remote machine. It does not report the machine as ready.

For the open Workspace, choose an existing remote checkout path or save a
new destination and clone the local project's origin. Other Workspace mappings
are preserved. Private repositories use remote credentials, with an optional
GitHub sign-in step. Existing destinations are never overwritten; local
files and credential-bearing origin URLs are not copied. The only currently
supported remote Delegate is Claude Code. Readiness is rechecked after actions.

Saved changes refresh the “Where it runs” picker. Removing a Machine only
removes its local configuration: remote files and running sessions stay there.
Re-adding its original ID reconnects existing Conversations. Saves are atomic;
an unreadable configuration is reported and cannot be silently overwritten.

## Review follow-up (2026-11-17)

Code review fixed upgrade-lock inheritance into the detached host, explicit
flushing of relay output, the completion-versus-reconnect snapshot race,
cancellation racing remote admission, and local/remote ownership races.
Incremental replay now transfers only the missing tail and merges events that
arrived while a replay request was in flight. Remote operations requiring the
Mac (Klide Missions) fail promptly instead of waiting for an absent supervisor.
An unstarted worktree left by a failed setup can be recovered after its
repository identity is verified.

`tests/remote-install-smoke.py` exercises the actual installation script,
fresh relay connection, and rejection of a mismatched upgrade without
interrupting the installed host. Linux smoke tests have bounded deadlines and
progress diagnostics. The first Linux release binaries compiled, but their
unflushed relay smoke tests stalled and hit the workflow deadline; those runs
are not acceptance evidence. The corrected Linux workflow run 44116806131 passed both controlled-process smoke tests. Actual Claude and sleep/wake acceptance on the user’s machine remains outstanding.


## Agents and API keys on a remote machine

A remote conversation picks its agent and model in the composer, exactly as on
this Mac. The machine supplies credentials, never a model:

- **Claude Code** runs on the machine's own Claude login and its own models by
  default. It can also be routed to any authorized API source through the
  destination's model bridge.
- **Kit** (Klide's own agent) runs on any hosted API whose key the machine
  holds. The Harness loop already runs inside the remote Run host; only the
  admission (`remote_machine::validate_request`) and the key lookup changed.

Settings → Machines → Credentials shows the Claude login and lists the
authorized API keys. "Add an API key" sends one explicitly chosen key from this
Mac over SSH stdin to `~/.klide/remote-api/<provider>/api-key` (dir 700, file
600). On the host, `providers::provider_key_in` reads that file per request
before anything else, so neither the Mac nor a Mac-side proxy is needed while a
task runs. A missing or invalid previously configured key fails rather than
falling back to another account's key. Only plain-keyed hosted APIs qualify
(`machine_inference::remote_api_provider`): no local servers, no token
commands (Vertex), no account-scoped URLs (Azure, Bedrock, Cloudflare).

The probe reports `apiKeys` (`klide ptyd api-status`); a host without the
`remote-api` capability is shown as outdated once keys are authorized. The
older machine-wide `inference` setting (one OpenRouter model forced on every
run) is still parsed, never applied, and dropped on the next save; a
conversation bound under it keeps its original model.

### OpenRouter without Claude subscription login — live acceptance 2026-11-27

Helper host source `6c5d6deed83e9a5c871badf0019bef8a670f8c19` passed the native
Linux helper checks and was installed on the personal VPS over Tailscale.
Run `api-key-no-claude-6c5d6de` used OpenRouter model
`deepseek/deepseek-v4.1-flash-1017` and completed three successive tool calls,
with two timestamped after the approval client disconnected. Reconnect
recovered the durable `done` result.

The dedicated Claude test profile reported `loggedIn: false` before and after
the run. API environment keys were unset; inference used the explicitly
authorized destination key file with mode 600. Existing normal-profile logins
were preserved. The actual setup probe also found the API capability and key
ready while using that empty Claude test profile. Physical Mac closure was
not repeated in this acceptance. Evidence is recorded locally in
`artifacts/remote-setup-20261127/openrouter-no-signin-report.json`.
