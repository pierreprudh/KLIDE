# TODO

Working thesis: Klide is a quiet agentic coding control surface. Keep the VS
Code muscle memory, but make agent power available at the point of action:
mode, provider, context, skills, rules, diffs, and history. Avoid always-visible
dashboards, seeded demos, and telemetry panels unless the user explicitly opens
them.

## v0.5 — Agent Operations (feature-complete 2026-07-21)

- [x] Add direct race-flow regression coverage: persistence, malformed state,
  bounded history, isolated dispatch, partial failure, and orphan cleanup.
- [x] Remove a race worktree when its Harness run fails to start without forcing
  deletion of a dirty checkout.
- [x] Add CI gates for frontend tests/build and Rust tests.
- [x] Build and boot-verify the release-profile Apple Silicon `.app` bundle,
  including the embedded frontend and `ptyd` entry point.
- [x] Reconcile the README, changelog, and agent context with the actual v0.5
  product state.
- [x] Merge the architecture-deepening work through PR #17 and keep the full
  frontend/build/Rust validation gates green.

## v0.5.1 — Release hardening and publishing

- [ ] Dogfood the full Tauri race path: dispatch, permission pause, restart,
  evidence comparison, winner merge, and explicit worktree cleanup.
- [ ] Publish the first signed/notarized macOS bundle.
- [ ] Validate Windows and Linux. Both known compile blockers are cleared: the
  delegate PTY layer builds off unix (2026-08-04 — wire types in ungated
  `pty_wire.rs`, `pty_client` stubs "no daemon here"), and the keyring backend
  is chosen per target (2026-09-10 — `apple-native` on macOS, `windows-native`
  on Windows, `sync-secret-service` + `crypto-rust` on Linux, via
  `[target.'cfg(...)'.dependencies]`). What remains is a real build on each
  OS: a Windows runner and a Linux runner with the Tauri dev packages plus
  `libdbus-1-dev`, then a smoke test of key save/read and Quick Look's
  "no preview here" answer.
- [x] Make worktree-per-run isolation the default parallel-agent flow. Fresh
  Klide conversations and Mission Control task dispatches now create a branch
  before starting the Harness or delegate CLI; the worktree pin survives layout
  switches, failed delegate spawns clean up untouched checkouts, and only
  non-Git folders fall back to local execution.
- [x] Complete provider-aware waiting/exit markers for historical delegate runs.
  Claude Code and omp reduce user/tool/final-assistant turns, Codex consumes
  task-start/task-complete markers, and OpenCode bounds an unfinished user turn
  by recency. For Klide-hosted sessions, live blocked hooks and durable PTY exit
  outcomes override transcript guesses; Codex's notifier now carries its thread
  id so that join survives restart.

## v0.6 — Dependable orchestration

- [ ] Make a Mission the primary outcome object: intent, task graph, acceptance
  criteria, worker Runs, and final evidence.
- [ ] Add visible budget and capacity controls for dispatch, queues, retries,
  escalation, and stop conditions.
- [ ] Route bounded work by capability between the native Harness, local
  models, and Delegate CLIs without hard-coding provider brands into policy.
- [ ] Apply validation contracts automatically: static checks, tests, Diff
  scope, semantic review, budget, memory, and human approval.
- [ ] Add durable background execution and local-to-cloud handoff before
  unparking natural-language scheduling or proactive suggestions.

### v0.6 Slice 1 — durable Mission tracer bullet (started 2026-07-22)

- [x] Make Rust the durable Mission authority under `.klide/missions/`: one
  `mission.md`, task Markdown files, and an append-only `events.jsonl`.
- [x] Replace `MissionTask.runId` with multiple Run attempts plus one accepted
  attempt; retries and races no longer overload Task identity.
- [x] Compile authored Markdown + Rust events into the TypeScript
  `MissionState` projection and reconstruct the latest Mission on reopen.
- [x] Approve a plan, prepare a fresh attempt in Rust, dispatch through the
  existing Harness, and attach the Run to its Task.
