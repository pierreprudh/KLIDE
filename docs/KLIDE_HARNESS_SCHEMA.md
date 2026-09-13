# Klide Harness — Schema & Tool Lineage

What the Klide agent harness *is*, every tool it exposes, and where each tool's
design comes from. Klide's harness is **its own agent**, synthesizing patterns
from Claude Code, OpenCode, Pi (Oh My Pi / `omp`), and Codex — it is not any one
of them, and it never identifies as a third-party product.

Source of truth: `src-tauri/src/agent/` (the loop + registry). The frontend
fetches schemas over IPC (`ai_list_tools`) — there is no second TS copy.

## Lineage legend

| Tag | Origin | What Klide took |
|---|---|---|
| **CC** | Claude Code | tool naming (`read_file`/`grep`/`glob`), `str_replace`-style edits, TODO tool, skills |
| **OC** | OpenCode | read/search tool surface, context-compaction spirit, sub-agent nesting (delegate side) |
| **Pi** | Oh My Pi (`omp`) | the *edit contract* — numbered reads + tolerant write matching + post-edit syntax verify; `MAX_TURNS` |
| **CX** | Codex | `apply_patch` edit discipline (informs the diff-review contract) |
| **K** | Klide-native | diff-review UX, `clean_context`, `userAnswerQuestion`/interview, git surface, delegate seam, the loop itself |

## Architecture

```
AiPanel (view) ──startAgentRun()──▶  run_agent_loop()  [Rust, src-tauri/src/agent/mod.rs]
     ▲                                      │
     └────────── AgentEvent stream ◀────────┘
        (deltas, tool calls, diffs, results)
```

- **One loop, in Rust.** All modes (Chat / Plan / Goal) go through it. The
  frontend starts runs and renders the `AgentEvent` stream; it does not run its
  own tool loop. *(K)*
- **Model-agnostic.** The same loop drives every provider (Ollama, Anthropic,
  OpenAI, Mistral, xAI, custom endpoints). The model is interchangeable; the
  harness identity is Klide's. *(K)*
- **Bounded, configurable.** Tool-turn cap defaults to **50** and is set in
  Settings → Harness ("Max tool turns", up to 500; hard ceiling 1000). It's a
  runaway-loop guard, not a task-size limit — the conversation can always be
  continued past it. *(Pi — the cap concept; K — configurability)*
- **Continuation-aware.** Resuming replays prior turns as faithful structured
  tool messages so the model keeps its memory across turns. *(K)*

## Modes → tools

Tools are filtered by **kind** per mode (`tools.rs:list_tools`):

| Mode | Tools exposed |
|---|---|
| **Chat** | none — converse from visible context only |
| **Plan** | Workspace reads (9) + Conversation history (1) + Project Memory (2) + Plan state (1), plus the advisor exception — inspect local context and keep the plan, never edit, execute shell-backed dynamic tools, or use network |
| **Goal** | all built-in Tools (22) + dynamic command tools — inspect + approval-gated network reads + diff-reviewed edits + approval-gated commands + pause |

*Dynamic tools* (`load_dynamic_tools`) are shell-backed command tools loaded at
runtime from `.agents/tools.json`. They are Goal-only and pass through the same
permission gate, timeout, cwd validation, and transcript evidence path as
`run_command`. See [`HARNESS_CONTRACT.md`](./HARNESS_CONTRACT.md).

Run summaries also include transcript-derived validation evidence: file changes,
diff-review count, command count, failed commands, permission decisions, and
warnings for unverified implementation work.

## Tool registry (`src-tauri/src/agent/tools.rs`)

### Read-only workspace tools (Plan + Goal) — 9

