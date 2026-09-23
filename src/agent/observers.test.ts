import { describe, expect, it } from "vitest";
import { observerLabel, type Observer } from "./observers";
const base = { id: "s", command: "gh run watch 123 --exit-status", startedMs: 0, endedMs: null, notifyOnExit: true };
describe("observer status language", () => {
  it("does not equate successful CI with a successful deployment", () => {
    expect(observerLabel({ ...base, status: { state: "exited", code: 0 } })).toBe("Command finished");
  });
  it("distinguishes failure, cancellation and a live watch", () => {
    const states: Observer["status"][] = [{ state: "running" }, { state: "signalled" }, { state: "exited", code: 1 }];
    expect(states.map((status) => observerLabel({ ...base, status }))).toEqual(["Watching in background", "Observer stopped", "Command failed (exit 1)"]);
  });
});
