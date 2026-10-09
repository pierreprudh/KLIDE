import { describe, expect, it } from "vitest";
import type { Msg } from "./types";
import { groupToolRuns, pairToolResults, toolRunLabel } from "./toolRuns";

const call = (name: string): Msg => ({
  role: "assistant",
  content: "",
  toolCalls: [{ name, args: {} }],
});
const reasoningCall = (name: string, content: string, thinking?: string): Msg => ({
  role: "assistant",
  content,
  thinking,
  toolCalls: [{ name, args: {} }],
});
const result = (name: string): Msg => ({
  role: "tool",
  content: "ok",
  toolName: name,
});
const says = (content: string): Msg => ({ role: "assistant", content });
const asks = (content: string): Msg => ({ role: "user", content });

/** A delegate writes one message per call, so a stretch of work arrives as a
 *  column of them. This is the shape the screenshot showed. */
function burst(name: string, n: number): Msg[] {
  return Array.from({ length: n }, () => [call(name), result(name)]).flat();
}

describe("groupToolRuns", () => {
  it("folds each stretch of tool work into its own run", () => {
    const msgs = [
      asks("fix and commit"),
      ...burst("Bash", 9),
      says("Now a regression test that reproduces exactly what your screenshot showed."),
      ...burst("Bash", 5),
    ];

    const runs = groupToolRuns(msgs);

    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ start: 1, end: 19, calls: 9 });
    expect(runs[1]).toMatchObject({ start: 20, end: 30, calls: 5 });
  });

  it("ends a run at a sentence, because that sentence is the agent explaining itself", () => {
    const msgs = [...burst("Bash", 3), says("Found it."), ...burst("Bash", 3)];

    expect(groupToolRuns(msgs).map((r) => r.calls)).toEqual([3, 3]);
  });

  it("leaves a turn that both speaks and calls tools out of a run", () => {
    const speaking: Msg = { role: "assistant", content: "Reading it now.", toolCalls: [{ name: "Read", args: {} }] };

    expect(groupToolRuns([speaking, result("Read")])).toEqual([]);
  });

  it("folds every reasoning-only encoding without treating it as prose", () => {
    const msgs = [
      reasoningCall("Read", "", "Inspect the workspace."),
      result("Read"),
      reasoningCall("Grep", "<think>Find the relevant symbol.</think>"),
      result("Grep"),
      reasoningCall("Bash", JSON.stringify({
        analysis: "Verify the change.",
        plan: "Run the focused tests.",
        commands: [{ tool_name: "Bash", arguments: { command: "npm test" } }],
      })),
      result("Bash"),
    ];

    expect(groupToolRuns(msgs)).toEqual([
      { start: 0, end: 6, calls: 3 },
    ]);
  });

  it("still ends a run when inline thinking is followed by visible prose", () => {
    const speaking = reasoningCall(
      "Read",
      "<think>Choose the next file.</think>Reading the implementation now.",
    );
    const msgs = [...burst("Bash", 3), speaking, result("Read"), ...burst("Grep", 3)];

    expect(groupToolRuns(msgs).map((run) => run.calls)).toEqual([3, 3]);
  });

  it("does not stack what was never a wall", () => {
    expect(groupToolRuns(burst("Bash", 2))).toEqual([]);
    expect(groupToolRuns(burst("Bash", 3))).toHaveLength(1);
  });

  it("counts results as a run when their calls are no longer in view", () => {
    // Compaction can take the assistant turns and leave the results behind.
    const runs = groupToolRuns([result("Bash"), result("Bash"), result("Bash")]);

    expect(runs[0].calls).toBe(3);
  });

  it("sums the reasoning between the calls, so the row can say how long it thought", () => {
    const thought = (ms: number): Msg => ({ role: "assistant", content: "", thinking: "next", thinkingMs: ms, toolCalls: [{ name: "Bash", args: {} }] });
    const runs = groupToolRuns([asks("go"), thought(700), result("Bash"), thought(1400), result("Bash"), call("Bash"), result("Bash")]);

    expect(runs).toHaveLength(1);
    expect(runs[0].thinkingMs).toBe(2100);
  });

  it("leaves the span unknown when no turn measured one", () => {
    const [run] = groupToolRuns([asks("go"), ...burst("Bash", 3)]);
    expect(run.thinkingMs).toBeUndefined();
    expect(run.workedMs).toBeUndefined();
  });

  it("sums the wall time of the turns, for runs whose reasoning was never timed", () => {
    const landed = (ms: number): Msg => ({ role: "assistant", content: "", thinking: "whole", meta: { ms }, toolCalls: [{ name: "Bash", args: {} }] });
    const [run] = groupToolRuns([asks("go"), landed(20_000), result("Bash"), landed(21_000), result("Bash"), call("Bash"), result("Bash")]);

    expect(run.workedMs).toBe(41_000);
    expect(run.thinkingMs).toBeUndefined();
  });
});

