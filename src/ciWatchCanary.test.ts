// Throwaway: fails on purpose so Watch CI (PR #564) has a failing check to
// catch. Close the PR and delete the branch once tested — never merge.
import { describe, expect, it } from "vitest";

describe("ci watch canary", () => {
  it("fails on purpose", () => {
    expect(1 + 1).toBe(3);
  });
});
