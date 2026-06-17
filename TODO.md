# TODO

Working thesis: Klide is a quiet agentic coding control surface. Keep the VS
Code muscle memory, but make agent power available at the point of action:
mode, provider, context, skills, rules, diffs, and history. Avoid always-visible
dashboards, seeded demos, and telemetry panels unless the user explicitly opens
them.

## Stabilize v0.2

- [x] Reconcile README with real delegate PTYs, Mission Control handoff, Project Memory, and Context Lens status.
- [x] Keep compile gates clean: `npm run build` and `cargo check`.
- [x] Run a live provider smoke matrix before tagging v0.2 (verified 2026-06-08):
  - [x] Ollama streaming + tools
  - [x] MLX chat via `mlx_lm.server` (no tool calling / Goal mode yet)
  - [x] Anthropic direct API streaming + tool calls
  - [x] One OpenAI-compatible API provider
  - [x] Claude Code / Codex / OpenCode delegate mode, including workspace diff refresh
- [x] Settings depth without persistent chrome — stats panel, keychain-backed keys, harness settings editor.
- [x] Skill management stabilization:
  - [x] Load skills from workspace `.agents/skills`, workspace `.klide/skills`, user `.agents/skills`, and user `.claude/skills`.
  - [x] Wire/test install + uninstall commands from the UI (SkillsModal → Install tab → `install_skill` / `uninstall_skill` Rust commands, full provenance-grouped loader).
  - [x] Auto-generate skills from finished sessions (`detectAndGenerateSkill` in `src/components/ai/summarize.ts`, writes to `.klide/skills/<slug>/SKILL.md`).

## Premium Polish (completed 2026-06-08)

- [x] Skills modal — vertical nav rail, FLIP-animated accent indicator, full-width header, paper-card instructions, full Tools & MCP inventory, group-by-provenance loader.
- [x] Shared FLIP indicator hook (`src/hooks/useFlipIndicator.ts`) — used by Skills nav rail, ActivityBar top zone, TabBar.
- [x] Activity bar — top zone (6 tools) + bottom zone (Settings + Profile) with a hairline divider. Top zone uses a FLIP-animated indicator; bottom zone uses a 3px dock dot.
- [x] Tab bar — FLIP-animated 2px bottom accent bar that follows the active tab's width.
- [x] Status bar — dot separators between status items, `klide-status-chip-btn` for action chips, glass blend on the surface.
- [x] Profile modal — local IDE profile (avatar + identity + workspace line, no account stuff).
- [x] Project Memory v2 — `find_install_skills` Rust command groups by author/repo metadata into "Vercel / Matt Pocock / Anthropic / Personal / Workspace" sections in the modal loader.

## Architecture deepening (started 2026-06-10)

- [x] Workspace module (`src-tauri/src/workspace.rs`) — one home for the Workspace-rooted invariant. Agent tool executions take `&Workspace` (not a root string); explorer commands resolve through `resolve_abs_entry`; `read_text_file` / `list_dir` now enforce containment too. Replaced `assert_in_workspace` + `resolve_existing_path` / `resolve_new_path`.
- [x] Phase 2 — close the plugin-fs bypass: migrated `@tauri-apps/plugin-fs` call sites (App.tsx save, AiPanel, SearchPanel, CommandPalette, summarize.ts, workspaceFiles.ts) to workspace-checked Rust commands, then dropped the unscoped `fs:allow-*` permissions from `capabilities/default.json`.

## Refactoring (completed 2026-06-04)

- [x] Split AiPanel.tsx (3809 → 902 lines) — extracted 9 sub-modules into `src/components/ai/`
- [x] One agent loop — retired TS tool-dispatch loop; Rust harness handles all modes (Chat/Plan/Goal)
- [x] Write-tool diff review wired — harness pauses for approval via `tokio::sync::oneshot`; `agent_resolve_diff` unblocks
- [x] Provider seam — `StreamingProvider` trait + shared `stream_provider()` loop; 3 adapters (Ollama, OpenAI, Anthropic)
- [x] Tool registry — Rust `ToolEntry` struct bundles schema + execution; frontend fetches schemas over IPC
- [x] Command palette — Cmd+P (fuzzy file search), Cmd+Shift+P (command mode, 9 commands)
- [x] Find-in-files — Cmd+Shift+F, Rust `search_in_files` command, results panel with file-open-on-click

## Next Product Moves

