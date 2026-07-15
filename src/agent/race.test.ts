import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, startAgentRunMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  startAgentRunMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("./client", () => ({ startAgentRun: startAgentRunMock }));

import { dispatchRace, PartialRaceError } from "./race";
import { listRaces } from "../races";
import { memoryStorage } from "../testStorage";

const agents = [
  { provider: "ollama" as const, model: "klide-8b" },
  { provider: "openai" as const, model: "gpt-5" },
];

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  vi.spyOn(Date, "now").mockReturnValue(123_456);
  invokeMock.mockReset();
  startAgentRunMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("dispatchRace", () => {
  it("creates isolated worktrees sequentially and persists the run group", async () => {
    const order: string[] = [];
    invokeMock.mockImplementation(async (command: string, args: { branch: string }) => {
      order.push(`${command}:${args.branch}`);
      const segments = args.branch.split("/");
      return {
        path: `/workspace-worktrees/${segments[segments.length - 1]}`,
        branch: args.branch,
        bootstrapped: [],
      };
    });
    startAgentRunMock.mockImplementation(async (input: { workspaceRoot: string }) => {
      order.push(`start:${input.workspaceRoot}`);
      return { runId: `run_${order.length}`, done: Promise.resolve() };
    });

    const group = await dispatchRace({
      prompt: "Fix checkout",
      workspaceRoot: "/workspace",
      agents,
    });

    expect(order).toEqual([
      "git_worktree_add:klide/race-2n9c-1",
      "start:/workspace-worktrees/race-2n9c-1",
      "git_worktree_add:klide/race-2n9c-2",
      "start:/workspace-worktrees/race-2n9c-2",
    ]);
    expect(startAgentRunMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workspaceRoot: "/workspace-worktrees/race-2n9c-1",
        mode: "goal",
        provider: "ollama",
        model: "klide-8b",
        text: "Fix checkout",
        requireDiffReview: false,
      }),
      expect.any(Function),
    );
    expect(group.members).toHaveLength(2);
    expect(listRaces("/workspace")).toEqual([group]);
  });

  it("removes a new worktree, its recipe copies, and its branch when the run fails to start", async () => {
    invokeMock.mockImplementation(async (command: string, args: { branch?: string }) => {
      if (command === "git_worktree_remove") return undefined;
      const segments = args.branch?.split("/") ?? [];
      return {
        path: `/workspace-worktrees/${segments[segments.length - 1]}`,
        branch: args.branch,
        bootstrapped: [".env"],
      };
    });
    startAgentRunMock
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce({ runId: "run_b", done: Promise.resolve() });

    let failure: unknown;
    try {
      await dispatchRace({ prompt: "Fix checkout", workspaceRoot: "/workspace", agents });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(PartialRaceError);
    expect((failure as PartialRaceError).group.members.map((member) => member.runId)).toEqual(["run_b"]);
    expect(invokeMock).toHaveBeenCalledWith("git_worktree_remove", {
      workspaceRoot: "/workspace",
      path: "/workspace-worktrees/race-2n9c-1",
      force: false,
      cleanFiles: [".env"],
      deleteBranch: "klide/race-2n9c-1",
    });
    expect(listRaces("/workspace")).toHaveLength(1);
  });

  it("reports a refused cleanup instead of hiding it (dirty checkout preserved)", async () => {
    invokeMock.mockImplementation(async (command: string, args: { branch?: string }) => {
      if (command === "git_worktree_remove") {
        throw new Error("contains modified or untracked files");
      }
      const segments = args.branch?.split("/") ?? [];
      return {
        path: `/workspace-worktrees/${segments[segments.length - 1]}`,
        branch: args.branch,
        bootstrapped: [],
      };
    });
    startAgentRunMock.mockRejectedValue(new Error("provider unavailable"));

    let failure: unknown;
    try {
      await dispatchRace({ prompt: "Fix checkout", workspaceRoot: "/workspace", agents });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("provider unavailable");
    expect((failure as Error).message).toContain("worktree cleanup failed");
    expect((failure as Error).message).toContain("contains modified or untracked files");
    // Nothing started, so no group is persisted.
    expect(listRaces("/workspace")).toHaveLength(0);
  });
});
