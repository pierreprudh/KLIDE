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
      result("B", "Async agent launched successfully."),
      // A conversation recorded before reports were read: a foreground call's
      // result is the sub-agent's own report.
      result("C", "Found three shallow modules."),
    ];
    expect(turnSubagents(msgs, false).map((r) => r.status)).toEqual(["ended", "ended", "completed"]);
  });

  it("is empty for a turn that started none, or for calls Klide ran itself", () => {
    const own: Msg = { role: "assistant", content: "", toolCalls: [{ id: "k", name: "Agent", args: {} }] };
    expect(turnSubagents([{ role: "user", content: "hi" }, own], true)).toEqual([]);
  });
});
