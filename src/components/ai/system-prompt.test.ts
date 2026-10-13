import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./system-prompt";
import type { ProviderId } from "../../agent/types";

function prompt(provider: ProviderId, model = "mistral-test") {
  return buildSystemPrompt(null, false, [], "chat", false, "", undefined, model, provider);
}
describe("selected harness identity", () => {
  it("identifies a Hermes turn as Hermes rather than Kit", () => {
    const text = prompt("hermes");
    expect(text).toContain("You are Hermes");
    expect(text).not.toContain("You are Kit");
    expect(text).not.toContain("say you're Kit");
  });
  it("retains Kit for the native harness", () => {
    expect(prompt("mistral")).toContain("You are Kit");
  });
  it("uses the selected delegate rather than the model maker as its identity", () => {
    const text = prompt("codex", "claude-test");
    expect(text).toContain("You are Codex");
    expect(text).toContain("claude-test");
    expect(text).not.toContain("You are Kit");
  });
  it("describes the actual model behind an encoded Hermes choice", () => {
    const text = prompt("hermes", 'hermes-source:{"provider":"mistral","model":"mistral-test"}');
    expect(text).toContain("`mistral-test`");
    expect(text).not.toContain("hermes-source:");
  });
});
