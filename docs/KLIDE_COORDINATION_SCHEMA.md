# Klide Run Coordination — Schema and Command Contract

Source of truth:

- Rust domain and persistence: `src-tauri/src/coordination.rs`
- TypeScript wire mirror: `src/agent/coordination.ts`
- Supervisor command schema: `schemas/klide-coordination-command.schema.json`
- Durable event schema: `schemas/klide-coordination-event.schema.json`
- Snapshot schema: `schemas/klide-coordination-snapshot.schema.json`

## Event line schema v1

Every line in `.klide/coordination/events.jsonl` has this envelope:

```json
{
  "schemaVersion": 1,
  "seq": 7,
  "ts": 1788282000000,
  "event": {
    "type": "envelope_delivered",
    "envelopeId": "env_a21d…",
    "runId": "run_child"
  }
}
```

`seq` starts at zero and is contiguous. The reader rejects an unreadable line,
a gap, a duplicate, or a version newer than the current build before it returns
any projection.

### Event vocabulary

| Event | Meaning |
|---|---|
| `run_registered` | Immutable identity and initial normalized state were accepted |
| `run_state_changed` | One authorized state transition occurred |
| `envelope_queued` | A semantic payload was durably addressed |
| `envelope_delivered` | The execution adapter projected it into the recipient at a safe boundary |
| `envelope_acknowledged` | The recipient consumed it |
| `cancel_requested` | An authorized actor requested supervisor cancellation |
| `result_published` | The Run published its single structured outcome |

## Stable Run registration

```json
{
  "runId": "run_1788282000000_a21d",
  "workerKind": "harness",
  "parentRunId": "run_parent",
  "missionId": "release-061",
  "missionTaskId": "verify-bundle",
  "label": "Bundle verifier"
}
```

- `runId` is the immutable address; panel ids, pane ids, and process ids are not
  routing identities.
- `workerKind` is `harness` or `delegate`.
- `parentRunId` must already exist before child registration.
- Mission identity is an all-or-nothing `(missionId, missionTaskId)` pair.
- The remaining metadata is frozen. An identical retry is idempotent; different
  metadata for the same Run is rejected.

## Normalized state

The cross-adapter vocabulary is:

```text
queued | starting | working | blocked | waiting | reviewing |
done | failed | cancelled
```

- `blocked` means external input or authority is required.
- `waiting` means the Run is intentionally waiting for another Run or process.
- `reviewing` means work exists but is passing a review/admission gate.
- `done`, `failed`, and `cancelled` are terminal.

State events record `fromState` and `toState`. Replay verifies the previous
state and the legal transition graph, so reordered or contradictory events fail
closed.

## Coordination actor

```json
{ "type": "operator" }
```

or:

```json
{ "type": "run", "runId": "run_parent" }
```

The generic supervisor schema contains an actor because native Klide IPC is a
trusted seam. Remote adapters must replace it with the identity authenticated
by their connection/session; callers cannot self-assert a Run id.

## Envelope

```json
{
  "id": "env_a21d…",
  "from": { "type": "run", "runId": "run_parent" },
  "toRunId": "run_child",
  "kind": "question",
  "body": "Which parser invariant is still unverified?",
  "replyTo": "env_98bc…",
  "correlationId": "parser-audit",
  "idempotencyKey": "parent-turn-4-question-1",
  "sourceRefs": [
    {
      "sourceType": "file",
      "id": "coordination-parser",
      "path": "src-tauri/src/coordination.rs",
      "lineStart": 720,
      "lineEnd": 910
    }
  ],
  "createdAtMs": 1788282000000
}
```

`kind` is `instruction`, `question`, `answer`, `progress`, or `handoff`. Body
size is capped at 32 KiB. A reply must preserve participation in the original
exchange. File paths are Workspace-relative. External adapters remove any
machine-local data not represented by this public shape.

Delivery is monotonic:

| State | Required next command |
|---|---|
| `queued` | `mark_envelope_delivered` by the addressed Run adapter |
| `delivered` | `acknowledge_envelope` by the addressed Run |
| `acknowledged` | Terminal delivery state |

## Coordination result

```json
{
  "id": "result_91fe…",
  "runId": "run_child",
  "status": "succeeded",
  "summary": "Added strict journal replay and verified corrupt-line failures.",
  "artifacts": [
    {
      "kind": "file",
      "reference": "src-tauri/src/coordination.rs",
      "label": "Coordination core"
    },
    {
      "kind": "commit",
      "reference": "f00ba7",
      "label": "Implementation commit"
    }
  ],
  "sourceRefs": [
    { "sourceType": "transcript", "id": "run_child:0-42" }
  ],
  "publishedAtMs": 1788282300000
}
```

Status is `succeeded`, `partial`, `failed`, or `cancelled`. Artifact kinds are
`file`, `commit`, `transcript`, `diff`, and `memory`. A Run publishes one final
result; an identical retry is idempotent and a different second result is
rejected.

## Snapshot contract

```json
{
  "schemaVersion": 1,
  "nextSeq": 12,
  "runs": [],
  "envelopes": [],
  "results": []
}
```

`nextSeq` is an inclusive event cursor. After reading the snapshot, a consumer
calls:

```ts
readCoordinationEvents(workspaceRoot, snapshot.nextSeq)
```

The snapshot contains:

- registrations, current state/reason, registration and transition times;
- the latest cancellation request for each Run;
- envelopes and their delivery/acknowledgement timestamps;
- structured results.

It contains no second source of truth. Rust produces it by folding the journal.

## Command mapping

| Rust command type | Current Tauri IPC | Native authenticated agent Tool |
|---|---|---|
| `register_run` | `coordination_apply_command` | supervisor-owned only |
| `set_run_state` | `coordination_apply_command` | adapter-owned only |
| `send_envelope` | `coordination_apply_command` | `agent_send` |
| `mark_envelope_delivered` | `coordination_apply_command` | adapter-owned only |
| `acknowledge_envelope` | `coordination_apply_command` | adapter-owned only |
| `request_cancel` | `coordination_apply_command` | `agent_cancel` |
| `publish_result` | `coordination_apply_command` | supervisor-owned terminal publish |
| snapshot read | `coordination_snapshot` | `agent_list` / resource |
| cursor read | `coordination_events` | subscription/resource updates |

`agent_wait` combines authenticated snapshot reads with delivery and
acknowledgement commands. `agent_read_result` reads the authorized result
projection without introducing another durable record.

The future MCP adapter maps identity-bound agent Tools onto these Rust
operations. It does not persist its own inbox, infer state from terminal output,
or bypass Workspace-scoped authorization.
