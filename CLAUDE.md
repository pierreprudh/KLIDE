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
| Keep the familiar IDE structural layout (sidebar rail, tabs, editor, status bar, panel) | Strip out structural elements to "simplify" |
| Quiet light/dark palettes with shared app + terminal tokens | Saturated accent colors, gradients, drop shadows |
| Generous whitespace, thin 1px borders, no heavy dividers | Boxes, frames, busy chrome |
| Restrained type — Atkinson Hyperlegible for UI, Monaspace for code | Multiple display fonts, decorative weights |
| Subtle, considered motion (fades, no bounces) | Springy animations |
| Icons only when they earn their place | Icon-for-every-button maximalism |

If a UI element doesn't serve clarity, it doesn't ship.

## Stack

| Layer | Tech | Notes |
|---|---|---|
| Shell | **Tauri 2** | Rust backend, native webview, 27 MB app bundle (measured 2026-08-24; re-measure with `du -sh src-tauri/target/release/bundle/macos/Klide.app`) |
| Editor | **Monaco** via `@monaco-editor/react` | The browser editor core (also used by VS Code) |
| Terminal | **xterm.js** + Rust **portable-pty** | Real shell, not a sandbox |
| Frontend | **React 19 + TypeScript + Vite** | |
| Local AI | **Ollama** (`localhost:11434`) + **MLX** (`mlx_lm.server` on `:8080`) | Both run the full tool harness; default `llama3.1:8b` |
| Online AI | Anthropic, OpenAI, Mistral, xAI, DeepSeek, OpenRouter + self-hosted OpenAI-wire endpoints | Keys in macOS Keychain; self-hosted tokens via `${VAR}` refs |
| Auto-install | `npx skills add <owner/repo>` | Skill install + uninstall via Rust commands |

## Repo layout

