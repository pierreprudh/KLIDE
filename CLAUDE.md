# CLAUDE.md — Klide project context

This file is loaded automatically when Claude Code works in this directory. Read it first.

## What Klide is

Klide is a code editor Pierre is building from scratch. The goal is a small, fast, AI-first IDE that **looks like a 2026 design tool**, **works like a full-featured code editor**, and **treats agents as a first-class surface** — an editor and an agentic control panel in one shell.

Pierre is new to building desktop apps and is learning Rust as he goes. Frame technical explanations for a smart beginner — explain what each piece does, cite docs, and prefer fewer-moving-parts solutions.

## Vision in one sentence

**A familiar IDE structure, a calm minimal aesthetic, and fluent AI — Tauri-light, local-model-first, agent-native.**

## Design philosophy

"Minimalist" here is a **visual/UX principle**, not a feature-pruning principle.

| ✅ Do | ❌ Don't |
|---|---|
| Keep the familiar IDE structural layout (activity bar, sidebar, tabs, editor, status bar, panel) | Strip out structural elements to "simplify" |
| Quiet light/dark palettes with shared app + terminal tokens | Saturated accent colors, gradients, drop shadows |
| Generous whitespace, thin 1px borders, no heavy dividers | Boxes, frames, busy chrome |
| Restrained type — Atkinson Hyperlegible for UI, Monaspace for code | Multiple display fonts, decorative weights |
| Subtle, considered motion (fades, no bounces) | Springy animations |
| Icons only when they earn their place | Icon-for-every-button maximalism |

If a UI element doesn't serve clarity, it doesn't ship.

## Stack

| Layer | Tech | Notes |
|---|---|---|
| Shell | **Tauri 2** | Rust backend, native webview, ~10 MB binary |
| Editor | **Monaco** via `@monaco-editor/react` | The browser editor core (also used by VS Code) |
| Terminal | **xterm.js** + Rust **portable-pty** | Real shell, not a sandbox |
| Frontend | **React 19 + TypeScript + Vite** | |
| Local AI | **Ollama** (`localhost:11434`) + **MLX** (`mlx_lm.server` on `:8080`) | Both run the full tool harness; default `llama3.1:8b` |
| Online AI | Anthropic, OpenAI, Mistral, xAI + self-hosted OpenAI-wire endpoints | Keys in macOS Keychain; self-hosted tokens via `${VAR}` refs |
| Auto-install | `npx skills add <owner/repo>` | Skill install + uninstall via Rust commands |

## Repo layout

