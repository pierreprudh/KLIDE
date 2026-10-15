import { describe, expect, it } from "vitest";
import type { PermissionRequest } from "../../agent/types";
import { permissionCard, suggestCommandPattern } from "./permissionCard";

/** What the relay raises when a headless Claude Code worker asks before a
 *  Bash call — the exact shape of the first background-worker dogfood. */
const relayed: PermissionRequest = {
  id: "perm_sub_parent_call_1_toolu_9",
  runId: "sub_parent_call_1",
  toolCallId: "toolu_9",
  toolName: "Bash",
  input: { command: "xxd hello.txt && git add hello.txt && git commit -q -m 'chore: add hello.txt'", cwd: "/w", delegateTool: "Bash", externalPaths: [] },
  summary: "The agent asks to run Bash xxd hello.txt && git add hello.txt",
  reason: "The CLI asked before acting. A headless turn has no terminal of its own, so the question comes here.",
  options: [],
};

describe("permissionCard", () => {
  it("draws a worker's relayed shell prompt as a command card bound to the child's Run", () => {
    const card = permissionCard("sub_parent_call_1", relayed);
    expect(card.kind).toBe("command");
    expect(card.runId).toBe("sub_parent_call_1");
    expect(card.requestId).toBe(relayed.id);
    expect(card.command).toContain("git add hello.txt");
    expect(card.reason).toContain("no terminal of its own");
    // A project rule stops at the first operator: never `git commit *` by accident.
    expect(card.suggestedPattern).toBe("xxd hello.txt *");
  });

  it("reads a worker dispatch as a worker card, named after the Delegate and role", () => {
    const card = permissionCard("run-1", {
      ...relayed,
      toolName: "spawn_subagent",
      input: { worker: "claude-code", workerLabel: "Claude Code", subagent: "implementer", task: "Add CONTRIBUTING.md", branch: "klide/worker-x" },
    });
    expect(card.kind).toBe("worker");
    expect(card.worker).toBe("claude-code");
    expect(card.peer).toBe("Claude Code implementer");
    expect(card.command).toBe("Add CONTRIBUTING.md");
    expect(card.suggestedPattern).toBeUndefined();
  });

  it("names an unknown peer by its short id when no index is given", () => {
    const card = permissionCard("run-1", { ...relayed, input: { fromRunId: "mv9abcdef0123456", envelopeId: "env-1", body: "Can you review?" } });
    expect(card.kind).toBe("message");
    expect(card.command).toBe("Can you review?");
    expect(card.peer).toBeTruthy();
  });
});

describe("suggestCommandPattern", () => {
  it("keeps `npm run <script>` whole and widens the rest", () => {
    expect(suggestCommandPattern("npm run test -- --watch")).toBe("npm run test *");
    expect(suggestCommandPattern("git log --oneline -5")).toBe("git log *");
    expect(suggestCommandPattern("ls")).toBeUndefined();
  });
});