- [x] Have the Rust Harness record its persisted validation summary back to the
  Mission after settling; downstream tasks unlock only after acceptance, not
  process exit.
- [x] Keep the first surface an editable task list/tier board. Graph layout and
  cycle validation remain slice 2.
- [x] Freeze each task's worker kind, provider, model, and diff-review policy
  into its Markdown spec when the plan is approved.
- [x] Move one-at-a-time dispatch/chaining into a Rust Mission supervisor so
  the next accepted-ready task starts while every frontend surface is closed;
  rejected attempts park for explicit retry and independent branches proceed.
- [x] Reattach the tier-board surface to Rust-started Runs from transcript plus
  the global event stream so permission/diff pauses remain operable on reopen.
- [x] Reconcile Missions once when a workspace becomes active after a full
  desktop-process restart. Terminal Harness summaries recover validation and
  continue the graph; missing/non-terminal summaries become
  `attempt_interrupted` and park for explicit retry instead of replaying edits.
- [x] Slice 2: add the task graph view, cycle validation, and Markdown-backed
  dependency manipulation without introducing a second graph state model.
  Graph derives from the same task `dependencies` (`missionGraph.ts` layout +
  cycle mirror; `MissionGraph.tsx` SVG view with a Board/Graph switch). Edge
  edits write the dependent task's Markdown back through `mission_save_task`,
  which now rejects cycles in Rust (`first_dependency_cycle`) as the durable
  authority. Edits are pre-approval only.
- [x] Dispatch approved Delegate tasks through bounded one-shot CLI commands
  behind the existing Delegate adapter seam. PTY/ptyd metadata persists the
  Mission link and process outcome; exit moves the attempt to explicit
  operator review rather than acceptance. Accept/reject records durable
  validation, and restart recovery never replays an ambiguous Delegate.

## OpenCode v2 delegate (deferred — upstream is beta, noted 2026-08-12)

OpenCode 2.0 is a rewrite (Bun → Node, Electron desktop) whose server API is an
intentional breaking change: a documented HTTP API plus a generated TypeScript
client (`@opencode-ai/client`), with an OpenAPI 3.1 spec served at
`http://localhost:4096/doc` and bearer auth via an `authorization` header. It
installs as a **separate** binary — `npm i -g @opencode-ai/cli@next` → `opencode2`
— so it coexists with the v1 `opencode` our current adapter drives. Upstream
warns beta data may be wiped and the API may still move, so this stays deferred
until it stabilizes; nothing here blocks v0.5.1 or v0.6.

Why it's worth doing when it lands: the v2 server exposes over HTTP most of what
`delegate/opencode.rs` currently obtains by scraping — sessions, durable
history, event streams, models/providers, permissions, questions/forms, PTY
sessions, shell processes, skills, MCP, filesystem, snapshots/reverts,
compaction, and VCS status/diff.

- [ ] Add `OpenCode2` as its own `DelegateAdapter` beside the existing one, so
  v1 keeps working on the SQLite/`opencode export` path and only the new kind
  talks to the API. Do not migrate the v1 adapter in place.
- [ ] Drive run listing and transcripts from the API instead of reading
  `~/.local/share/opencode/opencode.db` and parsing the session id out of
  startup stdout.
- [ ] Evaluate `GET /api/experimental/session/{id}/log?after=<seq>&follow=true`
  (newline-delimited `{ id, event, data }`, replay-then-follow) against our
  hand-built delegate replay contract — capped scrollback ring + monotonic
  `seq` + `delegate_pty_snapshot` then dedupe. If it holds, the v2 kind reads
  upstream's log rather than carrying our own ring buffer, and its PTY
  endpoints may cover what `ptyd` does for v1.
- [ ] Handle the renamed config surface when we read or write opencode config:
  one global `~/.config/opencode/cli.json`, `agent`→`agents`, `prompt`→`system`,
  `disable`→`disabled`, MCP under `mcp.servers`.

