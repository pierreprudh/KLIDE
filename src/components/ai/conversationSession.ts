import type { ProviderId } from "../../agent/types";
import { isDelegateProvider } from "../../agent/providers";
import type { Conversation, Msg } from "./types";
import {
  deriveTitle,
  genId,
  latestRestorableConversationId,
  loadConversations,
  loadPanelSession,
  messagesForPersist,
} from "./utils";

export type ConversationRunActivity = "thinking" | "waiting" | null;

/**
 * The complete live state of one AI-panel Conversation. Keeping these fields
 * together makes identity changes atomic: a resume or branch cannot adopt new
 * messages while accidentally retaining the previous Conversation's lineage
 * or Git metadata.
 */
export type ConversationSession = {
  conversationId: string;
  messages: Msg[];
  provider: ProviderId;
  model: string;
  workspaceRoot: string | null;
  branch: string | null;
  worktree: string | null;
  forkedFrom: Conversation["forkedFrom"];
  run: {
    active: boolean;
    activity: ConversationRunActivity;
  };
};

export type RestoreConversationSessionInput = {
  panelId?: string;
  initialConversationId?: string | null;
  provider: ProviderId;
  model: string;
  workspaceRoot: string | null;
  createId?: () => string;
};

export type ConversationSessionAction =
  | { type: "messages-replaced"; messages: Msg[] }
  | {
      type: "configured";
      provider?: ProviderId;
      model?: string;
      workspaceRoot?: string | null;
    }
  | { type: "fresh-started"; conversationId: string }
  | { type: "resumed"; conversation: Conversation }
  | {
      type: "branched";
      conversationId: string;
      messageIndex: number;
      mode: "chat" | "worktree";
      createdAt: number;
    }
  | { type: "run-started"; activity?: ConversationRunActivity }
  | { type: "run-settled" };

function workspaceMatches(conversation: Conversation, workspaceRoot: string | null): boolean {
  return !workspaceRoot || !conversation.cwd || conversation.cwd === workspaceRoot;
}

/**
 * Restore one Conversation session in precedence order: an explicit reattach,
 * the panel's durable binding, the primary panel's latest Conversation, then a
 * fresh identity. The entire saved Conversation is adopted in one read.
 */
export function restoreConversationSession({
  panelId,
  initialConversationId,
  provider,
  model,
  workspaceRoot,
  createId = genId,
}: RestoreConversationSessionInput): ConversationSession {
  const conversations = loadConversations<Conversation>();
  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const explicitId = initialConversationId || null;
  const panelBinding = panelId ? loadPanelSession(panelId) : null;
  const boundConversation = panelBinding ? byId.get(panelBinding.convoId) : undefined;
  const panelWorkspaceMatches =
    !panelBinding ||
    panelBinding.workspaceRoot === undefined ||
    panelBinding.workspaceRoot === workspaceRoot;
  const boundProvider = panelBinding?.provider ?? provider;
  const bindingIsScoped =
    panelBinding?.workspaceRoot !== undefined && panelBinding.provider !== undefined;
  const canUsePanelBinding =
    !!panelBinding &&
    panelWorkspaceMatches &&
    (bindingIsScoped ||
      isDelegateProvider(boundProvider) ||
      (!!boundConversation && workspaceMatches(boundConversation, workspaceRoot)));
  const latestId =
    !explicitId &&
    !canUsePanelBinding &&
    !isDelegateProvider(provider) &&
    (!panelId || panelId === "ai-main")
      ? latestRestorableConversationId(workspaceRoot, provider)
      : null;
  const conversationId =
    explicitId ??
    (canUsePanelBinding ? panelBinding?.convoId ?? null : null) ??
    latestId ??
    createId();
  const saved = byId.get(conversationId);

  return {
    conversationId,
    messages: saved?.msgs ?? [],
    provider: saved?.provider ?? (canUsePanelBinding ? boundProvider : provider),
    model: saved?.model || model,
    workspaceRoot,
    branch: saved?.branch ?? null,
    worktree: saved?.worktree ?? null,
    forkedFrom: saved?.forkedFrom ?? null,
    run: { active: false, activity: null },
  };
}

export function conversationSessionReducer(
  session: ConversationSession,
  action: ConversationSessionAction,
): ConversationSession {
  switch (action.type) {
    case "messages-replaced":
      return { ...session, messages: action.messages };
    case "configured":
      return {
        ...session,
        provider: action.provider ?? session.provider,
        model: action.model ?? session.model,
        workspaceRoot:
          action.workspaceRoot === undefined ? session.workspaceRoot : action.workspaceRoot,
      };
    case "fresh-started":
      return {
        ...session,
        conversationId: action.conversationId,
        messages: [],
        branch: null,
        worktree: null,
        forkedFrom: null,
        run: { active: false, activity: null },
      };
    case "resumed": {
      const conversation = action.conversation;
      return {
        ...session,
        conversationId: conversation.id,
        messages: conversation.msgs,
        provider: conversation.provider ?? session.provider,
        model: conversation.model || session.model,
        branch: conversation.branch ?? null,
        worktree: conversation.worktree ?? null,
        forkedFrom: conversation.forkedFrom ?? null,
        run: { active: false, activity: null },
      };
    }
    case "branched":
      return {
        ...session,
        conversationId: action.conversationId,
        messages: session.messages.slice(0, action.messageIndex + 1),
        forkedFrom: {
          conversationId: session.conversationId,
          title: deriveTitle(session.messages),
          messageIndex: action.messageIndex,
          createdAt: action.createdAt,
          mode: action.mode,
        },
        run: { active: false, activity: null },
      };
    case "run-started":
      return {
        ...session,
        run: { active: true, activity: action.activity ?? null },
      };
    case "run-settled":
      return { ...session, run: { active: false, activity: null } };
  }
}

/** Build the durable Conversation snapshot. Empty sessions are intentionally
 * not persisted; a trailing empty assistant placeholder is removed. */
export function snapshotConversationSession(
  session: ConversationSession,
  updatedAt = Date.now(),
): Conversation | null {
  const messages = messagesForPersist(session.messages);
  if (messages.length === 0) return null;
  return {
    id: session.conversationId,
    title: deriveTitle(messages),
    msgs: messages,
    updatedAt,
    provider: session.provider,
    model: session.model,
    cwd: session.workspaceRoot,
    branch: session.branch,
    worktree: session.worktree,
    forkedFrom: session.forkedFrom ?? null,
  };
}
