import type { ProviderId } from "../../agent/types";
import { isDelegateProvider } from "../../agent/providers";
import type { Conversation, Msg } from "./types";
import {
  deriveTitle,
  latestRestorableConversationId,
  loadConversations,
  loadPanelSession,
  messagesForPersist,
  savePanelSession,
  type PanelSession,
} from "./storedConversations";
import { genId } from "./utils";

export type ConversationRunActivity = "thinking" | "waiting" | null;

/**
 * The complete live state of one AI-panel Conversation. Keeping these fields
 * together makes identity changes atomic: a resume or branch cannot adopt new
 * messages while accidentally retaining the previous Conversation's lineage
 * or Git metadata. The durable panel↔Conversation binding is part of that
 * atomicity: apply transitions through `applyConversationSessionTransition`,
 * which writes the binding for every identity-carrying transition — a caller
 * cannot adopt a new identity and forget to persist it.
 */
export type ConversationSession = {
  conversationId: string;
  messages: Msg[];
  /** Where the *next* turn goes. The picker edits this; it is the panel's
   *  dispatch target, not a claim about the messages already on screen. */
  provider: ProviderId;
  model: string;
  /** Where the turns already on screen actually came from — stamped by the
   *  first Run of this identity and then frozen. This, not `provider`, is
   *  what the Stored conversation records, so moving the picker to another
   *  Provider cannot retroactively relabel a thread it never ran. Undefined
   *  until a Run stamps it (or a restore/resume carries one in). */
  originProvider?: ProviderId;
  originModel?: string | null;
  workspaceRoot: string | null;
  branch: string | null;
  worktree: string | null;
  /** The CLI session this thread continues, when it was carried in from one. */
  delegateSession: string | null;
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
  /** Branch currently checked out when a new Conversation identity is
   *  created. Restored Conversations keep their own recorded branch. */
  workspaceBranch?: string | null;
  /** A composer handoff that semantically starts a new Conversation must not
   *  inherit this panel's durable binding or latest saved Conversation. */
  startFresh?: boolean;
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
  | { type: "fresh-started"; conversationId: string; branch?: string | null }
  | { type: "branch-captured"; branch: string }
  | { type: "resumed"; conversation: Conversation }
  | {
      type: "branched";
      conversationId: string;
      messageIndex: number;
      mode: "chat" | "worktree";
      createdAt: number;
    }
  | {
      type: "run-started";
      activity?: ConversationRunActivity;
      /** The pair this Run actually dispatched with. Stamps the thread's
       *  origin on its first Run; later Runs never restamp it. */
      provider?: ProviderId;
      model?: string;
    }
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
  workspaceBranch = null,
  startFresh = false,
  createId = genId,
}: RestoreConversationSessionInput): ConversationSession {
  if (startFresh) {
    return {
      conversationId: createId(),
      messages: [],
      provider,
      model,
      workspaceRoot,
      branch: workspaceBranch,
      worktree: null,
      delegateSession: null,
      forkedFrom: null,
      run: { active: false, activity: null },
    };
  }

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

  // The binding records where this panel last dispatched THIS conversation, so
  // it outranks the stored record for the next turn — a mid-thread Provider
  // switch survives a remount. The stored record still owns the thread's
  // origin below.
  const bindingProvider =
    canUsePanelBinding && panelBinding?.convoId === conversationId
      ? panelBinding.provider
      : undefined;

  return {
    conversationId,
    messages: saved?.msgs ?? [],
    provider: bindingProvider ?? saved?.provider ?? provider,
    model: saved?.model || model,
    originProvider: saved?.provider,
    originModel: saved?.model ?? undefined,
    workspaceRoot,
    // A restored Conversation without branch metadata predates branch
    // capture. Treat that as unknown: assigning today's checked-out branch
    // would rewrite its history and make navigation look like branch creation.
    // A genuinely new identity still snapshots the live branch.
    branch: saved ? saved.branch ?? null : workspaceBranch,
    worktree: saved?.worktree ?? null,
    delegateSession: saved?.delegateSession ?? null,
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
        // A new identity has produced nothing yet — its first Run stamps it.
        originProvider: undefined,
        originModel: undefined,
        branch: action.branch ?? null,
        worktree: null,
        delegateSession: null,
        forkedFrom: null,
        run: { active: false, activity: null },
      };
    case "branch-captured":
      return { ...session, branch: action.branch };
    case "resumed": {
      const conversation = action.conversation;
      return {
        ...session,
        conversationId: conversation.id,
        messages: conversation.msgs,
        provider: conversation.provider ?? session.provider,
        model: conversation.model || session.model,
        originProvider: conversation.provider,
        originModel: conversation.model ?? undefined,
        branch: conversation.branch ?? null,
        worktree: conversation.worktree ?? null,
        delegateSession: conversation.delegateSession ?? null,
        forkedFrom: conversation.forkedFrom ?? null,
        run: { active: false, activity: null },
      };
    }
    case "branched":
      return {
        ...session,
        conversationId: action.conversationId,
        messages: session.messages.slice(0, action.messageIndex + 1),
        // A branch keeps part of the thread; the CLI's session holds all of
        // it, so continuing that session here would answer the wrong history.
        delegateSession: null,
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
        // First Run of this identity stamps what produced its turns; a later
        // Run on another Provider continues the thread without rewriting it.
        originProvider: session.originProvider ?? action.provider ?? session.provider,
        originModel:
          session.originProvider !== undefined
            ? session.originModel
            : action.model ?? session.model,
        run: { active: true, activity: action.activity ?? null },
      };
    case "run-settled":
      return { ...session, run: { active: false, activity: null } };
  }
}

