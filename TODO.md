# TODO

Working thesis: Klide is a quiet agentic coding control surface. Keep the VS
Code muscle memory, but make agent power available at the point of action:
mode, provider, context, skills, rules, diffs, and history. Avoid always-visible
dashboards, seeded demos, and telemetry panels unless the user explicitly opens
them.

## Stabilize v0.2

- [ ] Verify provider paths end-to-end:
  - Ollama streaming + tools
  - Anthropic direct API streaming + tool calls
  - One OpenAI-compatible API provider
  - Claude Code / Codex delegate mode, including workspace diff refresh
- [x] Reconcile README with real delegate PTYs, Mission Control, and Context Lens status.
- [x] Run `cargo check` and `npx tsc --noEmit` clean before shipping.

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
- [ ] Settings depth without adding persistent chrome.
- [x] Mission Control v2: resume/open session handoff to the right CLI instead of read-only inspection.
- [ ] Project Memory v2: cross-link entries to the file graph (click `filesTouched` to jump to the file) + auto-summarizer that watches completed/stopped runs.

## Small Follow-Ups

- [x] Refresh the AI panel connection after saving or clearing a provider key.
- [x] Let Claude Code / Codex run as delegate agents in Goal mode; Klide surfaces resulting workspace diffs.
- [x] Show delegate PTY launch/live/error state in the terminal header.
- [x] Make Mission Control useful as a read-only transcript/log inspector.
- [x] Shelve `gemini-cli` — dead stubs removed.

## Parking Lot

- The earlier "Context Lens" idea (heuristic auto-injection of folder
  descriptions, parent scopes, changed-file context) was killed along with
  the file-tree sidebar — the heuristics weren't earning their place.
  If a real project-graph signal ever lands, it should feed Memory /
  summarization, not the chat composer.
- `.klide/memory/` write semantics — currently plain workspace files,
  not gitignored and not auto-committed. The user needs to pick per repo.
