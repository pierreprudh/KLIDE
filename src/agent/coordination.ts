import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Frontend mirror of the Rust-owned coordination journal. The UI reads this
 * projection; it never infers agent state from terminal text or owns inboxes
 * in React state.
 */

export type CoordinationWorkerKind = "harness" | "delegate";

export type CoordinationRunState =
  | "queued"
  | "starting"
  | "working"
  | "blocked"
  | "waiting"
  | "reviewing"
  | "done"
  | "failed"
  | "cancelled";

export type CoordinationActor = { type: "operator" } | { type: "run"; runId: string };

export type CoordinationRunRegistration = {
  runId: string;
  workerKind: CoordinationWorkerKind;
  parentRunId?: string;
  missionId?: string;
  missionTaskId?: string;
  label?: string;
};

export type CoordinationEnvelopeKind =
  | "instruction"
  | "question"
  | "answer"
  | "progress"
  | "handoff";

export type CoordinationSourceType =
  | "run"
  | "transcript"
  | "commit"
  | "file"
  | "memory"
  | "mission_task";

export type CoordinationSourceRef = {
  sourceType: CoordinationSourceType;
  id: string;
  label?: string;
  /** Workspace-relative. Adapters must not emit absolute local paths. */
  path?: string;
  lineStart?: number;
  lineEnd?: number;
};

export type CoordinationEnvelope = {
  id: string;
  from: CoordinationActor;
  toRunId: string;
  kind: CoordinationEnvelopeKind;
  body: string;
  replyTo?: string;
  correlationId?: string;
  idempotencyKey?: string;
  sourceRefs: CoordinationSourceRef[];
  createdAtMs: number;
};

/** `queued` is awaiting the receiving side's review; `accepted` is cleared for
 *  delivery at its next turn; `declined` is refused, for good. */
export type CoordinationDeliveryState = "queued" | "accepted" | "delivered" | "acknowledged" | "declined";
export type CoordinationResultStatus = "succeeded" | "partial" | "failed" | "cancelled";
export type CoordinationArtifactKind = "file" | "commit" | "transcript" | "diff" | "memory";

export type CoordinationArtifact = {
  kind: CoordinationArtifactKind;
  reference: string;
  label?: string;
};

export type CoordinationResult = {
  id: string;
  runId: string;
  status: CoordinationResultStatus;
  summary: string;
  artifacts: CoordinationArtifact[];
  sourceRefs: CoordinationSourceRef[];
  publishedAtMs: number;
};

/** agent_send reports message delivery independently from the current wait. */
export type CoordinationSendReceipt = {
  envelopeId: string;
  deliveryState: CoordinationDeliveryState;
  replyStatus: "not_requested" | "received" | "timed_out";
  timedOut: boolean;
  replies?: CoordinationEnvelopeSnapshot[];
  text: string;
};

export type CoordinationEvent =
  | {
      type: "run_registered";
      registration: CoordinationRunRegistration;
      state: CoordinationRunState;
    }
  | {
      type: "run_state_changed";
      actor: CoordinationActor;
      runId: string;
      fromState: CoordinationRunState;
      toState: CoordinationRunState;
      reason?: string;
    }
  | { type: "envelope_queued"; envelope: CoordinationEnvelope }
  | { type: "envelope_delivered"; envelopeId: string; runId: string }
  | { type: "envelope_acknowledged"; envelopeId: string; runId: string }
  | { type: "envelope_accepted"; envelopeId: string; runId: string; actor: CoordinationActor }
  | { type: "envelope_declined"; envelopeId: string; runId: string; actor: CoordinationActor }
  | { type: "cancel_requested"; actor: CoordinationActor; runId: string; reason?: string }
  | { type: "result_published"; result: CoordinationResult };

export type CoordinationEventLine = {
  schemaVersion: 1;
  seq: number;
  ts: number;
  event: CoordinationEvent;
};

export type CoordinationCancelRequest = {
  actor: CoordinationActor;
  reason?: string;
  requestedAtMs: number;
};

