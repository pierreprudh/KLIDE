import { describe, expect, it } from "vitest";
import { agentPickForConversation, routedModelString, routedSelection } from "./harnessSource";
import { isForeignModelFor } from "../components/ai/rememberedModel";
import { conversationMark, modelIdentity } from "../modelIdentity";

const LOCAL = "pierreprudh/lfm2.5-8b-a1b:latest";

describe("a routed model string", () => {
  it("round-trips its source and model, and is null for a plain id", () => {
    const routed = routedModelString("claude-code", "ollama", LOCAL);
    expect(routedSelection(routed)).toEqual({ provider: "ollama", model: LOCAL });
    expect(routedModelString("hermes", "openai", "gpt-5")).toMatch(/^hermes-source:/);
    expect(routedSelection("sonnet")).toBeNull();
    expect(routedSelection("harness-source:broken")).toBeNull();
    expect(routedSelection(null)).toBeNull();
  });

  it("is not a foreign model for the CLI that carries it", () => {
    expect(isForeignModelFor("claude-code", routedModelString("claude-code", "ollama", LOCAL))).toBe(false);
    expect(isForeignModelFor("claude-code", LOCAL)).toBe(true);
  });

  it("is marked by the model inside it, under the CLI that ran it", () => {
    const routed = routedModelString("claude-code", "ollama", LOCAL);
    expect(modelIdentity(routed)?.name).toBe(modelIdentity(LOCAL)?.name);
    expect(conversationMark(routed, "claude-code")?.label).toBe(`Claude Code · ${modelIdentity(LOCAL)?.name}`);
  });
});

describe("picking an agent in an existing Conversation", () => {
  it("switches freely before the first Run and on an API-origin thread", () => {
    expect(agentPickForConversation(undefined, "ollama")).toEqual({ kind: "switch" });
    expect(agentPickForConversation("ollama", "claude-code")).toEqual({ kind: "switch" });
    expect(agentPickForConversation("openrouter", "anthropic")).toEqual({ kind: "switch" });
  });

  it("keeps a Delegate thread in its CLI: a Provider routes it, another CLI is refused", () => {
    expect(agentPickForConversation("claude-code", "ollama")).toEqual({ kind: "route", harness: "claude-code" });
    expect(agentPickForConversation("claude-code", "anthropic")).toEqual({ kind: "route", harness: "claude-code" });
    expect(agentPickForConversation("claude-code", "codex")).toEqual({ kind: "refuse", harness: "claude-code" });
    expect(agentPickForConversation("claude-code", "claude-code")).toEqual({ kind: "switch" });
  });
});