| Tool | Purpose | Lineage |
|---|---|---|
| `read_file` | Read a file. Lines are returned numbered `N: ` so edits can copy them verbatim. | CC + **Pi** (numbered reads) |
| `list_dir` | List a directory (`.` = root). | CC/OC |
| `glob` | Find files by `*`/`?` pattern. | CC/OC |
| `grep` | Literal text search across files. | CC/OC |
| `get_git_status` | Branch + changed files. | K |
| `get_git_diff` | Diff for the workspace or one path (staged optional). | K |
| `get_git_log` | Recent commit history (hash/subject/date/author). | K |
| `clean_context` | Drop dead-end tool results from the current turn (replaced by `[cleaned: …]`), keeping the prompt cache intact. | K (OC compaction spirit) |
| `get_todo_list` | Read the project TODO list. | CC (TodoWrite) |

### Plan state (Plan + Goal) — 1

| Tool | Purpose | Lineage |
|---|---|---|
| `update_todo_list` | add/complete/uncomplete/edit/remove/clear todos. *(`PlanState` kind, capability `UpdatePlanState`: it mutates Klide's own planning metadata, not workspace files — so it runs in Plan mode with no diff review.)* | CC (TodoWrite) |

### Conversation history (Plan + Goal) — 1

| Tool | Purpose | Lineage |
|---|---|---|
| `search_conversations` | Search prior Klide Harness Conversations in the current Workspace, excluding the current Run and its children. Carries `ReadConversationHistory`, not `ReadWorkspace`. | K |

### Project Memory (Plan + Goal) — 2

| Tool | Purpose | Lineage |
|---|---|---|
| `memory_search` | Deterministically search reviewed, Workspace-scoped Project Memory by terms and optional kinds. Returns scores, matched fields, excerpts, and provenance metadata; stale/superseded entries stay out unless explicitly requested. | K |
| `memory_read` | Read the authoritative Markdown and structured provenance for one stable memory id. Id and Workspace-root checks prevent traversal outside `.klide/memory/`. | K |

Both carry capability `ReadProjectMemory` (`read_project_memory` in the
Transcript). See [`KLIDE_MEMORY_SCHEMA.md`](./KLIDE_MEMORY_SCHEMA.md).

### Network (Goal only) — 2

| Tool | Purpose | Lineage |
|---|---|---|
| `web_search` | Web search, up to 10 results. Pauses for approval; run/project approval targets `web_search`. | CC/CX/OC + K (approval gate) |
| `web_fetch` | Fetch a URL as text. Pauses for approval; run/project approval targets the fetched host, e.g. `host:docs.rs`, persisted in `.klide/network-allowlist.json` for project scope. | CC/CX/OC + K (approval gate) |

### Write (Goal only, every edit is diff-reviewed) — 3

| Tool | Purpose | Lineage |
|---|---|---|
| `write_file` | Search-and-replace on an existing file. `old_str` is matched tolerantly — leading `N: ` line-number prefixes and indentation differences are forgiven. After approval, Klide runs built-in Rust/JSON syntax checks and the optional Settings → Harness test-after-edit command. | **Pi** + CC (`str_replace`) + CX (`apply_patch`) |
| `create_file` | Create a new file (fails if it exists). After approval, Klide runs built-in Rust/JSON syntax checks and the optional Settings → Harness test-after-edit command. | CC/CX |
| `create_skill` | Save a reusable skill to `.agents/skills/<name>/SKILL.md`. | CC (skills) |

### Command (Goal only, approval-gated) — 1

| Tool | Purpose | Lineage |
|---|---|---|
| `run_command` | Run a shell command from the workspace root; returns stdout + stderr + exit code. The agent's way to run tests, build, typecheck, lint, install — i.e. verify its own work. Every new command is shown for **approval before it runs** (same permission gate diff review is for edits), via the wired `PermissionRequested`/`agent_resolve_permission` flow. The Harness preflights paths resolving outside the workspace (absolute, `~`/`$HOME`/`$PWD`, and relative `..` escapes) and shows them in the permission request. "Approve for this run" stores the exact command/cwd in memory for the current run; "Approve for project" persists the exact command to `.klide/command-allowlist.json`, whose `rules` array can also hold intentional wildcard patterns like `cargo test *`. Killed after a **timeout** (default 180s, Settings → Harness) so a hung command can't stall the run; output capped at 16KB. | CC/CX/OC (bash tool) + K (approval gate) |

### Pause (Goal only) — 3

A Pause tool does not execute in Rust at all: the registry entry has no
`run_read`/`run_write_preview`, and the loop parks the Run on a `oneshot` until
something outside it answers.

| Tool | Purpose | Lineage |
|---|---|---|
| `userAnswerQuestion` | Pause the run and ask the user one free-form question; their typed answer returns as the tool result. Powers the Codebase Interview. One question per turn. | K |
| `spawn_subagent` | Delegate a focused, read-only investigation to a named subagent (`explorer` maps code, `reviewer` critiques it) and get its report back as the tool result. The subagent cannot edit — it parallelises discovery without spending the parent's context. Roles live in `src-tauri/src/agent/subagents.rs`, mirrored by `src/agent/subagents.ts`. | OC (sub-agent nesting) + K |
| `consult_advisor` | Escalate one hard decision to a stronger advisor model without handing off the task. Emits `AdvisorRequested`; the frontend puts the self-contained question to the advisor (a bigger model or a Claude Code session) and resolves with the advice. The cheap executor stays in control and applies it. | K (the advisor strategy) |

## The edit contract *(Pi-derived, the core of write reliability)*

Why edits land cleanly even on small local models:

1. **Numbered reads** — `read_file` returns `N: ` line gutters (`number_lines`).
2. **Tolerant matching** — `write_file` strips a copied `N: ` prefix and
   forgives indentation when locating `old_str` (`normalize_match_line` +
   the line-based fallback in `locate_edit`), so a model that pastes a
   numbered line still edits.
3. **Post-edit syntax verify** — freshly written Rust/JSON is parsed in-process
   ("omp's post-edit diagnostics, lite", `verify_syntax`); advisory, not blocking.
4. **Diff review** — every write pauses for the user to APPLY or REJECT via a
   `oneshot` channel before anything touches disk. Applied writes can be
   reverted one checkpoint at a time or all remaining checkpoints for the Run.
   *(K)*

## Delegate mode *(K — the delegate seam)*

Goal-mode runs can be handed to a real external CLI instead of Klide's own loop.
Four adapters, each running the actual binary and reading its on-disk sessions
(`src-tauri/src/delegate/`):

| Adapter | Binary | Sessions |
|---|---|---|
| `claude-code` | `claude` | `~/.claude/projects/**/*.jsonl` |
| `codex` | `codex` | `~/.codex/sessions/**` |
| `opencode` | `opencode` | SQLite `~/.local/share/opencode/opencode.db` |
| `omp` (Pi) | `omp` | `~/.omp/agent/sessions/**` |

Mission Control aggregates runs from Klide's own loop **and** all four delegates
into one board.

## Evals

`src-tauri/src/agent/eval.rs` — golden scenarios that run scripted tool-call
sequences (what a model *would* emit) through the **real** execution path
(`execute_read_only_tool` / `execute_write_tool_preview` + `apply_write` /
`run_command_capture`) against a fixture workspace, then assert the resulting
files + tool results. It also has a scripted model-loop eval: fake provider
turns emit tool calls, the real tool layer executes, and tool results replay
into provider-shaped messages before the next turn. They run as `cargo test`
(`agent::eval`). Add a scenario by appending to `scenarios()` or
`scripted_model_scenarios()`.

Scope: this evals the harness's **deterministic** behavior (read → edit →
verify, command success/failure surfacing), plus the first model-loop shape:
did the harness react correctly to a provider that chose tools? The production
run loop now calls providers through `AgentProviderCaller` (`RealProviderCaller`
wraps `ai_chat`; tests can inject a mock). A fuller model-in-loop layer still
needs the remaining loop shell split away from `tauri::AppHandle`.

## Identity

The harness presents as **Klide's coding agent** running on whichever model the
user selected. It must not claim to be Claude, Claude Code, GPT, Codex, or any
other product — even when the injected project reference (`CLAUDE.md`) mentions
those names. Enforced in `src/components/ai/system-prompt.ts`.
