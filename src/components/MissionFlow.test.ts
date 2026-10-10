import { expect, it } from "vitest";
import { missionFlowTransfers } from "./MissionFlow";

it("pulses only along dependencies when the next task starts", () => {
  const edges = [{ from: "a", to: "b" }, { from: "b", to: "c" }];
  expect(missionFlowTransfers({ a: "done", b: "ready", c: "queued" }, { a: "done", b: "running", c: "queued" }, edges)).toEqual(["a->b"]);
  expect(missionFlowTransfers({ a: "done", b: "running" }, { a: "done", b: "validating" }, edges)).toEqual([]);
  expect(missionFlowTransfers({ a: "running", b: "ready" }, { a: "running", b: "running" }, edges)).toEqual([]);
  expect(missionFlowTransfers({ a: "done", b: "done" }, { a: "done", b: "done" }, edges)).toEqual([]);
});
