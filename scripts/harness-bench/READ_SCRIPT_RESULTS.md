# Read-script comparison — 2026-10-30

Decision: remove this implementation after evaluation (2026-10-30). Its runtime,
Tool registration/dispatch, optional QuickJS dependency, feature flags, dedicated
tests and executable comparison driver have been removed. Keep native request
diagnostics, this report and the [archived fixtures and trial data](read-script-2026-10-30-data.json).

For these interactive tasks, saving $0.000632646 across nine trials while adding
33.29 seconds of waiting does not justify the implementation and maintenance
cost. This conclusion concerns this prototype/model/workload combination. It
does not establish that programmatic tool calling is generally ineffective.

Compared the real native Harness with direct read-only Tools against the same
Harness with the optional read-script Tool. Model: `deepseek/deepseek-v4.1-flash-1017`
on OpenRouter. Three tasks × three repeats × two configurations = 18 trials.
All 18 final answers passed the independent exact-answer and unchanged-fixture
checks. Direct and script configurations each made 43 recorded model requests.
No retries, compaction calls or missing timed-turn usage were found in these
Transcripts.

Before removal, all 20 saved scripts from these trials were replayed locally
without inference and produced the same outputs after interpreter hardening.
Historical runtime checks covered permissions, sensitive paths, symlink escape,
output/memory/call limits, asynchronous-work rejection and Stop during execution.

| Task | Direct median cost | Script median cost | Cost change | Direct median time | Script median time | Requests, direct → script |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| single-read | $0.000080 | $0.000200 | +151.4% | 1.65 s | 3.58 s | 2 → 3 |
| multi-read-rollup | $0.000753 | $0.000469 | -37.7% | 10.11 s | 15.07 s | 3 → 5 |
| dependent-chain | $0.000505 | $0.000568 | +12.5% | 19.25 s | 16.35 s | 9 → 6 |

Across the nine trials per configuration, recorded cost was $0.00408872
for direct Tools and $0.00345608 for scripts (15.5% lower).
Total measured elapsed time was 90.70 s versus 123.99 s
(36.7% longer). This total weights these three synthetic tasks equally;
it is not an estimate of savings on production Conversations.

The main comparison's total recorded cost was $0.00754480.
A separate two-trial single-file smoke cost $0.000352862; all 20 paid trials
together recorded $0.00789766 (less than one US cent).

## What happened

- On the single-file task, the model used two scripts where one direct read
  was enough. Script schema/code and extra model work increased cost.
- On the multi-file rollup, scripts returned smaller computed results and
  reduced recorded cost in every pair, but used more model requests.
- On the dependent chain, one script trial used direct reads and then a script
  to reread/verify. Another completed in three model requests instead of nine.
  Paired script cost changes were +34.9%, −51.5% and +17.6%, showing substantial
  variation even with the same task and model.

## Method and limits

- Same model, prompts, fixtures, reply/context budgets and reflection setting.
- Direct Tools allowed parallel reads (cap 4); the script arm could also choose
  direct Tools. Adding the script schema/code is included in its cost.
- Disposable Workspaces; trusted Python grading outside the Workspace; every
  failure would be retained. All results here passed. Script use was not forced.
- Native debug-build Run timing excludes compilation and UI startup. Local
  diagnostics were enabled in both configurations.
- Arm order randomized with seed 42. Natural Provider caches were not reset or
  pinned. Preliminary smoke trials had already exercised the single-file task.
  These results do not isolate cold-cache behavior or prove a cache-independent
  causal cost reduction.
- Three repeats on one hosted model, read-only synthetic tasks only. This does
  not establish coding quality, local-model behavior or reliable workload routing.
- The readText helper normalizes the existing read_file wrapper/line numbers;
  the direct arm receives its ordinary human-readable Tool output.

## Quality and comparison with Factory

Both configurations passed 9/9 tasks. That ceiling leaves this test unable to
demonstrate a quality advantage; it does not prove equal quality on difficult
work. We did not test multi-file bug fixes, integration regressions, long-context
distractions or exhaustive validation of large sets. Runtime limit tests and
replaying the same programs check implementation behavior, not coding quality.

[Factory's article](https://factory.com/news/frontier-harness) describes
per-model tuning, concurrent Tools and much larger workflows. It attributes a
15% cost reduction on Opus to Script mode; broader headline results compare
complete harnesses. Some bulk-workflow direct baselines are modeled estimates.
Our synchronous four-Tool DeepSeek prototype is a different system.

A plausible quality benefit is using a loop to check every item against an
explicit condition, keeping counts and stopping on failed checks, instead of
relying on a model to remember each check across many turns. This is a hypothesis
for Klide: programs may also encode wrong assumptions, omit conditions or hide
relevant context. A future evaluation would need tasks that expose such mistakes,
independent grading, repeated trials on multiple models, and the complete
cost/latency tradeoff. No quality gain was demonstrated here.

## Every trial

| Task | Repeat | Configuration | Pass | Model requests | Script calls | Nested reads | Cost USD | Time s |
| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
| single-read | 1 | script | yes | 3 | 2 | 2 | 0.000163726 | 2.681 |
| single-read | 1 | direct | yes | 2 | 0 | 0 | 0.000071036 | 1.579 |
| multi-read-rollup | 1 | script | yes | 5 | 3 | 28 | 0.000526640 | 27.650 |
| multi-read-rollup | 1 | direct | yes | 3 | 0 | 0 | 0.000750236 | 12.531 |
| dependent-chain | 1 | direct | yes | 9 | 0 | 0 | 0.000606480 | 26.851 |
| dependent-chain | 1 | script | yes | 10 | 1 | 8 | 0.000817970 | 39.536 |
| single-read | 2 | script | yes | 3 | 2 | 2 | 0.000205182 | 4.445 |
| single-read | 2 | direct | yes | 2 | 0 | 0 | 0.000079702 | 2.034 |
| multi-read-rollup | 2 | script | yes | 6 | 4 | 44 | 0.000469280 | 15.074 |
| multi-read-rollup | 2 | direct | yes | 3 | 0 | 0 | 0.000760724 | 10.113 |
| dependent-chain | 2 | script | yes | 3 | 1 | 8 | 0.000244740 | 5.515 |
| dependent-chain | 2 | direct | yes | 9 | 0 | 0 | 0.000504856 | 6.675 |
| single-read | 3 | script | yes | 3 | 2 | 2 | 0.000200396 | 3.582 |
| single-read | 3 | direct | yes | 2 | 0 | 0 | 0.000079702 | 1.650 |
| multi-read-rollup | 3 | script | yes | 4 | 3 | 19 | 0.000260130 | 9.161 |
| multi-read-rollup | 3 | direct | yes | 3 | 0 | 0 | 0.000753036 | 10.022 |
| dependent-chain | 3 | direct | yes | 10 | 0 | 0 | 0.000482950 | 19.246 |
| dependent-chain | 3 | script | yes | 6 | 2 | 13 | 0.000568012 | 16.348 |

The [data archive](read-script-2026-10-30-data.json) contains the manifest,
synthetic file fixtures, prompts, expected answers and every trial result.
The original runner/runtime are no longer executable in this checkout.

The machine-local raw manifest, complete results, stdout/stderr and Transcripts
are under `/private/tmp/klide-script-comparison-20261030/`; the separate smoke
is under `/private/tmp/klide-script-smoke-20261030/`. These temporary paths are
not committed evidence. The table above preserves every observed trial.

Revisit only with a concrete workload or observed quality failure that gives
the technique a reason to be evaluated again. Reuse the archived tasks as
controls; add harder independent quality checks before making broader claims.