```
Klide/
├── README.md                  Project pitch + status
├── CLAUDE.md                  This file
├── TODO.md                    Current milestone + shipped history
├── Ideas.md                   Future ideas + inspiration
├── src/                       React + TypeScript frontend
│   ├── main.tsx                 React boot
│   ├── App.tsx                  Root layout — composes view/panel/editor state; threads props
│   ├── theme.ts                 5 themes + Monaco theme defs
│   ├── styles/tokens.css        CSS custom properties + design primitives
│   ├── hooks/
│   │   ├── useFlipIndicator.ts  Shared FLIP animation for rail/tab indicators
│   │   ├── useEditorTabs.ts    Open tabs: open/edit/save/close/rename, external-change watch, reveal
│   │   └── usePanelLayout.ts   Workbench size + panel rects + AI-panel list (hydrate/persist/clamp)
│   ├── components/
│   │   ├── ActivityBar.tsx      Left rail — top zone (6 tools, FLIP) + bottom zone (Settings + Profile, dock dot)
│   │   ├── AiPanel.tsx          AI chat panel host + run interaction surface
│   │   ├── CheckpointPanel.tsx  Per-run file checkpoint rollback UI
│   │   ├── CommandPalette.tsx   Cmd+P / Cmd+Shift+P modal
│   │   ├── ContextMenu.tsx      Right-click context menu
│   │   ├── EditorArea.tsx       Monaco editor wrapper
│   │   ├── FileViewerPanel.tsx  Read-only Quick View overlay
│   │   ├── FloatingPanel.tsx    Free-floating, resizable, draggable panel shell
│   │   ├── GitReview.tsx        Full-view Git workbench (staging + diffs)
│   │   ├── GridLayoutBuilder.tsx Drag-and-drop grid layout editor
│   │   ├── GridWorkbench.tsx    Grid layout rendering
│   │   ├── LayoutBento.tsx      Layout picker widget
│   │   ├── LayoutCanvas.tsx     Visual layout editor
│   │   ├── MemoryModal.tsx      Centered Memory handoff-notes modal
│   │   ├── MemoryPanel.tsx      List+detail body inside MemoryModal
│   │   ├── MissionControl.tsx   Run board, attention/review, races + delegate handoff
│   │   ├── OrchestratorConsole.tsx Mission planner + chained execution board
│   │   ├── ProfileModal.tsx     Local IDE profile (avatar + identity + workspace)
│   │   ├── SearchPanel.tsx      Find-in-files results
│   │   ├── SettingsPanel.tsx    Full settings (keychain, harness, stats)
│   │   ├── Sidebar.tsx          File explorer tree
│   │   ├── SkillsModal.tsx      Skill editor + install + provenance groups
│   │   ├── SplitPane.tsx        Vertical/horizontal split shell
│   │   ├── StatusBar.tsx        Bottom bar — file/lang/branch/notice/chips
│   │   ├── TabBar.tsx           Open file tabs (FLIP-animated underline)
│   │   ├── TerminalPanel.tsx    xterm.js + Rust PTY
│   │   ├── TodoStrip.tsx        Project-wide todo list strip
│   │   ├── WelcomeScreen.tsx    Empty-state screen
│   │   └── ai/                  Extracted AI panel modules
│   │       ├── types.ts           Msg, QueuedTurn, Conversation
│   │       ├── icons.tsx          Provider logos, action icons
│   │       ├── utils.ts           Tokens, fuzzy files, persistence
│   │       ├── system-prompt.ts   buildSystemPrompt
│   │       ├── markdown.tsx       CodeBlock, renderMarkdown
│   │       ├── ChatMessage.tsx    renderMessageBody
│   │       ├── eventsToMsgs.ts    AgentEvent replay into chat messages
│   │       ├── summarize.ts       Summarize-and-handoff + auto-skill detect
│   │       ├── ConversationHistory.tsx
│   │       └── DelegateTerminal.tsx
│   ├── agent/
│   │   ├── types.ts             Agent protocol types (events, diffs, permissions)
│   │   ├── providers.ts         Provider definitions (12 providers)
│   │   ├── client.ts            Frontend agent harness client
│   │   ├── race.ts              Same-task multi-run dispatch into isolated worktrees
│   │   ├── missionChain.ts      Dependency-aware mission dispatch
│   │   ├── routingPolicy.ts     Deterministic tier/model routing
│   │   └── tools.ts             Frontend tool list fetcher (fetches from Rust)
│   ├── gridLayouts.ts           Freeform grid layouts
│   ├── layouts.ts               Fixed-frame layout presets
│   ├── memory.ts                Project Memory data layer
│   ├── races.ts                 Persisted race-group membership + pub/sub
│   ├── panelLayout.ts           Floating panel rect store
│   ├── skills.ts                Skills store (loader + auto-grant)
│   ├── tasks.ts                 Delegated tasks
│   ├── runs.ts                  Agent run data layer
│   └── klideConvos.ts           AI panel → Mission Control pub/sub
└── src-tauri/                 Rust backend
    ├── Cargo.toml
    ├── src/
    │   ├── main.rs               Entry point
    │   ├── lib.rs                Command registration + thin Tauri glue, AI chat dispatch, keychain keys, fs ops, find-in-files, profile info, shared helpers
    │   ├── adapters.rs           Provider streaming trait + shared loop + 3 wire adapters (Ollama/OpenAI/Anthropic)
    │   ├── models.rs             Model discovery — list models, context windows, tool support
    │   ├── git/                  Git + gh commands (status/diff/log/worktree/PR)
    │   ├── skills.rs             Filesystem-skill loader (4 dirs, provenance) + install/uninstall
    │   ├── local_servers.rs      Ollama / MLX local server start/stop/status
    │   ├── pty.rs                PTY plumbing (native shell + delegate spawn)
    │   ├── workspace.rs          Workspace module — owns the Workspace-rooted invariant
    │   ├── memory.rs             Project memory markdown I/O
    │   ├── delegate/             Delegate seam — adapter per CLI (mod.rs trait+registry+run-listing; claude_code/codex/opencode; runs.rs shared types)
    │   └── agent/
    │       ├── mod.rs             Agent supervisor + run loop
    │       ├── tools.rs           Tool registry (schema + execution)
    │       ├── types.rs           Agent types (events, diffs, summaries)
    │       └── transcripts.rs     Transcript persistence (JSONL)
    └── capabilities/
```

