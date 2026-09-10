# Klide

The domain language of Klide — a minimalist AI-first IDE. One context for the whole repo: the editor shell, the agent harness, and Mission Control all share these terms. Architecture reviews and design discussions use this vocabulary; when code disagrees with it, the code is what drifts.

## Language

### Workspace

**Workspace**:
The single folder open in Klide. The root of all file access — nothing is read or written outside it.
_Avoid_: project, folder, root dir

**Workspace-rooted**:
The invariant that a path resolves inside the workspace, checked before any read or mutation. Enforced by the Workspace module (`src-tauri/src/workspace.rs`): commands and tools receive a `Workspace` value and resolve paths through it — there is no other sanctioned way to touch the filesystem from a path string.
_Avoid_: sandboxed, path-validated

### Agent execution

**Run**:
One agent working toward an outcome in the workspace, from start to done / error / aborted. Tracked on Mission Control whatever its source — Klide's own harness or a delegate.
_Avoid_: job, session, execution

**Harness**:
The Rust loop that drives a Klide-native run: provider streaming, tool dispatch, transcript writes, cancellation. There is exactly one; UI surfaces observe it, they don't reimplement it.
_Avoid_: agent loop, runner, executor

**Harness contract**:
The written interface of the Harness: modes, tool capabilities, permission
rules, diff review, dynamic tools, transcript evidence, and anti-slop
expectations. `HARNESS_CONTRACT.md` is the source of truth for this contract.
_Avoid_: implementation notes, rough docs

**Mode**:
The capability tier of a run — `chat` (no tools), `plan` (read-only tools), `goal` (full tools). Decided when the run starts.
_Avoid_: agent type, permission level

**Goal policy**:
What a `goal` run does with its two review gates — `review` (every edit pauses,
commands ask), `auto` (edits apply, still checkpointed; commands ask), `full`
(edits and commands, no prompts). Chosen per conversation — the live foot bar's
note cycles it; before a conversation exists, Focus's start-stage "+" menu lists
it — stamped onto each run request, never persisted (a reload reverts to
prompting).
_Avoid_: autonomy level, trust mode, rung (the ladder is gone)

**Tool**:
A workspace-rooted capability the model can call during a run (read_file, grep, write_file…). Defined by a schema and an execution, which belong together.
_Avoid_: function, action

**Tool capability**:
The trust effect of a Tool — read workspace, write workspace, run command,
pause for user, or future network access. Modes permit capabilities; individual
Tool names do not bypass that policy.
_Avoid_: tool category, permission flag

**Permission engine**:
The Harness decision path that classifies a Tool capability against the Mode,
emits a permission request when needed, remembers per-run approvals/rejections,
and only then executes command-, network- and message-capability Tools.
_Avoid_: confirmation modal, approval UI

**Validation contract**:
The evidence snapshot derived from the Transcript that says whether a Run's
changes were diff-reviewed and command-validated. It is a guardrail against AI
slop, not a proof that the implementation is correct.
_Avoid_: test result, quality score, correctness

**Goal loop**:
A bounded supervisor contract above one or more Runs: explicit goal,
definition of done, gates, revision/stall/budget limits, and a final stop
reason. It does not execute Tools. The Harness still owns provider turns and
Tool dispatch; the Goal loop decides whether the evidence is enough to keep
going, revise, stop, or record completion.
_Avoid_: autonomous mode, background agent, second harness

**Gate**:
A falsifiable review point in a Goal loop, such as plan coverage, delivery
coverage, Diff scope, command validation, semantic review, budget, or human
approval. A failed Gate creates bounded revision work; it does not create an
unbounded retry loop.
_Avoid_: vibe check, soft review, confidence score

**Agent event**:
A typed event a run emits (token, tool call, status change). The only way any surface learns what a run is doing.
_Avoid_: message, update

**Run coordination**:
The Rust-owned control plane through which Runs identify, address, steer, wait
for, cancel, and return structured work to one another. Its append-only journal
under `.klide/coordination/` is shared across private worktrees and folds into a
snapshot; the Harness, Delegate adapters, UI, embedded MCP, and future local
socket are consumers of this one domain, never competing coordinators.
_Avoid_: terminal orchestration, agent chat, external A2A provider, panel routing