```
Klide/
├── README.md                  Project pitch + status
├── CLAUDE.md                  This file
├── CONTEXT.md                 Domain language — reviews use this vocabulary; code drifts, not it
├── CHANGELOG.md               Notable changes per milestone
├── TODO.md                    Current milestone + shipped history
├── Ideas.md                   Future ideas + inspiration (git-ignored, local only)
├── HARNESS_CONTRACT.md        The harness trust model (modes, capabilities, permissions)
├── KLIDE_HARNESS_SCHEMA.md    Tool interface schema
├── KLIDE_MEMORY_SCHEMA.md     Project Memory entry + retrieval/MCP contract
├── MEMORY_ENGINE.md           All-in-one memory architecture + PR sequence
├── MODEL_ROUTING.md           Auto model routing — the rule, the wire, what it deliberately is not
├── Design.md                  Design system — tokens, themes, principles (mirror changes in styles/tokens.css)
├── docs/                      Design docs (delegate replay, competitors, website) + adr/ (git-ignored, local only)
├── schemas/                   Versioned JSON Schemas for durable/wire contracts
├── src/                       React + TypeScript frontend
│   ├── main.tsx                 React boot
│   ├── monaco-setup.ts          Self-host Monaco from the npm bundle (no CDN fetch)
│   ├── App.tsx                  Root layout — composes view/panel/editor state; threads props
│   ├── theme.ts                 7 themes + Monaco theme defs
│   ├── styles/tokens.css        CSS custom properties + design primitives
│   ├── icons.tsx                App-wide icon vocabulary, one weight lever (Phosphor Light; brand/file marks stay hand-drawn)
│   ├── zLayers.ts               Z scale for root-level overlay stacking
│   ├── shortcuts.ts             Keyboard shortcut registry (names + displayed keycaps)
│   ├── settingsStore.ts         Declarative persisted-settings catalog + useSetting
│   ├── settingsNavigation.ts    Registered-opener seam — a data module can request a Settings section
│   ├── persistedStore.ts        The one persisted-store contract (get/subscribe/mutate) under the run-data stores
│   ├── toast.ts                 Global notification bus (surface: components/ToastHost.tsx)
│   ├── errors.ts                errMessage — readable text from any thrown value
│   ├── time.ts                  Shared elapsed-span + relative-time formatters
│   ├── fileSearch.ts            The one fuzzy file-path ranking (⌘P + @file picker)
│   ├── dragSession.ts           One reusable mouse-drag session for resize handles
│   ├── editorLanguage.ts        Extension → Monaco language id, single table
│   ├── terminalTheme.ts         One xterm theme/font/ANSI palette for every terminal surface
│   ├── terminals.ts             Terminal tab store that survives panel remounts
│   ├── tauriEvents.ts           Listener scope owning async Tauri event registrations
│   ├── workspaceFs.ts           Workspace-rooted fs invokes (join, list, read)
│   ├── projectPaths.ts          Path normalization + project/worktree ownership checks
│   ├── recentFolders.ts         Recent-folder ordering (remember on open, promote on work)
│   ├── focusHistory.ts          Focus rail history expand/collapse rules
│   ├── railDestinations.tsx     Foot-of-rail destinations shared by both rails
│   ├── modelIdentity.tsx        Model → display name + logo (modelBrand.tsx: maker mark + link)
│   ├── favModels.ts             Shared starred-model list
│   ├── runs.ts                  Agent run data layer
│   ├── runIsolation.ts          Default worktree-per-run policy — branch naming, local fallback
│   ├── runningConversations.ts  Which conversations have a live Harness Run right now (rail marker)
│   ├── runLedger.ts             Unified run ledger — merges tasks/convos/transcripts
│   ├── runPresentation.ts       The one status vocabulary: run state → word + tone
│   ├── runInspection.ts         Mission Control detail-subject resolution + lineage
│   ├── races.ts                 Persisted race-group membership + pub/sub
│   ├── tasks.ts                 Delegated tasks
│   ├── klideConvos.ts           AI panel → Mission Control pub/sub
│   ├── transcripts.ts           Pure conversation compaction + markdown export
│   ├── delegates.ts             Canonical DelegateId list (mirrors Rust delegate::ALL)
│   ├── delegateStatusNotify.ts  Delegate-status events → toasts under a noise policy
│   ├── diffComments.ts          Line-anchored diff comments sent back to running agents
│   ├── customProviders.ts       Self-hosted OpenAI-wire providers (customCli.ts: user CLI agents)
│   ├── gateway.ts               opencodex proxy registered as one self-hosted endpoint
│   ├── memory.ts                Project Memory data layer (+ memoryDrafts.ts, memorySearch.ts)
│   ├── gitGraph.ts              Lane layout for the commit graph (gitTypes.ts: wire types)
│   ├── gitReview.ts             Pure Git Review policy — derivations + mutating-action outcomes
│   ├── gridLayouts.ts           Freeform grid layouts (layouts.ts: fixed presets)
│   ├── panelLayout.ts           Floating panel rect store
│   ├── skills.ts                Skills store (loader + auto-grant)
│   ├── worktrees.ts             Worktree wire types + setup notices
│   ├── contextTray.ts           Project context snapshot for the composer
│   ├── agentHandoff.ts          Handoff summaries from conversation messages
│   ├── ipc/                     Typed Tauri command wire — one module per family, drift-tested
│   │   ├── git.ts                 Every git_* / github_* / create_pr command + wire types
│   │   ├── delegatePty.ts         Delegate PTY commands, events, reattach/replay handshake
│   │   ├── aiProviders.ts         Provider key status, model metadata, local-server start
│   │   └── gateway.ts             opencodex proxy lifecycle — installed, running, start/stop
│   ├── hooks/
│   │   ├── useFlipIndicator.ts  Shared FLIP animation for rail/tab indicators
│   │   ├── useEditorTabs.ts     Open tabs: open/edit/save/close/rename, external-change watch
│   │   ├── usePanelLayout.ts    Workbench size + panel rects + AI-panel list
│   │   ├── useAiPanelFleet.ts   Reducer for panel handoffs, resume targets, race watch tabs
│   │   ├── useArtifactInspector.ts Artifact Inspector docking state
│   │   ├── useCustomProviders.ts React subscription to the custom-provider store
│   │   ├── usePortalMenu.ts     Body-portaled dropdown state
│   │   └── useUserInfo.ts       Cached local + GitHub identity for the rail footer
│   ├── components/
│   │   ├── WorkspaceRail.tsx    The app's one sidebar — actions, project/conversation tree, identity foot; shared by Focus + workbench
│   │   ├── ActivityHeatmap.tsx  52-week run activity grid
│   │   ├── AiPanel.tsx          AI chat panel host + run interaction surface
│   │   ├── AnchoredWorkbench.tsx Anchored layout shell — sidebar, tabs, editor, terminal, AI panels
│   │   ├── ArtifactInspector.tsx Dockable Monaco viewer for run artifacts (files, diffs, checkpoints)
│   │   ├── CheckpointPanel.tsx  Per-run file checkpoint rollback UI
│   │   ├── CommandPalette.tsx   Cmd+P / Cmd+Shift+P modal
│   │   ├── ContextMenu.tsx      Right-click context menu
│   │   ├── DiffModal.tsx        Blocking approve/reject modal for one pending agent edit
│   │   ├── diffView.tsx         The one diff renderer — gutters, word highlights, line comments
│   │   ├── DiffViewerPanel.tsx  Read-only side-by-side Monaco diff panel
│   │   ├── EditorArea.tsx       Monaco editor wrapper
│   │   ├── fileMarks.tsx        Agent-file star + shared file-type icon set
│   │   ├── FileViewerPanel.tsx  Read-only Quick View overlay
│   │   ├── FloatingPanel.tsx    Free-floating, resizable, draggable panel shell
│   │   ├── FocusMode.tsx        Chat-first fullscreen surface — project rail, start stage, composer
│   │   ├── FocusGitIsland.tsx   Compact git lane-graph island on the Focus canvas
│   │   ├── GitReview.tsx        Full-view Git workbench (staging + diffs + PRs)
│   │   ├── GitHistoryGraph.tsx  Memoized commit lane graph with density zoom
│   │   ├── GridLayoutBuilder.tsx Drag-and-drop grid layout editor (GridWorkbench.tsx renders it)
│   │   ├── HoverPopover.tsx     Generic delayed hover popover
│   │   ├── ImageView.tsx        Read-only image preview in the editor
│   │   ├── InlineCommandReview.tsx Inline approval card for shell/network commands + allowlists
│   │   ├── InlineDiffReview.tsx Inline hunk-peek edit review — apply, reject, request changes
│   │   ├── Kbd.tsx              The single keycap renderer (KeyboardShortcuts.tsx: cheatsheet overlay)
│   │   ├── LayoutBento.tsx      Layout picker widget (LayoutCanvas.tsx: visual layout editor)
│   │   ├── markdown.tsx         Hand-rolled markdown renderer (code highlighting, tool markers)
│   │   ├── MemoryModal.tsx      Centered Memory handoff-notes modal (MemoryPanel.tsx: its body)
│   │   ├── MissionControl.tsx   Run board, attention/review, races + delegate handoff
│   │   ├── MissionControlSkeleton.tsx Geometry-matched loading skeleton
│   │   ├── MissionGraph.tsx     Mission dependency graph view + dependency editing
│   │   ├── OrchestratorConsole.tsx Mission planner + chained execution board
│   │   ├── ProfileModal.tsx     Local IDE profile (avatar + identity + workspace)
│   │   ├── SearchPanel.tsx      Find-in-files results
│   │   ├── SettingsPanel.tsx    Settings shell (sections live in settings/)
│   │   ├── settings/            accounts, apiKeys, controls, customProviders, gateway, icons, localServers, stats, storage
│   │   ├── Sidebar.tsx          File explorer tree
│   │   ├── SkillsModal.tsx      Skill editor + install + provenance groups
│   │   ├── SplitPane.tsx        Vertical/horizontal split shell
│   │   ├── StatusBar.tsx        Bottom bar — file/lang/branch/notice
│   │   ├── TabBar.tsx           Open file tabs (FLIP-animated underline)
│   │   ├── TerminalPanel.tsx    xterm.js + Rust PTY (floats as a card in Focus)
│   │   ├── ToastHost.tsx        The single toast surface for src/toast.ts
│   │   ├── TodoStrip.tsx        Project-wide todo list strip
│   │   ├── Tooltip.tsx          Portaled themed tooltip (replaces native title)
│   │   ├── WelcomeScreen.tsx    Start/resume surface — recents, clone, new project
│   │   ├── WorktreesModal.tsx   Worktree list — open-in-panel, merge, remove
│   │   └── ai/                  Extracted AI panel modules
│   │       ├── types.ts           Msg, QueuedTurn, stored Conversation
│   │       ├── icons.tsx          Provider logos, action icons, brand colors
│   │       ├── utils.ts           Token estimate, persistence helpers
│   │       ├── system-prompt.ts   buildSystemPrompt (Kit persona)
│   │       ├── ChatMessage.tsx    renderMessageBody
│   │       ├── MessageActions.tsx Hover per-message actions (copy, retry, branch, edit)
│   │       ├── ModelPicker.tsx    Portaled model selector (filter, favorites, keyboard)
│   │       ├── replayConversation.ts On-disk transcript → resumable panel Conversation
│   │       ├── transcriptReducer.ts  Live Msg[] view of one run's fold (region splice, stable refs)
│   │       ├── turnDriver.ts      Streaming state machine for one turn
│   │       ├── conversationSession.ts Atomic live Conversation identity
│   │       ├── contextBudget.ts   Context-window accounting + auto-compaction threshold
│   │       ├── autonomyLadder.ts  Mode choices + the Goal policy cycle (review/auto/full)
│   │       ├── panelHost.ts       App↔AiPanel contract — identity, handoffs, resume policy
│   │       ├── workspaceFiles.ts  Bounded file walk for @mentions
│   │       ├── summarize.ts       Summarize-and-handoff + auto-skill detect
│   │       ├── attachments.ts     Drop/paste rules — image → data URI, doc → text, refuse binaries (AttachmentTray.tsx: staged strip)
│   │       ├── toolRuns.ts        Fold a prose-free stretch of tool messages into one openable row
│   │       ├── storedConversations.ts Durable localStorage conversation index + panel binding + title rule
│   │       ├── ConversationHistory.tsx / DelegateTerminal.tsx / RaceFollowUpBar.tsx
│   └── agent/
│       ├── types.ts             Agent protocol types (events, diffs, permissions)
│       ├── providers.ts         Provider definitions (16 providers)
│       ├── client.ts            Frontend agent harness client
│       ├── foldEvents.ts        Sole owner of folding AgentEvent[] into conversation rows
│       ├── race.ts              Same-task multi-run dispatch into isolated worktrees
│       ├── durableMissions.ts   Mission IPC + Markdown/events → MissionState projection
│       ├── missionHarness.ts    MissionState reducer (projection model, not a second loop)
│       ├── missionGraph.ts      Pure mission dependency graph — layers, edges, cycle detection
│       ├── planner.ts           Decomposes a goal into routed-ready tasks
│       ├── routingPolicy.ts     Deterministic tier/model routing
│       ├── budgetLedger.ts      Mission cost/time/retry envelopes + spend ledger
│       ├── capacityPlanner.ts   Concurrency slots per run kind — admit, queue, defer
│       ├── validationContracts.ts Validation contract model — checks, reviewers, status
│       ├── advisor.ts           Advisor escalation config (advisorConsult.ts: nested one-shot run)
│       ├── subagents.ts         Subagent @mention menu (roles mirror Rust agent::subagents)
│       └── tools.ts             Frontend tool list fetcher (fetches from Rust)
└── src-tauri/                 Rust backend
    ├── Cargo.toml
    ├── src/
    │   ├── main.rs               Entry point (also the `klide ptyd` daemon entry)
    │   ├── lib.rs                Command registration + thin Tauri glue, AI chat dispatch, fs ops, app menu
    │   ├── cli.rs                Login-shell binary resolution + subscription-CLI install/auth status
    │   ├── adapters.rs           Provider streaming trait + shared loop + 3 wire adapters (Ollama/OpenAI/Anthropic)
    │   ├── providers.rs          Provider registry — one row per provider (wire, key, models, subscription)
    │   ├── custom_providers.rs   User-added self-hosted OpenAI-wire endpoints
    │   ├── custom_cli.rs         User-defined CLI agents via command templates
    │   ├── models.rs             Model discovery — list models, context windows, tool support
    │   ├── pricing.rs            Hand-curated per-model token prices for run cost
    │   ├── accounts.rs           Snapshot/list/restore delegate CLI login credentials
    │   ├── git/                  mod.rs: git shell-outs · github.rs: gh seam, PRs, avatars, pinned identity
    │   ├── skills.rs             Filesystem-skill loader (4 dirs, provenance) + install/uninstall
    │   ├── local_servers.rs      Ollama / MLX local server start/stop/status
    │   ├── gateway.rs            opencodex proxy process — install check, start/stop, Codex un-inject
    │   ├── search.rs             Find-in-files over a Workspace with ignore policy
    │   ├── workspace.rs          Workspace module — owns the Workspace-rooted invariant
    │   ├── worktree_setup.rs     Per-workspace worktree bootstrap recipe (copy/link/port/script)
    │   ├── memory.rs             Project Memory schema, Markdown I/O, and local retrieval
    │   ├── storage.rs            Where the runs dir lives — user-choosable folder, validated moves, cache accounting
    │   ├── missions.rs           Durable Missions — authored specs, append-only events, drive loop
    │   ├── durable.rs            Atomic + append-only write primitives for on-disk state
    │   ├── file_memo.rs          Parsed-file memo keyed on (mtime, len, epoch) — Delegate runs, Harness summaries, scrollback metas
    │   ├── blocking.rs           The one door for blocking work — spawn_blocking behind async commands + the sync-command drift test
    │   ├── pty.rs                Delegate PTY commands + host-choice rules (SessionHosting)
    │   ├── pty_host.rs           Tauri-free PTY session host — sessions, scrollback, reader loop
    │   ├── pty_daemon.rs         Detached `klide ptyd` server over a unix socket
    │   ├── pty_client.rs         App-side socket transport to ptyd (stubbed off-unix)
    │   ├── pty_wire.rs           Portable ptyd wire vocabulary — Request/Response/Event
    │   ├── pty_spawn.rs          Pure Delegate spawn-spec assembly — adapter vs custom CLI, one-shot, Mission link, cwd rules, MCP wiring
    │   ├── coordination.rs       Run coordination journal — registry, states, envelopes, results; one writer gate, replayed snapshot
    │   ├── coordination_bridge.rs Loopback door Delegate CLIs use to reach the journal — actor bound from the PTY session, never the caller
    │   ├── mcp_server.rs         `klide mcp coordination` — embedded stdio MCP server a Delegate runs; relays every tool call to the bridge
    │   ├── delegate/             Adapter per CLI (claude_code/codex/opencode/omp) + runs.rs shared types + chat.rs one-shot turns + chat_stream.rs structured-stream parsing + status.rs hook server
    │   └── agent/
    │       ├── mod.rs             Agent supervisor + run loop
    │       ├── run_core.rs        Tauri-free turn prep — provider quirks, message assembly, compaction
    │       ├── routing.rs         The `auto` Provider → one concrete provider+model at run start (gate, rank, lock)
    │       ├── tools.rs           Tool registry (schema + capability + execution, including native memory recall)
    │       ├── tool_handlers.rs   Per-capability call ceremony — permission gates, pauses, checkpoints
    │       ├── conversation_search.rs Workspace-scoped search over prior Harness transcripts
    │       ├── glob_match.rs      Shared */? matcher (glob tool + command allowlist)
    │       ├── permission.rs      Permission engine — classify, prompt, remember, persist
    │       ├── approval_store.rs  HEAD-fingerprinted persisted project approvals
    │       ├── command_allowlist.rs Per-project run_command approvals + wildcard rules
    │       ├── network_allowlist.rs Per-project network target approvals
    │       ├── failure_budget.rs  Crash-loop quarantine for repeatedly failing runs
    │       ├── steering.rs        Repeated/failing tool-call detection → steering nudges
    │       ├── subagents.rs       Subagent roles + nested-run spec — the source of truth
    │       ├── evidence.rs        Run summary + transcript → Markdown evidence
    │       ├── eval.rs            Test-only golden scenarios over the real tool path
    │       ├── todo.rs            On-disk agent TODO list + mutation events
    │       ├── types.rs           Agent types (events, diffs, summaries)
    │       └── transcripts.rs     Transcript persistence (JSONL, durable appends + atomic summaries)
    └── capabilities/
```