Docs: <https://opencode.ai/v2/docs/migrate-v1>, <https://opencode.ai/v2/docs/build/client>.

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
- [x] Project Memory engine foundation: versioned kinds/review/provenance schema,
  deterministic local retrieval, and native `memory_search` / `memory_read`
  Harness Tools with their own `ReadProjectMemory` Transcript capability.
  Architecture, JSON Schemas, website SVGs, and the embedded-MCP PR sequence
  live in `MEMORY_ENGINE.md` and `KLIDE_MEMORY_SCHEMA.md`.
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
- [x] Evidence summaries: each run row shows last meaningful event, branch/worktree, files touched, diff/review entry point, tokens/cost, and memory status. (Done: last meaningful event — `last_event` parsed from the newest assistant turn in all 4 delegate adapters, shown as a quiet line under the row title; branch, files, tokens/cost, sub-agent count; diff/review entry point in the detail pane; memory status — `· memory` row chip + "Memory: Saved/Not saved" detail stat, matched by note `runId`. Klide's own runs now carry `last_event` too (enriched from the transcript in `write_summary`; `cost_usd` was already on `AgentRunSummary`) — live in-memory convos now also derive `last_event` (newest assistant turn, first line capped at 120 — `convoLastEvent` in `runLedger.ts`, mirroring the Rust `last_assistant_summary`), closed 2026-06-25. Worktree closed 2026-06-18: `delegate::runs::worktree_label(cwd)` detects a linked git worktree cheaply — `.git` is a *file* (a `gitdir: …/worktrees/<name>` pointer) for linked worktrees vs a directory for the main checkout, so one `stat` + tiny read, no `git` subprocess — populated centrally in `list_agent_runs`' existing `iter_mut()` pass over all 4 adapters. Surfaced as a "Worktree" EvidenceMeta in the detail pane and `· in <name>` in the compact row under `showEvidence`. Klide's own `AgentRunSummary` now carries `worktree` too — added the field + derive it from `cwd` via `delegate::worktree_label` in `agent_list_runs` (not persisted, so historical runs pick it up), closed 2026-06-25.)
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

## Focus delegate turns (shipped 2026-08-26, one gap parked)

Focus runs a delegate CLI headless and renders it as ordinary Klide messages.
Three fixes landed (`6c28a74`, `2e49d0a`, `adbcbf4`):

- Session reuse — the session id the CLI reports is remembered per run id and
  passed back as `claude --resume` / `opencode run -s`, so a turn sends only the
  newest message instead of re-folding the transcript. Verified against the real
  CLI: two turns, one session file, memory carried across.
- The fold no longer repeats text a delegate's own tool card already split off.
- The project command allowlist is carried into `--allowedTools Bash(<pattern>)`,
  so a headless turn may run what the user already approved. Verified: `gh pr
  list` was refused before, runs after.

- [ ] **Parked gap** — nothing on the delegate path writes the command
  allowlist; only an inline approval during a Klide Harness run does. A project
  that has only ever used delegates therefore has an empty allowlist, and the
  `--allowedTools` fix cannot be triggered. The closer is to surface a *blocked
  delegate command* as an approval card writing to the same store this already
  reads. Small, and it is what makes that commit reachable.
- [ ] Codex and omp still have no `parse_stream_line`, so Focus shows their
  prose with no tool rows. Claude Code and OpenCode have one.
- [ ] Approvals are granted upfront for a turn rather than asked per call. The
  per-call answer is Claude Code's `can_use_tool` control protocol (the "VS Code
  extension design" idea in `Ideas.md` #8), not a widening of this flag.
- [ ] A mode change made mid-conversation (Chat → Goal) lives in the system
  message, which a resumed session never receives.

## Parking Lot

- The earlier "Context Lens" idea (heuristic auto-injection of folder
  descriptions, parent scopes, changed-file context) was killed along with
  the project-graph UI — the heuristics weren't earning their place.
  If a real project-graph signal ever lands, it should feed Memory /
  summarization, not the chat composer.
- `.klide/memory/` write semantics — currently plain workspace files,
  not gitignored and not auto-committed. The user needs to pick per repo.
