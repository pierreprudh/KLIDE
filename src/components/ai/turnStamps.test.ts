import { describe, expect, it } from "vitest";
import { STAMP_GAP_MS, stampBefore } from "./turnStamps";
import type { Msg } from "./types";

// Noon local, so "same day" probes don't straddle midnight on any machine.
const BASE = new Date(2026, 9, 5, 12, 0, 0).getTime();
const MIN = 60_000;

const user = (ts: number | undefined, extra: Partial<Extract<Msg, { role: "user" }>> = {}): Msg =>
  ({ role: "user", content: "hi", ts, ...extra }) as Msg;
const assistant = (ts: number | undefined): Msg => ({ role: "assistant", content: "ok", ts });

describe("stampBefore", () => {
  it("stamps the first timestamped turn of a thread", () => {
    expect(stampBefore([user(BASE)], 0)).toBe(true);
  });

  it("never stamps a turn with no recorded time", () => {
    expect(stampBefore([user(undefined)], 0)).toBe(false);
    expect(stampBefore([user(BASE), assistant(BASE + MIN), user(undefined)], 2)).toBe(false);
  });

  it("keeps a quick follow-up unstamped", () => {
    const msgs = [user(BASE), assistant(BASE + MIN), user(BASE + 5 * MIN)];
    expect(stampBefore(msgs, 2)).toBe(false);
  });

  it("stamps a turn that follows an hour of silence", () => {
    const msgs = [user(BASE), assistant(BASE + MIN), user(BASE + MIN + STAMP_GAP_MS)];
    expect(stampBefore(msgs, 2)).toBe(true);
  });

  it("measures the gap from the answer, not the earlier question", () => {
    // A long answer then a prompt 10 min later: still one sitting.
    const msgs = [user(BASE), assistant(BASE + 55 * MIN), user(BASE + 65 * MIN)];
    expect(stampBefore(msgs, 2)).toBe(false);
  });

  it("stamps across midnight even inside the gap", () => {
    const lateNight = new Date(2026, 9, 5, 23, 50).getTime();
    const afterMidnight = new Date(2026, 9, 6, 0, 10).getTime();
    expect(stampBefore([user(lateNight), assistant(lateNight + MIN), user(afterMidnight)], 2)).toBe(true);
  });

  it("ignores non-user rows, queued turns and wake turns", () => {
    expect(stampBefore([assistant(BASE)], 0)).toBe(false);
    expect(stampBefore([user(BASE, { queueState: "queued" })], 0)).toBe(false);
    expect(stampBefore([user(BASE, { wake: true })], 0)).toBe(false);
    // A wake turn's time doesn't reset the silence either.
    const msgs = [user(BASE), assistant(BASE + MIN), user(BASE + 2 * STAMP_GAP_MS, { wake: true }), user(BASE + 2 * STAMP_GAP_MS + MIN)];
    expect(stampBefore(msgs, 3)).toBe(true);
  });
});
