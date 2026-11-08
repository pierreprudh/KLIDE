# Design feedback — seven production-panel scenarios

This development-only fixture renders the **production `AiPanel`**, including
its real transcript, tool fold, message actions, scroll behavior and composer.
It uses synthetic history and an explicit native IPC mock. It does not open real
conversations, use credentials, read workspace files, or contact model providers.
No production component was copied or changed for the fixtures.

Implemented scenarios:

| Scenario | Captured states and behavior |
| --- | --- |
| `conversation-long` | Latest/earlier history; tool fold, internal code scroll and jump to latest |
| `compose-empty` | Empty composer; typing enables Send and clearing disables it |
| `tools-and-review` | Pending command, mixed tool output, proposed/expanded Diff, rejected edit |
| `waiting-and-error` | Keyboard answer, retryable provider error, recovered reply and cancelled question |
| `subagent-activity` | Running/completed/failed/stopped children, nested steps, collapsed and settled tray |
| `composer-menu` | Open picker, keyboard model selection, filtered list, Escape and focus return |
| `result-and-diff` | Three-file review run (README approved, Validate all on notes/a.md, notes/b.md auto-applied): reviewed labels, See changes opens only the unread file, compact wrapped diff, one scroll with a pinned row, reviewed file still opens |

The live scenarios replay typed synthetic Agent events through the production
Run controller. Card answers use the real IPC adapters; a development-only mock
records them, appends synthetic resolutions and emits normal Run notifications.
Retry uses the real start-Run channel; no Harness/provider/CLI is launched.
Child activity uses the normal observed-event fold and production tray. The
menu opens through its actual trigger and keeps real keyboard/focus behavior.
A development-only native visual reviewer is available; see below.
This is not a shipped Design capability or council.

## Use

Requires Node 22.12+ (the pinned accessibility dependency), `npm ci`, and a
one-time developer browser installation:

```sh
npx playwright install chromium
npm run design:capture -- --scenario conversation-long --output artifacts/design-feedback/baseline
npm run design:capture -- --scenario conversation-long --output artifacts/design-feedback/candidate
npm run design:compare -- --baseline artifacts/design-feedback/baseline --candidate artifacts/design-feedback/candidate --output artifacts/design-feedback/comparison
npm run design:test
npx tsc --project tsconfig.design.json --noEmit
```

Open the resulting `index.html` directly in a browser; it uses relative local
files and needs no server or model. Each output must be a **new directory**.
Capture owns an in-process, loopback-only Vite server on port 1459 (override with
`--port`); it refuses busy ports, never uses Tauri's 1420, and closes its own
server/browser on success, failure or interruption. No browser is bundled with
the app and none is downloaded by capture itself.

For interactive inspection, run the normal Vite dev server and open
`/preview/design-feedback.html?scenario=conversation-long&theme=klide-light`.
Themes: `klide-light`, `sage-garden-dark`; captures use both at 1440×900 and
900×700, DPR 1. `window.__designFeedback` exposes `ready`, `scenarioId`,
`fixtureVersion`, `states`, `reset()` and `setState(name)`.
Named states are scoped to each scenario: long conversation has `earlier`;
tools/review has `diff` and `rejected`; waiting/error has `error` and `recovered`;
child activity has `settled`; all support `initial`. `composer-menu` opens its
production model picker on entry/reset. Reset restores the original model,
transcript and pending gates and clears recorded actions and drafts. Unknown
scenarios/themes/states fail explicitly. Fresh browser contexts isolate storage;
reset clears the production composer draft cache too. The capture clock fixes
Date to the fixture time while allowing real timers and interaction animations.

## Evidence and checks

A bundle contains latest/earlier PNGs, accessible YAML snapshots, automated
accessibility findings, console/page/network errors, checks, a manifest, a
source patch, untracked source inputs and a pending native-desktop checklist.
It records source/fixture/brief/file hashes, browser and platform versions,
viewport, DPR, theme, locale and timezone. Source hashing covers the declared
source/config paths in `evidence.mjs`, excluding generated artifacts and private
runtime state. Evidence is local and ignored by Git.

