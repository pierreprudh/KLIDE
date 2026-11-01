# Task continuity through compaction

Native automatic and manual compaction share `agent/compaction.rs`. The summary
request asks for the current goal and scope, constraints and decisions, progress,
open work and blockers, verification, and the next action. It distinguishes side
questions and cancelled work from the active task, and historical evidence from
new instructions or authorization.

The model's notes are supplemented from the append-only Transcript:

- The opening and latest folded user requests remain verbatim, including
  constraints after the first 600 characters. The first and eleven newest requests
  are retained; intervening retained requests can be shortened to 600 characters.
- The latest recorded system TODO snapshot survives, with task IDs and completed
  or pending status, even if the summary is empty or fails. A newer snapshot in
  the retained tail takes precedence and is replayed there instead. Clearing the
  list also survives. The live loop still refreshes task state from the TODO store.
- Tool history distinguishes succeeded, failed and no-result-recorded calls.
  Success records the tool outcome, not proof of correctness or goal completion.
  Successfully retained results keep their `peek_value` identifiers.

Repeated compaction reads the original journal rather than depending on the
previous model summary. Existing markers need no migration. No extra model call
is added, and the summary request still appends to the existing prompt. Delegate
CLIs manage their own compaction.

## Verification and limits

Regression tests exercise incomplete/empty summaries, repeated compaction,
long Unicode requests, later corrections, cleared lists, pending tool calls,
and transcript persistence/reload through both replay formats without a panel.
These establish deterministic preservation and replay, not real-model adherence.
Decisions, free-text blockers and verification details that are not recorded as
structured state still rely on the model's notes. Older middle requests can be
omitted or shortened; original Transcripts remain on disk. Preserving long
opening/latest requests and TODO snapshots costs context space; existing fit
checks remain authoritative. This change is not a coding-quality benchmark result.