describe("toolRunLabel", () => {
  it("counts the calls, and never names the tools", () => {
    expect(toolRunLabel({ calls: 9 })).toEqual({ count: "9 tool calls" });
  });

  it("says one call in the singular", () => {
    expect(toolRunLabel({ calls: 1 }).count).toBe("1 tool call");
  });

  it("leads with the thinking it folded away, in a turn header's words", () => {
    expect(toolRunLabel({ calls: 11, thinkingMs: 6300 }).thought).toBe("Thought for 6.3s");
    expect(toolRunLabel({ calls: 11 }).thought).toBeUndefined();
  });

  it("falls back to the wall time when the reasoning was never timed", () => {
    expect(toolRunLabel({ calls: 35, workedMs: 41_000 }).thought).toBe("Worked for 41.0s");
    // A measured reasoning span wins: it is the more specific claim.
    expect(toolRunLabel({ calls: 35, thinkingMs: 6300, workedMs: 41_000 }).thought).toBe("Thought for 6.3s");
  });
});

describe("pairToolResults", () => {
  const calls = (...specs: { name: string; id?: string }[]): Msg => ({
    role: "assistant",
    content: "",
    toolCalls: specs.map((c) => ({ ...c, args: {} })),
  });
  const speaks = (content: string, ...specs: { name: string; id?: string }[]): Msg => ({
    role: "assistant",
    content,
    toolCalls: specs.map((c) => ({ ...c, args: {} })),
  });
  const answer = (toolName: string, toolCallId?: string): Msg => ({ role: "tool", content: "ok", toolName, toolCallId });

  it("files each result under the call that asked for it, by id", () => {
    const msgs = [calls({ name: "read_file", id: "a" }, { name: "peek_value", id: "b" }), answer("peek_value", "b"), answer("read_file", "a")];
    const { byCall, claimed } = pairToolResults(msgs);

    expect(byCall.get(0)?.get("a")).toBe(2);
    expect(byCall.get(0)?.get("b")).toBe(1);
    expect([...claimed.keys()]).toEqual([1, 2]);
  });

  it("falls back to name order when the provider sent no ids", () => {
    const msgs = [calls({ name: "read_file" }, { name: "read_file" }), answer("read_file"), answer("read_file")];
    const { byCall } = pairToolResults(msgs);

    expect(byCall.get(0)?.get("#0")).toBe(1);
    expect(byCall.get(0)?.get("#1")).toBe(2);
  });

  it("stops at the first message that is not a result", () => {
    const msgs = [calls({ name: "grep", id: "a" }), says("found it"), answer("grep", "a")];
    const { byCall, claimed } = pairToolResults(msgs);

    expect(byCall.size).toBe(0);
    expect(claimed.size).toBe(0);
  });

  it("keeps a sentence's results out of the run that follows it", () => {
    // The prose turn draws its own glob + grep rows; their results must not
    // seed a fold that counts them again right underneath.
    const msgs = [
      speaks("Let me find the Rust side.", { name: "glob", id: "g" }, { name: "grep", id: "r" }),
      answer("glob", "g"),
      answer("grep", "r"),
      ...burst("read_file", 3),
    ];
    const runs = groupToolRuns(msgs, pairToolResults(msgs));

    expect(runs).toHaveLength(1);
    expect(runs[0].start).toBe(3);
    expect(runs[0].calls).toBe(3);
  });

  it("still counts orphan results as a run", () => {
    const msgs = [answer("Bash"), answer("Bash"), answer("Bash")];
    expect(groupToolRuns(msgs, pairToolResults(msgs))[0].calls).toBe(3);
  });
});
