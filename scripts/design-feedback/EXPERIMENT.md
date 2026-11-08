# Local vision pilot and writer iteration loop

This is development tooling. It uses the normal Run host, provider adapters,
transcript writer, tool gates and cancellation. It adds no provider executor.
The initial live pilot supports **Ollama only**, with an explicit installed
vision model. Hosted providers and the council remain outside this slice.

Build the development executable with `npm run design:parity`. Quit the isolated
Mac test app first. The executable is then:
`/private/tmp/klide-native-check/Klide Native Check.app/Contents/MacOS/klide`.
The CLI does not launch a window or start the fixture server.

## Live visual-input canary

Save a local configuration, using a new absolute output directory:

```json
{
  "binary": "/private/tmp/klide-native-check/Klide Native Check.app/Contents/MacOS/klide",
  "model": "qwen3.5:9b",
  "output": "/private/tmp/my-vision-canary"
}
```

Run `node scripts/design-feedback/canary.mjs /path/to/config.json`.
The program generates six unpredictable colored rectangles. Their sequence is
absent from the prompt. It requires strict JSON and an exact visual answer,
a completed Run, unchanged model identity, and the exact image hash on every
recorded HTTP attempt. `kind: "digits"` selects the OCR variant. A failed answer
or malformed response stays incomplete. Keep failed attempts; a later pass does
not establish general model reliability or design judgment. No canary is a
UI-quality evaluation.

The pre-dispatch hook reserves an attempt durably before each model HTTP send,
including adapter and Harness retries. Required images are checked against those
wire-body receipts. Receipt files contain hashes, not image bytes. Normal local
Run transcripts and the CLI input retain the actual attachments for replay.
No automatic test invokes a real model or downloads one.

## Bounded writer loop

The controller creates an independent local clone, overlays the current tracked
patch and declared untracked source inputs, and verifies the copied source
identity. It never resets or applies a patch to the source checkout. It reuses
installed `node_modules` through a symlink; model tools cannot follow that link
outside the disposable workspace. Git history and source inputs are local.

Create a configuration like this (paths are examples):

```json
{
  "source": "/absolute/path/to/KIDE",
  "binary": "/private/tmp/klide-native-check/Klide Native Check.app/Contents/MacOS/klide",
  "model": "qwen3.5:9b",
  "canary": "/private/tmp/my-vision-canary/verification.json",
  "brief": "Improve the pending-command card's reading hierarchy while preserving its controls and keyboard behavior.",
  "scenario": "tools-and-review",
  "captureIds": ["klide-light-900x700-permission"],
  "allowedWritePaths": ["src/components/AiPanel.tsx"],
  "parity": "/absolute/path/to/matching/verification.json",
  "capturePort": 1468
}
```

Run:

```sh
node scripts/design-feedback/experiment.mjs start /path/to/config.json /private/tmp/new-design-trial
```

The canary must match the exact executable hash and model. The brief and model
configuration are frozen in the trial state. Only the listed files under `src/`
or `preview/` can be written; the evidence harness cannot be edited. Changes
inside the disposable clone are accepted automatically and preserved as patches
and per-cycle file snapshots. Model shell commands, connectors, advisors,
subagents, dynamic tools and Sight prose fallback are disabled. Trusted capture,
typecheck and browser-test subprocesses run under the controller.

Each cycle is: native-cleared baseline/latest evidence → scoped writer Run →
fresh candidate capture → typecheck and browser flow checks → matching native
verification → tool-free visual self-review → revise or settle. Every subsequent
writer receives the **latest candidate images and findings**, not the baseline
again. Functional failure and increased recorded accessibility violation counts
stop the attempt before visual review. Findings do not supply a design score.

Limits: 45 minutes, three writer cycles, 24 reserved physical provider HTTP
attempts across all Runs/retries. Model context is 16,384 tokens; outputs are
capped at 4,096 tokens, writer turns at six, and individual Runs at five minutes.
Stop reasons include no actionable findings, two unresolved cycles, budget,
cancellation, failure and human decision required. Earlier candidates and patches
remain available; the baseline is the fallback until a clean candidate settles.

## Native checkpoint and recovery

A browser capture cannot certify a newly changed WKWebView interface. The loop
therefore pauses as `waiting-native` whenever its selected captures lack matching
UI/fixture hashes and native scope. This is an intentional checkpoint, not a
completed review. Test the candidate checkout in the Mac parity window, record
an actual `scoped-pass` verification for its captured identity, then explicitly
resume:

```sh
node scripts/design-feedback/experiment.mjs resume /private/tmp/new-design-trial /path/to/candidate-verification.json
```

An older attestation does not clear changed UI. The controller verifies file
hashes and source identity again before dispatch. Do not edit its JSON to claim
a native pass that was not performed. Native attestations are local operator
records, not independently authenticated proof.

SIGINT/SIGTERM stop the controller's current Run or capture/check subprocess.
Native cancellation waits for host retirement before producing its terminal
report. State writes are atomic; transition records are flushed. `state.json`,
`events.jsonl`, Run admissions/transcripts, `attempts.json`, source snapshots,
patches and `report.json` remain on disk. Missing terminal evidence is incomplete.
The loop never automatically replays an in-flight writer after a crash. Inspect
the recorded PID/Run ID, terminal transcript and source hashes, stop any surviving
process, and reconcile before creating a new trial. A stale `controller.lock`
is deliberately not removed automatically. Resume supports the native checkpoint
only; it is not automatic crash recovery. The report's attempt total may lag an
interrupted child; its durable `attempts.json` is authoritative in reconciliation.

The controller state machine and guard tests exercise multiple revisions,
fresh-image handoff, functional failures, native checkpoints, crash replay,
limits and stalled issues without spending model calls. A full live UI redesign
still needs native checks for each candidate and a human quality decision.

The optional `handoff.mjs` takes a JSON configuration with `binary`, `canary`
(the passed color-canary verification path), and a new `output` directory. It
asks a scoped writer Run to transcribe the fresh image into one temporary file.
Its report distinguishes native image delivery from answer correctness; a
wrong transcription remains incomplete even when delivery and the file tool work.

Controller exit codes: 0 for settled, 2 for a native/operator checkpoint,
1 for failed, cancelled, budget or stalled. Always inspect the JSON stop reason.
