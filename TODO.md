# TODO

Working thesis: Klide is a quiet agentic coding control surface. Keep the VS
Code muscle memory, but make agent power available at the point of action:
mode, provider, context, skills, rules, diffs, and history. Avoid always-visible
dashboards, seeded demos, and telemetry panels unless the user explicitly opens
them.

## Current priority — clean up local workflows before VPS

Direction confirmed 2026-10-26: VPS execution is the next major capability.
First finish and verify the existing local experience. This is a bounded
stabilization pass, not a requirement to finish every item in this backlog.
Existing recovery, approval, review and model-selection features stay the
baseline; unchecked items below are verification or specific remaining gaps.

- [x] Verify the current baseline (2026-10-26): all 1,753 frontend tests and
  the production build/bundle-split check passed. The full Rust test command
  passed outside the sandbox; the sandbox run denied local sockets/processes.
  This verifies automated checks, not the real-app acceptance pass below.
- [ ] Complete a real-app acceptance pass: start an isolated Run, answer an
  approval, stop and resume, restart and recover the Conversation, inspect the
  Diff and validation evidence, then merge or reject and explicitly clean up.
  Exercise a native hosted model, a local model and a supported Delegate;
  record which combinations passed and any limitations.
  **Parked 2026-10-31, in progress.** Sandbox `~/Documents/Private/klide-acceptance`,
  entry ⌘⇧P → Agent: New Run in Worktree, Work mode, Review policy, prompt
  "Add a `--max N` option to slug.sh … add two cases to test.sh, then run
  `sh test.sh`". DeepSeek Flash (OpenRouter) passed: isolated in its worktree,
  Stop then a follow-up resumed the same Run, 3 diffs + 2 commands waited for
  approval, Merge landed and `sh test.sh` passed on main. Restart-and-recover
  was not exercised. Fixed on the way: the worktree run opened a panel the
  one-slot surfaces never draw, so the visible panel wrote to main (#386, plus
  the Worktrees window in the Git preview's glass); the auto-commit subject was
  the latest prompt and Merge left the branch behind (#387). Remaining: restart
  leg, then Ollama `qwen3.5:9b`, then a Delegate (Claude Code).
- [x] Foreground Worker acceptance in the app (2026-10-26, sandbox repo
  `~/Documents/Private/klide-acceptance`, DeepSeek Flash parent, Claude Code
  worker): setup stage ran and was shown, the worker committed on its branch,
  **Merge** landed it and removed the worktree; a broken setup said "Setup
  failed" with its output, started no worker, and **Discard** cleaned up.
  Fixed on the way: a Focus task sent OpenRouter's model to Anthropic (#295,
  #296, #297), the parent redid a worker's fix in the main checkout (#300),
  untracked `.klide/coordination/` blocked every Merge (#300), the setup
  failure drew as a boxed report with no way to drop its worktree (#301).
- [x] Background Worker acceptance in the app (2026-10-27, same sandbox):
  with the parent hidden, the worker's approval reached you as a toast under
  Claude Code's mark with Deny / Allow / Open, Allow from the toast resumed it,
  and its finish toasted; the parent's rail row showed it running. A worker
  asking to read outside its worktree led its card with "Outside its working
  folder (…)". Shipped on the way: `worker:status` / `run:attention` app-wide
  (#303–#305); toast answers on their own centred row (#306, #308, #309,
  #312); `›` for commands, not `$` (#307); a waiting conversation's name
  shimmers and a finished, unseen one gets an accent point that the loader
  condenses into (#315–#321); "I'm sending a worker: …" before the dispatch
  row (#322, #324); no worker approval toast while its conversation is on
  screen (#324).
- [x] A project names its own check (2026-10-28): `checkCommand` in
  `.klide/worktree.json`, shown on the dispatch card, Settings as fallback.
- [x] Shell-command approval transparency (code reconciled 2026-10-28):
  `preflight_command` surfaces recognizable outside-workspace paths in the
  permission reason and `externalPaths`; the card and notification name them.
  This is a best-effort argument scan, not containment of arbitrary shell code.
- [x] Background subscription approval forwarding (code reconciled 2026-10-28):
  `agent/remote.rs` passes forwarded events through `attention::emit`, shared
  with app-hosted Runs. Asking/clearing and external-path payloads have tests
  in `agent/attention.rs`; the real-app restart/hidden-conversation acceptance
  above remains open.
- [x] Cancel an individual Klide-dispatched worker from its activity row,
  including setup, slot waiting and execution. Setup shares the command
  process lifecycle: cancellation stops its process group before settling,
  starts no model, and retains the worktree for inspection/discard. The parent
  can continue after cancelling one worker. Automated coverage includes setup
  cancellation, parent Stop during setup and cancellation at Run admission.
- [ ] Verify worker Cancel in the real app: setup, queued API worker, running
  Delegate/API worker and an approval pause; reopen the conversation and
  confirm Cancelled and the retained worktree. The tray of a Delegate's own
  internal sub-agents is separate from a Klide-dispatched worker.
- [x] Worker capacity at admission (2026-10-27): API workers wait in a fair
  queue for one of 4 app-wide slots, in front of the child Run
  (`agent/worker_slots.rs`), "Queued behind N running API workers" on the
  row, cancellable while queued. Verified in the app with a 2-CLI limit, then
  Pierre dropped the CLI limit (a CLI runs on its own subscription); bring it
  back as a second `Slots` if needed.
- [x] Consolidate local launch readiness from the existing checks: ready /
  unsupported / needs login / offline / unknown, with a reason and observation
  time (`launch_readiness.rs`, 2026-10-29). The worker card lists only workers
  that are not a definite no; a worker and a Mission attempt are rechecked
  with their model right before they start, and a definite no is refused with
  its reason (Mission: a recorded dispatch failure). A routed Delegate is
  judged on its source, not its own login. Unknown never blocks. Not yet on a
  picker or Settings row; extend the same answer for VPS later.
- [x] Reconcile README/TODO claims with acceptance evidence (2026-10-28),
  leaving unverified or unsupported behavior explicit. Results and remaining
  live checks: [acceptance evidence audit](#acceptance-evidence-audit--2026-10-28).
  This closes the documentation audit only; the stabilization pass stays open.

Exit: the checks above pass for the recorded supported paths, with no unresolved
blocker involving lost work, missed approvals, duplicate execution or misleading
completion. Then start the narrow VPS execution slice below. Phone control,
machine transfer, scheduling, new agent integrations and broad redesigns remain
later work; notarization and other desktop platforms keep their own release scope.

## Acceptance evidence audit — 2026-10-28

Documentation audit against repository code, tracked contracts, and the dated
acceptance notes below. No model calls, native app exercises, test suites or
release builds were run for this audit. A checked implementation item is not
proof of live acceptance for every runtime. Local notes and transcripts are
machine-local evidence, not fixtures shipped with the repository.

| Claim / flow | Available evidence | Remaining limit or check |
|---|---|---|
| Automated baseline | 2026-10-26 result recorded above; current [CI configuration](.github/workflows/ci.yml) defines frontend/build and Rust checks | Historical pass, not a fresh run. Linux tests enabled; Windows compile-only. Desktop acceptance still open |
| Foreground workers | 2026-10-26 record above: DeepSeek Flash parent, Claude Code worker, setup, commit, Merge cleanup, failed setup and Discard | Does not verify every runtime pair or cancellation stage |
| Background worker attention | 2026-10-27 record above: hidden parent, approval toast, Allow, finish notification and rail status; [attention handling](src-tauri/src/agent/attention.rs) | Hiding a conversation is not quitting the desktop. Individual Cancel and restart recovery still need acceptance |
| Worker cancellation / capacity | [Dispatch and setup regressions](src-tauri/src/agent/mod.rs), [worker validation](src-tauri/src/agent/tool_handlers.rs), [dispatch cancellation](src-tauri/src/agent/dispatch_cancel.rs), [API slot queue](src-tauri/src/agent/worker_slots.rs) | Live cancellation matrix remains open; orchestration capacity display still uses fresh planning state per task |
| `/btw` | Local note `docs/btw-live-acceptance-2026-10-26.md`: real Anthropic model, unchanged canary, concurrent main command, history and panel remount | No app/OS restart or live side-Stop exercise; Delegates that cannot enforce read-only are refused |
| Desktop quit/relaunch | [Background contract and verification scope](docs/BACKGROUND_CONVERSATIONS.md), [host placement](src-tauri/src/agent/run_host.rs) | Process test uses a fake CLI; real installed-CLI desktop quit/relaunch remains open. Eligible standalone subscription Runs only on Unix; no VPS execution |
| OpenCode V2 | [Verification notes](docs/OPENCODE_DELEGATE.md#verification), captured CLI fixtures and reproducible mock-model transport smoke | Transport coverage is not a funded real-model desktop acceptance pass; V2 account switching stays CLI-owned |
| Local inference | [Live smoke record](scripts/local-inference/results/SMOKE.md) for Llama app/managed llama.cpp setup, tool calls and restart selection | Specific servers/model only; not the full local Run recovery/review matrix |
| Spreadsheets / races | Implemented tools and automated coverage; live acceptance items under v0.5.1 remain unchecked | Create/revise/reject/rollback on local and hosted models; race approval/restart/compare/merge/cleanup still owed |
| Compaction / caching / Auto | Dated compaction and Ollama continuation records under Context management; [routing contract](docs/MODEL_ROUTING.md) | Headless compaction, delayed Anthropic cache display and Auto desktop flow remain unchecked; no universal runtime acceptance claim |
| Goal completion / review | [Goal gate](src-tauri/src/agent/goal.rs), [permission engine](src-tauri/src/agent/permission.rs) | Bounded check retries; missing check or unchanged native Run can finish without a pass. Review policy and prior approvals govern prompts; shell path warnings are not containment |
| Project Memory | [Automatic draft creation](src/components/AiPanel.tsx), [draft inbox](src/memoryDrafts.ts), repository [.gitignore](.gitignore) | Automatic drafts require review; `.klide/memory/` is ignored here. Other repositories choose their sharing policy |

README now states these verification limits and follows the current local-first
stabilization → narrow VPS priority. No live acceptance item was closed by this
audit. Next follow-up: verify worker Cancel during setup, API queueing, active
Delegate/API execution and an approval pause, then reopen and inspect Cancelled
state and the retained worktree.

## Harness follow-ups

- [x] Strengthen native compaction continuity (2026-10-31): opening goal and
  latest request verbatim, latest recorded TODO state even after an empty
  summary, explicit tool outcomes, and summary guidance for constraints,
  blockers, verification and the next action. Repeated compaction and durable
  replay are covered without inference; real-model adherence remains unmeasured.
  Contract and limits: [Task continuity](docs/COMPACTION_CONTINUITY.md).
- [ ] Clean coding-quality benchmark baseline (deferred by Pierre 2026-10-31,
  alongside the VPS backlog): use the independent multi-file quality graders,
  fixed harness/model versions and repeated trials. Compare correctness,
  elapsed time and cost with cold/warm cache conditions separated; retain
  failures and sample counts. Grader tests passing is not a measured model
  quality gain. Run when the environment and representative tasks are ready.

## Orb follow-ups — remote work and continuity

- [x] `/btw` read-only side questions: reuse the conversation panel, transcript
  and Run controller; keep a saved child conversation with a bounded public
  parent-context snapshot on each send. Closing hides it; Stop targets only
  the child. Rust retains the read-only policy on resume and refuses delegate
  runtimes that cannot enforce it. Real-model in-app acceptance passed
  2026-10-26 with Anthropic Claude Opus 4.8: canary unchanged, writes/commands
  unavailable, side answered during a 90-second main command, and history plus
  read-only mode survived closing/reopening and a full panel remount.
  Evidence: `docs/btw-live-acceptance-2026-10-26.md` (local notes).
- [ ] VPS execution, first vertical slice: one SSH-connected Linux host, one
  supported CLI and an existing checkout. Launch, stream, stop and reattach
  after desktop disconnection; retrieve remote files/diffs and validation
  evidence without treating remote paths as local. Keep destination credentials
  on that host and reuse Run host admission/control semantics. Extract the
  headless host as needed; `agent/remote.rs` currently means the local daemon.
- [ ] Extend the unified launch readiness item above with minimal remote
  checks in the VPS slice, reusing `launch_readiness::Readiness` as the
  shape a remote host reports.
- [ ] Local ↔ VPS transfer, after VPS execution: settle the source, show the
  inventory/exclusions, checkpoint, verify the destination, then activate with
  a durable receipt and one execution ownership generation. Preserve the
  Conversation and historical Runs/evidence; subsequent execution gets a new
  Run and normally a fresh native session with portable history. Reconcile lost
  acknowledgements before retry; use destination credentials. Cover dirty files,
  duplicate activation, interrupted copy and stale source events. Preserve
  ADR-0002's explicit retry for interrupted Mission attempts.
- [ ] Durable one-shot wake-ups: persisted due time/reason, occurrence identity,
  cancellation, restart recovery and deduplicated admission through the Run
  host. Show waiting-for-client/permission/error states. Existing process-local
  shell/worker follow-ups are not a durable scheduler.
- [ ] Cross-machine project-context replication, after real multi-machine use:
  explicit scope, revisions, conflicts, exclusions and offline reconciliation.
  Keep working Foundations separate from reviewed Project Memory; a transfer
  checkpoint does not require continuously synchronized workspace files.

- [ ] Phone companion — a premium app to talk to Kit while the Mac does the
  work, on your own models, listing only the ones usable now (direction
  confirmed 2026-10-26, scheduled for later). Plan: `docs/COMPANION.md`;
  screens: `preview/companion.html`.
  - [ ] Resident runs: the daemon hosts subagents and `consult_advisor`, starts
    observer wake turns itself, drops a replaced key from its token cache, and
    keeps its own connector pool. Then `background_eligible` widens to any
    standalone conversation (Missions stay app-side). Parity first, widening
    last, or API runs silently lose subagents and GitHub watches.
  - [ ] Usable models: the model half of Unified launch readiness above, one
    Rust answer with a reason per refused row; stars move from localStorage to
    a file both clients read.
  - [ ] Companion door in `klide ptyd`: HTTP + SSE over the daemon's existing
    operations, Tailscale interface only, QR pairing, device secrets kept as
    sha256, full auto refused from the phone.
  - [ ] iOS app with Tauri 2 from the same React components (needs the Apple
    developer account the signed macOS bundle also needs).
  - Open: push for "Waiting on you" needs an APNs sender (minimal relay).

Research and implementation audit: `docs/competitors-orb.md` (local notes).

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

- [x] Give Claude Code its reasoning-effort dial: low, medium, high, xhigh,
  and max, carried into terminal launch/resume and Focus headless turns.
  Unsupported or absent values leave the CLI default unchanged.
- [ ] Dogfood the spreadsheet path in the app: create, inspect, revise, reject
  a proposal, and roll a workbook back from a checkpoint — on a small local
  model as well as a hosted one. The Tools shipped in 0.6.3 with Rust and
  frontend coverage but no live in-app pass.
- [ ] Dogfood the full Tauri race path: dispatch, permission pause, restart,
  evidence comparison, winner merge, and explicit worktree cleanup.
- [x] Decide the distribution channel: GitHub Releases only, ad-hoc signed
  (2026-09-20). Notarization is deferred, not cancelled — the channel does not
  change what Gatekeeper does, since the quarantine flag comes from the
  download itself, so an ad-hoc bundle is still blocked on a machine that is
  not the build machine. The answer while the audience is small is to document
  the way past it (System Settings › Privacy & Security › Open Anyway, or
  `xattr -dr com.apple.quarantine`), which the README and the release notes now
  do.
- [ ] Notarize the macOS bundle when Klide is handed to someone who should not
  have to read install instructions. Needs an Apple Developer Program
  membership and a Developer ID Application certificate, then `notarytool
  submit` + `stapler staple` in the bundle step. Until then every release that
  ships a bundle repeats the Open Anyway note.
- [ ] Validate Windows and Linux. CI now builds both (2026-10-26, job
  `rust-other-os`): **Linux** compiles and passes the full suite; **Windows**
  compiles, and its test run is off until these 35 Unix-assuming tests are
  fixed or gated (`cargo test` on `windows-latest`, run 40367830430):
  conversation_store ×9 (all), agent ×9 (command_env venv, worker_setup ×2,
  tools secret-paths + preflight ×2, types emit-site scan, worker_dispatch ×2),
  delegate ×4 (claude_code ×2, copilot, list_runs), worktree_setup ×2,
  storage ×2, deep_link ×2, search, run_documents, pty_host, providers mirror
  (likely CRLF on checkout), memory proposals, klide_skill, coordination memo.
  Fixed on the way: `linkDirs` symlinks per platform, the PTY title watcher is
  Unix-only, and a stdio MCP server that dies at once now quotes its stderr
  instead of "Broken pipe" (a race on every OS, caught on Linux). Still owed:
  a real app build on each OS and a smoke test of key save/read and Quick
  Look's "no preview here" answer.
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

## Worker upgrades — comparison reviewed 2026-09-21

- [x] Return failed child Runs as failed Tool results, require a durable `done`
  state before accepting their report, and attach observed Git checkout state.
  A clean checkout is not validation; auto-commit failure must not be hidden
  behind an unconditional "committed" claim.
- [x] Carry an explicit source commit between dependent workers: `source_ref`
  resolves before approval, pins the new worktree, and returns `sourceCommit`.
  Testers can receive the implementer's committed changes without merging them
  into the parent. Uncommitted files are excluded and existing branches rejected.
- [x] Background dispatch: `spawn_subagent(background: true)` returns the
  child's Run id at once; the report is delivered at the parent's next turn
  boundary or by a follow-up turn (the observer watcher, asking the worker
  registry). Inspect / cancel / read-result go through the coordination verbs
  the child is already registered for; no second door. Shipped 2026-10-13,
  foreground/background Claude Code acceptance recorded 2026-10-26/27 above.
  Individual Cancel and desktop restart recovery remain open.
- [x] Align the orchestration capacity display with live admission usage
  (2026-10-29): `OrchestratorConsole` routes the whole plan against one
  capacity state carrying Rust's live API worker pool (`agent_worker_capacity`,
  polled every 3 s) and shows "API workers running n/4" (+ "· k waiting").
  The TS defaults now match Rust: 4 API workers, Delegate CLIs unlimited.
  Mission attempts still take no API worker slot. Previously it constructed a fresh `createCapacityState()`
  for each task, rather than reserving against shared live occupancy. Rust
  already limits API workers to 4 with cancellable queuing (`agent/worker_slots.rs`).
  Delegate CLI workers deliberately have no limit. Other capacity kinds in
  `capacityPlanner.ts` remain a planning model, not enforced admission limits.
  Off-screen permission notifications are implemented (`attention.rs` and
  `runAttention.ts`); keep their live verification in the acceptance pass.
- [x] Make worker setup an approved, visible stage (2026-10-26). The dispatch
  card names the recipe's `setupScript`, the script runs to completion in the
  worker's worktree before the child Run exists (`ToolProgress` → "Running
  setup…" on the dispatch row), and a failure is the Tool's failed result: no
  worker, no tokens, worktree kept. Re-read at run time, a changed recipe
  voids the approval. Worker setup now responds to individual Cancel and
  parent Stop through the shared command process lifecycle; its configured
  `scriptTimeoutSecs` remains the timeout fallback (default 600 s).
- [x] Join worker results to validation evidence and a review/apply action
  (2026-10-26). The parent's check command runs in the worker's worktree when
  it reports (`WorkerOutcome::describe` in `agent/tool_handlers.rs`; result on the report
  and, for foreground workers, on the Tool metadata as `validation`). The dispatch row offers Merge / Discard while a
  worktree on the branch exists (`WorkerBranchActions`, Mission Control's
  semantics); nothing removes a worker's worktree on its own. A
  background worker's check takes the individual dispatch cancellation token;
  parent Stop intentionally does not cancel it, and the command timeout still
  bounds it. Live Cancel during validation remains unverified. Merge has no
  diff preview on the row: Git Review shows it.

Research and benchmark plan: `docs/workers-comparison-2026-09-21.md` (local notes).

## v0.6 — Dependable orchestration

- [ ] Make a Mission the primary outcome object: intent, task graph, acceptance
  criteria, worker Runs, and final evidence.
- [x] Mission attempts in worktrees of their own (2026-10-29,
  `missions/isolation.rs`): the Mission branch `klide/mission-<id>` starts at
  HEAD, each attempt forks from its tip, acceptance commits and fast-forwards
  it (refused with a failed `mission-integration` check when it cannot), the
  checkout is never written to and the Mission card offers Merge. Open: the
  recipe's setup script in attempt worktrees (needs plan approval to show it),
  a live run of an isolated Mission in the app (Harness + Delegate attempt).
- [ ] Add visible budget and capacity controls for dispatch, queues, retries,
  escalation, and stop conditions.
- [ ] Route bounded work by capability between the native Harness, local
  models, and Delegate CLIs without hard-coding provider brands into policy.
- [ ] Apply validation contracts automatically: static checks, tests, Diff
  scope, semantic review, budget, memory, and human approval.
- [ ] Add durable background execution and local-to-cloud handoff before
  unparking natural-language scheduling or proactive suggestions.
- [x] Agent coordination between Harness Runs (PR #84, 2026-09-05) and
  Delegate CLIs via the embedded MCP server `klide mcp coordination` +
  app-side bridge (PR #93, 2026-09-10). Every Run with a Workspace is on the
  plane whatever its Mode. Proven end to end by an opt-in test that drives a
  real `claude -p` turn into the journal (`a_real_claude_code_turn`,
  2026-09-11). Surviving an app restart is
  done (2026-09-11): the MCP server resolves the bridge from
  `coordination-endpoint.json` per call instead of holding a port, and the
  bridge rebuilds an unbound session from its scrollback record. Open
  follow-ups: wake an idle Delegate on accepted mail (Claude Code Stop hook
  blocking with the inbox as reason); dogfood Codex `-c` overrides after
  `resume` and OpenCode's `OPENCODE_CONFIG` merge; hold #3
  `From<AgentRunStatus>` in coordination.rs. Message quality hardened in
  PR #101 (2026-09-13): receipts read from the journal, replies bound to the
  original route, and the operator path answerable on both sides.

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

## OpenCode v2 delegate (shipped 0.6.9, 2026-10-12)

OpenCode 2.0 is a rewrite whose server API is an intentional breaking change:
a documented HTTP API under `/api`, bearer auth, and a separate binary
(`@opencode/cli`). Klide supports it beside v1 in one adapter — the installed
version picks the contract, nothing is migrated in place.

- [x] Support v2 in the existing `OpenCode` adapter, switched on the installed
  version (`configure_version` / `installed_v2`): v1 keeps the `--attach` +
  `/event` + `opencode export` path, v2 launches a private `--standalone`
  server, reads `/api/event`, sends `/api/session/{id}/command`, and handles
  permissions over `/api/session/{id}/permission`. Focus, interactive PTY
  sessions, Missions, resume, native slash commands and status callbacks all
  work; reasoning streams separately from the answer.
- [x] Recover an interrupted turn from durable history
  (`/api/session/{id}/message`) instead of trusting the event stream alone.
- [x] Discover v2 models through a private server so a down shared service
  can't hide local, free or configured models. Credentials stay in OpenCode
  (V2 keeps them in SQLite; the v1 `auth.json` account switcher is disabled
  for v2).
- [x] Connector discovery reads `~/.config/opencode/cli.json` as well as
  `opencode.json`, and accepts MCP entries under `mcp.servers` or `mcp`.
- [x] Isolated smoke test covering discovery, reasoning + answer streaming,
  resume, commands and status callbacks without paid inference.
- [x] Run listing and transcript reads for v2 stay on `opencode.db`, deliberately
  (2026-10-26). `GET /api/session` exists and is stable, but answering through
  it means starting a server, because the background service may be down and
  Klide must never wake it carrying a session's env. Mission Control history
  would then cost a process spawn per scan. The read is read-only SQLite on
  `session_v2` / `session_message`. Schema rechecked against 2.0.27. The tests
  build their own schema, so a later release that renames these tables would
  empty the list silently (`discover` returns nothing on a failed query):
  recheck on each OpenCode minor bump.
- [x] `GET /api/experimental/session/{id}/log?after=<seq>&follow=true`: not
  adopted (2026-10-26). It replays a session *on one server*; Klide runs a
  private `--standalone` server per turn, so there is no long-lived server to
  re-follow. An interrupted turn is already recovered from
  `/api/session/{id}/message`, and PTY sessions keep Klide's ring buffer + `seq`
  + `delegate_pty_snapshot` in `ptyd`. It is also still experimental. Revisit
  only if Klide ever attaches to the shared service.
- [x] MCP wiring speaks the installed version's shape (2026-10-26): v2 gets
  `mcp.servers.klide` + `disabled: false`, v1 keeps `mcp.klide` + `enabled`.
  Probed on 2.0.27 with a stub stdio server under `--standalone`: both shapes
  connect (v2 migrates the old one on load), so this removes a dependency on
  the migration, not a live bug. Never probe with `OPENCODE_CONFIG` set
  through a non-standalone command: it boots the shared background service
  with that env.

Docs: <https://opencode.ai/v2/docs/migrate-v1>, <https://opencode.ai/v2/docs/build/client>.

## klide-bot — PR review + fix on any model (plan: docs/KLIDE_BOT.md, drafted 2026-10-23)

- [x] Reviewer: read-only OpenCode on `REVIEW_MODEL` sets the `review` status
  and one sticky comment (PR #267). Inert until configured.
- [ ] Pierre: decide D1–D5 in `docs/KLIDE_BOT.md`.
- [ ] S0 — Pierre: secret `OPENROUTER_API_KEY`, variable `REVIEW_MODEL`, spend
  limit, `review-override` label. Done when three real PRs carry a review.
- [ ] S0 — after a week of reviews that hold up: branch protection requires
  `review` on `main`.
- [ ] S1 — Pierre: create the `klide-bot` GitHub App (Contents, Pull requests,
  Issues, Statuses: write) and add `KLIDE_BOT_APP_ID` / `KLIDE_BOT_PRIVATE_KEY`.
- [ ] S1 — workflows mint an App token and act as `klide-bot[bot]`, so its
  pushes trigger CI and the reviewer.
- [ ] S2 — `/fix`, `/fix <instruction>`, `/fix model=…`: OpenCode on
  `FIX_MODEL` fixes only the blocking findings, runs `tsc` + `vitest`, pushes
  one commit to the PR branch. Done when a planted break goes red → `/fix` →
  green.
- [ ] S3 (optional) — `AGENTS.md` review guidelines pointing to `REVIEW.md`;
  Pierre turns on Codex automatic reviews.
- [ ] S4 (later) — automatic rework on a failed review, 2 tries, then
  `needs-pierre`. Waits until S2 has earned trust.

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
  live in `docs/MEMORY_ENGINE.md` and `docs/KLIDE_MEMORY_SCHEMA.md`.
- [x] Memory auto-summarizer foundation (superseded by the v0.4 review inbox below): eligible completed native Runs propose a memory draft, controlled by `autoMemoryOnRunDone` (default ON). Automatic proposals do not become Project Memory until the user reviews and accepts them (`AiPanel.tsx`, `memoryDrafts.ts`). Explicit manual save actions remain available.
- [x] `userAnswerQuestion` pause tool + `/interview` slash command: new tool in the Rust registry that pauses the harness via oneshot, surfaces an inline Q&A card in the AI panel, returns the user's typed answer to the model. Built-in skill "Codebase Interview" shipped in `DEFAULT_SKILLS` (src/skills.ts) — visible in the Skills modal, toggleable like the Code Review built-in, and the system prompt picks it up automatically. Plan mode, read-only, writes `docs/codebase-decisions.md` at the end. The skill explicitly forbids re-asking the same question (the model must track asked questions in its scratchpad). The `/interview` slash command inlines a self-contained prompt so it works even when the skill is disabled.

- [x] Several API keys per provider, one main (2026-10-19): Settings › API keys
  saves more keys beside the one in use and switches which is main
  (`provider_keys.rs`); only the main key is ever sent.
- [ ] Budget management window: a spend budget per provider and per saved key —
  top-ups, spend against them, what happens at the limit (warn / stop / switch
  to another saved key). Today a budget is one localStorage figure per
  provider (`klide.budget.*`, Settings › Balance) and keys carry no spend.

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

## Context management — prompt caching + Rust compaction (PRs #214, #215, #218)

Shipped 2026-10-20: prefix-stable prompts, Anthropic/OpenAI/OpenRouter cache
hints, cache-aware cost, one-batch trimming with retained values, summary
compaction owned by the Rust loop (`agent/compaction.rs`, `kept` markers),
fit guard, adaptive thinking on current Claude models (dogfooded ✓).

- [x] Dogfood compaction in the app (2026-10-21, Ollama lfm2.5 at 32k): a batch
  that overflows alone is squeezed to the value store; mid-run compaction keeps
  going without re-reading (tool ledger); the follow-up keeps the thread
  (verbatim requests); Compact from the gauge panel; the fit guard refuses only
  what can't fit. Fixed along the way: PRs #219–#240.
  - [ ] a headless Run (worker or Mission attempt) compacts with no panel open
- [ ] Dogfood the cache: reply after 10+ min on Anthropic and check "N% cached".
- [x] Background-shells review leftovers (2026-10-26): the observer list polls
  only while an observer runs or a follow-up waits (`agent/observerPoll.ts`),
  and a wake turn that fails toasts an error with Open, not "updated".
- [x] Observer guidance is explicitly conditional: "Background observers
  (when run_command is available)" (`system-prompt.ts`). The block remains
  stable across Mode changes, preserving the frozen prompt prefix; it does
  not grant tools to Chat or Plan. Code reconciled 2026-10-28.
- [x] Stop a degenerate reply: a small model looping on one line streamed for minutes until the window filled (lfm2.5 after a bad prompt). The shared stream loop now closes a reply whose tail is one unit repeated (≥ 2000 bytes, ≥ 10 copies), keeps it up to the first repeat and says so (2026-10-25). Live check on a looping local model owed.
- [x] Record the exact fenced delivery in the transcript, with its position
  before the operator's message (2026-10-24). Peer mail, observer completions
  and background worker reports replay without changing the cached prefix;
  older observer transcripts still replay their original completion text.
- [x] Ollama continuations preserve structured tool calls and results
  (2026-10-24). The native adapter translates argument objects and `tool_name`;
  trimming and squeeze-to-fit can reach prior results. Live lfm2.5 check:
  the second request reused 221 of 242 prompt tokens. Cache-read counts are
  reported when the Ollama server supplies them.
- [x] Upgrade ironcalc to 0.9 (zip ≥ 9) and drop the three ignores in
  `.cargo/audit.toml` (2026-10-25 — ironcalc 0.9.1, zip 9.1; the file is gone).
- [x] Refresh base list prices in `pricing.rs`. The GPT-5 family is current
  (2026-10-22); Mistral and xAI per model from their own endpoints on
  OpenRouter, DeepSeek from its pricing page (peak rates), 2026-10-25.
- [x] DeepSeek row moved to the documented names (2026-10-29): default and
  light/standard `deepseek-flash`, strong `deepseek-v4-pro`. Checked against
  DeepSeek's pricing page, not a key (none on this Mac); whether the old names
  still answer is moot for new picks.
- [x] xAI row moved to `grok-4.7` (default + standard rung, 2026-10-29); xAI's
  model list names no bare `grok-4`. Docs-checked, no key on this Mac.
- [ ] Dogfood Auto in the app (the Rust side was probed live 2026-10-21,
  `auto_on_this_bench`): picker row, the meta line names the routed model, a
  follow-up stays on it, stars reorder the pick, reopen restores the thread,
  and "which model are you?" gets the routed model's name.

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

- [x] A delegate command now writes the command allowlist (2026-10-02, Claude
  Code): its permission prompt is relayed to the same card the Harness shows,
  and "for this project" writes the store the next turn reads. Still parked for
  Codex: a `declined` command is visible as a failed row but raises no card,
  because Codex has no prompt hook in `exec` — that one needs the post-hoc
  "allow and continue" card.
- [x] Codex and omp have a `parse_stream_line` (2026-10-02): `codex exec
  --json` and `omp --mode json`, each resuming its own session, so Focus shows
  their tool rows like Claude Code's and OpenCode's. Fixtures are from the real
  CLIs; a live in-app pass with a funded Codex account is still owed.
- [x] Approvals are asked per call for Claude Code (2026-10-02): the headless
  turn names `mcp__klide__permission` as its `--permission-prompt-tool`, the
  bridge binds the prompt to the Run, and the operator answers on the Harness
  card (`agent/permission_relay.rs`). Codex and OpenCode stay upfront
  (`--auto` / `workspace-write`); a live in-app pass is owed.
- [x] A mode change made mid-conversation (Chat → Goal) reaches a resumed
  session (2026-10-02): the runner fingerprints the system block per session
  and, when it changed, says it again ahead of the message. Not through
  `--append-system-prompt`: Claude Code snapshots its system prompt on a
  session's first request and ignores the flag on `--resume`.

## Parking Lot

- The earlier "Context Lens" idea (heuristic auto-injection of folder
  descriptions, parent scopes, changed-file context) was killed along with
  the project-graph UI — the heuristics weren't earning their place.
  If a real project-graph signal ever lands, it should feed Memory /
  summarization, not the chat composer.
- `.klide/memory/` sharing policy — plain workspace files, ignored in this
  repository and not auto-committed. Other repositories choose whether to
  ignore or explicitly share reviewed memory; drafts remain private.
