# Native Harness request diagnostics

Implemented 2026-10-30 as the first measurement slice inspired by
[Factory's frontier harness article](https://factory.com/news/frontier-harness).
Disabled by default. No new panel, external telemetry or model calls.

## Collect and inspect

Launch the app with the environment variable inherited by its Rust process:

```sh
KLIDE_HARNESS_DIAGNOSTICS=1 npm run tauri dev
```

Run a native Conversation with Tool calls. In the configured Runs storage
directory (Settings → Storage), its `<run-id>.jsonl` contains diagnostics on
`assistant_message.timing.diagnostics`. Delegates and subscription Providers
are excluded because Klide cannot inspect their internal requests.

Generate a local JSON report using Python's standard library:

```sh
python3 scripts/harness-bench/report_diagnostics.py /absolute/path/to/run.jsonl
```

Pass multiple transcript paths to produce separate reports per Conversation.
The command reads existing files; it does not contact a Provider. It exports
timings, usage, Provider/model identity, Run id and prompt-change metadata, never
message or Tool-result content. Source transcripts retain their existing content
and privacy requirements.

## What the measurements mean

Setup spans appear once, on the first successful provider turn of each Harness
invocation, including a resumed Conversation:

| Field | Boundary |
| --- | --- |
| `contextGatherMs` | Opening shared notes, explicit Skill/TODO context, context events and neutral system/user message assembly. Excludes earlier memory recall and photo-description calls. |
| `toolCatalogMs` | Mode-filtered Tool schema assembly plus connector catalog loading/filtering. |
| `historyReplayMs` | Prior event reconstruction, Retained value replay and insertion of opening context. Excludes reading the Transcript from disk before the loop. |
| `capabilitiesMs` | Context-window resolution, including a capabilities probe if needed. |

Every diagnosed provider turn also records:

- `inputBuildMs`: time cloning neutral inputs into `ProviderTurnRequest`, summed
  over attempts for that turn. It excludes Provider-specific wire serialization.
- `inspectionMs`: time spent constructing configuration metadata and hashing
  logical inputs for diagnostics. This is instrumentation overhead.
- `attempts`: number of attempts, including a retried failure before streaming.
- `prompt`: comparison with the previous provider-turn input in this invocation.

Existing `modelMs` / `ttftMs` measure from entry to the Provider caller; they
include its wire conversion, authentication and transport work. On a retry they
describe the final attempt, excluding the retry pause. These selected spans do
not add up to Send → first token: admission, initial Transcript reads, memory,
compaction, coordination/approval waits and other boundary work are outside them.

## Prompt stability and cache usage

The monitor compares configuration, then Tool definitions, then ordered neutral
messages. It retains SHA-256 fingerprints only in memory, stores no fingerprints
in the Transcript, and never changes the model request. Output includes:

- `no_baseline`: first request of this invocation; no comparison available.
- `unchanged` / `appended`: previous logical inputs are unchanged / extended.
- `configuration` / `tools`: changed configuration or Tool definitions.
- `message` / `messages_removed`: rewritten or removed prior messages; includes
  the first affected zero-based message index.

`unchangedMessages` counts the equal leading messages even if configuration or
Tools changed. A configuration change takes precedence over a Tool/message change.
Comparison resets on resume/restart. It does not currently diagnose prefix changes
between separate user turns or capture internal compaction-summary requests.

This is **logical input stability**, not a measurement of the Provider's exact
serialized prefix or proof of a cache hit. Provider protocols order and encode
Tools/messages differently and may insert cache markers. Use actual
`usage.cacheReadTokens` / `cacheWriteTokens` alongside these diagnostics.

Reports keep absent usage unknown (`null`), distinguish known zero from missing,
and include sample counts. Cache shares use only turns with both a positive
prompt-token count and a known cache-read count. `meanRequestReadShare` averages
those turns equally; `tokenWeightedReadShare` divides their total cache-read
tokens by their total prompt tokens. Missing turns are counted separately.
Reports contain timed assistant messages and count `run_error` events; failed or
cancelled calls without an assistant message have no timing row. This is a
diagnostic report, not a correctness benchmark.

## Validation and next experiment

Pure monitor tests cover appends, changed messages, Tool/configuration changes,
message removal, and non-mutation. A real-loop test exercises read Tool dispatch,
Transcript persistence and Conversation resume with diagnostics enabled and
disabled. Report tests cover missing usage, unequal request sizes, setup
accounting, failures and content exclusion. No paid inference is required.

Collect short and long real Conversations on the same Provider/model before
choosing an optimization. Keep cold and warm cache conditions separate. Use a
specific measured cause to justify the next change; compare correctness and
latency/cost against the current Harness before enabling programmatic calling.
