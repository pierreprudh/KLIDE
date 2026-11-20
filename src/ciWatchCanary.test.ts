import { describe, expect, it } from "vitest";

// Throwaway canary for the Watch CI end-to-end test — fails on purpose, do not merge.
describe("ci watch canary", () => {
  it("fails on purpose", () => {
    expect(1 + 1).toBe(3);
  });
});