The capture fails on blank root, missing fonts, unknown IPC calls, page/console
errors, external requests, document overflow, an unreachable composer or failed
interaction assertions. Every intermediate state is captured with its own
accessible snapshot and accessibility scan. Unexpected native calls fail even if production code
catches their rejection. Accessible snapshots use Playwright's `ariaSnapshot`.
The regression suite injects an overflow defect and proves the check rejects it.
Accessibility violations are preserved as findings rather than silently claimed
as passes; this slice does not enforce an existing-code accessibility baseline.

Comparisons verify file hashes and matching environments, fixture and brief
identities before showing baseline/candidate/diff images. A changed pixel is
not evidence of better design. Capture completion describes browser evidence,
not native parity or design quality. No masking is used. Still capture temporarily disables CSS animations/transitions
and caret painting, waits for rendering frames, and requires consecutive
byte-identical screenshots. The temporary stylesheet is removed before the next
interaction; a state that never settles fails capture.

## Native desktop gate

The recorded Mac pass is in `artifacts/design-feedback/native-parity-2026-11-07/`:
40 screenshots plus accessibility-state records. All six scenarios render in both
themes and both window sizes. Detailed interactions were exercised at light
900×700 only. Send dispatch, native horizontal code scrolling and the two-done
child template remain unverified. Native screenshots include OS overlays and
DPR 2; use browser captures for visual review, not cross-engine pixel diffs.
Each browser bundle retains its pending checklist; the separate hash-bound
`verification.json` clears only its declared capture scope, not the whole bundle.
This local record is a human attestation, not independent proof of correctness.

```sh
npm run design:parity
npx vite --config vite.design-parity.config.mjs
# In another terminal:
open '/private/tmp/klide-native-check/Klide Native Check.app'
```

Quit the test app before rebuilding. The preparation command selects the
feature-specific Cargo executable, creates an isolated temporary app bundle,
and never replaces `/Applications/Klide.app`. The dedicated fixture server
replaces SDK modules at the Vite boundary; native Tauri globals stay intact.
The native Design parity menu selects scenarios, themes and content sizes.

Choose **Design parity → Open visual reviewer** to use actual native commands.
Enter the workspace, a complete capture manifest, a matching native verification,
1–4 eligible capture IDs, and an explicit connected vision provider/model.
Verify evidence first, then explicitly start the reviewer Run (which checks native vision support). The selected
provider may incur cost. Stop and Inspect use the normal Run host. The driver
rehashes all bundle members, checks native fixture/UI identity and scope, applies
attachment limits, and sends Chat image attachments without tools. Exported
reports retain image hashes and structured findings, excluding image bytes.
Malformed output remains incomplete. Tests prove the production OpenAI request
contains the exact selected PNG bytes; a live unpredictable-image canary, writer
handoff and bounded iteration controller remain open. No paid calls run by default.

## Pixel repeatability limitation

Each recorded still must settle to two consecutive identical paints. Across
fresh Chromium renders, antialiased circular borders can still differ by
1–2 RGB levels in a few pixels despite identical content and element geometry.
The comparison viewer preserves those raw differences and reports
`identicalBytes: false`; no pixels are masked and no tolerance is silently
applied. Do not claim cross-run byte identity for the expanded scenario matrix.
The browser suite verifies reset content/layout, controls and per-capture
settling; it does not turn this renderer limitation into a design-quality score.

The isolated Mac app has its own file-access permissions. On this machine,
opening evidence directly under Documents stalled in the OS file-open call;
verification passed after copying the same immutable bundle and verification
into `/private/tmp/klide-visual-review/` with the same relative paths and selecting
that directory as the workspace. File reads and capability lookups time out
after 20 seconds each. A timed-out OS read can remain blocked in the background;
quit the test app before retrying repeated blocked reads. No macOS privacy
permission was changed for this verification.

## Live pilot and writer loop

See [EXPERIMENT.md](../../scripts/design-feedback/EXPERIMENT.md) for the local
vision canary, isolated writer loop, exact file scopes, budgets, native checkpoints
and recovery rules. The first live color canary passed on Ollama `qwen3.5:9b`;
earlier OCR and formatting failures remain recorded. This verifies visual input,
not model judgment or a completed UI improvement.
