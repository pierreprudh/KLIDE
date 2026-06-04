# Klide

The domain language of Klide — a minimalist AI-first IDE. One context for the whole repo: the editor shell, the agent harness, and Mission Control all share these terms. Architecture reviews and design discussions use this vocabulary; when code disagrees with it, the code is what drifts.

## Language

### Workspace

**Workspace**:
The single folder open in Klide. The root of all file access — nothing is read or written outside it.
_Avoid_: project, folder, root dir

**Workspace-rooted**:
The invariant that a path resolves inside the workspace, checked before any mutation. Every tool and file command must hold it.
_Avoid_: sandboxed, path-validated

### Agent execution

**Run**:
One agent working toward an outcome in the workspace, from start to done / error / aborted. Tracked on Mission Control whatever its source — Klide's own harness or a delegate.
_Avoid_: job, session, execution

**Harness**:
The Rust loop that drives a Klide-native run: provider streaming, tool dispatch, transcript writes, cancellation. There is exactly one; UI surfaces observe it, they don't reimplement it.
_Avoid_: agent loop, runner, executor

**Mode**:
The capability tier of a run — `chat` (no tools), `plan` (read-only tools), `goal` (full tools). Decided when the run starts.
_Avoid_: agent type, permission level

**Tool**:
A workspace-rooted capability the model can call during a run (read_file, grep, write_file…). Defined by a schema and an execution, which belong together.
_Avoid_: function, action

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
An external CLI agent (Claude Code, Codex) dispatched into the workspace through a PTY session. Klide observes its output; it does not drive its loop.
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
