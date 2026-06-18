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

- [x] Review queue: failed, waiting, idle, and completed delegated runs have explicit reasons (`runBoardReason`) and a clear next action. The attention queue (`AttentionQueue`) now gives every reason kind an inline hover action: failed/awaiting-input/idle → resume (ResumeKlide for Klide, ResumeCli for delegate CLIs); awaiting-review → Review (opens the detail pane); errored/queued tasks → QuickSend. Dropped the dead `onQuickSend` gate that left errored tasks actionless.
- [x] Evidence summaries: each run row shows last meaningful event, branch/worktree, files touched, diff/review entry point, tokens/cost, and memory status. (Done: last meaningful event — `last_event` parsed from the newest assistant turn in all 4 delegate adapters, shown as a quiet line under the row title; branch, files, tokens/cost, sub-agent count; diff/review entry point in the detail pane; memory status — `· memory` row chip + "Memory: Saved/Not saved" detail stat, matched by note `runId`. Klide's own runs now carry `last_event` too (enriched from the transcript in `write_summary`; `cost_usd` was already on `AgentRunSummary`) — only live in-memory convos (mid-run, before the on-disk twin is preferred) lack `last_event`, a minor gap. Worktree closed 2026-06-18: `delegate::runs::worktree_label(cwd)` detects a linked git worktree cheaply — `.git` is a *file* (a `gitdir: …/worktrees/<name>` pointer) for linked worktrees vs a directory for the main checkout, so one `stat` + tiny read, no `git` subprocess — populated centrally in `list_agent_runs`' existing `iter_mut()` pass over all 4 adapters. Surfaced as a "Worktree" EvidenceMeta in the detail pane and `· in <name>` in the compact row under `showEvidence`. Klide's own `AgentRunSummary` runs don't carry it yet — they run in the workspace root, a minor gap.)
- [x] Delegate observability: fix Claude routine design in Mission Control and restore missing sub-agent visibility for Claude conversations. (Claude parser now counts `Agent`/`Task` sub-agent calls and excludes inline `isSidechain` turns from message_count, surfaced as a row chip + detail-pane stat; removed the Claude-only `extract_routine_heading` title-hijack so routine badging is now one source-agnostic path in TS `runRoutineInfo`.)
- [x] Reviewable memory: completed runs draft memory notes that can be accepted, edited, or skipped before becoming durable project memory. (Auto-on-done now *generates* a note and parks it as a per-workspace draft in `src/memoryDrafts.ts` — localStorage-backed pub/sub — instead of writing. The Memory modal shows a "Pending review" section; selecting a draft opens an editable review (title/goal/notes/decisions) with Accept & save / Skip. `summarize.ts` split into `generateMemoryNote` (no write) + `summarizeAndHandoff` (generate+write). Explicit actions — manual Summarize, MC "Save memory" — still write directly. Setting relabeled "Auto-draft memory on run done".)
- [x] Settings performance: reduce settings open lag; defer usage/provider stat work so the settings surface opens immediately. (Root cause: all 9 sections rendered their subtree on mount — `display:none` — so ApiKeyRow ×4, LocalServerRow ×2 (+4s poll), and CustomEndpointsBlock fired per-provider status `invoke`s on open. Fix: sections now mount on first visit and stay mounted (`visitedSections` set + `Section mounted` prop), so opening to General pays only ~1 top-level call instead of ~7 serial ones. Stats parse was already deferred behind "Load stats".)
- [~] Product restraint: keep natural-language scheduling and proactive suggestions parked until the review/evidence loop feels excellent. **Multi-account unparked 2026-06-19** (review/evidence loop is now solid — worktree closed). See "Account switching" below.

## Account switching (delegate CLIs) — started 2026-06-19

Goal: switch which account a delegate CLI runs under (e.g. personal vs. work
ChatGPT for Codex). Model is **snapshot/restore only** — Klide copies
credentials the CLI already wrote (you log in normally); it never mints or
refreshes tokens, so worst case is "log in again", never "account broke".

Verified storage shapes:
- **Codex** — one plaintext file `~/.codex/auth.json` (`auth_mode` chatgpt|apikey, `OPENAI_API_KEY`, `tokens`). Stable identity: `tokens.account_id` (UUID) + email/plan decodable from the `id_token` JWT claims; apikey → sha256 fingerprint. Switching = swap the one file. No keychain.
- **Claude Code** — *two coupled pieces*: macOS Keychain item `Claude Code-credentials`/`<user>` (tokens) **and** the `oauthAccount` block + top-level `userID` in `~/.claude.json`. Switching = swap both atomically. Klide must keep its snapshots in keychain (Klide-namespaced), never plaintext.

Architecture: one generalized `src-tauri/src/accounts.rs` — provider-keyed
`AccountIdentity` (match key = stable `account_id`/fingerprint) + shared index
(`~/.klide/accounts/<provider>/accounts.json`, non-secret metadata only) +
per-provider capture. Generic commands `accounts_list(provider)` /
`account_save_current(provider, name)`. UI: Settings → Subscription → "Accounts"
renders a reusable `AccountsBlock` per provider (Codex / Claude Code / OpenCode).
Inline name field (Tauri's webview returns null from `window.prompt()`).

Slices:
- [x] **Capture + list + active-detect, all providers** (done 2026-06-19): list snapshots with active-detection (live identity vs saved), drift guard rejects unrecognised shapes, mode-600 snapshots. **Codex** → copy `~/.codex/auth.json`. **OpenCode** → copy `~/.local/share/opencode/{auth.json,account.json}`, identity = active account id. **Claude Code** → tokens copied from Claude's keychain item (`Claude Code-credentials`) into Klide's own keychain item (`Klide Claude Accounts`, never plaintext) + `oauthAccount`/`userID` snapshot file for later restore; listing is keychain-free (identity from `~/.claude.json`), only Save reads the keychain (one-time macOS prompt). omp has no auth → skipped. 6 unit tests.
- [x] **Activate (switch)** (done 2026-06-19): `accounts::activate` + `account_activate` command. Live-run guard — `DelegatePtyState::has_live_session(provider)` (PTY sessions now carry their provider) refuses a swap while a Klide delegate run is live (external terminals are invisible — documented limit). Codex/OpenCode → read all snapshots, then atomic temp+rename over each live file. Claude → restore tokens from Klide's keychain item into `Claude Code-credentials` + splice `oauthAccount`/`userID` back into `~/.claude.json` (one-deep `.klide-bak` backup, atomic config write). Format-drift abort if snapshot file count ≠ live layout.
- [x] **Premium inline UI** (done 2026-06-19): collapsed the separate Accounts block into the connection rows — Settings → Subscription → "Connections & Accounts" is now one row per provider with an `AccountControl` dropdown (active-account pill + ▾). Menu switches between saved accounts (✓ active, "switching…" feedback), inline "Save current login as…" name field, errors shown in-menu (incl. the live-run guard message). Fixes the earlier "too many rows / fiddly save / not premium" feedback.

Also fixed (same `prompt()` root cause): GitReview "Open PR" now uses an inline title/body composer overlay instead of `window.prompt()`.

Caveats baked in: old chatgpt-mode snapshots may hold stale refresh tokens → "may require re-login" (acceptable). Klide manages *other apps'* credentials, so it strictly snapshots/restores what you created.

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
