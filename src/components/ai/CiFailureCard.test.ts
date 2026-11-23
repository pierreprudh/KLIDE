import { expect, it } from "vitest";
import { statusLine } from "./CiFailureCard";
import { ciFailureStands } from "../../ipc/ciWatch";

it("tells what became of the failure", () => {
  expect(statusLine("Rust tests", null)).toEqual({ text: "Rust tests failed", tone: "failed" });
  expect(statusLine("Rust tests", "running").tone).toBe("neutral");
  expect(statusLine("Rust tests", "passed")).toEqual({ text: "Rust tests passed", tone: "passed" });
  expect(statusLine("Rust tests", "failing").text).toBe("Rust tests failed again");
});

it("puts Fix it away once there's nothing left to fix", () => {
  expect([null, "running", "failing"].every(n => ciFailureStands(n as never))).toBe(true);
  expect(["passed", "moved", "closed"].some(n => ciFailureStands(n as never))).toBe(false);
});
