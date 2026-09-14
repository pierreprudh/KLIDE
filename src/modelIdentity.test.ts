import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { conversationMark, modelIdentity } from "./modelIdentity";
import type { ProviderId } from "./agent/types";

/** What a mark actually draws, as markup — the only way to tell a mark that
 *  wears the CLI from one that wears the maker, since both arrive as one node. */
function drawn(model: string | null, provider: ProviderId, size: number): string {
  const mark = conversationMark(model, provider, size);
  if (!mark) throw new Error("no mark");
  return renderToStaticMarkup(mark.node);
}

const OPENCODE_MARK = "opencode-logo-light.svg";

describe("modelIdentity", () => {
  it.each([
    ["mlx-community/Qwen3-30B", "Qwen"],
    ["openrouter/deepseek/deepseek-v4", "DeepSeek"],
    ["claude-sonnet-4-6", "Anthropic"],
    ["openai/gpt-5.6", "OpenAI"],
    ["gemma-3-27b", "Google"],
    ["grok-4", "xAI"],
    ["moonshot/kimi-k2", "Kimi"],
    ["z-ai/glm-5", "Z.AI"],
    // Delegate CLIs namespace their catalogue `<route>/<model>`, so the maker
    // sits behind a prefix that is not the maker (OpenCode's own gateway).
    ["opencode-go/kimi-k3", "Kimi"],
    ["opencode-go/glm-5.2", "Z.AI"],
    ["opencode-go/gpt-5.6-luna", "OpenAI"],
    ["opencode-go/grok-4.5", "xAI"],
    ["opencode-go/minimax-m3", "MiniMax"],
    ["opencode/deepseek-v4-flash-free", "DeepSeek"],
  ])("recognizes %s as %s", (model, maker) => {
    expect(modelIdentity(model)?.name).toBe(maker);
  });

  // A gateway id names the maker in its vendor segment, and the model half can
  // say nothing at all — which is how these drew no mark before.
  it.each([
    ["openai/chatgpt-4o-latest", "OpenAI"],
    ["anthropic/claude-next", "Anthropic"],
    ["google/palm-2", "Google"],
    ["mistralai/pixtral-large", "Mistral AI"],
    ["meta-llama/maverick-17b", "Llama"],
    ["qwen/qwq-32b", "Qwen"],
    ["moonshotai/moonlight-16b", "Kimi"],
    ["x-ai/sherlock-alpha", "xAI"],
    // OpenRouter's variant prefix rides in front of the vendor.
    ["~deepseek/deepseek-v4-flash-latest", "DeepSeek"],
    // The model half names no maker at all here, so the vendor carries it.
    ["sakana/fugu-ultra", "Sakana AI"],
  ])("reads the maker from the vendor segment of %s", (model, maker) => {
    expect(modelIdentity(model)?.name).toBe(maker);
  });

  // The model half is the more specific evidence, so it outranks the vendor:
  // a Nemotron is still a Llama, and the host org is not its maker.
  it("prefers the model half over the vendor segment", () => {
    expect(modelIdentity("nvidia/llama-3.3-nemotron-super-49b")?.name).toBe("Llama");
  });

  // A router is not a maker, and neither is a local namespace.
  it.each(["openrouter/auto", "openrouter/horizon-beta", "nousresearch/hermes-4-70b", "pierreprudh/klide-8b:latest"])(
    "leaves %s unbranded",
    (model) => {
      expect(modelIdentity(model)).toBeNull();
    },
  );

  it.each([null, undefined, "", "default", "auto", "unknown-model", "phi-4"])(
    "does not invent an identity for %s",
    (model) => {
      expect(modelIdentity(model)).toBeNull();
    },
  );
});

describe("conversationMark", () => {
  it("names the maker when the model id does", () => {
    expect(conversationMark("deepseek/deepseek-v4-flash", "openrouter", 15)?.label).toBe(
      "DeepSeek",
    );
  });

  // The arm the rail was missing: a routed model whose vendor Klide has no mark
  // for still ran somewhere, and that somewhere has one. Drawing nothing read
  // as metadata that had failed to load.
  it("falls back to the provider that hosted an unbranded model", () => {
    expect(conversationMark("openrouter/auto", "openrouter", 15)?.label).toBe("OpenRouter");
    expect(conversationMark("hermes-4-70b", "ollama", 15)?.label).toBe("Ollama");
  });

  it("leads with the CLI for a delegate thread, whatever it ran", () => {
    expect(conversationMark("opencode-go/kimi-k3", "opencode", 24)?.label).toBe(
      "OpenCode · Kimi",
    );
  });

  it("has nothing to draw when neither the model nor the provider is known", () => {
    expect(conversationMark("unknown-model", null, 15)).toBeNull();
    expect(conversationMark(null, undefined, 15)).toBeNull();
  });
});

describe("a delegate whose catalogue is one house", () => {
  it("names its maker even when the run pinned no model", () => {
    // `default` is "no --model flag, let the CLI choose" — an ordinary way to
    // run one, and it names no model. The maker is still knowable from the CLI.
    expect(conversationMark("default", "claude-code", 22)?.label).toBe("Claude Code · Anthropic");
    expect(conversationMark(null, "codex", 22)?.label).toBe("Codex · OpenAI");
  });

  it("still prefers what the turn actually recorded", () => {
    expect(conversationMark("claude-opus-5", "claude-code", 22)?.label).toBe(
      "Claude Code · Anthropic",
    );
  });

  it("leaves a multi-house delegate alone, having nothing true to draw", () => {
    // OpenCode's catalogue is other makers' models: with no model id there is
    // no maker to name, and inventing one would be a claim about the run.
    expect(conversationMark("default", "opencode", 22)?.label).toBe("OpenCode");
    expect(conversationMark("kimi-k2", "opencode", 22)?.label).toBe("OpenCode · Kimi");
  });
});

describe("a single slot, at rail size", () => {
  // The rail draws its rows at 15: too small for a pair, so one mark has to
  // carry the row. Under an "OpenCode" group heading that mark repeated the
  // heading and said nothing — the maker is the half the row didn't have.
  it("lets the maker lead a multi-house delegate", () => {
    const kimi = drawn("kimi-k2", "opencode", 15);
    expect(kimi).toContain("kimi-logo-light.svg");
    expect(kimi).not.toContain(OPENCODE_MARK);

    expect(drawn("anthropic/claude-opus-5", "opencode", 15)).not.toContain(OPENCODE_MARK);
  });

  it("keeps the CLI when a multi-house delegate pinned no model", () => {
    expect(drawn("default", "opencode", 15)).toContain(OPENCODE_MARK);
  });

  // Claude Code names Anthropic by naming itself, so the CLI stays: swapping it
  // for the maker would lose a fact and gain none.
  it("keeps the CLI for a one-house delegate", () => {
    expect(drawn("claude-opus-5", "claude-code", 15)).toContain("claude-code-logo.png");
  });

  // The maker leading is a rule about the single slot, not a demotion of the
  // runner: wherever both fit, both are drawn.
  it("still pairs both at a size that fits them", () => {
    const pair = drawn("kimi-k2", "opencode", 24);
    expect(pair).toContain(OPENCODE_MARK);
    expect(pair).toContain("kimi-logo-light.svg");
  });
});
