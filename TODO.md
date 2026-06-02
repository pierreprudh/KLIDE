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
- [ ] Run `cargo check` and `npx tsc --noEmit` clean before shipping.

## Next Product Moves

- [ ] Command palette (`Cmd+P` / `Cmd+Shift+P`) as the main hidden control surface.
- [ ] Find-in-files using a Rust ripgrep-style search command.
- [ ] Editable harness settings: mode prompts, tool toggles, and tool descriptions.
- [ ] Checkpoint rollback: preview files changed since a turn and revert selected files.
- [ ] Settings depth without adding persistent chrome.
- [ ] Mission Control v2: resume/open session handoff to the right CLI instead of read-only inspection.
- [ ] Context Lens v2: use real imports, Tauri invokes, and edited-file history instead of mostly heuristics.

## Small Follow-Ups

- [x] Refresh the AI panel connection after saving or clearing a provider key.
- [x] Let Claude Code / Codex run as delegate agents in Goal mode; Klide surfaces resulting workspace diffs.
- [x] Show delegate PTY launch/live/error state in the terminal header.
- [x] Make Mission Control useful as a read-only transcript/log inspector.
- [ ] Finish or shelve `gemini-cli`.

## Parking Lot

- Project Memory / Context Lens is promising but not there yet. Avoid overfitting
  the UI around manual context controls; the differentiator should feel like
  Klide understands the project graph and proposes the right working set.
