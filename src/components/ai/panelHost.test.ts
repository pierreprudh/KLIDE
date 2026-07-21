import { describe, expect, it } from "vitest";
import {
  DEFAULT_AI_PANEL_ID,
  conversationSessionKey,
  initialHandoffFor,
  panelWorkspace,
  resumeConversationFor,
  type PendingAiPanel,
} from "./panelHost";

describe("conversationSessionKey", () => {
  it("keeps panel identity stable inside one Workspace", () => {
    expect(conversationSessionKey("ai-main", "/workspace")).toBe(
      conversationSessionKey("ai-main", "/workspace"),
    );
  });

  it("rotates panel identity when its effective Workspace changes", () => {
    expect(conversationSessionKey("ai-main", "/workspace-a")).not.toBe(
      conversationSessionKey("ai-main", "/workspace-b"),
    );
  });

  it("preserves a surface-specific key while still scoping it to the Workspace", () => {
    expect(conversationSessionKey("ai-racer", "/workspace", "focus-ai-racer")).toBe(
      "focus-ai-racer::/workspace",
    );
  });
});

const pendingFor = (panelId: string, extra?: Partial<PendingAiPanel>): PendingAiPanel => ({
  panelId,
  provider: "claude-code",
  resumeSessionId: null,
  initialTask: null,
  conversationId: null,
  ...extra,
});

describe("initialHandoffFor", () => {
  it("targets only the panel the pending handoff names", () => {
    const pending = pendingFor("ai-2", {
      resumeSessionId: "sess-1",
      initialTask: "fix the tests",
      conversationId: "convo-9",
    });

    const matched = initialHandoffFor("ai-2", "ollama", pending);
    expect(matched.matched).toBe(true);
    expect(matched.initialProvider).toBe("claude-code");
    expect(matched.initialResumeSessionId).toBe("sess-1");
    expect(matched.initialTask).toBe("fix the tests");
    expect(matched.initialConversationId).toBe("convo-9");

    // Another mounted panel in the same render must NOT adopt the handoff —
    // it keeps its own provider and receives no resume/task/conversation.
    const other = initialHandoffFor(DEFAULT_AI_PANEL_ID, "ollama", pending);
    expect(other.matched).toBe(false);
    expect(other.initialProvider).toBe("ollama");
    expect(other.initialResumeSessionId).toBeUndefined();
    expect(other.initialTask).toBeUndefined();
    expect(other.initialConversationId).toBeUndefined();
  });

  it("without a pending handoff every panel starts on its own provider", () => {
    const handoff = initialHandoffFor("ai-2", "mlx", null);
    expect(handoff.matched).toBe(false);
    expect(handoff.initialProvider).toBe("mlx");
  });

  it("normalizes the handoff's nullable fields to undefined props", () => {
    // A "Resume in CLI" handoff carries no conversation id (that's reattach
    // only) — the prop must be undefined, not null, so AiPanel's defaults win.
    const handoff = initialHandoffFor("ai-2", undefined, pendingFor("ai-2"));
    expect(handoff.matched).toBe(true);
    expect(handoff.initialConversationId).toBeUndefined();
    expect(handoff.initialResumeSessionId).toBeUndefined();
    expect(handoff.initialTask).toBeUndefined();
  });
});

describe("resumeConversationFor", () => {
  it("only the targeted panel adopts the resumed conversation", () => {
    const convo = { id: "run-1" };
    const target = { panelId: "ai-2", convo };
    expect(resumeConversationFor("ai-2", target)).toBe(convo);
    expect(resumeConversationFor(DEFAULT_AI_PANEL_ID, target)).toBeNull();
    expect(resumeConversationFor("ai-2", null)).toBeNull();
  });
});

describe("panelWorkspace", () => {
  it("a worktree-pinned panel runs in its own checkout and shows the worktree name", () => {
    const ws = panelWorkspace(
      { cwd: "/repo/.worktrees/fix-tests/" },
      "/repo",
      true
    );
    expect(ws.root).toBe("/repo/.worktrees/fix-tests/");
    expect(ws.worktreeName).toBe("fix-tests");
  });

  it("anchored/grid surfaces ignore the panel cwd and stay in the main workspace", () => {
    const ws = panelWorkspace({ cwd: "/repo/.worktrees/fix-tests" }, "/repo", false);
    expect(ws.root).toBe("/repo");
    expect(ws.worktreeName).toBeUndefined();
  });

  it("falls back to the global workspace when the panel has no cwd", () => {
    const ws = panelWorkspace(undefined, "/repo", true);
    expect(ws.root).toBe("/repo");
    expect(ws.worktreeName).toBeUndefined();
  });
});
