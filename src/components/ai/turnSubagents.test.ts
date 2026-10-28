import { describe, expect, it } from "vitest";
import type { Msg } from "./types";
import { traySummary, turnSubagents } from "./turnSubagents";

const agent = (id: string, description: string, extra: Record<string, unknown> = {}) => ({
  id, name: "Agent", args: { description, subagent_type: "Explore" }, observedBy: "claude-code", ...extra,
});
const result = (toolCallId: string, content: string): Msg => ({ role: "tool", content, toolName: "Agent", toolCallId, observedBy: "claude-code" });

describe("the sub-agents of the turn in hand", () => {
  it("lists only this turn's, and reads where each is from the CLI's reports", () => {
    const msgs: Msg[] = [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "", toolCalls: [agent("old", "Earlier work")] },
      { role: "user", content: "fan out" },
      {
        role: "assistant", content: "", toolCalls: [
          agent("A", "Map  src-tauri/src/agent", { subagent: { status: "running", activity: "Reading mod.rs", startedMs: 1 } }),
          agent("B", "Read CONTEXT.md", { subagent: { status: "completed", steps: 2, startedMs: 1, endedMs: 4 } }),
          { id: "r", name: "Read", args: { file_path: "x" }, observedBy: "claude-code" },
        ],
      },
      // A background call returns at once; that is not the sub-agent finishing.
      result("A", "Async agent launched successfully."),
      result("B", "Async agent launched successfully."),
    ];
    const rows = turnSubagents(msgs, true);
    expect(rows.map((r) => [r.id, r.kind, r.task, r.status])).toEqual([
      ["A", "Explore", "Map src-tauri/src/agent", "running"],
      ["B", "Explore", "Read CONTEXT.md", "completed"],
    ]);
    expect(traySummary(rows)).toBe("1 running · 1 done");
  });

  it("claims no outcome it was not told once the Run is over", () => {
    const msgs: Msg[] = [
      { role: "user", content: "fan out" },
      { role: "assistant", content: "", toolCalls: [agent("A", "Map", { subagent: { status: "running" } }), agent("B", "Read"), agent("C", "Find")] },
      result("B", "Agent started in background with agent_id: x."),
      // A conversation recorded before reports were read: a foreground call's
      // result is the sub-agent's own report.
      result("C", "Found three shallow modules."),
    ];
    expect(turnSubagents(msgs, false).map((r) => r.status)).toEqual(["ended", "ended", "completed"]);
  });

  it("draws each item of omp's `task` list as a sub-agent of its own", () => {
    const msgs: Msg[] = [
      { role: "user", content: "fan out" },
      { role: "assistant", content: "", toolCalls: [
        {
          id: "T", name: "task", observedBy: "omp",
          args: { agent: "explore", tasks: [{ id: "ReadA", description: "Read a.txt", assignment: "# Target…" }, { id: "ReadB", assignment: "Read  b.txt" }] },
          subagentItems: { 0: { status: "completed", tokens: 54689, startedMs: 1, endedMs: 7 }, 1: { status: "running", activity: "Reading b.txt", startedMs: 1 } },
        },
        // A call with an empty list starts nothing.
        { id: "W", name: "task", observedBy: "omp", args: { agent: "explore", tasks: [] } },
      ] },
      // The batch's call returns before its sub-agents finish.
      { role: "tool", content: "Spawned 2 background agents using explore.", toolName: "task", toolCallId: "T", observedBy: "omp" },
    ];
    const rows = turnSubagents(msgs, true);
    expect(rows.map((r) => [r.id, r.kind, r.task, r.status, r.activity])).toEqual([
      ["T#0", "explore", "Read a.txt", "completed", undefined],
      ["T#1", "explore", "Read b.txt", "running", "Reading b.txt"],
    ]);
    expect(turnSubagents(msgs.slice(0, 2).map((m) => m.role === "assistant" ? { ...m, toolCalls: m.toolCalls?.map((c) => ({ ...c, subagentItems: undefined })) } : m), false).map((r) => r.status)).toEqual(["ended", "ended"]);
  });

  it("reads OpenCode's `subagent` call: its `agent`, and the step it has open", () => {
    const step = (type: "observed_tool_call" | "observed_tool_result", toolCallId: string) =>
      type === "observed_tool_call"
        ? { type, runId: "r", toolCallId, provider: "opencode", name: "read", input: { path: "src/time.ts" }, summary: "read src/time.ts", parentToolCallId: "A", ts: 1 } as const
        : { type, runId: "r", toolCallId, ok: true, content: "…", parentToolCallId: "A", ts: 2 } as const;
    const msgs: Msg[] = [
      { role: "user", content: "fan out" },
      { role: "assistant", content: "", toolCalls: [{
        id: "A", name: "subagent", observedBy: "opencode",
        args: { agent: "explore", description: "Find the clock" },
        subagent: { status: "running", startedMs: 1 },
        nested: [step("observed_tool_call", "r1"), step("observed_tool_result", "r1"), step("observed_tool_call", "r2")],
      }] },
    ];
    expect(turnSubagents(msgs, true)).toMatchObject([{ kind: "explore", task: "Find the clock", status: "running", activity: "Reading src/time.ts" }]);
  });

  it("is empty for a turn that started none, or for calls Klide ran itself", () => {
    const own: Msg = { role: "assistant", content: "", toolCalls: [{ id: "k", name: "Agent", args: {} }] };
    expect(turnSubagents([{ role: "user", content: "hi" }, own], true)).toEqual([]);
  });
});
