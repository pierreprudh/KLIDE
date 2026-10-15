import { describe, expect, it } from "vitest";
import { namingRequestFor } from "./conversationNaming";

const user = { role: "user" as const };
const assistant = { role: "assistant" as const };

describe("namingRequestFor — when a run asks for a name, and with whom", () => {
  it("asks on the first turn of an unnamed thread, automatic by default", () => {
    expect(namingRequestFor({ messages: [user], renamed: false, subagent: false })).toEqual({});
    expect(namingRequestFor({ messages: [user, assistant], renamed: false, subagent: false })).toEqual({});
  });
  it("carries the pinned pair only when both halves are set", () => {
    expect(namingRequestFor({ settings: { namingProvider: "ollama", namingModel: "qwen3:4b" }, messages: [user], renamed: false, subagent: false }))
      .toEqual({ model: { provider: "ollama", model: "qwen3:4b" } });
    expect(namingRequestFor({ settings: { namingProvider: "ollama" }, messages: [user], renamed: false, subagent: false })).toEqual({});
  });
  it("never asks for a later turn, a named thread, a subagent, or when off", () => {
    expect(namingRequestFor({ messages: [user, assistant, user], renamed: false, subagent: false })).toBeUndefined();
    expect(namingRequestFor({ messages: [user], renamed: true, subagent: false })).toBeUndefined();
    expect(namingRequestFor({ messages: [user], renamed: false, subagent: true })).toBeUndefined();
    expect(namingRequestFor({ settings: { nameConversations: false }, messages: [user], renamed: false, subagent: false })).toBeUndefined();
  });
});
