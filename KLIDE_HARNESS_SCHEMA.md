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
| **Plan** | `ReadOnly` tools only (12) — inspect, never edit or execute shell-backed dynamic tools |
| **Goal** | all kinds (17) + dynamic command tools — inspect + diff-reviewed edits + approval-gated commands + pause |

*Dynamic tools* (`load_dynamic_tools`) are shell-backed command tools loaded at
runtime from `.agents/tools.json`. They are Goal-only and pass through the same
permission gate, timeout, cwd validation, and transcript evidence path as
`run_command`. See [`HARNESS_CONTRACT.md`](./HARNESS_CONTRACT.md).

Run summaries also include transcript-derived validation evidence: file changes,
diff-review count, command count, failed commands, permission decisions, and
warnings for unverified implementation work.

## Tool registry (`src-tauri/src/agent/tools.rs`)

### Read-only (Plan + Goal) — 12

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
| `web_search` | Web search, up to 10 results. | CC/CX/OC |
| `web_fetch` | Fetch a URL as text. | CC/CX/OC |
| `get_todo_list` | Read the project TODO list. | CC (TodoWrite) |
| `update_todo_list` | add/complete/uncomplete/edit/remove/clear todos. *(Read-only kind: mutates the todo store, not workspace files — no diff review.)* | CC (TodoWrite) |

### Write (Goal only, every edit is diff-reviewed) — 3

| Tool | Purpose | Lineage |
|---|---|---|
| `write_file` | Search-and-replace on an existing file. `old_str` is matched tolerantly — leading `N: ` line-number prefixes and indentation differences are forgiven. After approval, Klide runs built-in Rust/JSON syntax checks and the optional Settings → Harness test-after-edit command. | **Pi** + CC (`str_replace`) + CX (`apply_patch`) |
| `create_file` | Create a new file (fails if it exists). After approval, Klide runs built-in Rust/JSON syntax checks and the optional Settings → Harness test-after-edit command. | CC/CX |
| `create_skill` | Save a reusable skill to `.agents/skills/<name>/SKILL.md`. | CC (skills) |

### Command (Goal only, approval-gated) — 1

| Tool | Purpose | Lineage |
|---|---|---|
| `run_command` | Run a shell command from the workspace root; returns stdout + stderr + exit code. The agent's way to run tests, build, typecheck, lint, install — i.e. verify its own work. Every new command is shown for **approval before it runs** (same permission gate diff review is for edits), via the wired `PermissionRequested`/`agent_resolve_permission` flow. "Approve for this run" stores the exact command in memory for the current run; "Approve for project" persists it to `.klide/command-allowlist.json` for future Klide runs in that workspace. Killed after a **timeout** (default 180s, Settings → Harness) so a hung command can't stall the run; output capped at 16KB. | CC/CX/OC (bash tool) + K (approval gate) |

### Pause (Goal only) — 1

| Tool | Purpose | Lineage |
|---|---|---|
| `userAnswerQuestion` | Pause the run and ask the user one free-form question; their typed answer returns as the tool result. Powers the Codebase Interview. One question per turn. | K |

## The edit contract *(Pi-derived, the core of write reliability)*

Why edits land cleanly even on small local models:

1. **Numbered reads** — `read_file` returns `N: ` line gutters (`tools.rs:928`).
2. **Tolerant matching** — `write_file` strips a copied `N: ` prefix and
   forgives indentation when locating `old_str` (`tools.rs:1633`), so a model
   that pastes a numbered line still edits.
3. **Post-edit syntax verify** — freshly written Rust/JSON is parsed in-process
   ("omp's post-edit diagnostics, lite", `tools.rs:1897`); advisory, not blocking.
4. **Diff review** — every write pauses for the user to APPLY or REJECT via a
   `oneshot` channel before anything touches disk. *(K)*

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