## Architecture

### One agent loop (Rust harness unified)

The agent loop lives **exclusively in Rust** (`src-tauri/src/agent/mod.rs`). AiPanel is a pure view that starts runs and renders the `AgentEvent` stream. Mission Control reads the same events.

```
AiPanel (view) → startAgentRun() → Rust run_agent_loop()
    ↑                                     ↓
    └── AgentEvent stream ←───────────────┘
         (deltas, tool calls, diffs, results)
```

- Chat / Plan / Goal modes all go through the harness
- Write tools pause for diff review via `tokio::sync::oneshot` channels
- Diff approval triggers `agent_resolve_diff` → harness continues
- Default tool-turn cap 50 (configurable), cancellation via `CancellationToken`, auto-compaction on a recency + token-budget trigger

### Mission Control → AI panel handoff

Mission Control rows for CLI runs (claude-code / codex / opencode) carry a "Resume" / "Open in {CLI}" action that doesn't open a separate terminal — it asks the parent (`App.tsx`) to spawn a fresh AI panel pinned to the chosen delegate. The AI panel's `initialProvider` / `initialResumeSessionId` / `initialTask` props land the TUI in the right state on mount. The detail pane is transcript + metadata only; the TUI lives in the AI panel.

### Delegate session replay (scrollback + reattach)

Delegate PTYs (Claude Code / Codex / OpenCode / Oh My Pi) keep running in Rust
after their `DelegateTerminalSurface` unmounts. Each session holds a capped
256 KB `Scrollback` ring buffer + a monotonic chunk `seq` (`pty.rs`); every
`delegate-pty:data` event carries its `seq`. On (re)mount the terminal calls
`delegate_pty_snapshot` to repaint history, then dedupes live chunks by `seq` —
so a panel switch no longer returns a blank terminal. Mission Control shows a
**Live now** strip (`delegate_pty_live_sessions`) with a **Reattach** action that
opens an AI panel bound to the session's conversation id (`initialConversationId`)
so its terminal reconnects + replays — distinct from "Resume", which `--resume`s
an on-disk run. The live PTY remains process-owned, while its bounded scrollback
and spawn metadata are mirrored to disk so Recent sessions can repaint history
after an app restart. Full design + roadmap: `docs/delegate-session-replay.md`.

### Project Memory (handoff notes)

Durable end-of-session notes in `<workspace>/.klide/memory/` so a future agent (or future you) can pick up where the last session stopped.

- **Storage** — `src-tauri/src/memory.rs` writes one markdown file per entry with a YAML frontmatter (date, runId, provider, model, mode, status) + structured body (Goal / Plan / Decisions / Files touched / Next steps / Notes). Commands: `memory_write`, `memory_list`, `memory_read`.
- **Frontend** — `src/memory.ts` typed data layer; `MemoryPanel` is the list+detail body; `MemoryModal` is the centered overlay (same pattern as `SkillsModal`).
- **Trigger** — the AI panel header has a "Summarize" bookmark button (`src/components/ai/summarize.ts`) that calls the model once with a structured prompt, parses the response, and writes via `memory_write`. The first user message becomes the title; file paths are extracted from the conversation; the model produces Notes + Decisions + Goal.

