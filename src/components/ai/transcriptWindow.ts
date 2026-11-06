import type { Msg } from "./types";

export const TRANSCRIPT_WINDOW_TURNS = 24;
export const TRANSCRIPT_PAGE_TURNS = 16;

export function isExchangeBoundary(message: Msg): boolean {
  return message.role === "user" ? message.queueState !== "queued"
    : message.role === "system" && (!!message.observer || !!message.workerReport);
}

/** Start on an exchange boundary, keeping tool calls and their results together.
 * Queued prompts do not push the answer still running out of the window. */
export function transcriptWindowStart(
  messages: readonly Msg[],
  turns = TRANSCRIPT_WINDOW_TURNS,
  before = messages.length,
): number {
  let remaining = turns;
  for (let i = Math.min(before, messages.length) - 1; i >= 0; i--) {
    const message = messages[i];
    if (isExchangeBoundary(message) && --remaining === 0) return i;
  }
  return 0;
}

/** Exclusive end of a forward page; queued prompts remain with their answer. */
export function transcriptWindowEnd(messages: readonly Msg[], start: number, turns = TRANSCRIPT_WINDOW_TURNS): number {
  let remaining = turns;
  for (let i = start + 1; i < messages.length; i++) {
    if (isExchangeBoundary(messages[i]) && --remaining === 0) return i;
  }
  return messages.length;
}
