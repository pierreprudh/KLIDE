import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../../testStorage";
import type { Conversation, Msg } from "./types";
import {
  healStoredConversationModels,
  healStoredConversationOrigins,
  healStoredConversationsFromTranscripts,
  healedConversationFromRunOrigin,
  healedConversationOrigin,
  originDelegateOf,
} from "./conversationOriginHeal";
import { loadConversations, saveConversations } from "./storedConversations";

const ask: Msg = { role: "user", content: "Refactor the loop" };
function answer(delegateProvider?: string): Msg {
  return { role: "assistant", content: "Done", delegateProvider };
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "thread",
    title: "Refactor the loop",
    msgs: [ask, answer()],
    updatedAt: 10,
    provider: "openrouter",
    model: "deepseek/deepseek-v4",
    cwd: "/workspace",
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("window", new EventTarget());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("originDelegateOf", () => {
  it("reads the delegate off the first assistant turn", () => {
    expect(originDelegateOf([ask, answer("Claude Code")])).toBe("claude-code");
    expect(originDelegateOf([ask, answer("Oh My Pi")])).toBe("omp");
  });

  it("is null when the first turn came from no delegate", () => {
    expect(originDelegateOf([ask, answer()])).toBeNull();
    expect(originDelegateOf([])).toBeNull();
  });

  it("is null for a CLI name this build cannot resolve", () => {
    expect(originDelegateOf([ask, answer("Some Retired CLI")])).toBeNull();
  });
});

describe("healedConversationOrigin", () => {
  it("restores the delegate a relabelled thread began on, and drops the foreign model", () => {
    const healed = healedConversationOrigin(
      conversation({ msgs: [ask, answer("Claude Code")] }),
    );
    expect(healed?.provider).toBe("claude-code");
    // OpenRouter's model belonged to no turn in this thread.
    expect(healed?.model).toBeNull();
  });

  it("leaves a correct record alone", () => {
    expect(
      healedConversationOrigin(
        conversation({ provider: "claude-code", model: "default", msgs: [ask, answer("Claude Code")] }),
      ),
    ).toBeNull();
    expect(healedConversationOrigin(conversation())).toBeNull();
  });

  it("leaves a thread that only later moved to a CLI alone", () => {
    // First turn came from an API provider (no stamp), so the origin is
    // unrecoverable — guessing "Claude Code" from the second turn would trade
    // one wrong label for another.
    expect(
      healedConversationOrigin(
        conversation({ msgs: [ask, answer(), ask, answer("Claude Code")] }),
      ),
    ).toBeNull();
  });
});

describe("healStoredConversationModels", () => {
  it("drops a CLI thread's model when it plainly belongs to another Provider, and nothing else", () => {
    saveConversations([
      conversation({ id: "carried-in", provider: "claude-code", model: "deepseek/deepseek-v4.1-flash", updatedAt: 7 }),
      conversation({ id: "bare", provider: "claude-code", model: "opus", updatedAt: 6 }),
      conversation({ id: "opencode-ok", provider: "opencode", model: "anthropic/claude-sonnet-4-6", updatedAt: 5 }),
      conversation({ id: "router", provider: "openrouter", model: "deepseek/deepseek-v4.1-flash", updatedAt: 4 }),
    ]);
    expect(healStoredConversationModels()).toBe(1);
    const stored = loadConversations<Conversation>();
    expect(stored.find((c) => c.id === "carried-in")?.model).toBeNull();
    expect(stored.find((c) => c.id === "carried-in")?.updatedAt).toBe(7);
    expect(stored.find((c) => c.id === "bare")?.model).toBe("opus");
    expect(stored.find((c) => c.id === "opencode-ok")?.model).toBe("anthropic/claude-sonnet-4-6");
    expect(stored.find((c) => c.id === "router")?.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(healStoredConversationModels()).toBe(0);
  });
});

describe("healStoredConversationOrigins", () => {
  it("heals the index in place without touching activity time or correct rows", () => {
    saveConversations([
      conversation({ id: "mislabelled", msgs: [ask, answer("Claude Code")], updatedAt: 7 }),
      conversation({ id: "genuine-router", updatedAt: 5 }),
    ]);

    expect(healStoredConversationOrigins()).toBe(1);

    const stored = loadConversations<Conversation>();
    const healed = stored.find((c) => c.id === "mislabelled");
    expect(healed?.provider).toBe("claude-code");
    expect(healed?.updatedAt).toBe(7);
    expect(stored.find((c) => c.id === "genuine-router")?.provider).toBe("openrouter");
  });

  it("is idempotent — a second boot changes nothing", () => {
    saveConversations([conversation({ msgs: [ask, answer("Codex")] })]);
    expect(healStoredConversationOrigins()).toBe(1);
    expect(healStoredConversationOrigins()).toBe(0);
    expect(loadConversations<Conversation>()[0].provider).toBe("codex");
  });
});

describe("healedConversationFromRunOrigin", () => {
  const origin = (provider: string, model: string) => ({
    runId: "thread",
    provider,
    model,
  });

  it("returns the record to what its Run was dispatched with", () => {
    const healed = healedConversationFromRunOrigin(
      conversation({ provider: "openrouter", model: "sakana/fugu-ultra" }),
      origin("openrouter", "deepseek/deepseek-v4-flash"),
    );
    expect(healed?.provider).toBe("openrouter");
    expect(healed?.model).toBe("deepseek/deepseek-v4-flash");
  });

  it("corrects the Provider too, in either direction", () => {
    // An OpenRouter label over a Claude Code run…
    expect(
      healedConversationFromRunOrigin(
        conversation({ provider: "openrouter", model: "sakana/fugu-ultra" }),
        origin("claude-code", "default"),
      )?.provider,
    ).toBe("claude-code");
    // …and a delegate label over an OpenRouter run. The delegate heal cannot
    // touch this one; the transcript settles it.
    expect(
      healedConversationFromRunOrigin(
        conversation({ provider: "claude-code", model: "default" }),
        origin("openrouter", "deepseek/deepseek-v4-flash"),
      )?.provider,
    ).toBe("openrouter");
  });

  it("leaves a record that already agrees with its Run", () => {
    expect(
      healedConversationFromRunOrigin(
        conversation({ provider: "openrouter", model: "deepseek/deepseek-v4-flash" }),
        origin("openrouter", "deepseek/deepseek-v4-flash"),
      ),
    ).toBeNull();
  });

  it("treats a missing model as needing the Run's", () => {
    expect(
      healedConversationFromRunOrigin(
        conversation({ provider: "claude-code", model: null }),
        origin("claude-code", "default"),
      )?.model,
    ).toBe("default");
  });

  it("leaves a thread whose Transcript is gone exactly as it is", () => {
    expect(
      healedConversationFromRunOrigin(conversation(), undefined),
    ).toBeNull();
  });
});

describe("healStoredConversationsFromTranscripts", () => {
  it("heals the index and leaves updatedAt alone", async () => {
    saveConversations(
      [
        conversation({ id: "a", provider: "openrouter", model: "sakana/fugu-ultra", updatedAt: 5 }),
        conversation({ id: "b", provider: "ollama", model: "bge-m3:latest", updatedAt: 7 }),
      ],
      undefined,
      false,
    );
    const healed = await healStoredConversationsFromTranscripts(async () => [
      { runId: "a", provider: "openrouter", model: "deepseek/deepseek-v4-flash" },
      { runId: "b", provider: "ollama", model: "bge-m3:latest" },
    ]);
    expect(healed).toBe(1);
    const stored = loadConversations<Conversation>();
    const a = stored.find((c) => c.id === "a");
    expect(a?.model).toBe("deepseek/deepseek-v4-flash");
    // Repairing a label is not activity — Focus orders its rail by this.
    expect(a?.updatedAt).toBe(5);
    expect(stored.find((c) => c.id === "b")?.model).toBe("bge-m3:latest");
  });

  it("writes nothing when every label already agrees", async () => {
    saveConversations(
      [conversation({ id: "a", provider: "ollama", model: "qwen3.5:9b" })],
      undefined,
      false,
    );
    const healed = await healStoredConversationsFromTranscripts(async () => [
      { runId: "a", provider: "ollama", model: "qwen3.5:9b" },
    ]);
    expect(healed).toBe(0);
  });

  it("asks for nothing when there is no history", async () => {
    const fetchOrigins = vi.fn(async () => []);
    expect(await healStoredConversationsFromTranscripts(fetchOrigins)).toBe(0);
    expect(fetchOrigins).not.toHaveBeenCalled();
  });
});
