import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { memoryStorage } from "../testStorage";
import { startAgentRun } from "./client";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class { onmessage?: (event: unknown) => void },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

beforeEach(() => { vi.stubGlobal("localStorage", memoryStorage()); vi.mocked(invoke).mockResolvedValue({ runId: "retry-run" }); });

it.each([true, undefined])("preserves explicit retry intent through IPC: %s", async (retry) => {
  await startAgentRun({
    runId: "retry-run", workspaceRoot: "/tmp/test", mode: "goal",
    provider: "codex", model: "test-model", text: "", attachments: [], retry,
  }, () => {});
  expect(invoke).toHaveBeenLastCalledWith("agent_start_run", expect.objectContaining({
    request: expect.objectContaining({ initialText: "", retry }),
  }));
});

it("sends the conversation machine for native remote dispatch", async () => {
  const { setConversationMachine } = await import("../conversationMachines");
  setConversationMachine("remote-run", "box");
  await startAgentRun({ runId: "remote-run", workspaceRoot: "/tmp/project", mode: "goal", provider: "claude-code", model: "default", text: "do work", attachments: [] }, () => {});
  expect(invoke).toHaveBeenLastCalledWith("agent_start_run", expect.objectContaining({ machineId: "box" }));
});