## Architecture

### Three surfaces, one state

Klide opens on the surface that matches the task; all three share the same
runs, transcripts, conversations, and review state.

- **Welcome** (`WelcomeScreen.tsx`) — start or resume a project: recents,
  clone, new project.
- **Focus** (`FocusMode.tsx`) — chat-first fullscreen: one centered
  conversation (an `AiPanel` `variant="focus"`, never a duplicate chat
  implementation), a Git island, and the shared terminal docked
  *under* the canvas so run subscriptions keep streaming while you shell.
  Its picker offers every provider the workbench does — **delegate CLIs
  included**, so a Claude Code or Codex subscription can start a Focus
  conversation without an API key anywhere in Klide.
- **Workbench** (`AnchoredWorkbench.tsx`) — the editor-first IDE layout, plus
  free-mode floating panels, fixed presets, and the grid builder.

The sidebar is one `WorkspaceRail`, rendered once by `App.tsx` for every
surface — Focus included, so switching mode morphs the foot icon and leaves the
column standing rather than remounting it. Focus differs only in the `nav` and the
conversation handlers. The Explorer is not part of the rail: the anchored
workbench draws it as its own column beside the rail, free mode as a drawer.

Icons across every rail come from `src/icons.tsx` (Phosphor Light behind an
`Icon` primitive, one weight lever). Provider logos, file-type marks and
AgentMark stay hand-drawn.

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

