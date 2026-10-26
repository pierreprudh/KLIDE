# Companion — talk to Kit from your phone

Where this is going: a Klide app on the phone that opens your conversations,
starts new ones on the model you choose, and answers what a Run is waiting on,
while the Mac keeps doing the work. A premium app, not a chat bot in a
messenger, and not a hosted service: your machine runs the agents and your
phone reaches it directly.

Prototype of the three screens: `preview/companion.html` (threads, a
conversation waiting on an approval, the model sheet). `?theme=dark` for dark.

## What it is, and what it deliberately is not

- **One Mac, your devices.** The phone talks to `klide ptyd` on your Mac over
  your own private network (Tailscale). No Klide server, no relay holding
  your transcripts, no open port on the internet.
- **Your model choices, only usable ones.** The phone's picker shows what can
  answer *right now* (key present, local server up, the CLI signed in, tools
  when the Mode needs them). Each refused row says why. The Mac decides
  this, with the same gate `auto` uses, so the two can't disagree.
- **The same gates.** Every edit and command a Run proposes still waits for
  an answer. The phone can answer it. Full auto stays a Mac-only choice.
- **Not a fleet.** The companion needs no remote machines and no containers:
  it reaches the Mac you already run Klide on. VPS execution is its own track
  (TODO.md, Orb follow-ups); when it lands, the companion lists those Runs
  like any other.

## What exists today

`klide ptyd` already hosts standalone *subscription* conversations (Claude
Code, Codex, OpenCode, Omp) with the window closed: the daemon owns the loop,
approvals wait for an answer, and reopening replays the transcript
(`docs/BACKGROUND_CONVERSATIONS.md`). The control wire already carries Stop,
permission, diff, question and command-policy answers (`pty_wire::ChatControl`).
The app is one observer of that host. The phone becomes a second one.

## Slices

Each slice is usable on its own and is verified before the next starts.

### 1 · Resident runs — any conversation can outlive the window

`run_host::background_eligible` admits subscription providers only, because
API and local runs use things only the app process can host today:

| What | Why it's app-only | Change |
|---|---|---|
| `spawn_subagent`, `consult_advisor` | the daemon's `RunSupervisor` keeps the default `spawn_subagent`, which refuses; the app's uses `AppHandle` | a host-generic `run_subagent_to_completion` over `run_host`, so the daemon runs the child beside its parent |
| `run_command(notifyOnExit)` wake turns | `agent/observers.rs` starts the follow-up through `AppHandle`; the daemon refuses (`observer_support`) | the host that owns the Run starts its follow-up |
| Keys | `providers::TOKEN_CACHE` is per process, so a key changed in Settings stays stale in the daemon | a key save tells the daemon to drop that entry (the marker file is not rewritten when a key is only replaced, so its mtime can't be the signal) |
| Connectors | `connector_pool` is per process | the daemon keeps its own pool; count the extra MCP children before calling it done |

Then the rule widens: a standalone conversation goes to the daemon whatever
its provider. Mission attempts stay app-side for now (the Mission supervisor
is app-owned). The daemon never starts a model server; a local run whose
server is down fails at the gate with the usual message.

Until those parity rows land, a wider rule would silently lose subagents
and GitHub watches, so the rule widens last, not first.

**Done when:** an Anthropic Work conversation and an Ollama one, each with a
subagent and a `gh run watch` observer, finish with the window closed, and
quit → relaunch replays both.

### 2 · Usable models — one Rust answer

`models_usable_now()` beside `agent/routing.rs`, reusing its gate, returning
every candidate with `usable` and a reason (`No key`, `Server stopped`,
`Not signed in`, `No tool support`). Stars move from localStorage to a file
under app data so both clients read the same list. The desktop picker can
adopt the same "N not usable now" fold.

This is the model half of TODO.md's *Unified launch readiness* item (ready /
unsupported / needs login / offline / unknown, with reasons). Build it once,
there, and let the phone read it; it is not a second check.

### 3 · The companion door

An authenticated HTTP + server-sent-events API served by `klide ptyd`, not by
the app, because it has to answer with the window closed. It exposes the
daemon's existing operations, not new ones: list conversations, read a
transcript from a `seq`, start a turn, stop, answer a card, list usable models.
Coordination keeps its two doors; the companion is an observer of Runs, not a
third writer to the journal.

- **Reach:** listens on the Tailscale interface only (never `0.0.0.0`).
- **Pairing:** a QR code on the Mac carries a one-time code; the phone gets a
  device secret kept in its Keychain; the daemon keeps only its sha256. Paired
  devices are listed in Settings and revocable.
- **Policy:** Plan and Work modes only; a full-auto request from the phone is
  refused; prompts and secrets are never logged.
- **Conversation list:** the index lives in SQLite under app data
  (`conversation_store.rs`). The daemon reads it (WAL allows a second reader).
  The app stays its only writer.

### 4 · The phone app

Tauri 2 builds iOS from the same React code, so the companion reuses
`renderMessageBody`, the marks and the tokens, and Pierre stays on one stack.
TestFlight needs the Apple developer account, the same one the signed macOS
bundle (owed since v0.5.1) needs.

### Open questions

- **Push.** "Waiting on you" is worth a notification, but APNs needs a sender
  holding Apple's key. A minimal relay that sees only "conversation X needs
  you" is the likely answer. Until then the phone polls while open.
- **Scheduled wake-ups** stay parked behind the v0.6 foundations (CLAUDE.md).
- **Android** after iOS proves the shape.
