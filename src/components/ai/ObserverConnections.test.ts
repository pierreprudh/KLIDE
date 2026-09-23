import { describe, expect, it } from "vitest";
import { observerConnections } from "./ObserverConnections";
import type { Msg } from "./types";

describe("observer connections", () => {
  const msgs: Msg[] = [
    { role: "assistant", content: "", toolCalls: [{ id: "call1", name: "run_command", args: {} }] },
    { role: "tool", toolName: "run_command", toolCallId: "call1", content: "Watching `sleep 45` as `shell_1`. Finish your reply now." },
    { role: "assistant", content: "Started." },
    { role: "user", content: "2 + 2?" },
    { role: "assistant", content: "4" },
    { role: "system", content: "Background observer finished", observer: { shellId: "shell_1" } },
    { role: "assistant", content: "Command finished." },
  ];
  it("links to the launch across unrelated turns without highlighting them", () => {
    expect(observerConnections(msgs)).toEqual([{ start: 0, end: 5, members: [5, 0, 2, 6] }]);
  });
  it("does not connect ordinary conversations or foreground commands", () => {
    expect(observerConnections(msgs.slice(0, 5))).toEqual([]);
    const foreground = msgs.map(row => row.role === "tool" ? { ...row, content: "Command exited 0" } : row);
    expect(observerConnections(foreground)).toEqual([]);
  });
  it("does not include a later unrelated answer when completion has no report", () => {
    const interrupted: Msg[] = [...msgs.slice(0, 6), { role: "user", content: "Hello" }, { role: "assistant", content: "Hi" }];
    expect(observerConnections(interrupted)[0].members).toEqual([5, 0, 2]);
  });
  it("does not guess a source for an unknown shell", () => {
    expect(observerConnections([...msgs.slice(0, 5), { role: "system", content: "Finished", observer: { shellId: "shell_10" } }])).toEqual([]);
  });
});