- **Storage** — `src-tauri/src/memory.rs` writes one versioned markdown file per entry with machine frontmatter (kind, review state, tags, source refs, supersession, Run/provider metadata) + structured body (Goal / Plan / Decisions / Files touched / Next steps / Notes). Markdown is authoritative; retrieval is local and deterministic. Commands: `memory_write`, `memory_list`, `memory_read`; Harness Tools: `memory_search`, `memory_read`.
- **Frontend** — `src/memory.ts` typed data layer; `MemoryPanel` is the list+detail body; `MemoryModal` is the centered overlay (same pattern as `SkillsModal`).
- **Trigger** — the AI panel header has a "Summarize" bookmark button (`src/components/ai/summarize.ts`) that calls the model once with a structured prompt, parses the response, and writes via `memory_write`. The first user message becomes the title; file paths are extracted from the conversation; the model produces Notes + Decisions + Goal.

### v0.5 closeout and next milestone

v0.5 was declared feature-complete on 2026-07-21. Mission Control is the
operations surface for Klide Harness runs and Delegate runs; review evidence,
worktree fleets, mission chaining, subagents, advisor escalation, and two-agent
races are shipped. v0.5.1 owns release hardening and publishing: default
worktree isolation and provider-aware historical lifecycle signals are done
(the latter 2026-08-27 — per-CLI turn markers + PTY hook/exit joins, session
ids persisted in scrollback metadata); still open are full race/restart/merge
dogfooding, the first signed/notarized macOS bundle, and Windows/Linux
validation (keyring feature selection is the remaining compile blocker).