/** The Conversation's recorded branch is historical truth. Older snapshots
 * without branch metadata remain unknown instead of borrowing today's branch. */
export function displayedConversationBranch(
  conversationBranch: string | null | undefined,
): string | null {
  return conversationBranch ?? null;
}

/** Injectable durable write, so tests can prove the binding lands without a
 *  real localStorage. Production uses `savePanelSession`. */
export type PanelBindingWrite = (panelId: string, binding: PanelSession) => void;

/** The durable panel↔Conversation binding this session state implies. */
export function sessionPanelBinding(session: ConversationSession): PanelSession {
  return {
    convoId: session.conversationId,
    provider: session.provider,
    workspaceRoot: session.workspaceRoot,
  };
}

/** The single place the durable panel binding is written. AiPanel's delegate
 *  panels call this directly (their binding must be durable the moment the
 *  provider/convo pair binds, not on a transition); everything else goes
 *  through `applyConversationSessionTransition` below. */
export function persistConversationSessionBinding(
  panelId: string,
  session: ConversationSession,
  write: PanelBindingWrite = savePanelSession,
): void {
  write(panelId, sessionPanelBinding(session));
}

/** Which transitions must land in the durable panel binding. Identity changes
 *  (fresh, resume, branch) and Provider changes rebind the panel; a Run start
 *  re-asserts the binding so a mid-run view switch reattaches to this
 *  Conversation even when it was restored without ever transitioning.
 *  Message streaming and Run settle change no binding field. */
function transitionRebindsPanel(action: ConversationSessionAction): boolean {
  switch (action.type) {
    case "fresh-started":
    case "resumed":
    case "branched":
    case "run-started":
      return true;
    case "configured":
      return action.provider !== undefined || action.workspaceRoot !== undefined;
    case "messages-replaced":
    case "branch-captured":
    case "run-settled":
      return false;
  }
}

/**
 * Apply one transition *and* its durable persist. The reducer above stays
 * pure (React mirrors state through it), but an identity transition is not
 * complete until the panel binding is durable — previously each call site had
 * to remember its own `savePanelSession`, and ~8 scattered writes kept that
 * promise by hand. Returns the next session; the binding write happens here.
 */
export function applyConversationSessionTransition(
  session: ConversationSession,
  action: ConversationSessionAction,
  panelId: string | null | undefined,
  write?: PanelBindingWrite,
): ConversationSession {
  const next = conversationSessionReducer(session, action);
  if (panelId && transitionRebindsPanel(action)) {
    persistConversationSessionBinding(panelId, next, write);
  }
  return next;
}

/** Build the durable Conversation snapshot. Empty sessions are intentionally
 * not persisted; a trailing empty assistant placeholder is removed. */
export function snapshotConversationSession(
  session: ConversationSession,
  updatedAt = Date.now(),
): Conversation | null {
  const messages = messagesForPersist(session.messages);
  if (messages.length === 0) return null;
  // The first stamped message is the thread's start. `upsertConversation`
  // keeps whatever the stored record already had, so this only ever sets it
  // on the first save.
  const firstStamped = messages.find((m) => typeof (m as { ts?: number }).ts === "number");
  return {
    id: session.conversationId,
    title: deriveTitle(messages),
    msgs: messages,
    updatedAt,
    createdAt: (firstStamped as { ts?: number } | undefined)?.ts ?? updatedAt,
    // The thread's own Provider/model, never the panel's current dispatch
    // target — history rows and Mission Control read this snapshot.
    provider: session.originProvider ?? session.provider,
    model: session.originModel ?? session.model,
    cwd: session.workspaceRoot,
    branch: session.branch,
    worktree: session.worktree,
    delegateSession: session.delegateSession ?? null,
    forkedFrom: session.forkedFrom ?? null,
  };
}
