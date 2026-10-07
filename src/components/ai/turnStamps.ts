// When a conversation says what time it is.
//
// A thread picked back up after lunch, or the next morning, reads as one
// unbroken exchange unless something marks the gap. The mark is a centered
// day stamp ("Today 11:29 AM", "Yesterday 4:40 PM") above the user turn that
// reopened it — the first turn of the thread, and any turn that follows a
// silence. Turns a few minutes apart carry no stamp; their own clock sits
// under the bubble.
//
// Pure: the panel asks `stampBefore(msgs, i)` for each user turn it draws.

import type { Msg } from "./types";

/** A silence this long between two timestamped turns earns a stamp. */
export const STAMP_GAP_MS = 60 * 60 * 1000;

function sameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

/** Whether the user turn at `i` should carry a day stamp above it. A turn
 *  without a recorded time never does — nothing truthful could be printed.
 *  Queued turns are not yet in the past, so they wait too. */
export function stampBefore(msgs: readonly Msg[], i: number): boolean {
  const m = msgs[i];
  if (!m || m.role !== "user" || m.ts === undefined || m.wake || m.queueState) return false;
  for (let j = i - 1; j >= 0; j--) {
    const prev = msgs[j];
    if (!("ts" in prev) || prev.ts === undefined) continue;
    if (prev.role === "user" && prev.wake) continue;
    return m.ts - prev.ts >= STAMP_GAP_MS || !sameLocalDay(prev.ts, m.ts);
  }
  return true;
}
