# CLAUDE.md — Klide project context

This file is loaded automatically when Claude Code works in this directory. Read it first.

## What Klide is

Klide is a code editor Pierre is building from scratch. Inspired by [Sinew](https://sinew-ide.com/). The goal is a small, fast, AI-first IDE that **looks like a 2026 design tool** but **works like VS Code**.

Pierre is new to building desktop apps and is learning Rust as he goes. Frame technical explanations for a smart beginner — explain what each piece does, cite docs, and prefer fewer-moving-parts solutions.

## Vision in one sentence

**VS Code's structure, Linear's aesthetic, Cursor's AI fluency — Tauri-light, local-model-first.**

## Design philosophy

"Minimalist" here is a **visual/UX principle**, not a feature-pruning principle.

| ✅ Do | ❌ Don't |
|---|---|
| Keep VS Code's structural layout (activity bar, sidebar, tabs, editor, status bar, panel) | Strip out structural elements to "simplify" |
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
| Editor | **Monaco** via `@monaco-editor/react` | Same editor as VS Code |
| Terminal | **xterm.js** + Rust **portable-pty** | Real shell, not a sandbox |
| Frontend | **React 19 + TypeScript + Vite** | |
| Local AI | **Ollama** HTTP API on `localhost:11434` | Default model: `llama3.1:8b` |
| Online AI | Anthropic + OpenAI + Mistral + xAI | Keys in macOS Keychain, never in webview |

## Repo layout

```
Klide/
├── README.md                  Project pitch + status
├── GETTING_STARTED.md         Step-by-step build guide
├── CLAUDE.md                  This file
├── TODO.md                    Stabilization checklist + next moves
├── Ideas.md                   Future ideas + inspiration
├── src/                       React + TypeScript frontend
│   ├── main.tsx                 React boot
│   ├── App.tsx                  Root layout
│   ├── theme.ts                 5 themes + Monaco theme defs
│   ├── styles/tokens.css        CSS custom properties
│   ├── components/
│   │   ├── ActivityBar.tsx      Vertical icon bar (7 items)
│   │   ├── AiPanel.tsx          AI chat panel (post-split)
│   │   ├── CommandPalette.tsx   Cmd+P / Cmd+Shift+P modal
│   │   ├── ContextMenu.tsx      Right-click context menu
│   │   ├── DiffModal.tsx        Diff review modal
│   │   ├── EditorArea.tsx       Monaco editor wrapper
│   │   ├── GitPanel.tsx         Git staging + diff viewer
│   │   ├── LayoutBento.tsx      Layout picker widget
│   │   ├── LayoutCanvas.tsx     Visual layout editor
│   │   ├── GridWorkbench.tsx    Grid layout rendering
│   │   ├── GridLayoutBuilder.tsx Grid drag-and-drop builder
│   │   ├── MemoryModal.tsx      Centered Memory handoff-notes modal
│   │   ├── MemoryPanel.tsx      List+detail body inside MemoryModal
│   │   ├── MissionControl.tsx   Agent run board
│   │   ├── SearchPanel.tsx      Find-in-files results
│   │   ├── SettingsPanel.tsx    Full settings (8 sections)
│   │   ├── Sidebar.tsx          File explorer tree
│   │   ├── SkillsModal.tsx      Skill editor
│   │   ├── StatusBar.tsx        Bottom bar
│   │   ├── TabBar.tsx           Open file tabs
│   │   ├── TerminalPanel.tsx    xterm.js + Rust PTY
│   │   ├── WelcomeScreen.tsx    Empty-state screen
│   │   └── ai/                  Extracted AI panel modules
│   │       ├── types.ts           Msg, QueuedTurn, Conversation
│   │       ├── icons.tsx          Provider logos, action icons
│   │       ├── utils.ts           Tokens, fuzzy files, persistence
│   │       ├── system-prompt.ts   buildSystemPrompt
│   │       ├── tool-execution.ts  executeTool, toOllamaMessage
│   │       ├── markdown.tsx       CodeBlock, renderMarkdown
│   │       ├── ChatMessage.tsx    renderMessageBody
│   │       ├── summarize.ts       Summarize-and-handoff helper
│   │       ├── ConversationHistory.tsx
│   │       └── DelegateTerminal.tsx
│   ├── agent/
│   │   ├── types.ts             Agent protocol types (events, diffs, permissions)
│   │   ├── providers.ts         Provider definitions (12 providers)
│   │   ├── client.ts            Frontend agent harness client
│   │   ├── reducer.ts           Frontend state reducer for agent events
│   │   └── tools.ts             Frontend tool list fetcher (fetches from Rust)
│   ├── gridLayouts.ts           Freeform grid layouts
│   ├── layouts.ts               Fixed-frame layout presets
│   ├── memory.ts                Project Memory data layer
│   ├── panelLayout.ts           Floating panel rect store
│   ├── skills.ts                Skills store
│   ├── tasks.ts                 Delegated tasks
│   ├── runs.ts                  Agent run data layer
│   └── klideConvos.ts           AI panel → Mission Control pub/sub
└── src-tauri/                 Rust backend
    ├── Cargo.toml
    ├── src/
    │   ├── main.rs               Entry point
    │   ├── lib.rs                Tauri commands
    │   │   ├── AI chat dispatch (Ollama, OpenAI, Anthropic, Mistral, xAI)
    │   │   ├── Provider streaming trait + 3 adapters
    │   │   ├── Subscription CLI delegates (Claude Code, Codex, OpenCode)
    │   │   ├── File system ops + git commands
    │   │   ├── Memory read/write/list (project handoff notes)
    │   │   ├── Agent run listing (Claude Code, Codex, OpenCode, Klide)
    │   │   ├── Keychain-backed API key management
    │   │   ├── Tool list + find-in-files commands
    │   │   └── Tauri plugin registration
    │   ├── pty.rs                PTY management (native + delegate)
    │   ├── memory.rs             Project memory markdown I/O
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
- Max 8 turns, cancellation via `CancellationToken`

### Mission Control → AI panel handoff

Mission Control rows for CLI runs (claude-code / codex / opencode) carry a "Resume" / "Open in {CLI}" action that doesn't open a separate terminal — it asks the parent (`App.tsx`) to spawn a fresh AI panel pinned to the chosen delegate. The AI panel's `initialProvider` / `initialResumeSessionId` / `initialTask` props land the TUI in the right state on mount. The detail pane is transcript + metadata only; the TUI lives in the AI panel.

### Project Memory (handoff notes)

Durable end-of-session notes in `<workspace>/.klide/memory/` so a future agent (or future you) can pick up where the last session stopped.

- **Storage** — `src-tauri/src/memory.rs` writes one markdown file per entry with a YAML frontmatter (date, runId, provider, model, mode, status) + structured body (Goal / Plan / Decisions / Files touched / Next steps / Notes). Commands: `memory_write`, `memory_list`, `memory_read`.
- **Frontend** — `src/memory.ts` typed data layer; `MemoryPanel` is the list+detail body; `MemoryModal` is the centered overlay (same pattern as `SkillsModal`).
- **Trigger** — the AI panel header has a "Summarize" bookmark button (`src/components/ai/summarize.ts`) that calls the model once with a structured prompt, parses the response, and writes via `memory_write`. The first user message becomes the title; file paths are extracted from the conversation; the model produces Notes + Decisions + Goal.

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

## Features shipped (v0.2)

- [x] Activity bar (Files, Git, Memory, Skills, AI, Mission Control, Settings)
- [x] File explorer with tree view, git decorations, context menu, inline rename
- [x] Tabs with dirty indicator, unsaved-changes confirm
- [x] Monaco editor with syntax highlighting, Cmd+S, 5 themes
- [x] Status bar with file path, language, git branch, theme/terminal/layout toggles
- [x] Terminal panel with real shell via Rust portable-pty
- [x] AI panel — streaming chat with Ollama, Anthropic, OpenAI, Mistral, xAI
- [x] Agent mode — goal/plan modes, diff-reviewed edits, tool loop
- [x] Git panel — stage/unstage/commit with inline diff
- [x] Mission Control — aggregate agent run board (Claude Code, Codex, OpenCode, Klide) with handoff to AI panel
- [x] Project Memory — durable handoff notes in `.klide/memory/`, opened as a centered modal (Skills-style list+detail)
- [x] AI-panel "Summarize" header action — writes a structured memory note from the current conversation
- [x] Settings — 8 sections, API keys in macOS Keychain
- [x] Skills — AI instruction bundles with tool allowlists
- [x] Layout system — fixed presets + freeform grid builder
- [x] Command palette — Cmd+P files, Cmd+Shift+P commands
- [x] Find in files — Cmd+Shift+F, Rust-backed search

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
- Inspiration — <https://sinew-ide.com/>