The next product milestone is v0.6, dependable orchestration: Missions as
outcomes, visible budget and capacity, capability-based worker routing,
automatic validation contracts, and durable background execution. Do not
unpark scheduling or proactive suggestions ahead of those foundations.

The v0.6 durability boundary is shipped (slices 1–2 + Delegate dispatch, see
TODO.md): Rust owns `.klide/missions/<id>/mission.md`, `tasks/*.md`, and
append-only `events.jsonl`; TypeScript only compiles those documents/events
into `MissionState`. A Mission Task owns zero or more Run attempts and one
accepted attempt — Task id and Run id are never the same lifecycle object. The
detached Rust Harness writes validation back to the linked Mission after it
settles, and dependency readiness gates on an accepted attempt, never on
process exit. Approval freezes the worker kind, provider, model, and
diff-review policy into each task Markdown file. A one-at-a-time Rust Mission
supervisor selects an unattempted ready task, starts its Harness Run
headlessly, and re-enters after validation; rejected attempts park for
explicit retry. The tier-board only observes events and reattaches to operator
pauses. After a process restart, Rust validates terminal orphan summaries and
marks ambiguous missing/non-terminal Runs `attempt_interrupted` without
replaying them. The Board/Graph switch reads and edits the same task Markdown
dependencies; Rust rejects dependency cycles at the write boundary
(`first_dependency_cycle`). Approved Delegate tasks dispatch as bounded
one-shot CLI commands behind the Delegate seam; exit moves the attempt to
explicit operator review, never auto-acceptance.

