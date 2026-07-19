import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation, Msg } from "./types";
import { memoryStorage } from "../../testStorage";
import {
  conversationSessionReducer,
  restoreConversationSession,
  snapshotConversationSession,
  type ConversationSession,
} from "./conversationSession";

const userMessage: Msg = { role: "user", content: "Inspect the workspace" };

function session(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    conversationId: "conversation-a",
    messages: [userMessage, { role: "assistant", content: "Working" }],
    provider: "ollama",
    model: "qwen3",
    workspaceRoot: "/workspace",
    branch: "feature/a",
    worktree: "a",
    forkedFrom: null,
    run: { active: false, activity: null },
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("restoreConversationSession", () => {
  it("hydrates identity, messages, provider, model, lineage, and Git metadata atomically", () => {
    const saved: Conversation = {
      id: "saved-run",
      title: "Saved",
      msgs: [userMessage],
      updatedAt: 42,
      provider: "openai",
      model: "gpt-5.4",
      cwd: "/workspace",
      branch: "feature/saved",
      worktree: "saved-tree",
      forkedFrom: {
        conversationId: "parent",
        title: "Parent",
        messageIndex: 2,
        createdAt: 10,
        mode: "chat",
      },
    };
    localStorage.setItem("klide-conversations", JSON.stringify([saved]));
    localStorage.setItem(
      "klide.panelSession.ai-main",
      JSON.stringify({ convoId: saved.id, active: false }),
    );

    expect(
      restoreConversationSession({
        panelId: "ai-main",
        provider: "ollama",
        model: "qwen3",
        workspaceRoot: "/workspace",
      }),
    ).toEqual({
      conversationId: saved.id,
      messages: saved.msgs,
      provider: "openai",
      model: "gpt-5.4",
      workspaceRoot: "/workspace",
      branch: "feature/saved",
      worktree: "saved-tree",
      forkedFrom: saved.forkedFrom,
      run: { active: false, activity: null },
    });
  });

  it("does not carry a hosted panel binding into another Workspace", () => {
    localStorage.setItem(
      "klide-conversations",
      JSON.stringify([
        {
          id: "other-workspace",
          title: "Other",
          msgs: [userMessage],
          updatedAt: 10,
          provider: "openai",
          model: "gpt-5.4",
          cwd: "/other",
        },
      ]),
    );
    localStorage.setItem(
      "klide.panelSession.ai-main",
      JSON.stringify({ convoId: "other-workspace", active: false }),
    );

    const restored = restoreConversationSession({
      panelId: "ai-main",
      provider: "openai",
      model: "gpt-5.4",
      workspaceRoot: "/workspace",
      createId: () => "fresh",
    });

    expect(restored.conversationId).toBe("fresh");
    expect(restored.messages).toEqual([]);
  });

  it("restores a scoped empty hosted Conversation before its first Run", () => {
    localStorage.setItem(
      "klide.panelSession.ai-main",
      JSON.stringify({
        convoId: "empty-conversation",
        provider: "openai",
        workspaceRoot: "/workspace",
      }),
    );

    const restored = restoreConversationSession({
      panelId: "ai-main",
      provider: "openai",
      model: "gpt-5.4",
      workspaceRoot: "/workspace",
      createId: () => "fresh",
    });

    expect(restored.conversationId).toBe("empty-conversation");
    expect(restored.messages).toEqual([]);
  });

  it("keeps a Delegate panel binding even before it has renderable messages", () => {
    localStorage.setItem(
      "klide.panelSession.delegate-panel",
      JSON.stringify({ convoId: "live-delegate", active: true }),
    );

    const restored = restoreConversationSession({
      panelId: "delegate-panel",
      provider: "codex",
      model: "",
      workspaceRoot: "/workspace",
      createId: () => "fresh",
    });

    expect(restored.conversationId).toBe("live-delegate");
  });

  it("does not reconnect a Delegate binding recorded for another Workspace", () => {
    localStorage.setItem(
      "klide.panelSession.delegate-panel",
      JSON.stringify({
        convoId: "other-delegate",
        provider: "codex",
        workspaceRoot: "/other",
      }),
    );

    const restored = restoreConversationSession({
      panelId: "delegate-panel",
      provider: "codex",
      model: "",
      workspaceRoot: "/workspace",
      createId: () => "fresh",
    });

    expect(restored.conversationId).toBe("fresh");
  });
});

describe("conversationSessionReducer", () => {
  it("switches Provider and model without changing Conversation identity or messages", () => {
    const current = session({ run: { active: true, activity: "thinking" } });
    const next = conversationSessionReducer(current, {
      type: "configured",
      provider: "openai",
      model: "gpt-5.4",
    });

    expect(next).toEqual({
      ...current,
      provider: "openai",
      model: "gpt-5.4",
    });
  });

  it("starts fresh without leaking lineage, Git metadata, messages, or Run activity", () => {
    const next = conversationSessionReducer(
      session({
        forkedFrom: {
          conversationId: "parent",
          title: "Parent",
          messageIndex: 1,
          createdAt: 1,
          mode: "chat",
        },
        run: { active: true, activity: "thinking" },
      }),
      { type: "fresh-started", conversationId: "conversation-b" },
    );

    expect(next).toMatchObject({
      conversationId: "conversation-b",
      messages: [],
      branch: null,
      worktree: null,
      forkedFrom: null,
      run: { active: false, activity: null },
      provider: "ollama",
      model: "qwen3",
      workspaceRoot: "/workspace",
    });
  });

  it("branches identity, messages, and lineage in one transition", () => {
    const next = conversationSessionReducer(session(), {
      type: "branched",
      conversationId: "branch-b",
      messageIndex: 0,
      mode: "chat",
      createdAt: 99,
    });

    expect(next.conversationId).toBe("branch-b");
    expect(next.messages).toEqual([userMessage]);
    expect(next.forkedFrom).toEqual({
      conversationId: "conversation-a",
      title: "Inspect the workspace",
      messageIndex: 0,
      createdAt: 99,
      mode: "chat",
    });
  });

  it("owns the Run activity transition", () => {
    const running = conversationSessionReducer(session(), {
      type: "run-started",
      activity: "thinking",
    });
    const settled = conversationSessionReducer(running, { type: "run-settled" });

    expect(running.run).toEqual({ active: true, activity: "thinking" });
    expect(settled.run).toEqual({ active: false, activity: null });
  });
});

describe("snapshotConversationSession", () => {
  it("persists one coherent Conversation and removes a trailing empty assistant placeholder", () => {
    const snapshot = snapshotConversationSession(
      session({ messages: [userMessage, { role: "assistant", content: "" }] }),
      123,
    );

    expect(snapshot).toEqual({
      id: "conversation-a",
      title: "Inspect the workspace",
      msgs: [userMessage],
      updatedAt: 123,
      provider: "ollama",
      model: "qwen3",
      cwd: "/workspace",
      branch: "feature/a",
      worktree: "a",
      forkedFrom: null,
    });
  });
});
