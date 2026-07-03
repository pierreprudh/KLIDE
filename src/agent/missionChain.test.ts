import { describe, it, expect } from "vitest";
import { chainStep, type ChainStatus, type ChainTask } from "./missionChain";

// A linear-ish plan with a diamond: t3 and t4 both wait on t2; t5 waits on both.
const PLAN: ChainTask[] = [
  { taskId: "t1" },
  { taskId: "t2", dependsOn: ["t1"] },
  { taskId: "t3", dependsOn: ["t2"] },
  { taskId: "t4", dependsOn: ["t2"] },
  { taskId: "t5", dependsOn: ["t3", "t4"] },
];

const statuses = (map: Record<string, ChainStatus>) => (id: string) => map[id];
const none = new Set<string>();

describe("chainStep", () => {
  it("launches only dep-free tasks on a fresh board", () => {
    const step = chainStep(PLAN, statuses({}), none);
    expect(step.launch).toEqual(["t1"]);
    expect(step.settled).toBe(false);
  });

  it("unlocks dependents when their dependency is done", () => {
    const step = chainStep(PLAN, statuses({ t1: "done" }), none);
    expect(step.launch).toEqual(["t2"]);
  });

  it("unlocks both sides of a fan-out at once", () => {
    const step = chainStep(PLAN, statuses({ t1: "done", t2: "done" }), none);
    expect(step.launch).toEqual(["t3", "t4"]);
  });

  it("waits for ALL deps of a fan-in", () => {
    const step = chainStep(PLAN, statuses({ t1: "done", t2: "done", t3: "done", t4: "running" }), none);
    expect(step.launch).toEqual([]);
    expect(step.running).toBe(true);
    expect(step.settled).toBe(false);
  });

  it("blocks dependents of a failed task and settles", () => {
    const step = chainStep(PLAN, statuses({ t1: "done", t2: "error" }), none);
    expect(step.launch).toEqual([]);
    expect(step.settled).toBe(true); // t3–t5 are parked, nothing runs
  });

  it("a failure on one branch does not block the other branch", () => {
    const step = chainStep(PLAN, statuses({ t1: "done", t2: "done", t3: "error" }), none);
    expect(step.launch).toEqual(["t4"]); // t5 stays blocked (t3 failed), t4 proceeds
  });

  it("never relaunches a task that already has a status or was just launched", () => {
    const step = chainStep(PLAN, statuses({ t1: "done" }), new Set(["t2"]));
    expect(step.launch).toEqual([]);
    // t2's "running" status hasn't landed yet, but alreadyLaunched holds the door.
    expect(step.settled).toBe(true); // nothing running *in state* and nothing to launch
  });

  it("treats dangling dependsOn ids as satisfied", () => {
    const plan: ChainTask[] = [{ taskId: "t1", dependsOn: ["t9"] }];
    const step = chainStep(plan, statuses({}), none);
    expect(step.launch).toEqual(["t1"]);
  });

  it("settles when every task is done", () => {
    const step = chainStep(PLAN, statuses({ t1: "done", t2: "done", t3: "done", t4: "done", t5: "done" }), none);
    expect(step.launch).toEqual([]);
    expect(step.settled).toBe(true);
  });
});
