Update (2026-11-08, live pilot): Native image delivery passed a fresh randomized
color canary on local Ollama `qwen3.5:9b`, with exact pre-dispatch PNG hashes.
Earlier OCR/formatting failures and an incorrect writer transcription are retained;
this is input-delivery proof, not model reliability or design judgment. A Node
writer controller now isolates source, scopes file writes, captures each candidate,
checks flows/typecheck, requires native identity clearance, and self-reviews/revises
under three-cycle/45-minute/24-HTTP-attempt limits. It refuses automatic crash replay.
The isolated baseline/capture smoke reaches the native checkpoint with zero model
attempts; a complete live UI iteration and human quality decision remain open.
See `scripts/design-feedback/EXPERIMENT.md`.

Update (2026-11-08): Mac verification now records 40 screenshot/AX pairs:
six scenarios in both themes/sizes, with detailed interaction checks at light
900×700. Scope and remaining checks are recorded in the local native report.
A development-only visual reviewer now validates bundle hashes and native scope,
then uses the normal Chat Run host with image attachments. Mock-wire hash tests
pass. This is partial PR 4: live canary, writer handoff, controller and council
remain open. The earlier review below is retained as historical findings; the
launcher and scoped native evidence are now available. Exact cross-run PNG
identity remains open.

# Design agent: visual feedback first, council second

