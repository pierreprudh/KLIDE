import { describe, expect, it } from "vitest";
import { DELEGATES } from "../delegates";
import { nativePermissionMode, nativePermissionModes } from "./nativePermissions";
import { toStartRunRequest } from "./client";
import type { StartAgentRunInput } from "./types";

describe("native agent permissions", () => {
  it("offers a default for each built-in agent and no native modes for model endpoints", () => {
    for (const agent of DELEGATES) expect(nativePermissionModes(agent.id)[0].id).toBe("");
    for (const provider of ["openai", "ollama", "auto", "cli:custom"]) expect(nativePermissionModes(provider)).toEqual([]);
  });
  it("keeps provider-specific authority from crossing to another agent", () => {
    expect(nativePermissionMode("claude-code", "bypassPermissions")).toBe("bypassPermissions");
    expect(nativePermissionMode("codex", "bypassPermissions")).toBeUndefined();
    expect(nativePermissionMode("codex", "auto-review")).toBe("auto-review");
    expect(nativePermissionMode("amp", "full-access")).toBeUndefined();
  });
  it("carries the native selection through the run request", () => {
    const input = { provider: "codex", model: "default", mode: "goal", text: "test", workspaceRoot: null, attachments: [], nativePermissionMode: "auto-review" } satisfies StartAgentRunInput;
    expect(toStartRunRequest(input).nativePermissionMode).toBe("auto-review");
    expect(toStartRunRequest({ ...input, nativePermissionMode: undefined }).nativePermissionMode).toBeUndefined();
  });
});