export type CoordinationRunSnapshot = {
  registration: CoordinationRunRegistration;
  state: CoordinationRunState;
  stateReason?: string;
  registeredAtMs: number;
  stateChangedAtMs: number;
  cancelRequest?: CoordinationCancelRequest;
};

export type CoordinationEnvelopeSnapshot = {
  envelope: CoordinationEnvelope;
  deliveryState: CoordinationDeliveryState;
  deliveredAtMs?: number;
  acknowledgedAtMs?: number;
};

export type CoordinationSnapshot = {
  schemaVersion: 1;
  /** Inclusive cursor to pass as `fromSeq` on the next event read. */
  nextSeq: number;
  runs: CoordinationRunSnapshot[];
  envelopes: CoordinationEnvelopeSnapshot[];
  results: CoordinationResult[];
};

export type CoordinationCommand =
  | {
      type: "register_run";
      registration: CoordinationRunRegistration;
      initialState?: CoordinationRunState;
    }
  | {
      type: "set_run_state";
      actor: CoordinationActor;
      runId: string;
      state: CoordinationRunState;
      reason?: string;
    }
  | {
      type: "send_envelope";
      from: CoordinationActor;
      toRunId: string;
      kind: CoordinationEnvelopeKind;
      body: string;
      replyTo?: string;
      correlationId?: string;
      idempotencyKey?: string;
      sourceRefs?: CoordinationSourceRef[];
    }
  | { type: "mark_envelope_delivered"; runId: string; envelopeId: string }
  | { type: "acknowledge_envelope"; runId: string; envelopeId: string }
  | { type: "review_envelope"; actor: CoordinationActor; runId: string; envelopeId: string; accept: boolean }
  | { type: "request_cancel"; actor: CoordinationActor; runId: string; reason?: string }
  | {
      type: "publish_result";
      runId: string;
      status: CoordinationResultStatus;
      summary: string;
      artifacts?: CoordinationArtifact[];
      sourceRefs?: CoordinationSourceRef[];
    };

export type CoordinationCommandOutcome = {
  /** Missing when idempotency found the same durable intent already applied. */
  appended?: CoordinationEventLine;
  snapshot: CoordinationSnapshot;
};

/**
 * Trusted local supervisor seam. An MCP or socket adapter must bind its
 * authenticated Run identity before it constructs a command; it must never
 * forward an arbitrary remote `actor` object into this function.
 */
export function applyCoordinationCommand(
  workspaceRoot: string,
  command: CoordinationCommand,
): Promise<CoordinationCommandOutcome> {
  return invoke<CoordinationCommandOutcome>("coordination_apply_command", {
    workspaceRoot,
    command,
  });
}

export function readCoordinationSnapshot(workspaceRoot: string): Promise<CoordinationSnapshot> {
  return invoke<CoordinationSnapshot>("coordination_snapshot", { workspaceRoot });
}

export function readCoordinationEvents(
  workspaceRoot: string,
  fromSeq?: number,
  limit?: number,
): Promise<CoordinationEventLine[]> {
  return invoke<CoordinationEventLine[]>("coordination_events", {
    workspaceRoot,
    fromSeq,
    limit,
  });
}

/** Fired by Rust after every command that appended to a Workspace's journal
 *  (mirrors `COORDINATION_CHANGED_EVENT` in coordination.rs). Idempotent
 *  replays stay silent. */
export const COORDINATION_CHANGED_EVENT = "coordination:changed";

export type CoordinationChanged = {
  workspaceRoot: string;
  seq: number;
};

export function onCoordinationChanged(handler: (change: CoordinationChanged) => void): Promise<UnlistenFn> {
  return listen<CoordinationChanged>(COORDINATION_CHANGED_EVENT, (e) => handler(e.payload));
}

/** The operator's review of a message another agent queued for one of their
 *  conversations, from the panel before that conversation's next turn. */
export function reviewEnvelope(
  workspaceRoot: string,
  runId: string,
  envelopeId: string,
  accept: boolean,
): Promise<CoordinationCommandOutcome> {
  return applyCoordinationCommand(workspaceRoot, {
    type: "review_envelope",
    actor: { type: "operator" },
    runId,
    envelopeId,
    accept,
  });
}