Status (2026-11-07): visual feedback infrastructure implemented locally for all
six planned production AiPanel scenarios. Captures cover intermediate approval,
rejection, question/error/retry/cancel, child-activity and model-menu states,
with browser interaction checks, accessible snapshots, accessibility findings,
source/evidence manifests and local pixel comparisons. Exact cross-run pixel
identity for the expanded matrix remains open: Chromium antialiased borders
show small raster differences, retained in the raw comparison reports. Native desktop parity
is pending. Native visual Runs, iteration/council controllers and measured
trials remain planned; no model or council results are claimed.
Date: 2026-11-06. Reviewed 2026-11-08 — see [Review](#review--2026-11-08)
before starting PR 4; it proposes parking the council (PR 6–8).

By this plan's own definition (see *Dependency order*), the first vertical
slice is **not** complete: the browser half is done, the recorded desktop parity
check is not, and PR 2's "three clean captures match" acceptance fails on
Chromium antialiasing.

## Outcome and scope

Give a Klide Run repeatable evidence of the interface it changes, then measure
whether independent reviewers improve the result enough to justify their cost.
Start with Klide's conversation panel and composer. The first deliverable is
developer tooling plus a local comparison report. A user-facing Design capability
comes only after the experiment supports it.

Success means working changes that Pierre prefers under blind comparison,
supported by interaction checks and a desktop verification pass. Model scores
are observations, never the completion gate.

Do not add a browser pane, ship Chromium, install Storybook, train a model, or
build a second agent executor for the pilot. Playwright is a development-only
dependency. Its browser installation is a documented development prerequisite,
not an app dependency or an automatic runtime download.

## Verified starting points

| Existing seam | What we can reuse | Limitation / decision |
| --- | --- | --- |
| `preview/*.html` and `preview/*.tsx` | Vite previews importing production components, tokens and fonts | Ad hoc fixtures use current time and partial mock layouts; establish a dedicated deterministic fixture contract. Existing uncommitted previews remain untouched. |
| `src/theme.ts`, `Design.md`, `src/styles/tokens.css` | Theme IDs and design language | Use real IDs (`klide-light`, `sage-garden-dark`), not generic `light` / `dark`. |
| `src-tauri/src/agent/types.rs`, `run_core.rs`, adapters | Image attachments, image limits, provider wire conversion | Verify delivery after attachment clamping; a file path or text reference alone does not prove the model received pixels. |
| `src-tauri/src/agent/sight.rs` | Vision capability checks and descriptions for models without vision | Descriptions support implementation but are not independent visual reviews. Require native image input for the pilot writer and reviewers. |
| `src-tauri/src/agent/mod.rs` | Synthetic `look_at_image` events used by Sight | There is no callable `look_at_image` entry in `agent/tools.rs`; do not plan against one. |
| `agent/run_host.rs`, Run coordination, Transcripts | Admission, cancellation, Run lineage, durable evidence | All experiment model calls must use the native Harness through the Run host. |
| `agent/subagents.rs` | Same-model read-only roles and editing Workers | Ordinary subagents do not give us a cross-provider council. Workers may edit; do not repurpose them as supposedly read-only judges. |
| `agent/goal.rs` | Bounded command validation at a `/goal` finish | This is not a shipped general visual optimization supervisor. Keep experiment revision state outside it. |
| `scripts/harness-bench/`, `agent/live_eval.rs` | Manifest/report conventions and real provider/Harness benchmark patterns | The existing paired benchmark uses a test supervisor and coding fixtures. Do not copy its admission bypass or claim it already handles image review. |
| `src/agent/runTraceDetails.ts`, diagnostics | Usage, vision usage, unknown-cost handling | Reconcile parent and child usage by unique Run/request identity; do not double count or turn missing prices into zero. |
| `docs/browser-preview.md` | Earlier parked preview proposal | This plan authorizes developer capture tooling, not that pane. `src-tauri/src/preview.rs` now renders document thumbnails; do not overwrite it with browser lifecycle code. |

## End-to-end flow

1. Freeze a source revision, brief, scenario set, model selections and budgets.
2. Start a disposable checkout and its loopback-only Vite server.
3. Capture the baseline: screenshots, accessible structure, console/page errors,
   and interaction assertion results.
4. A writer Run receives the brief and verified image attachments, edits the
   production components, and requests another capture through a command tool.
5. The capture completes as an immutable evidence bundle. The experiment
   controller passes its images into the next writer Run; the pilot may split
   work into multiple Runs rather than inventing dynamic image-tool delivery.
6. Single-agent arm: the same writer reviews the result against the rubric.
   Council arm: two independent tool-free image-capable reviewer Runs inspect
   the identical bundle; their validated findings go to the writer together.
7. Revise at most three times; retain all candidates and an explicitly selected
   best candidate. Report stop reason, checks, unknowns, usage and source patch.
8. Generate a blinded local comparison for Pierre. Verify finalists on macOS
   in the real desktop app before drawing a shipping conclusion.

The experiment controller is a bounded state machine that starts/stops Runs,
requests captures and evaluates gates. It never implements provider streaming,
tool dispatch, its own credential handling, or a separate message bus.

## PR 1 — Deterministic conversation scenarios

Proposed files: `preview/design-feedback.html`,
`preview/design-feedback.tsx`, `preview/design-feedback/scenarios.ts`,
`preview/design-feedback/fixtures.ts`, `preview/design-feedback/README.md`.

Import production conversation/composer components, the normal fold and tokens.
Use a narrow dependency-injection seam if necessary; do not copy JSX/CSS into a
benchmark-only imitation. If a shared render seam must be extracted, preserve
existing behavior and keep the extraction separate from design changes.

Expose scenario selection through validated query parameters and a small
test-only API: `ready`, `scenarioId`, `fixtureVersion`, `setState`, `reset`.
The ready promise waits for fixtures, fonts and explicit rendering completion.
Seed IDs, time and generated data. Disable caret blinking and unrelated
transitions for still captures; interaction tests run with production behavior.
Use fresh browser contexts and isolated storage; mock only the named native
boundaries with production-shaped data. Record which boundaries are mocked.

Initial scenarios:

| ID | State and important behavior |
| --- | --- |
| `compose-empty` | Empty conversation, focused composer, actual send binding and disabled/ready states |
| `conversation-long` | Long folded transcript, large code block, long paths and follow-latest behavior |
| `tools-and-review` | Running/settled tool output, long command, inline approval and rejected edit |
| `waiting-and-error` | Needs-input question, provider failure, retry and cancel affordances |
| `subagent-activity` | Mixed child states using the production tray and observed-event fold |
| `composer-menu` | Open model/context menu, keyboard navigation, Escape and focus return |

Capture each in `klide-light` and `sage-garden-dark`, at 1440×900 and
900×700 CSS pixels, DPR 1. These are pilot sizes, not supported-size claims.
Add screenshots after keyboard focus, open menus and recovery actions where
relevant, rather than capturing every possible combination.

Acceptance: a listed scenario loads without Tauri, renders real components,
resets reproducibly, and exposes explicit ready/error state. No actual user
conversations, API keys, network calls to providers, or current-time labels.

## PR 2 — Capture command and immutable evidence bundles

Proposed files: `playwright.design.config.ts`, `scripts/design-feedback/capture.mjs`,
`scripts/design-feedback/report.mjs`, `tests/design-feedback/*.spec.ts`;
development scripts/dependency in `package.json` and the lockfile.

Proposed developer command, implemented in this PR:

```sh
npm run design:capture -- --scenario conversation-long --output artifacts/design-feedback/baseline
```

Use a dedicated port supplied by the controller with strict-port behavior;
avoid Vite's Tauri port 1420. Record readiness and terminate only processes
started by this capture invocation. Refuse an existing output directory.

Each capture writes `manifest.json`, `checks.json`, per-state PNGs,
accessible snapshots, console/page errors and `index.html`. Use Playwright's
supported accessible-snapshot assertion API for the pinned version. The HTML
viewer shows baseline/candidate side by side and a pixel diff; no model is
needed to view evidence. A pixel diff detects change, not improvement.

The manifest includes schema version, evidence ID, source commit, dirty patch
hash, fixture/brief hashes, file hashes, browser version, OS, viewport/DPR,
locale/timezone, theme, timestamps and capture status. Record a normalized
source-tree identity too; exclude generated evidence from source hashing.
The patch itself must be retained, including relevant untracked inputs.

Acceptance: three clean captures of one unchanged scenario on the same pinned
environment match. Any mask is narrowly justified and listed; do not mask
content or controls under review. Missing fonts, unknown scenario, timeout,
blank root and page exception make the bundle incomplete and exit nonzero.
Capture cancellation cleans up browser/server processes. Different render
environments are explicitly incomparable for pixel-baseline checks.

## PR 3 — Functional gates and desktop parity

Add task-level assertions for keyboard entry/send, cancel, approval response,
retry, menu dismissal/focus return, long-line overflow and scroll behavior.
Assert effects, not just that a button can be clicked. Add automated
accessibility checks using a development-only engine; report their limited
coverage rather than claiming full accessibility compliance.

Validate fixture parity against the real macOS app with synthetic data: capture
the same six states, note viewport/content-area differences, and exercise the
keyboard/scroll/menu flows. This is an explicit manual release gate initially;
portable browser tests do not count as a WKWebView pass. Create a short parity
checklist and record build revision, OS and findings in the bundle.

Acceptance: seeded focus, overflow and disabled-control regressions are caught;
existing production behavior passes. Classify disagreements as fixture drift,
browser/desktop difference or real defect. Unresolved parity defects block
agent trials for the affected scenario, rather than being silently ignored.

## PR 4 — Native visual Run driver and image delivery proof

Proposed files: `src-tauri/src/agent/design_feedback.rs` (development/test entry),
`scripts/design-feedback/run.py`, and focused fixtures/tests. Reuse Run-host
admission and existing provider adapters; keep any headless host adapter thin.
First spike: prove a headless writer and a tool-free reviewer can be admitted,
cancelled and inspected through the same host contract. If this needs a large
refactor, use a development-only app command through the existing host instead;
do not build a second executor to avoid the work.

Writer Runs use Work with explicitly scoped command/edit authority in their
disposable checkout. Reviewer Runs use Chat, image attachments and no tools.
Select concrete supported provider/model pairs up front. Record actual resolved
identity and capabilities; no silent provider substitution. Delegates and
text-only/Sight-description reviewers are outside this first experiment.

Resolve images through Workspace, apply existing byte/MIME limits, and bind
the reviewer input to evidence file hashes. Record which images were offered,
accepted, omitted and sent as native image blocks; omit raw image bytes from
summary reports. A mock adapter test verifies exact image hashes on the wire.
An opt-in live canary uses a freshly generated, unpredictable visual marker
whose answer is absent from the prompt to check end-to-end visual input.
Canaries are excluded from design-quality judgments and do not prove taste.

Acceptance: unsupported vision, a dropped required image, incomplete capture,
malformed output or cancelled Run yields unavailable/incomplete, never a review
based on prose pretending to be visual evidence. Also prove a writer receives
a newly captured candidate in its next Run. No paid calls in default tests.

## PR 5 — Single-agent workflow and bounded controller

Add `scripts/design-feedback/experiment.py`, versioned brief/rubric files,
experiment-state schema and transition tests. The capture subprocess is a
developer tool callable through existing command capability. It does not add
a runtime browser tool or a new permission bypass.

State: prepared → baseline captured → writing → candidate captured → checking
→ self-reviewing → revising or settled. Failure/cancellation is terminal for
that attempt; resume requires explicit reconciliation of recorded Runs and
source hashes. Atomic state writes and append records use Klide's durable-state
conventions; do not replay edits or dispatch a duplicate child after a crash.

Per revision record hypothesis, source identity, evidence IDs, checks, findings,
selected action, usage and selected best candidate. Preserve rejected patches.
Do not reset a user's checkout; every attempt is isolated. The writer can
retain an earlier candidate when the new version regresses. Functional failure
always outranks aesthetic preference. An unresolved preference tradeoff is
reported for human judgment, not resolved by an invented score.

Initial pilot limits: 45 minutes per trial, at most three revision cycles,
24 total provider attempts across all Runs/retries, and bounded per-call
context/output settings frozen in the experiment manifest. Count automatic
retries and any vision side calls. If the provider path cannot expose attempts
before dispatch, that is a PR 4 prerequisite, not an unenforced budget claim.
Cancellation reaches child Runs, capture processes and the writer.

Stop reasons: completed, no-actionable-findings, stalled (two consecutive
cycles with no new actionable issue resolved), budget, cancelled, failed,
or human-decision-required. A budget stop produces a report, not a success.
The three-cycle limit is separate from the existing command Goal gate; its
internal retries still count against aggregate limits.

Acceptance: one complete real-component change produces a patch and comparable
before/after bundle. Mock-host tests cover budget exhaustion, late child
completion, cancel, duplicate dispatch, crash recovery and unknown usage.

## PR 6 — Independent council arm

Extend the same controller with two tool-free reviewer Runs per review round.
Reviewer A covers hierarchy, typography, density and token consistency.
Reviewer B covers interaction clarity, state communication and visible
accessibility concerns. Both receive the full common rubric, brief and identical
evidence; specialization changes emphasis, not what each is allowed to flag.
Use two concrete vision models from different providers when available, recorded
in configuration. Availability is a prerequisite, not permission to substitute.

Reviewers do not see each other's response, writer rationale, prior ratings,
model identity of the writer, or a target score. Return schema-validated JSON:
evidence ID/hash, scenario/state, affected region/control, observation,
task impact, severity, suggested remedy, A/B preference or tie, and uncertainty.
Claims about behavior must cite an interaction result; screenshots alone cannot
prove a control works. Schema errors receive at most one bounded retry.

Collect both responses before revision. Keep disagreements visible, deduplicate
the same issue, and let the writer address findings in priority order. A failed
reviewer leaves a council attempt incomplete; no hidden downgrade to one agent.
The controller permits review concurrency only, with a single editing Run.

Compare anonymous A/B images with randomized order. For disputed choices repeat
with reversed order, within budget; disagreement becomes inconclusive. Keep a
known unchanged control pair for reviewer calibration. Its checks detect some
biases but do not establish judge validity.

Acceptance: each reviewer receives the exact same capture, has no tools, and
cannot mutate files. Cancellation/budgets include both children; their usage
is aggregated once. Do not route these reviews through editing Workers.

## PR 7 — Freeze and run the comparison

Freeze tasks, prompts, capture checks, models, rubric, budgets and decision
rules before measured trials. Two separate calibration tasks establish that
delivery and budgets work; exclude them from the evaluation. If calibration
requires changes, re-freeze before starting the measured set.

The measured set has six task briefs: composer hierarchy, long tool output,
needs-input/error recovery, compact child activity, narrow-window layout, and
menu discoverability/focus clarity. Each starts from the same frozen revision
and named scenario set, with explicit constraints and an observable task.
All changes must preserve the familiar IDE structure and existing capabilities.
Hold out additional fixture content within those scenarios for final regression
checks; neither arm receives the hidden expected results.

| Arm | Writer and evidence | Feedback |
| --- | --- | --- |
| S: single agent | Same fixed writer model, tools, design references and capture access | Writer's own structured critique using the common rubric |
| C: council | Identical writer setup and capture access | Two independent reviewers, then writer revision |

Run two repetitions per task and arm: 24 trial outputs, forming 12 paired
comparisons. Randomize arm execution order within each pair, record the seed,
and run pairs sequentially to reduce machine-load interference. Fresh isolated
checkouts, history and Memory prevent cross-arm learning. Preserve each arm's
own context across revision Runs; never carry council findings into arm S.
Neither arm gets implementation hints unavailable to the other.

Both arms share the 45-minute, 24-attempt and three-cycle ceilings. Arm S may
use the attempts that arm C spends on reviewers for its own work/self-review.
Freeze writer request limits identically. Request ceilings do not equalize
money, tokens or intelligence; report all observed resources separately.
This tests these two configured systems under matched operational ceilings,
not the isolated causal value of model diversity or a universal agent ranking.
If the council wins, a same-writer-model reviewer ablation is the next experiment.

Failed, cancelled, incomplete and budget-exhausted attempts remain in results.
Infrastructure errors are categorized; a replacement is a new recorded attempt
for both arms under a stated rule, never deletion of an unfavorable outcome.
An all-no-change result is not a win merely because functional checks passed.

## PR 8 — Blinded report and decision

Generate `REPORT.md`, `report.json`, trial manifest and a local HTML viewer.
Hide arm/model, cost, round count, writer rationale and revealing filenames
until judgments are locked; mask generated identifiers in presentation only,
never product content. Randomize left/right per pair and retain a private map.
Pierre compares both finals and an anonymous baseline using the same tasks.
Record A / B / tie / neither acceptable, reason, and task-check findings.
One operator's taste is not representative-user validation.

Separate report dimensions:

- Visual preference and whether each final improves on its baseline.
- Browser interaction/accessibility failures, held-out regressions and manual
  desktop parity. Automated interaction success is not user discoverability.
- Changed files/lines and reviewer findings accepted, rejected or unsupported.
- End-to-end wall time, model time where available, provider attempts,
  input/output/cache tokens, actual reported cost and cost coverage.
- Every expected trial, incomplete count, retries, stop reasons and unknowns.

Primary practical adoption rule, fixed before trials: council wins at least
8 of all 12 paired judgments (ties are not wins), at least 8 council finals are
acceptable improvements over baseline, no new severe functional regression,
and all council trials have complete required visual evidence. This is a small
pilot threshold, not statistical proof; repeat count does not turn six tasks
into 12 independent task types. Also report results per task.

Resource rule: where full monetary cost is known, council median total cost
must be at most 2× single-agent median. Count writer, reviewer, retry and vision
calls. If monetary coverage is incomplete, make no cost-effectiveness claim;
Pierre must explicitly accept the observed latency/attempt tradeoff before
productizing. Trial wall-time limits apply regardless of billing visibility.

If quality improves only for particular task types, retain the council as an
optional escalation for those types. If results tie or disappoint, ship the
visual feedback infrastructure and keep the single-agent workflow. Do not
add reviewers just to make the pipeline look more sophisticated.

Before broader rollout, observe representative users attempting the changed
workflows. Record misunderstandings and recovery, not just screenshot taste.
This can invalidate the pilot's preferred direction and reopen the brief.

## Dependency order and first implementation slice

PR 1 → PR 2 → PR 3 → PR 4 → PR 5 → PR 6 → PR 7 → PR 8.
Each PR must be independently reviewable; the capture viewer is useful before
any inference integration. Begin PR 1 with just `conversation-long`, at both
themes and sizes, then expand to all six scenarios before finishing PR 3.

The first vertical slice is complete when one command captures that real
surface, produces a stable local report, catches a deliberate overflow defect,
and has a recorded desktop parity check. It requires no council and no paid
model calls. Then prove native image delivery before building iteration logic.

Run focused tests for the touched seam. TypeScript changes require
`npx tsc --noEmit`; Rust changes require `cargo check` in `src-tauri` plus
relevant Rust tests. Live inference runs stay opt-in. Packaging/build checks
must confirm capture dependencies and test fixtures do not enter the app bundle.

## Comparisons informing the plan

- [Design Council Double Diamond](https://www.designcouncil.org.uk/resources/the-double-diamond/): define the problem and explore alternatives before converging.
- [Google Design Sprint](https://designsprintkit.withgoogle.com/methodology): use distinct candidate directions for structural design; local polish can proceed directly.
- [Storybook stories](https://storybook.js.org/docs/8/writing-stories/index): borrow explicit rendered-state fixtures without requiring Storybook installation.
- [Playwright visual comparisons](https://playwright.dev/docs/test-snapshots): repeatable capture requires a stable rendering environment; pixel differences are not quality scores.
- [Heuristic evaluation](https://www.nngroup.com/articles/how-to-conduct-a-heuristic-evaluation/): independent concrete findings complement user testing.
- [LLM judge research](https://arxiv.org/abs/2306.05685): language-judge bias findings motivate image-review controls; this does not establish visual judge validity.
- [Task-based usability testing](https://www.nngroup.com/articles/usability-testing-101/): real user behavior is a separate source of evidence from reviewer preference.

## Review — 2026-11-08

Verified on review: `design:typecheck` clean, 21 unit tests (comparison +
token contrast) and 21 Playwright tests pass, `cargo check --features
design-parity` builds. The browser half does what its README claims. The
findings below are what stands between it and a slice worth committing.

### Decisions for Pierre

1. **Stop the plan after PR 4, then use it.** The question worth answering
   first is "does Kit make a better UI change when it can see the result?" —
   PR 4 plus a single-writer loop answers it. The council (PR 6), the frozen
   24-trial comparison (PR 7) and the blinded report (PR 8) cost up to ~576
   provider attempts and 12 blinded judgments from one operator, to decide
   whether a second reviewer is worth adding. Proposed: park PR 6–8 until a
   week of real single-writer use says the self-review is the weak link.
2. **Keep the experiment tooling in Node, not Python.** PR 4/5 name
   `run.py` / `experiment.py`; everything else here is `.mjs` and the repo has
   no Python toolchain to lean on.
3. **Separate the brief from this plan.** `briefHash` is this file's hash, so
   editing the plan makes every earlier bundle incomparable. A brief should be
   its own small versioned file per experiment (PR 5 already proposes them).
4. **Is the audit a contract or a working note?**
   `docs/KLIDE_DESIGN_AUDIT_2026-11-06.md` is un-ignored, but it is a dated
   working note, names an absolute local path and links to evidence under the
   ignored `artifacts/`. By the docs policy it stays local; if it stays
   tracked, strip the path and the dead link.

### Findings to fix before committing

| # | Finding | Proposed fix |
| --- | --- | --- |
| 1 | `pixelmatch` runs at `threshold: 0`, so every cross-run comparison reports antialiasing noise as change; the comparison can't tell a real regression from a re-render. | Launch Chromium with deterministic raster flags (`--font-render-hinting=none`, `--disable-lcd-text`, `--force-color-profile=srgb`, `--disable-skia-runtime-opts`) and re-test identity first. If noise remains, report **both** the raw count and a declared perceptual count (pixelmatch default threshold, AA excluded) — declared tolerance is not silent tolerance. |
| 2 | The native parity build replaces the whole Tauri config (`build.rs` sets `TAURI_CONFIG`, `app_context()` overwrites it again): it drops `plugins.deep-link` and `bundle`, and hard-codes `version: 0.6.11`, which will drift. | Try the CLI's own merge first — `tauri dev --features design-parity --config src-tauri/tauri.design-parity.conf.json` — with the parity file holding only overrides. If that works, `build.rs` and `app_context()` go back to stock. |
| 3 | No documented way to launch the native parity window; no npm script runs `vite.design-parity.config.mjs`. The parity gate can't be passed by someone who didn't write it. | One `design:parity` script (Vite on 1465 as `beforeDevCommand`, then the feature build) and a README section. |
| 4 | Capture refuses to finish if *any* file under `src`, `src-tauri/src`, `scripts`, `tests`, `preview` changes during the run. With concurrent agent sessions in this checkout, that will fail often. | Capture from a disposable worktree (the plan's step 2 already says so), or narrow the watched set to the fixture's import graph. |
| 5 | Every bundle copies every untracked file under the source paths (today: `preview/folder-icons`, `scripts/remote-host`, …) into `source-inputs/`. | Same fix as 4; a worktree has no unrelated untracked files. |
| 6 | The transcript scroller is found by `[style*="overflow-anchor: none"]` — an inline-style string, which a harmless style refactor breaks. | A `data-transcript-scroller` attribute on the production element. One attribute is not "changing the component for the fixture". |
| 7 | Scenario, theme and fixed-time lists are written three times (`scenarios.ts`, `browser.mjs`, `design_parity.rs`). | One JSON file both sides read, or a test that pins them together. |
| 8 | `focus-contrast.test.mjs` tests shipped tokens for all eight themes — a product test, living in a dev-tool folder. | Move beside `src/styles/` so it's found when tokens change. |
| 9 | `capture.mjs` writes `*-console.json` twice per configuration. | Keep the `finally` write only. |

Fixed during review: `design_parity_mode()` had been inserted between
`smoke_test_mode()` and its doc comment in `lib.rs`.

### Commit hygiene

The working tree mixes this slice with unrelated work: Remote machines
(`CONTEXT.md` terms, `docs/REMOTE_MACHINES.md`, `scripts/remote-host/`),
`BUSINESS.md` and the Conductor TODO section, and the folder-icons preview.
Commit them separately; this slice is the `preview/design-feedback*`,
`scripts/design-feedback`, `tests/design-feedback`, Playwright/tsconfig/Vite
configs, `design_parity.rs` + its `lib.rs`/`Cargo.toml`/`build.rs` hooks, and
the `package.json` dev dependencies.