**Coordination bridge**:
The app-process loopback door through which a Delegate CLI's embedded MCP
server reaches Run coordination. It binds the calling Run's identity and
Workspace from the PTY session Klide spawned — never from a request field —
and forwards each operation to the journal's single writer gate, so a Delegate
and a Harness Run share one authority and one change event.
_Avoid_: MCP proxy, agent API, second journal writer, remote coordination endpoint

**Coordination envelope**:
A durable semantic payload addressed from an operator or authenticated Run to
one stable Run id. It has an explicit kind, correlation/reply identity,
idempotency key, evidence references, and queued → delivered → acknowledged
lifecycle. Delivery happens at an execution adapter's safe boundary; terminal
bytes are never the authoritative envelope.
_Avoid_: Agent event, prompt injection, terminal text, chat message

**Coordination result**:
The single structured outcome a Run publishes for its coordinator: status,
summary, artifacts, and evidence references. A result reports work; reviewed
knowledge extracted from it may later become Project Memory, but the result
itself is not memory.
_Avoid_: last assistant message, terminal tail, memory entry

**Coordination snapshot**:
The replay-derived view of registered Runs, normalized states, cancellation
requests, envelope delivery, and results at one journal cursor. Consumers take
a snapshot and then read events from `nextSeq`; React state and focused panels
never become the source of truth.
_Avoid_: agent registry, live panel list, cached bus state

**Transcript**:
The append-only JSONL record of a run's agent events on disk. A run can be replayed from it.
_Avoid_: log, history, chat history

**Conversation**:
The reader-facing shape of a Transcript. There is one owner of the wire format,
`src/agent/foldEvents.ts`: `createFold` folds an Agent event stream into
`FoldedRow[]`, at two paces over the same code — replay drains a whole
transcript (`foldAgentEvents`), and the live run feeds it one event at a time
through the AI panel's turn driver. Two mappers project the rows into the two
shapes surfaces actually render — `Msg[]` for the AI panel, `RunMessage[]` for
Mission Control. Everything downstream is a projection of that fold, never a
second parse of the events.

Two further folds sit *on top* of it, and are views rather than parsers:
`src/transcripts.ts` compacts `RunMessage[]` into `ConversationItem[]` for the
board's detail pane, and `src/components/ai/replayConversation.ts` adds the
system lines a resumed panel needs to explain itself.

> This entry used to say `transcripts.ts` was the shared parser, "so Mission
> Control, Memory, and export share one parser". They never did: it has one
> importer, Mission Control. The sentence described an intention as if it were
> a fact, and pointed the domain's headline noun at the wrong module.

_Avoid_: chat log, message list, thread

**Stored conversation**:
The persisted record of one AI-panel Conversation — `Conversation` in
`src/components/ai/types.ts`: an id, a title, its `Msg[]`, and the Provider,
model, Workspace, Git metadata and lineage it was worked in. This is what the
conversation index holds and what resume and fork pass around. It is a
*different shape* from the Conversation fold above, and the two share a name in
code; when it matters, say which.
_Avoid_: chat, session, history entry

**Conversation session**:
The live AI-panel state that binds one Conversation to its Provider, model,
Workspace, lineage, Git metadata, and current Run activity. It owns navigation
between fresh, restored, resumed, and branched Conversations; it is not itself
a Run, because one Conversation session may be idle between Runs.
_Avoid_: chat state, thread state, panel globals

**Project Memory**:
Reviewed, Workspace-scoped knowledge that survives Runs: decisions,
conventions, facts, failures, patterns, and handoffs. One entry is a versioned
Markdown file under `.klide/memory/`; Markdown is authoritative and any search
index is derived. A draft is not Project Memory until the user accepts it.
_Avoid_: external memory provider, vector database, chat memory

**Memory source**:
A structured reference from Project Memory back to the evidence that produced
it — a Run, Transcript region, commit, or Workspace-relative file/line. Recall
preserves these references so a model and reviewer can inspect the why behind
the knowledge.
_Avoid_: citation string, confidence score