Durability itself is a module: `durable.rs` owns atomic replace and flushed
append-only writes, and both the Mission log and the run Transcript go through
it — a torn final line is tolerated and reported, interior corruption is an
error, never a silent skip (2026-08-04 review).

Still open for v0.6 proper: budget/capacity controls in the dispatch path
(`budgetLedger.ts` / `capacityPlanner.ts` exist as models), capability-based
routing without hard-coded provider brands, automatic validation contracts,
and durable background execution / local-to-cloud handoff.

- Keep the Rust harness as the only durable agent loop. Do not reintroduce a frontend tool-dispatch loop.
- Treat Mission Control as the place to inspect runs and hand them off; delegate TUIs resume in AI panels.
- Treat Project Memory as the continuity surface. The older Context Lens/project-graph path is parked unless it feeds memory or summarization directly.
- Skills now load from four well-known locations (workspace `.agents/skills`, workspace `.klide/skills`, user `.agents/skills`, user `.claude/skills`), and the install + uninstall flow is wired through `install_skill` / `uninstall_skill` Rust commands. Provenance is grouped by `metadata.author` / GitHub repo owner into Workspace / Personal / Vercel / Matt Pocock / Anthropic / Other.
- "Save as skill" sparkle in the AI panel header (`detectAndGenerateSkill` in `src/components/ai/summarize.ts`) auto-generates a `SKILL.md` to `<workspace>/.klide/skills/<slug>/` when the model detects a reusable pattern.

