// What a run is waiting on, recovered from its transcript.
//
// A run can park on three things it cannot answer itself: a diff to approve, a
// shell command or network target to allow, a question to answer. Each arrives
// as an event, the panel draws a card, and the harness sits on a oneshot until
// the card is answered.
//
// `foldEvents` deliberately ignores all three — they are not conversation rows.
// That was fine while a panel could only ever watch the run it had started
// itself: the gate arrived on the live channel and the card was already up.
//
// It stopped being fine when leaving a conversation stopped killing its run. A
// run you walk away from can ask for approval while you are gone, and a run you
// come back to may already be parked — in both cases the card had no way back
// on screen, so the run waited forever with its request as the last line of the
// transcript and a blinking caret as the only sign of life.
//
// Gates are persisted like every other event, so the transcript is the answer:
// walk it, and whatever was requested and never resolved is what the run is
// waiting on right now.
import type { AgentEvent, DiffProposal, PermissionRequest, QuestionChoices } from "./types";

export type PendingGates = {
  permission: PermissionRequest | null;
  diff: DiffProposal | null;
  question: { runId: string; requestId: string; question: string; choices?: QuestionChoices } | null;
};

export const NO_PENDING_GATES: PendingGates = {
  permission: null,
  diff: null,
  question: null,
};

/**
 * The unanswered gates in a transcript, in order of appearance.
 *
 * Resolutions are matched by id rather than "the last one wins": the harness
 * can resolve a request the panel has already moved past (a subagent's, or one
 * abandoned by a retry), and clearing on any resolution would drop the card the
 * run is actually waiting on. A terminal event ends everything — a finished run
 * is waiting on nothing, whatever its last gate said.
 */
export function pendingGatesFromEvents(events: readonly AgentEvent[]): PendingGates {
  let permission: PermissionRequest | null = null;
  let diff: DiffProposal | null = null;
  let question: PendingGates["question"] = null;

  for (const event of events) {
    switch (event.type) {
      case "permission_requested":
        permission = event.request;
        break;
      case "permission_resolved":
        if (permission?.id === event.requestId) permission = null;
        break;
      case "diff_proposed":
        diff = event.proposal;
        break;
      case "diff_resolved":
        if (diff?.id === event.proposalId) diff = null;
        break;
      case "user_question_requested":
        question = {
          runId: event.runId,
          requestId: event.requestId,
          question: event.question,
          ...(event.choices ? { choices: event.choices } : {}),
        };
        break;
      case "user_question_resolved":
        if (question?.requestId === event.requestId) question = null;
        break;
      case "run_result":
      case "run_error":
        permission = null;
        diff = null;
        question = null;
        break;
      default:
        break;
    }
  }

  return { permission, diff, question };
}