**Memory recall**:
A native Harness read of reviewed Project Memory. `memory_search` returns
ranked summaries and match reasons; `memory_read` resolves one authoritative
entry. Both carry the `ReadProjectMemory` capability, and their Tool events make
the recalled knowledge part of the Transcript evidence.
_Avoid_: RAG call, prompt stuffing, MCP lookup

**Panel fleet**:
The host-owned collection of live Conversation sessions. It routes targeted
resumes, startup handoffs, race tabs, and follow-up messages by panel id. Panel
geometry is not fleet state; the layout module owns placement and persistence.
_Avoid_: global panel state, panel list

**Provider**:
A model backend Klide can talk to — Ollama, LM Studio, Anthropic, OpenAI. Differs only in wire format; behaviour behind the seam is shared.
_Avoid_: vendor, backend, LLM

**Auto**:
The Provider the picker sends when the user leaves the model choice to Klide.
Not a backend: the Harness router (`src-tauri/src/agent/routing.rs`) replaces
it with a concrete Provider + model at run start, and `RunStarted` carries the
resolved pair, so every surface shows what actually ran. The rule is: rule out
what cannot do the job (no key, server down, no tools when the Mode needs
them, a window the prompt won't fit); prefer starred models, cheapest first,
then what is installed locally; lock the pick for the conversation — a
continuation reuses its origin, never routes again. `RouteResolved` records
the reason and what was ruled out. Distinct from the Goal policy's `auto`
(edits apply without review): that is a review setting, this is a Provider.
_Avoid_: smart mode, auto-select, model router (the router is the mechanism;
Auto is the choice the user makes)

### Mission Control

**Mission Control**:
The board aggregating every run in the workspace — Klide convos and delegate tasks side by side — with observe / take over / stop controls.
_Avoid_: dashboard, agent panel

**Run inspection**:
The resolved detail subject for one Mission Control selection. It prefers a
durable Transcript over its live Klide convo twin, supplies live messages only
until that Transcript lands, and resolves fork lineage around the same Run.
_Avoid_: selected row state, detail-pane data

**Task**:
A queued todo on Mission Control. Starts as a plain item; "send an agent" dispatches a delegate to work on it. A task is the intent, the run is the work.
_Avoid_: ticket, issue, todo

**Delegate**:
An external CLI agent (Claude Code, Codex, OpenCode) dispatched into the workspace through a PTY session. Klide observes its output; it does not drive its loop. All per-CLI knowledge — spawn syntax, resume flags, session-id detection, transcript parsing — lives in the Delegate module (`src-tauri/src/delegate/`), one adapter per CLI; pty.rs and Mission Control consume the interface and know nothing CLI-specific.
_Avoid_: external agent, subprocess, CLI tool

**Klide convo**:
A snapshot of an AI-panel conversation published to Mission Control, so it stays on the board after its panel closes.
_Avoid_: chat, conversation, thread

**Account snapshot**:
A saved copy of the credentials a Delegate CLI already wrote, captured so Klide can switch which account that CLI runs under (personal vs. work). Snapshot/restore only — Klide never mints or refreshes tokens. Stored under `~/.klide/accounts/<provider>/`.
_Avoid_: login, credential, token

**Account provider**:
The per-CLI seam for Account snapshots (`src-tauri/src/accounts.rs`) — one `AccountProvider` adapter per CLI (Codex / Claude Code / OpenCode) behind a trait, resolved by a single `provider(id)` registry. Mirrors the Delegate seam: where a login lives, how to read its identity, and how to capture and restore it all sit behind the trait; the generic save / list / activate flow knows nothing CLI-specific.
_Avoid_: account manager, credential handler

### Prompt assembly

**Skill**:
A user-authored prompt extension injected into a run's system prompt when active.
_Avoid_: plugin, extension, preset

**Lens**:
The auto-selected slice of project context (open file, related files, workspace landmarks) appended to a prompt. Scored per message; capped small.
_Avoid_: context tray, project context, RAG

**Diff review**:
The accept/reject gate a run's file edits pass through before landing in the workspace.
_Avoid_: approval, confirmation
