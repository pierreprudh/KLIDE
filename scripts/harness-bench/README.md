# Hermes / KIDE harness comparison

Native request diagnostics are a separate, opt-in measurement tool. See
[Harness diagnostics](../../docs/HARNESS_DIAGNOSTICS.md) for collection boundaries
and `report_diagnostics.py` for a local report from existing Transcripts.

## Removed read-script experiment

The read-only programmatic Tool prototype, optional QuickJS dependency, feature
flags and executable comparison driver were removed after evaluation on
2026-10-30. [Results and decision](READ_SCRIPT_RESULTS.md) and the
[archived fixtures and trial data](read-script-2026-10-30-data.json) preserve the
evidence. Native request diagnostics and the Hermes comparison remain available.

## Hermes comparison

This small synthetic benchmark compares the real KIDE Rust Harness with Hermes's
one-shot CLI. It does not recreate either agent loop. Three smoke tasks cover a data
transformation, a code regression, and a change across two files. Two additional
quality tasks exercise cache expiry/falsy values across modules and atomic
inventory updates with duplicate items and invalid quantities. Each trial gets
fresh files. Hermes gets a fresh home so previous memories and learned skills do
not contaminate later trials. Randomized order and repeated runs reduce order
and model sampling effects.

Preview without inference:

```sh
python3 scripts/harness-bench/run.py --provider openrouter --model '<model-id>'
```

Execute (uses provider credentials and can incur charges):

```sh
python3 scripts/harness-bench/run.py --provider openrouter --model '<model-id>' --repeats 3 --run --output /private/tmp/kide-hermes-results
```

Supply the provider's API-key environment variable to both harnesses. Hermes
must be installed with its runtime dependencies. For providers whose Hermes
backend name differs, pass `--hermes-provider`; OpenAI maps to `openai-api`
automatically. Local endpoints must be configured consistently in both runtimes;
this script does not translate provider-specific endpoints for you. No credentials
are written by this script. Native compilation and Hermes dependency preparation
run before timed trials. Both harnesses may execute code in disposable
workspaces. The native case uses automatic edit and command approval; the driver
supplies no interactive human answers.

`manifest.json` records the model, provider, trial count, seed and limits.
`results.json` retains every trial, failures included, with file-grader results,
elapsed time, errors, and available token/cost/tool metrics. Native trial folders
also contain the authoritative Harness transcript. CLI stdout/stderr stay beside
each trial. Grading uses trusted assertions outside the agent workspace, with a
time limit, rather than trusting an agent's final answer or tests it rewrote.

Hermes CLI token/cost/tool metrics remain `null` where this transport does not
report them; absence is not zero. No human answers are injected, so the
intervention count is zero by construction, not an estimate of production review
burden. A blocked approval is a failed/timed-out trial. Native and Hermes keep
their own prompts and tools; this compares harness configurations rather than
isolating one internal component. It is not Terminal-Bench or a general coding
quality leaderboard. ACP transport coverage is separate from these CLI trials.

Run grader regression tests without a model:

```sh
python3 -m unittest discover -s scripts/harness-bench -p 'test_*.py'
```

Select `--suite smoke`, `--suite quality` or `--suite all` (default). Preview a
quality run without inference:

```sh
python3 scripts/harness-bench/run.py --provider openrouter --model '<model-id>' --suite quality
```

The quality graders stay outside the agent Workspace, use deterministic clocks,
and check rollback after errors, exact expiry, cached `None`, boolean quantities,
duplicate aggregation and preservation of caller inputs. Grader regression tests
show the broken fixtures and six plausible partial repairs fail, while complete
reference repairs pass. Benchmark identity is now `kide-hermes-synthetic-v2`;
do not pool its five-task totals with the old three-task suite. These new tasks
have not established a model-quality advantage; that requires actual repeated
model trials. Ordinary CI runs only the graders, with no inference or credentials.

## Hermes Focus integration

Hermes turns without an explicit reasoning-effort selection now use `hermes acp`
over newline-delimited JSON-RPC. KIDE initializes the protocol, creates or loads
the conversation session, supplies session-specific MCP servers, selects the
model, and streams the answer and observed tool activity. Loading old history
does not render it a second time. Usage is recorded when Hermes supplies it.
The process is killed on cancellation/drop; failed prompts are never retried
automatically because a foreign tool may already have changed files.

ACP permissions go through KIDE's authenticated permission bridge. Only a
single-use option actually offered by Hermes is returned. Missing identity,
bridge failures and unsupported host operations fail closed. Loaded sessions are
returned to Hermes's asking edit mode. KIDE does not execute Hermes's tool calls
again, and these edits do not become native checkpointed DiffProposals.

The session MCP server includes `memory_search` and `memory_read`, using KIDE's
native schemas and retrieval functions. The bridge binds the Workspace; results
retain provenance and inactive-entry policy. `memory_propose` queues an evidence-backed lesson in KIDE's Memory inbox; it
requires an exact quote from a non-secret Workspace file. Proposals are never
recallable until the operator keeps them. No publication tool is exposed.

Hermes ACP currently has no reasoning-effort setter. Explicit effort selections
and generic `harness-source:` selections retain the existing CLI transport;
Hermes-specific `hermes-source:` selections support ACP. A transition through
the CLI forgets the ACP session so a later ACP turn receives the full current
conversation. Terminal/Mission sessions retain the existing CLI path. CLI session
history import and Skill proposals from Hermes remain future work.

Protocol references checked against the installed adapter and official docs:
[ACP host integration](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp),
[Hermes architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture).

Installed-Hermes transport smoke (a localhost mock model; no paid inference):

```sh
python3 scripts/hermes-acp-smoke.py
```

This drives the production Focus adapter through a real Hermes process, reads a
fixture file through Hermes's tool, checks the observed activity, and loads the
same session in a second process while preserving its tool history. The mock
supports Chat Completions and Responses, since Hermes chooses the provider wire.
The installed Hermes 0.21.5 adapter enforces a minimum 64,000-token context; the
mock advertises 65,536. A smaller local context can be refused before inference.