### Agent coordination (one journal, two doors)

Runs address each other through a Rust-owned journal,
`.klide/coordination/events.jsonl` (`coordination.rs`): a Run registers with a
stable id (the conversation id), moves through a small state machine, sends
envelopes, and publishes one structured result. A snapshot is always a fold of
the journal; nothing in React is the source of truth. Another agent's words
never reach a conversation unreviewed — the receiving side's operator answers
an inline card, and the accept/decline is itself a journal event.

There are two doors onto that one journal, and no third:

- **Harness Runs** call the native Tools `agent_list` / `agent_send` /
  `agent_wait` / `agent_cancel` / `agent_read_result` (`agent/tools.rs`); the
  actor is always `ctx.id`, and delivery happens at the turn boundary as a
  `user` turn labelled as agent mail. Every Mode is on the plane: Chat carries
  the coordination tools and nothing else (no files, shell, or memory), so any
  conversation with a Workspace can be addressed and can answer.
- **Delegate CLIs** (Claude Code, Codex, OpenCode) get the same operations as
  MCP tools from `klide mcp coordination` (`mcp_server.rs`) — the same binary
  as the app, started by the CLI as a stdio child, wired per session by the
  adapter (`Delegate::mcp_wiring`: `--mcp-config` file / `-c` overrides /
  `OPENCODE_CONFIG`). The MCP child owns nothing: it relays each call over
  loopback to `coordination_bridge.rs` in the app, which looks the PTY session
  up in a map filled at spawn to learn which Run id and Workspace the call acts
  as. No tool argument can name an actor or a journal path. The bridge is a
  separate listener from the status hook server because an `agent_wait` blocks
  for up to two minutes; each request gets its own thread.

Nothing durable holds a port. A Delegate PTY is hosted by the ptyd daemon and
outlives the app, so the child is told a *path* and a session id, never a URL:
it reads the live port and token from `coordination-endpoint.json` in the app
data dir on every call, and the bridge rebuilds a session it never bound from
that session's scrollback metadata (`BridgeHooks::resolve_session`). A restart
therefore keeps a running CLI's agent tools working, and a session that
recorded an exit is never recovered.

