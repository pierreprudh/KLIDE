// A send can find its conversation's Run still holding the backend guard: a
// completion-triggered reply won the race between the queue check and
// dispatch, or the previous Run is still letting go of its handle. The turn is
// kept and retried — but not forever. It used to poll every 250 ms with no
// end, so a Run that never released left the message "running" for good.

/** First wait, and the ceiling the doubling stops at. */
export const BUSY_RETRY_FIRST_MS = 250;
export const BUSY_RETRY_MAX_MS = 1000;
/** Past this, the Run is not about to let go — tell the user instead. */
export const BUSY_RETRY_DEADLINE_MS = 20_000;

/** How long to wait before retry `attempt` (0-based), given how long the
 *  turn has already waited — or `null` to give up. Never waits past the
 *  deadline. */
export function nextBusyWait(attempt: number, elapsedMs: number): number | null {
  const left = BUSY_RETRY_DEADLINE_MS - elapsedMs;
  if (left <= 0) return null;
  const backoff = Math.min(BUSY_RETRY_FIRST_MS * 2 ** Math.max(0, attempt), BUSY_RETRY_MAX_MS);
  return Math.min(backoff, left);
}
