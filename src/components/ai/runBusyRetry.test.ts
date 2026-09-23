import { describe, expect, it } from "vitest";
import { BUSY_RETRY_DEADLINE_MS, nextBusyWait } from "./runBusyRetry";

describe("nextBusyWait", () => {
  it("backs off from 250 ms to a 1 s ceiling", () => {
    expect([0, 1, 2, 3, 8].map((attempt) => nextBusyWait(attempt, 0))).toEqual([250, 500, 1000, 1000, 1000]);
  });

  it("never waits past the deadline, then gives up", () => {
    expect(nextBusyWait(5, BUSY_RETRY_DEADLINE_MS - 300)).toBe(300);
    expect(nextBusyWait(5, BUSY_RETRY_DEADLINE_MS)).toBeNull();
    expect(nextBusyWait(0, BUSY_RETRY_DEADLINE_MS + 1)).toBeNull();
  });

  it("gives up in a bounded number of retries", () => {
    let elapsed = 0;
    let attempts = 0;
    for (let wait = nextBusyWait(0, 0); wait !== null; wait = nextBusyWait(++attempts, elapsed)) elapsed += wait;
    expect(elapsed).toBe(BUSY_RETRY_DEADLINE_MS);
    expect(attempts).toBeLessThan(30);
  });
});
