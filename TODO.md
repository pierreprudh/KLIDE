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
- [ ] Reconcile provider labels with reality in `README.md` and the AI switcher.
- [ ] Run `cargo check` and `npx tsc --noEmit` clean before shipping.

## Next Product Moves

- [ ] Command palette (`Cmd+P` / `Cmd+Shift+P`) as the main hidden control surface.
- [ ] Find-in-files using a Rust ripgrep-style search command.
- [ ] Editable harness settings: mode prompts, tool toggles, and tool descriptions.
- [ ] Checkpoint rollback: preview files changed since a turn and revert selected files.
- [ ] Settings depth without adding persistent chrome.

## Small Follow-Ups

- [x] Refresh the AI panel connection after saving or clearing a provider key.
- [x] Let Claude Code / Codex run as delegate agents in Goal mode; Klide surfaces resulting workspace diffs.
- [ ] Finish or shelve `gemini-cli`.