### v0.5 closeout and next milestone

v0.5 was declared feature-complete on 2026-07-21. Mission Control is the
operations surface for Klide Harness runs and Delegate runs; review evidence,
worktree fleets, mission chaining, subagents, advisor escalation, and two-agent
races are shipped. v0.5.1 owns release hardening and publishing: full
race/restart/merge dogfooding, default worktree isolation, provider-aware
historical lifecycle signals, the first signed/notarized macOS bundle, and
Windows/Linux validation.

The next product milestone is v0.6, dependable orchestration: Missions as
outcomes, visible budget and capacity, capability-based worker routing,
automatic validation contracts, and durable background execution. Do not
unpark scheduling or proactive suggestions ahead of those foundations.

The first v0.6 tracer bullet establishes the durability boundary: Rust owns
`.klide/missions/<id>/mission.md`, `tasks/*.md`, and append-only
`events.jsonl`; TypeScript only compiles those documents/events into
`MissionState`. A Mission Task owns zero or more Run attempts and one accepted
attempt — Task id and Run id are never the same lifecycle object. The detached
Rust Harness writes validation back to the linked Mission after it settles,
and dependency readiness gates on an accepted attempt, never on process exit.
Approval freezes the worker kind, provider, model, and diff-review policy into
each task Markdown file. A one-at-a-time Rust Mission supervisor now selects an
unattempted ready task, attaches and starts its Harness Run headlessly, and
re-enters after validation; rejected attempts park for explicit retry. The
tier-board only observes events and reattaches to operator pauses. Full
desktop-process restart/orphan reconciliation and the graph editor remain the
next durability/UI slices.

- Keep the Rust harness as the only durable agent loop. Do not reintroduce a frontend tool-dispatch loop.
- Treat Mission Control as the place to inspect runs and hand them off; delegate TUIs resume in AI panels.
- Treat Project Memory as the continuity surface. The older Context Lens/project-graph path is parked unless it feeds memory or summarization directly.
- Skills now load from four well-known locations (workspace `.agents/skills`, workspace `.klide/skills`, user `.agents/skills`, user `.claude/skills`), and the install + uninstall flow is wired through `install_skill` / `uninstall_skill` Rust commands. Provenance is grouped by `metadata.author` / GitHub repo owner into Workspace / Personal / Vercel / Matt Pocock / Anthropic / Other.
- "Save as skill" sparkle in the AI panel header (`detectAndGenerateSkill` in `src/components/ai/summarize.ts`) auto-generates a `SKILL.md` to `<workspace>/.klide/skills/<slug>/` when the model detects a reusable pattern.

### Provider streaming (1 loop, 3 adapters)

```
trait StreamingProvider            // the seam
├── fn build_request() → reqwest
├── fn parse_line()     → one format
└── fn finalize_response() → AiChatResponse

stream_provider()                  // shared loop (one copy)
├── POST → status → buffer/line → parse → assemble

OllamaAdapter      (~60 lines)
OpenAiAdapter      (~80 lines)
AnthropicAdapter   (~95 lines)
```

New provider (e.g. LM Studio) = one adapter, not 120 lines of duplicated infrastructure.

### Tool registry (Rust source of truth)

Each tool is defined once in `src-tauri/src/agent/tools.rs` as a `ToolEntry`:
```
ToolEntry { kind, schema, run_read, run_write_preview }
```

- `schemas_for_mode(mode)` filters the registry by kind
- `execute_read_only_tool()` and `execute_write_tool_preview()` dispatch through registry lookup
- Frontend fetches schemas via `invoke("ai_list_tools", { mode })` — no duplicate TS schemas

### IPC patterns