- [x] Editable harness settings: mode prompts, tool toggles, and tool descriptions (tool descriptions TBD).
- [x] Checkpoint rollback: preview files changed since a turn and revert selected files.
- [x] Mission Control v2: resume/open session handoff to the right CLI instead of read-only inspection.
- [x] Project Memory v3: cross-link entries to touched files (click `filesTouched` to jump to the file). Auto-summarizer watch is parked — current model is the user-triggered "Save as skill" sparkle, which the agent uses to capture reusable patterns explicitly.
- [x] Memory auto-summarizer: when a Klide agent run settles with status "done", automatically write a durable Project Memory note from the conversation. Toggle in Settings → Harness (`autoMemoryOnRunDone`, default ON). Manual Summarize header action still works. Inline "Auto-saved" notice under the composer fades after 4s. Done runs only (skip cancelled / errored / delegate providers / single-message exchanges).
- [x] `userAnswerQuestion` pause tool + `/interview` slash command: new tool in the Rust registry that pauses the harness via oneshot, surfaces an inline Q&A card in the AI panel, returns the user's typed answer to the model. Built-in skill "Codebase Interview" shipped in `DEFAULT_SKILLS` (src/skills.ts) — visible in the Skills modal, toggleable like the Code Review built-in, and the system prompt picks it up automatically. Plan mode, read-only, writes `docs/codebase-decisions.md` at the end. The skill explicitly forbids re-asking the same question (the model must track asked questions in its scratchpad). The `/interview` slash command inlines a self-contained prompt so it works even when the skill is disabled.

## v0.3 Done — Agent-Control Foundation

Decision on 2026-06-15: call v0.3 shipped and move the product forward. The
foundation is now real enough: self-hosted providers, subscription delegate
PTYs, Mission Control handoff, Project Memory, skills, usage/provider settings,
checkpoint rollback, workspace-rooted filesystem access, and the interview
tooling are all in place.

The next milestone should not broaden into "more AI editor features." Klide's
lane is the local-first control plane for coding agents: watch, resume,
delegate, compare, review, and remember work across Claude Code, Codex,
OpenCode, local providers, and future cloud agents.

## v0.4 — Review Queue + Evidence Layer

Goal: make Mission Control answer the three operator questions in under 3
seconds: what is running, what needs me, and what changed?

- [ ] Review queue: failed, waiting, idle, and completed delegated runs have explicit reasons and a clear next action.
- [~] Evidence summaries: each run row shows last meaningful event, branch/worktree, files touched, diff/review entry point, tokens/cost, and memory status. (Done: last meaningful event — `last_event` parsed from the newest assistant turn in all 4 delegate adapters, shown as a quiet line under the row title; branch, files, tokens/cost, sub-agent count; diff/review entry point in the detail pane; memory status — `· memory` row chip + "Memory: Saved/Not saved" detail stat, matched by note `runId`. Remaining: worktree (no data source yet); `last_event`/`costUsd` not yet surfaced for Klide's own runs — needs `AgentRunSummary` to carry them.)
- [x] Delegate observability: fix Claude routine design in Mission Control and restore missing sub-agent visibility for Claude conversations. (Claude parser now counts `Agent`/`Task` sub-agent calls and excludes inline `isSidechain` turns from message_count, surfaced as a row chip + detail-pane stat; removed the Claude-only `extract_routine_heading` title-hijack so routine badging is now one source-agnostic path in TS `runRoutineInfo`.)
- [x] Reviewable memory: completed runs draft memory notes that can be accepted, edited, or skipped before becoming durable project memory. (Auto-on-done now *generates* a note and parks it as a per-workspace draft in `src/memoryDrafts.ts` — localStorage-backed pub/sub — instead of writing. The Memory modal shows a "Pending review" section; selecting a draft opens an editable review (title/goal/notes/decisions) with Accept & save / Skip. `summarize.ts` split into `generateMemoryNote` (no write) + `summarizeAndHandoff` (generate+write). Explicit actions — manual Summarize, MC "Save memory" — still write directly. Setting relabeled "Auto-draft memory on run done".)
- [x] Settings performance: reduce settings open lag; defer usage/provider stat work so the settings surface opens immediately. (Root cause: all 9 sections rendered their subtree on mount — `display:none` — so ApiKeyRow ×4, LocalServerRow ×2 (+4s poll), and CustomEndpointsBlock fired per-provider status `invoke`s on open. Fix: sections now mount on first visit and stay mounted (`visitedSections` set + `Section mounted` prop), so opening to General pays only ~1 top-level call instead of ~7 serial ones. Stats parse was already deferred behind "Load stats".)
- [ ] Product restraint: keep multi-account setup, natural-language scheduling, and proactive suggestions parked until the review/evidence loop feels excellent.

## Small Follow-Ups

- [x] Refresh the AI panel connection after saving or clearing a provider key.
- [x] Let Claude Code / Codex run as delegate agents in Goal mode; Klide surfaces resulting workspace diffs.
- [x] Show delegate PTY launch/live/error state in the terminal header.
- [x] Make Mission Control useful as a read-only transcript/log inspector.
- [x] Shelve `gemini-cli` — dead stubs removed.

## Parking Lot

- The earlier "Context Lens" idea (heuristic auto-injection of folder
  descriptions, parent scopes, changed-file context) was killed along with
  the project-graph UI — the heuristics weren't earning their place.
  If a real project-graph signal ever lands, it should feed Memory /
  summarization, not the chat composer.
- `.klide/memory/` write semantics — currently plain workspace files,
  not gitignored and not auto-committed. The user needs to pick per repo.