A Delegate registers as a `delegate` Run in `delegate_pty_spawn`, its status
hooks move its state, and PTY exit settles it. A Focus conversation on a
Delegate runs headless turns through the Harness instead of a PTY; the run
loop asks `RunSupervisor::delegate_mcp_wiring` for the same wiring each turn
(same `{convoId}:{provider}` session id, Harness owns the Run's state) and the
adapter's `chat_stream_invocation` applies it, so both surfaces act as one Run. Delivery to a Delegate is pull
(`agent_wait`), because Klide owns no turn boundary inside a foreign CLI;
waking an idle CLI when mail arrives (a Stop hook that blocks with the inbox as
its reason) is the next slice. Do not add a direct journal writer outside the
app process, and do not let an adapter trust a caller-supplied actor.

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

### Auto model routing

`auto` is a Provider id the picker can send, not a backend. Every run enters
`start_run` (`agent/mod.rs`), and that is where `agent/routing.rs` replaces it
with a concrete pair before anything downstream reads the provider — the
failure budget, the summary, `RunStarted`, the adapters. The rule is small and
deterministic: **gate** (key present, local server up, tool support when the
Mode calls tools, context window ≥ 2× prompt + 4k), then **rank** (starred
models cheapest-first, then installed Ollama models with the default first),
then **lock** — a continuation of an `auto` thread reuses the pair its
transcript recorded (`read_run_origin`) rather than routing again. The
renderer sends its stars on the request (`preferredModels`; they live in
localStorage), and a `RouteResolved` event after `RunStarted` records the
reason and every candidate ranked above the pick with why it lost. Delegate
CLIs are never candidates; Mission attempts never arrive as `auto` (approval
freezes a concrete pair). Not a classifier, not per-turn, no LLM call in
front of a message — see `MODEL_ROUTING.md` for the reasoning and what's next.

### Provider gateway (opencodex)

A fourth wire would have been the wrong answer for reaching 40 more providers,
so Klide reaches them through a proxy instead. **opencodex** (`ocx`,
`npm install -g @bitkyc08/opencodex`) serves `/v1/chat/completions` and
`/v1/models` on `127.0.0.1:10100` in front of ~40 upstreams — API keys *or*
OAuth logins — which is exactly the shape `custom_providers.rs` already drives.
So the gateway is registered as **one self-hosted endpoint** (`custom:opencodex`,
no adapter, no token: the bearer is optional on loopback) and every surface —
Focus, Workbench, Mission Control, the full Rust tool loop — treats it as a
normal provider. Models are namespaced `provider/model` (`ollama/qwen3.5:9b`).

`gateway.rs` owns only the process: install check, start, stop, health. Two
deliberate behaviours: `ocx start` injects `openai_base_url` into
`$CODEX_HOME/config.toml`, so Klide runs `ocx restore` right after a successful
start — the Codex *delegate* must keep talking to OpenAI directly — and
`gateway_status` reads that config back rather than assuming. Stop goes through
`ocx stop`, never a bare kill, because the CLI is the only thing that unwinds
its own injection.

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

Covered command families go through typed wrappers in `src/ipc/` (git,
delegate PTY, AI providers) or a domain data layer — not raw `invoke` in
components. Rust drift tests (e.g. `every_git_command_has_a_frontend_wrapper`)
enforce wrapper coverage for the git family.

## Features shipped (through v0.5)

- [x] Activity bar — top zone (6 tools) with FLIP-animated indicator + bottom zone (Settings + Profile) with a dock-style dot and a hairline divider.
- [x] File explorer with tree view, git decorations, context menu, inline rename
- [x] Tabs with dirty indicator, unsaved-changes confirm, FLIP-animated 2px bottom accent bar
- [x] Monaco editor with syntax highlighting, Cmd+S, 7 themes
- [x] Status bar — file path, language, git branch, theme/terminal/layout toggles, dot separators
- [x] Terminal panel with real shell via Rust portable-pty
- [x] AI panel — streaming chat across Ollama, MLX, Anthropic, OpenAI, Mistral, xAI, DeepSeek, OpenRouter + self-hosted endpoints, 22 built-in tools, inline diff review + the foot-bar Goal-policy decider (review / auto-accept / full auto)
- [x] Agent mode — goal/plan modes, diff-reviewed edits, tool loop
- [x] Git panel — full-view Git Review workbench (staging + diffs)
- [x] Mission Control — aggregate agent run board (Claude Code, Codex, OpenCode, Oh My Pi, Klide) with handoff to AI panel
- [x] Project Memory — durable handoff notes in `.klide/memory/`, opened as a centered modal
- [x] AI-panel "Summarize" header action — writes a structured memory note from the current conversation
- [x] AI-panel "Save as skill" sparkle — auto-generates a `SKILL.md` for reusable patterns
- [x] Settings — keychain-backed keys, harness settings editor, stats panel
- [x] Skills — instruction bundles with tool allowlists, loaded from 4 filesystem locations, install/uninstall via `npx skills add`, provenance grouping
- [x] Profile modal — local IDE profile (avatar + identity + workspace), `⌘.`
- [x] Focus mode — chat-first fullscreen surface: project/thread rail, centered conversation, Git island, docked shell
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
- **Tools are defined once in Rust.** The `ToolEntry` struct bundles schema, kind, and execution together. Frontend fetches schemas over IPC. The transcript records each call's *capability* at dispatch time — readers never guess trust effects from a tool's name.
- **Durable state goes through `durable.rs`.** Missions and Transcripts use atomic replace + flushed appends; a reader must never see a torn document, and interior corruption is an error, not a `continue`.
- **Blocking work goes through `blocking.rs`.** A sync `#[tauri::command]` runs on the main thread and an inline `std::fs`/`Command` call holds a tokio worker, so IO-bearing commands are `async fn` whose body runs in `blocking::run`, and the Harness dispatches read-only Tools through the same door. `every_sync_command_is_on_the_allowlist` in `lib.rs` fails on a new sync command nobody vouched for.
- **Icons come from `src/icons.tsx`.** One vocabulary, one weight lever; don't draw a private copy of a glyph in a component (provider/brand/file marks are the hand-drawn exception).
- **GitHub identity is pinned.** Klide applies the account from `~/.klide/github_account.json` per-command via `GH_TOKEN`; it never follows or mutates gh's global active account.
- **Styling: inline styles for now.** No CSS framework before v1.0. CSS custom properties in `src/styles/tokens.css` for theming.

## Reference

- Tauri 2 docs — <https://v2.tauri.app>
- Monaco React — <https://github.com/suren-atoyan/monaco-react>
- xterm.js — <https://xtermjs.org/docs/>
- Ollama API — <https://github.com/ollama/ollama/blob/main/docs/api.md>
- MLX LM server — <https://github.com/ml-explore/mlx-lm>