| Direction | Mechanism | Used for |
|---|---|---|
| Frontend → Rust | `invoke()` | File ops, git, AI chat, agent commands |
| Rust → Frontend (request-scoped) | `Channel<T>` | AI token streaming, agent events |
| Rust → Frontend (global) | `emit()` / `listen()` | PTY data, delegate PTY data |

## Features shipped (through v0.5)

- [x] Activity bar — top zone (6 tools) with FLIP-animated indicator + bottom zone (Settings + Profile) with a dock-style dot and a hairline divider.
- [x] File explorer with tree view, git decorations, context menu, inline rename
- [x] Tabs with dirty indicator, unsaved-changes confirm, FLIP-animated 2px bottom accent bar
- [x] Monaco editor with syntax highlighting, Cmd+S, 5 themes
- [x] Status bar — file path, language, git branch, theme/terminal/layout toggles, dot separators
- [x] Terminal panel with real shell via Rust portable-pty
- [x] AI panel — streaming chat across Ollama, MLX, Anthropic, OpenAI, Mistral, xAI + self-hosted endpoints, 14 built-in tools, inline diff review + auto-accept toggle
- [x] Agent mode — goal/plan modes, diff-reviewed edits, tool loop
- [x] Git panel — full-view Git Review workbench (staging + diffs)
- [x] Mission Control — aggregate agent run board (Claude Code, Codex, OpenCode, Oh My Pi, Klide) with handoff to AI panel
- [x] Project Memory — durable handoff notes in `.klide/memory/`, opened as a centered modal
- [x] AI-panel "Summarize" header action — writes a structured memory note from the current conversation
- [x] AI-panel "Save as skill" sparkle — auto-generates a `SKILL.md` for reusable patterns
- [x] Settings — keychain-backed keys, harness settings editor, stats panel
- [x] Skills — instruction bundles with tool allowlists, loaded from 4 filesystem locations, install/uninstall via `npx skills add`, provenance grouping
- [x] Profile modal — local IDE profile (avatar + identity + workspace), `⌘.`
- [x] Layout system — fixed presets + freeform grid builder
- [x] Command palette — Cmd+P files, Cmd+Shift+P commands (incl. `View: Open Profile`)
- [x] Find in files — Cmd+Shift+F, Rust-backed search
- [x] Checkpoint rollback — preview files changed since a turn and revert selected ones
- [x] Project todo list — Rust-backed store, agent tools to add/complete items

## Development

```bash
npm install            # one-time
npm run tauri dev      # full dev loop (Vite + Rust hot reload)
```

`npx tsc --noEmit` and `cargo check` (in `src-tauri/`) must pass clean before committing.

## Working conventions

- **Two halves, two languages.** Frontend = TypeScript/React in `src/`. Backend = Rust in `src-tauri/`. They talk via `invoke()` (request/reply), `Channel<T>` (request-scoped streaming), and `emit`/`listen` (global events).
- **The Rust harness is the agent run module.** AiPanel starts runs and renders events; it does not run its own tool loop. All modes (Chat, Plan, Goal) go through `startAgentRun()`.
- **No API keys in the frontend.** Provider keys live in macOS Keychain (`keyring` crate), never in localStorage or React state.
- **Workspace-rooted file access.** Agent tools verify paths are inside the workspace before reading/writing.
- **Tools are defined once in Rust.** The `ToolEntry` struct bundles schema, kind, and execution together. Frontend fetches schemas over IPC.
- **Styling: inline styles for now.** No CSS framework before v1.0. CSS custom properties in `src/styles/tokens.css` for theming.

## Reference

- Tauri 2 docs — <https://v2.tauri.app>
- Monaco React — <https://github.com/suren-atoyan/monaco-react>
- xterm.js — <https://xtermjs.org/docs/>
- Ollama API — <https://github.com/ollama/ollama/blob/main/docs/api.md>
- MLX LM server — <https://github.com/ml-explore/mlx-lm>
