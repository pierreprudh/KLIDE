import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELEGATE_IDS } from "./delegates";
import { memoryStorage } from "./testStorage";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("task Delegate persistence", () => {
  it("hydrates every supported Delegate without losing its source", async () => {
    localStorage.setItem(
      "klide.tasks",
      JSON.stringify(
        DELEGATE_IDS.map((source, index) => ({
          id: `task-${source}`,
          title: `Task ${index + 1}`,
          source,
          model: null,
          status: "done",
          cwd: "/workspace",
          startedMs: index,
        })),
      ),
    );

    const { getTaskSessions } = await import("./tasks");
    expect(getTaskSessions().map((task) => task.source)).toEqual([...DELEGATE_IDS].reverse());
  });

  it("accepts every supported Delegate as the last-used agent", async () => {
    const { lastAgent } = await import("./tasks");

    for (const source of DELEGATE_IDS) {
      localStorage.setItem("klide-last-agent", source);
      expect(lastAgent()).toBe(source);
    }

    localStorage.setItem("klide-last-agent", "removed-delegate");
    expect(lastAgent()).toBe("claude-code");
  });
});
