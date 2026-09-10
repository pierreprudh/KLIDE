import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { GitStatus } from "./gitTypes";
import {
  GIT_STATUS_POLL_MS,
  getGitStatus,
  refreshGitStatus,
  resetGitStatusStoreForTests,
  sameGitStatus,
  subscribeGitStatus,
} from "./gitStatus";

const clean = (): GitStatus => ({ branch: "main", files: [] });
const dirty = (): GitStatus => ({
  branch: "main",
  files: [{ path: "src/a.ts", status: "M", staged: false }],
});

beforeEach(() => {
  vi.useFakeTimers();
  invokeMock.mockReset();
  resetGitStatusStoreForTests();
});

afterEach(() => {
  resetGitStatusStoreForTests();
  vi.useRealTimers();
});

describe("sameGitStatus", () => {
  it("treats a re-read of the same tree as the same status", () => {
    expect(sameGitStatus(dirty(), dirty())).toBe(true);
    expect(sameGitStatus(clean(), clean())).toBe(true);
    expect(sameGitStatus(null, null)).toBe(true);
  });

  it("sees a branch switch, a new file, a staged file, and a lost repo", () => {
    expect(sameGitStatus(clean(), { branch: "feat", files: [] })).toBe(false);
    expect(sameGitStatus(clean(), dirty())).toBe(false);
    const staged = dirty();
    staged.files[0].staged = true;
    expect(sameGitStatus(dirty(), staged)).toBe(false);
    expect(sameGitStatus(dirty(), null)).toBe(false);
  });
});

describe("the store", () => {
  it("keeps the same snapshot identity across polls that read the same tree", async () => {
    invokeMock.mockImplementation(async () => dirty());
    const fn = vi.fn();
    const off = subscribeGitStatus("/ws", fn);
    await vi.advanceTimersByTimeAsync(0);
    const first = getGitStatus("/ws");
    expect(first).toEqual(dirty());
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(GIT_STATUS_POLL_MS * 3);
    expect(invokeMock).toHaveBeenCalledTimes(4);
    expect(getGitStatus("/ws")).toBe(first);
    expect(fn).toHaveBeenCalledTimes(1);
    off();
  });

  it("wakes subscribers when the tree changes, and only then", async () => {
    let answer: GitStatus = clean();
    invokeMock.mockImplementation(async () => answer);
    const fn = vi.fn();
    const off = subscribeGitStatus("/ws", fn);
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);

    answer = dirty();
    await vi.advanceTimersByTimeAsync(GIT_STATUS_POLL_MS);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(getGitStatus("/ws")?.files).toHaveLength(1);
    off();
  });

  it("polls once per root however many subscribers listen, and stops with the last", async () => {
    invokeMock.mockImplementation(async () => clean());
    const a = subscribeGitStatus("/ws", vi.fn());
    const b = subscribeGitStatus("/ws", vi.fn());
    await vi.advanceTimersByTimeAsync(GIT_STATUS_POLL_MS * 2);
    expect(invokeMock).toHaveBeenCalledTimes(3);

    a();
    await vi.advanceTimersByTimeAsync(GIT_STATUS_POLL_MS);
    expect(invokeMock).toHaveBeenCalledTimes(4);

    b();
    await vi.advanceTimersByTimeAsync(GIT_STATUS_POLL_MS * 5);
    expect(invokeMock).toHaveBeenCalledTimes(4);
  });

  it("shares one read between concurrent refreshes", async () => {
    invokeMock.mockImplementation(async () => clean());
    const p1 = refreshGitStatus("/ws");
    const p2 = refreshGitStatus("/ws");
    expect(p1).toBe(p2);
    await p1;
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("reads a failed status as no status, like a folder that is not a repo", async () => {
    invokeMock.mockImplementation(async () => dirty());
    await refreshGitStatus("/ws");
    expect(getGitStatus("/ws")).not.toBeNull();
    invokeMock.mockImplementation(async () => {
      throw new Error("not a git repository");
    });
    await refreshGitStatus("/ws");
    expect(getGitStatus("/ws")).toBeNull();
  });

  it("keeps roots apart", async () => {
    invokeMock.mockImplementation(async (_cmd: string, args: { workspaceRoot: string }) =>
      args.workspaceRoot === "/a" ? dirty() : clean(),
    );
    await Promise.all([refreshGitStatus("/a"), refreshGitStatus("/b")]);
    expect(getGitStatus("/a")?.files).toHaveLength(1);
    expect(getGitStatus("/b")?.files).toHaveLength(0);
    expect(getGitStatus(null)).toBeNull();
  });
});
