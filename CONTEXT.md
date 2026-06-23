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
and only then executes command-capability Tools.
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

**Transcript**:
The append-only JSONL record of a run's agent events on disk. A run can be replayed from it.
_Avoid_: log, history, chat history

**Provider**:
A model backend Klide can talk to — Ollama, LM Studio, Anthropic, OpenAI. Differs only in wire format; behaviour behind the seam is shared.
_Avoid_: vendor, backend, LLM

### Mission Control

**Mission Control**:
The board aggregating every run in the workspace — Klide convos and delegate tasks side by side — with observe / take over / stop controls.
_Avoid_: dashboard, agent panel

**Task**:
A queued todo on Mission Control. Starts as a plain item; "send an agent" dispatches a delegate to work on it. A task is the intent, the run is the work.
_Avoid_: ticket, issue, todo

**Delegate**:
An external CLI agent (Claude Code, Codex, OpenCode) dispatched into the workspace through a PTY session. Klide observes its output; it does not drive its loop. All per-CLI knowledge — spawn syntax, resume flags, session-id detection, transcript parsing — lives in the Delegate module (`src-tauri/src/delegate/`), one adapter per CLI; pty.rs and Mission Control consume the interface and know nothing CLI-specific.
_Avoid_: external agent, subprocess, CLI tool

**Klide convo**:
A snapshot of an AI-panel conversation published to Mission Control, so it stays on the board after its panel closes.
_Avoid_: chat, conversation, thread

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
