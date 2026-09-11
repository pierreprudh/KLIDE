# Klide Agent Coordination

Klide owns inter-agent communication. It does not delegate identity, routing,
state, authorization, or durable delivery to an external service. MCP, a local
socket, and terminal-specific integrations are adapters into the same Rust
domain.

![Klide agent coordination architecture](public/agent-coordination-architecture.svg)

## Product promise

Every Run has a stable address. Coordinators can see whether it is working,
blocked, waiting, reviewing, or finished; send durable instructions and
questions; request cancellation; and receive a structured result with evidence.
The focused panel and a terminal's last line never decide identity or truth.

The design combines two useful patterns without adding a provider dependency:

- [Herdr](https://github.com/herdrdev/herdr) demonstrates process-owned agent
  identity, snapshot-plus-events clients, and atomic prompt/wait semantics.
- [Muse Code fan-out](https://github.com/meta-models/meta-model-cookbook/blob/main/04_muse_code/06_subagent_fanout/README.md)
  demonstrates explicit spawn, track, steer, stop, wait, and admit controls with
  isolated worktrees for write-capable agents.

Klide's Run and Mission vocabulary remains the domain. These projects are
design references, not runtime dependencies.

## Ownership boundary

| Layer | Owns | Does not own |
|---|---|---|
| Harness / Delegate adapter | Model turns, Tools, process lifetime, safe delivery boundary | Global inboxes or routing policy |
| Run coordination | Stable identity, normalized state, authorization, envelopes, cancellation intent, results, replay | Provider streaming or terminal emulation |
| Transcript | Detailed evidence emitted by one Run | Cross-Run delivery |
| Mission | Task graph, acceptance, attempt admission | Direct semantic transport |
| Project Memory | Reviewed reusable knowledge | Unreviewed coordination traffic |
| React | Snapshot presentation and operator input | Durable state or target selection by focus |

## Durable authority

One Workspace has one append-only journal:

```text
<main-checkout>/.klide/coordination/events.jsonl
```

Private Git worktrees resolve back to the checkout that owns the real `.git`
directory. A parent Run and write-isolated children therefore share one journal
without sharing one working tree. Reads never create `.klide/coordination/`;
the first accepted command creates it.

Each event line carries `schemaVersion`, a contiguous `seq`, a timestamp, and a
typed event. Replay is strict: malformed JSON, sequence gaps, future schema
versions, invalid lineage, illegal state transitions, unknown envelopes, or
impossible delivery transitions fail visibly. Klide never skips a damaged line
and invents a partial coordination state.

## Foundation command seam

The Rust core accepts provider-neutral supervisor commands:

| Command | Durable effect |
|---|---|
| `register_run` | Registers immutable Run identity, worker kind, lineage, and optional Mission link |
| `set_run_state` | Appends a validated normalized state transition |
| `send_envelope` | Queues an addressed semantic payload with correlation and evidence |
| `mark_envelope_delivered` | Records safe-boundary delivery to the addressed Run |
| `acknowledge_envelope` | Records that the recipient consumed the envelope |
| `request_cancel` | Records authorized cancellation intent |
| `publish_result` | Publishes one structured Run outcome and its artifacts |

This generic command seam is trusted local supervisor IPC. An MCP or socket
adapter must authenticate its caller and construct the actor in Rust. It must
never pass through an arbitrary remote `actor` field.

## Authorization

- The operator may address, transition, or request cancellation for any
  registered Run in the open Workspace.
- A Run may publish normalized state only for itself.
- A Run may exchange envelopes with any Run registered in the same Workspace
  journal: itself, its parent or children, Mission peers, and independent
  top-level conversations opened side by side. Two AI panels are peers the
  way two Claude Code sessions on one machine are. A Run in another Workspace
  is never visible.
- `agent_list` labels each visible Run `self`, `parent`, `child`,
  `mission_peer`, or `peer`, says whether it is live, and names its worker
  kind (`harness` or `delegate`). A message to an idle Harness peer waits in
  its inbox; the receiving operator's approval wakes that conversation with a
  no-text turn. A Delegate is never woken: it reads approved mail when it
  calls `agent_wait`.
- A Run may request cancellation only for itself or a direct child.
- Registration requires an existing parent, preventing cycles and ambiguous
  lineage.
- Mission Runs carry both `missionId` and `missionTaskId`, or neither.

These rules hold given an honest supervisor. The native Harness binds the
actor to the running Run's own id, so no Tool argument can impersonate another
Run. The generic `coordination_apply_command` IPC takes the actor from its
payload and is trusted local supervisor input only. The embedded MCP adapter
(`mcp_server.rs`) binds identity the same way: it relays each call over
loopback to the coordination bridge (`coordination_bridge.rs`) in the app
process, which looks the PTY session up in a map filled at spawn to learn the
Run id and Workspace the call acts as. Its request vocabulary has no actor
field and no journal path to pass through.

## Delivery semantics

![Klide coordination lifecycle](public/agent-coordination-lifecycle.svg)

An envelope progresses monotonically:

```text
queued → accepted → delivered → acknowledged
              ↘ declined
```

`queued → accepted` is the receiving side's review: another agent's words never
reach a conversation unreviewed. The operator answers an inline card (or has
welcomed that peer for the rest of the run); a reply to a question the receiver
itself asked, a message from the operator, and self-talk are accepted at once.

Transport is at-least-once. `idempotencyKey` makes retries safe, while the
journal gives each accepted intent exactly one projection. The recipient Run
id is immutable, so a replacement process, panel, or Delegate session cannot
accidentally satisfy another Run's delivery.

The native Harness projects accepted (and delivered-but-unacknowledged)
envelopes only between provider turns, never during streaming or Tool
execution. A successful provider request acknowledges that projection; a
failed request retries it at the next safe boundary. A Delegate has no turn
boundary Klide owns, so delivery is pull: `agent_wait` over MCP returns
accepted mail and marks it delivered and acknowledged in the same call, since
handing the text back over the wire is the read. PTY bytes are never used for
delivery.

## Snapshot and event cursors

Consumers follow one race-free pattern:

1. Call `coordination_snapshot`.
2. Render its Runs, envelopes, cancellations, and results.
3. Read `coordination_events` from the snapshot's inclusive `nextSeq` cursor.
4. Fold returned events and continue from the next cursor.

React can remount, an MCP connection can reconnect, and Klide can restart
without losing the coordination model. The journal, not an in-memory bus, is
the recovery contract.

## Result versus memory

A Coordination result is the Run's structured report:

- terminal or partial status;
- concise summary;
- files, commits, diffs, Transcripts, or Memory artifacts;
- source references back to evidence.

It may feed a Mission dependency or a Project Memory draft. It is not itself
Project Memory. Reusable knowledge still crosses the explicit review boundary
owned by the Memory Engine.

## PR sequence

### PR 1 — Coordination foundation

- Rust-owned command/event model and strict append-only replay;
- normalized Run state and lineage-scoped authorization;
- durable, idempotent envelope delivery projection;
- cancellation intent and structured results;
- snapshot and cursor-based event commands;
- main-checkout store resolution for private worktrees;
- TypeScript wire mirror, JSON Schemas, tests, and website-ready visuals.

### PR 2 — Native Harness integration

- register native Runs and publish normalized state/results from Agent events;
- expose lineage-scoped `agent_list`, `agent_send`, `agent_wait`,
  `agent_cancel`, and `agent_read_result` Tools;
- inject queued envelopes only at safe turn boundaries;
- atomically send-and-wait for an exact envelope reply;
- render contact actions in the transcript and durable traffic in Mission
  Control.

### PR 3 — Write-capable children and Missions

- give every write-capable child a private branch and Git worktree;
- expose steering, cancellation, status, and result admission in Mission
  Control;
- attach accepted predecessor results to dependent Task prompts;
- validate and admit artifacts before merge.

### PR 4 — Embedded MCP and Delegate adapters (shipped 2026-09-10, PR #93)

- expose identity-bound list/send/wait/result Tools over embedded MCP —
  `klide mcp coordination`, the app binary as a stdio child of the CLI, plus
  `agent_publish_result` because a CLI has to say when it is done;
- relay over loopback HTTP to the in-app bridge rather than a socket: the
  journal has one writer gate and one change event, both in the app process;
- map Delegate idle/blocked/waiting status hooks and PTY exit into normalized
  state (an interactive thread rests in `waiting`, a Mission attempt is
  terminal);
- wire per CLI behind `Delegate::mcp_wiring` — Claude Code `--mcp-config`
  file, Codex `-c mcp_servers.klide.*`, OpenCode `OPENCODE_CONFIG`; headless
  Focus turns carry the same wiring and pre-allow `mcp__klide`;
- PTY input is never a delivery channel; delivery is pull via `agent_wait`.

Still open from this PR: waking an idle Delegate on accepted mail (a Stop hook
that blocks with the inbox as its reason); re-binding Delegate sessions after
an app restart (the bridge port changes while ptyd sessions live on);
reconnect and duplicate-delivery tests against a real CLI.

## Testing the chain without the GUI

The first dogfood of the MCP adapter cost an afternoon of restarts because the
only way to see whether a Delegate had its tools was to ask the model. Two
tests in `mcp_server.rs` now stand in for that:

- `mod chain` runs a real MCP message through the real loopback bridge into a
  real journal on disk, and asserts the envelope it writes is stamped with the
  bound session's Run id even when the tool arguments claim another. It runs in
  the normal suite.
- `the_real_mcp_child_process_serves_the_bridge` spawns the app binary the way
  an MCP client does and speaks JSON-RPC to its stdio, which is the only way to
  prove `KLIDE_COORD_URL` survives a filtered child environment. It needs the
  binary, so it is opt-in:

```bash
cargo build && cargo test --lib -- --ignored the_real_mcp_child
```

What neither covers is a CLI's own permission layer — Claude Code refusing an
MCP tool nobody granted, which a headless turn cannot prompt for. That is
pinned in `claude_code.rs` (`klide_mcp_server_is_pre_allowed_on_a_headless_turn`)
and, end to end, only by a real `claude -p` run.

## Foundation success criteria

- A fresh process reconstructs the same snapshot solely from the journal.
- Private worktrees share one inbox without sharing file mutations.
- Runs in one Workspace can message one another; nobody but the operator, the
  Run itself, or its parent can cancel it.
- Duplicate retries do not append duplicate envelopes or results.
- Only the addressed Run can deliver and acknowledge an envelope.
- Terminal state cannot reopen.
- Interior corruption or a logically impossible journal fails closed. A torn
  final line, the one artefact a crash between write and flush can leave, is
  dropped by readers and trimmed by the next writer, exactly as the run
  Transcript handles it.
- A journal that cannot be read never stops a Run: that turn is delivered
  without an inbox and the reason is logged. Every Run with a Workspace
  registers, whatever its Mode, provider, or model. Chat carries the
  coordination Tools and nothing else — no file, shell, or memory Tool — so a
  Chat thread can be addressed and can answer while still touching nothing in
  the project.
