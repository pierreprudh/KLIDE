# Changelog

Notable changes per milestone. Dates are completion dates.

## Unreleased — v0.5 release-candidate hardening

- Race the same task across two Harness runs in isolated worktrees, keep sibling
  runs together in Mission Control, and compare status, validation, files,
  commands, tokens, cost, time, and worktree evidence side by side.
- Remove a newly created race worktree — including its recipe-copied config
  files and the branch created for it — when its Harness run fails to start,
  while preserving any checkout that holds other work.
- Validate persisted race groups before projecting them into Mission Control,
  with direct regression coverage for persistence, bounded history, partial
  dispatch, and orphan cleanup.
- Run frontend tests/build and Rust tests automatically on pushes to `main` and
  on pull requests.
- Verify that the release profile produces a 26 MB Apple Silicon `Klide.app`;
  distribution signing and notarization remain the publishing gate.

## v0.5 — Git Review + Delegate Live Ops

- Git Review grew into a full workbench: branch diff against the recorded fork base, PR list/create/open/checkout/merge actions, a commit history graph, and a structured commit-detail pane with avatars and full-width diffs.
- Delegate live status moved to hooks for Claude Code, Codex, and OpenCode, so Mission Control can show working/waiting/blocked state without scraping terminal output.
- Live-strip urgency and needs-you toasts make active delegate sessions visible while keeping the main workbench quiet.
- Subscription and custom CLI providers now share a cleaner default-model path: the "default" sentinel lets each CLI use its own configured default instead of forcing a stale model flag.
- Custom CLI agents are first-class in Settings, the AI panel, and dispatch.
- Mission Control now scopes delegate run history to the current workspace, keeping old runs from other projects out of the operator view.
- Production build splits the heaviest browser libraries (Monaco, xterm, Tauri, React) into named vendor chunks, and the main screens and modals now lazy-load on demand instead of shipping in the initial bundle.
- Docs were refreshed for the production README and changelog.

## v0.4 — Review Queue + Evidence Layer

- Mission Control answers "what is running?", "what needs me?", and "what changed?" at a glance — quiet rows, attention queue, per-run reasons + one next action.
- Evidence summaries per run — last meaningful event, branch, files touched, diff/review entry point, tokens/cost, sub-agent count, and saved-memory status, consistent across Klide and delegate runs.
- Delegate observability — Claude sub-agent visibility (counts `Agent`/`Task` calls, excludes sidechain turns) and symmetric routine badging.
- Reviewable memory — completed runs draft a note you accept, edit, or skip in the Memory modal before it becomes durable.
- Settings open instantly — sections mount on first visit, so per-provider status calls don't block the surface.
- Delegate account switching — save and switch Codex / Claude Code / OpenCode CLI logins from Settings without minting tokens.
- Parked (intentionally): natural-language scheduling and proactive suggestions — until the review/evidence loop has more daily mileage.

### Agent harness capability

- `run_command` — approval-gated shell execution so the agent can run tests/build/lint and verify its own work.
- Configurable turn cap (default 50) + command timeout (default 180s) + per-run command allowlist.
- Eval foundation — golden tool-layer scenarios run as `cargo test`; documented tool schema + lineage in `KLIDE_HARNESS_SCHEMA.md`.
- Scripted model-loop eval — fake provider turns choose tools, real tools execute, and tool results replay into the next provider message.
- Project-persistent command allowlist — "Approve for project" stores exact `run_command` approvals in `.klide/command-allowlist.json`.
- Test-after-edit — optional Settings → Harness command runs after accepted edits, alongside built-in Rust/JSON syntax checks.
- Provider seam extracted into `run_agent_loop` — production calls `ai_chat` through `RealProviderCaller`; tests can inject a mock provider caller.

## v0.3

- Self-hosted providers — add your own OpenAI-compatible endpoints (label + base URL + keychain token) in Settings; they appear in the provider picker under "Self-hosted", with live model listing and per-endpoint default model.
- Collapsible, glass-headed provider picker that scales to many providers.
- Project Memory v3 — touched-file links, run metadata, and automatic durable notes for completed Klide runs.
- Skills install/uninstall plus "Save as skill" generation from finished sessions.
- Mission Control handoff polish — resume/open delegate sessions in the right CLI surface, nested sub-agent runs, token/cost/file summaries, and brand marks.
- Workspace-rooted filesystem hardening — file reads/writes flow through checked Rust commands instead of broad webview FS permissions.
- Codebase Interview — `userAnswerQuestion` pause tool plus `/interview` for capturing project decisions.

## v0.2 (verified 2026-06-08)

- Plan / Build modes, `@`-mentions, slash commands, project-rules loading.
- Provider switcher — Ollama, OpenAI-compatible APIs, and subscription CLIs all live.
- Streaming through Rust for every provider.
- API keys stored in the OS keychain, managed from Settings.
- Quiet agent control surface with mode switching, provider choice, context pressure, skills, rules, history, and diff review.
- Real Claude Code / Codex / OpenCode delegate PTYs in the AI panel.
- Mission Control v2 — inspect runs, resume delegate sessions, and hand off a run to another CLI.
- Project Memory v1 — summarize a session into durable `.klide/memory/` markdown and browse it in a centered modal.
- Skills install + uninstall via `npx skills add`, with provenance grouping (Vercel / Matt Pocock / Anthropic / Personal / Workspace).
- "Save as skill" sparkle — auto-generates a `SKILL.md` for reusable patterns in finished sessions.
- Profile modal — local IDE profile (avatar + identity + workspace), `⌘.`
- Command palette · find-in-files · editable harness settings · checkpoint rollback.
- Live provider smoke matrix verified for Ollama, MLX, Anthropic direct API, one OpenAI-compatible API, and Claude Code / Codex / OpenCode delegates.
- Premium polish pass on the always-visible chrome (ActivityBar, TabBar, StatusBar, WelcomeScreen).
- Parked: Context Lens/project graph heuristics. If revived, feed Memory/summarization instead of silently injecting chat context.

## v0.1 — MVP

- Layout shell — activity bar, sidebar, tabs, editor, terminal, AI panel, status bar.
- File explorer — open folder, tree view, click to open.
- Tabs — multiple files, switch, close.
- Editor — Monaco with syntax highlighting + `Cmd+S`.
- Status bar — filename, language, cursor position.
- Terminal panel — real shell via PTY, toggleable.
- AI panel — streaming chat against local Ollama (native `tools` API).
- Agent mode — `write_file` / `create_file` with diff review.
