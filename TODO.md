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
- [ ] Project Memory v3: cross-link entries to touched files (click `filesTouched` to jump to the file). Auto-summarizer watch is parked — current model is the user-triggered "Save as skill" sparkle, which the agent uses to capture reusable patterns explicitly.
- [ ] Memory auto-summarizer: watch completed/stopped runs and write durable memory notes (the auto-generate path is already shipped for skills, this is the memory equivalent).

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
