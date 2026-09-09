import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import {
  listProviderModels,
  modelSupportsReflection as queryModelSupportsReflection,
  modelSupportsTools as queryModelSupportsTools,
  modelSupportsVision as queryModelSupportsVision,
  readLocalProviderStatus,
  readProviderContextWindow,
  readProviderKeyStatus,
  startLocalProvider,
} from "../ipc/aiProviders";
import { usePortalMenu } from "../hooks/usePortalMenu";
import { Kbd } from "./Kbd";
import { keysFor } from "../shortcuts";
import { errMessage, providerFailureMessage } from "../errors";
import { InlineDiffReview } from "./InlineDiffReview";
import { InlineCommandReview } from "./InlineCommandReview";
import { conversationToConvo, deleteKlideConvo, publishKlideConvo, settleKlideConvo } from "../klideConvos";
import {
  lensItemsForPrompt,
  type ProjectContextMode,
  type ProjectContextSnapshot,
} from "../contextTray";
import { acceptRunCheckpoints, readAgentRunEvents, startAgentRun, stopAgentRun, resolveDiff, resolveUserQuestion, resolvePermission, revertRunCheckpoints, getAgentRunStatus, isActiveRunStatus, reattachAgentRun, type RunReattachment } from "../agent/client";
import { parseSubagentDirective, resolveSubagent, buildSubagentSystemPrompt, matchSubagents, extractInlineSubagentCalls, type Subagent } from "../agent/subagents";
import { resolveAdvisor } from "../agent/advisor";
import { serviceAdvisorConsult } from "../agent/advisorConsult";
import { toolsForMode } from "../agent/tools";
import { readWorkspaceTextFile, workspacePathExists } from "../workspaceFs";
import { listWorkspaceFiles } from "./ai/workspaceFiles";
import { TodoStrip, type TodoStripSlot } from "./TodoStrip";
import { columnGeometry } from "./ai/canvasColumn";

/** The documents a completion produced, as the viewer's rail wants them. */
function documentSet(completion: RunCompletion): { path: string; bytes: number }[] {
  return (completion.artifacts ?? []).map((artifact) => ({ path: artifact.path, bytes: artifact.bytes }));
}
import { QuestionCard } from "./ai/QuestionCard";
import {
  CLI_DEFAULT_MODEL,
  defaultModelForProvider,
  isAutoProvider,
  isDelegateProvider,
  isManagedLocalProvider,
  normalizeAgentMode,
  providerGroupsWithCustom,
  providerName,
} from "../agent/providers";
import { isDelegateId } from "../delegates";
import {
  isCustomProvider,
  refreshCustomProviders,
} from "../customProviders";
import { useCustomProviders } from "../hooks/useCustomProviders";
import {
  refreshCustomCli,
  type CustomCli,
} from "../customCli";
import type {
  AgentAttachment as Attachment,
  AgentEvent,
  AgentMode,
  ProviderId,
  DiffProposal,
  PermissionRequest,
} from "../agent/types";
import { enabledSkillsPrompt, type Skill } from "../skills";

import { KlideMark, ProviderLogo, AssistantPlaceholderLoader, DotGridLoader } from "./ai/icons";
import { WorkingRow } from "./ai/WorkingRow";
import { AttachIcon, CloseIcon } from "../icons";
import { FileTypeIcon } from "./fileMarks";
import { DelegateTerminalSurface } from "./lazySurfaces";
import { PendingInboxRow, renderMessageBody, extractThinking, CompactionRow, ThinkingBlock, ToolRunRow } from "./ai/ChatMessage";
import { CompletionCard } from "./ai/CompletionCard";
import { hasCompletionReview, type RunCompletion } from "../agent/completion";
import { groupToolRuns, pairToolResults, toolRunIndex, toolRunLabel } from "./ai/toolRuns";
import type { AttachedResult } from "./ai/ChatMessage";
import { MessageActions } from "./ai/MessageActions";
import { ConversationHistory } from "./ai/ConversationHistory";
import { mayActivateModel } from "./ai/modelActivationPolicy";
import {
  hostModelAdoption,
  offlineModelFallback,
  providerSwitchModel,
  unavailableModelFallback,
} from "./ai/modelSelection";
import { modificationAcceptanceMode } from "./ai/panelHost";
import { ModelPicker, modelLabel } from "./ai/ModelPicker";
import { inboxSenders, latestCoordinationPeer, parseDeliveryReason, peerName, useCoordinationInbox, usePeerIndex } from "./ai/coordinationPeers";
import { PeerLink } from "./ai/PeerLink";
import { reviewEnvelope } from "../agent/coordination";
import { allFavModels, favModelsFor } from "../favModels";
import { conversationMark } from "../modelIdentity";
import { buildSystemPrompt } from "./ai/system-prompt";
import { ATTACH_ACCEPT, isPhotoAttachment, stageFiles, stagedImageBytes } from "./ai/attachments";
import { AttachmentTray } from "./ai/AttachmentTray";
import { summarizeAndHandoff, generateMemoryNote, detectAndGenerateSkill, summarizeForCompaction } from "./ai/summarize";
import { addMemoryDraft } from "../memoryDrafts";
import { writeMemory } from "../memory";
import { isSilentRunError, replayForAdoption, shouldHealFromTranscript } from "./ai/replayConversation";
import { createTurnDriver } from "./ai/turnDriver";
import { decideOnLeavingRun, shouldReadoptConversation, type RunLeaveDecision } from "./ai/leavingRun";
import { compactionMsg, extractAssistantText } from "../agent/foldEvents";
import { pendingGatesFromEvents } from "../agent/pendingGates";
import {
  applyConversationSessionTransition,
  conversationSessionReducer,
  displayedConversationBranch,
  persistConversationSessionBinding,
  restoreConversationSession,
  snapshotConversationSession,
  type ConversationSessionAction,
  type ConversationRunActivity,
} from "./ai/conversationSession";
import { buildRunHandoff, type HandoffSummary } from "../agentHandoff";
import {
  CONVERSATIONS_CHANGED_EVENT,
  CONVERSATION_DELETED_EVENT,
  forgetStoredConversation,
  type ConversationDeletedDetail,
  deriveTitle,
  loadConversations,
  persistConversation,
} from "./ai/storedConversations";
import {
  genId,
  estimateTokens,
  countMessageTokens,
  fuzzyFiles,
} from "./ai/utils";

import type { Msg, QueuedTurn, Conversation } from "./ai/types";
import { MODE_CHOICES, effectiveMode as effectiveModeFor, goalPolicyOf, nextGoalPolicy } from "./ai/autonomyLadder";
import {
  canCompactConversation,
  computeContextBudget,
  contextTone as contextToneFor,
  conversationCost,
  lastCompactionIndex,
  shouldAutoCompact,
  COMPACT_KEEP_RECENT,
  COMPACT_PROMPT_RATIO,
  conversationTokenEstimate,
} from "./ai/contextBudget";
import { Z } from "../zLayers";
import { notify } from "../toast";
import { delegateSessionId, stopDelegatePty, writeDelegatePty } from "../ipc/delegatePty";
import { initialsOf, useUserInfo } from "../hooks/useUserInfo";
import { SETTINGS, useSetting } from "../settingsStore";

function LocalServerStartingRow({ providerLabel, centered = false }: { providerLabel: string; centered?: boolean }) {
  const hairline = (
    <span
      aria-hidden="true"
      style={{
        height: 1,
        flex: "1 1 44px",
        minWidth: centered ? 42 : 28,
        maxWidth: centered ? 96 : 72,
        background: "color-mix(in srgb, var(--border) 82%, transparent)",
      }}
    />
  );
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        width: "100%",
        maxWidth: centered ? "min(520px, 86%)" : "min(520px, 100%)",
        color: "var(--fg-subtle)",
      }}
    >
      {hairline}
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0, flexShrink: 0 }}>
        <DotGridLoader size={11} label={`Starting ${providerLabel}`} />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--fg-strong)", fontWeight: 500, flexShrink: 0 }}>
          Starting {providerLabel}
        </span>
      </span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--fg-subtle)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        local server…
      </span>
      {hairline}
    </div>
  );
}

/**
 * Who asked — the other half of a discussion. It sits against the user's turn
 * the way a response mark sits against the model's, in the same 22px box, so
 * the thread reads as two participants talking rather than a stack of answers
 * with a single logo down one edge.
 *
 * The GitHub picture when there is one, initials when there isn't, and quiet
 * either way: this mark identifies a speaker, it never competes with the
 * message it belongs to.
 */
const AskerMark = memo(function AskerMark({
  username,
  avatarUrl,
}: {
  username: string;
  avatarUrl: string;
}) {
  return (
    <div
      aria-hidden="true"
      title={username || undefined}
      style={{
        position: "relative",
        flexShrink: 0,
        width: 22,
        height: 22,
        marginTop: 1,
        overflow: "hidden",
        borderRadius: "50%",
        display: "grid",
        placeItems: "center",
        background: "var(--bg-hover)",
        border: "1px solid var(--border)",
        color: "var(--fg-subtle)",
        fontFamily: "var(--font-ui)",
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: "0.01em",
        userSelect: "none",
      }}
    >
      {username ? initialsOf(username) : ""}
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt=""
          onError={(event) => { event.currentTarget.style.display = "none"; }}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", borderRadius: "inherit", objectFit: "cover" }}
        />
      ) : null}
    </div>
  );
});

function asksForWorkspaceInspection(text: string): boolean {
  const normalized = text.toLowerCase();
  const mentionsWorkspace =
    /\b(current|this|project|workspace|repo|repository|root)\b/.test(normalized) ||
    /\b(folder|folders|directory|directories|dir|files|tree)\b/.test(normalized) ||
    /(^|\s)\.(\s|$)/.test(normalized);
  const asksToInspect =
    /\b(what|which|show|list|ls|read|open|inspect|look|scan|contents?)\b/.test(normalized) ||
    /\b(folder|folders|directory|directories|files)\b/.test(normalized);
  return mentionsWorkspace && asksToInspect;
}

type AiHarnessSettings = {
  chatPrompt?: string;
  planPrompt?: string;
  goalPrompt?: string;
  toolOverrides?: Record<string, boolean>;
  contextWindows?: Record<string, number>;
  effortBudgets?: Record<string, number>;
  reflectionLevels?: Record<string, string>;
  maxParallelTools?: number;
  maxTurns?: number;
  commandTimeoutSecs?: number;
  testAfterEditCommand?: string;
  serverConcurrency?: number;
  autoMemoryOnRunDone?: boolean;
  advisorProvider?: string;
  advisorModel?: string;
};


type ReflectionOption = {
  value: string | undefined;
  label: string;
  level: number;
  desc: string;
};

type Props = {
  workspaceRoot: string | null;
  /** Set when this panel is pinned to a git worktree (its runs work an
   *  isolated branch, not the main checkout). Shown under the composer so the
   *  user can tell which panel writes where. Undefined → main workspace. */
  worktreeName?: string;
  /** Current branch of the open Workspace. Hidden for worktree-pinned panels,
   *  whose more specific location label takes precedence. */
  workspaceBranch?: string | null;
  onFileWritten?: (path: string, newContent: string) => void;
  onWorkspaceChanged?: () => void;
  /** Open this run's file changes in the workbench's docked Artifact
   *  Inspector (same review surface as Mission Control). Wired only on
   *  surfaces that dock one; without it the "N files changed" row is
   *  plain text. */
  onReviewChanges?: (info: { runId: string; title: string; path?: string }) => void;
  /** Open a document a run produced — the inspector for text, the machine's
   *  own app for a deck or a PDF. The host owns that choice. */
  /** Open one produced document. The whole set travels with it: the viewer
   *  puts the run's documents in a rail, so it needs the siblings of the row
   *  that was clicked, not only the row. */
  onOpenArtifact?: (info: { runId: string; path: string; documents: { path: string; bytes: number }[] }) => void;
  /** A picture of a produced document, when the host can make one. */
  onPreviewArtifact?: (path: string) => Promise<string | null>;
  visible: boolean;
  width: number;
  fill?: boolean;
  /**
   * Stable identity for this panel (provider/model prefs are keyed by it).
   * When the workbench view is unmounted (user switches to Settings /
   * Mission Control) the AiPanel unmounts with it. On remount Conversation
   * Session restores the Conversation this panel was showing from the durable
   * panel binding. The explicit new-chat action rotates that identity.
   */
  panelId?: string;
  model: string;
  onModelChange: (model: string) => void;
  availableModels: string[];
  onAvailableModelsChange: (models: string[]) => void;
  apiKeyVersion?: number;
  requireDiffReview: boolean;
  onRequireDiffReviewChange?: (enabled: boolean) => void;
  /** The full-auto rung's command half: shell commands run without a
   *  permission prompt. Per-conversation and never persisted. */
  autoApproveCommands?: boolean;
  onAutoApproveCommandsChange?: (enabled: boolean) => void;
  /** Open a proposed/applied edit as a full side-by-side diff in the editor. */
  onOpenDiff?: (edit: { path: string; oldContent: string; newContent: string; isCreate: boolean }) => void;
  stopAfterRejection: boolean;
  skills: Skill[];
  projectContext?: ProjectContextSnapshot | null;
  harnessSettings?: AiHarnessSettings;
  onDuplicate?: (snapshot: { provider: ProviderId; model: string }) => void;
  onForkConversationInWorktree?: (conversation: Conversation, baseRoot: string | null) => void;
  /** Open (or raise) another conversation this thread is talking to — the
   *  peer link's card offers the peer thread as a link. Same landing as a
   *  click in the rail's conversation tree. */
  onOpenPeerConversation?: (conversationId: string) => void;
  /** The host's Provider for this panel. Live, like `model` — surfaces outside
   *  the panel (the Focus hero) edit the pair, and the two must move together
   *  or a run goes out with a model the Provider doesn't serve. Absent means
   *  "the panel's own session owns it". */
  provider?: ProviderId;
  onProviderChange?: (provider: ProviderId) => void;
  /** Open Settings on one section. The provider menu's keyless rows use it to
   *  send you to "api" (API keys) instead of offering a provider that can't
   *  run. */
  onOpenSettingsSection?: (section: string) => void;
  onClose?: () => void;
  resumeConversation?: Conversation | null;
  onResumeConsumed?: () => void;
  /** When set on first mount, the panel starts pinned to this delegate
   *  provider (claude-code / codex / opencode). Used by Mission Control's
   *  "Resume in {CLI}" / "Open in {CLI}" handoffs to land the user in a
   *  TUI surface that's the natural home for an agent session. */
  initialProvider?: ProviderId;
  /** Bind this panel to an existing conversation id instead of minting a fresh
   *  one. Used by Mission Control's "Reattach" on a *live* delegate session: it
   *  makes `DelegateTerminalSurface`'s `sessionId` (`{convoId}:{provider}`)
   *  match the still-running PTY, so `delegate_pty_spawn` no-ops and the
   *  scrollback replays — a true reconnect, not a fresh `--resume`. */
  initialConversationId?: string | null;
  /** Pass-through to DelegateTerminalSurface so the TUI continues the
   *  named session instead of starting a fresh one. */
  initialResumeSessionId?: string | null;
  /** First prompt pre-baked into the TUI's spawn — used for Klide handoff. */
  initialTask?: string | null;
  /** Open on a new Conversation identity instead of restoring what this panel
   *  last held. Set by a handoff, which names a Provider and no conversation:
   *  on a panel a one-slot surface is reusing, the durable binding would
   *  otherwise outrank the handoff and the CLI session would never appear. */
  initialStartFresh?: boolean;
  /** A message to send through the normal composer path as soon as the panel
   *  is ready — the Focus home's hero composer hands its text over with this.
   *  Starts a fresh conversation first if the restored session already has
   *  messages (the hero composer always means "new chat"). */
  initialMessage?: string | null;
  /** Photos/documents staged beside that first message on the Focus start
   *  stage. They ride the same handoff so the opening turn carries what was
   *  dropped there — the panel doesn't re-read them from anywhere. */
  initialAttachments?: Attachment[] | null;
  onInitialMessageConsumed?: () => void;
  /** A message to send into the CURRENT conversation as a follow-up turn —
   *  the race "ask both" composer fans one text out to every racer's panel
   *  with this. Unlike `initialMessage` it never starts a new chat, and the
   *  turn queues behind an externally-started run that's still streaming.
   *  `nonce` distinguishes repeat sends of the same text. */
  followUpMessage?: { text: string; nonce: number } | null;
  onFollowUpConsumed?: () => void;
  /** Set only while this panel belongs to a watched race with 2+ racers:
   *  hovering the send button reveals a "Send to both" action that fans the
   *  composed text out to every racer (the host routes it back through
   *  `followUpMessage`, including to this panel). */
  onSendToRace?: (text: string) => void;
  /** "focus" restyles the same surface for the fullscreen Focus screen: the
   *  transcript and composer sit in a centered ~760px reading column with
   *  roomier padding. Logic is identical — this is a design variant only. */
  variant?: "panel" | "focus";
  /** Called once after the panel has consumed the initial* props (typically
   *  the App-level spawn queue entry). */
  onInitialConsumed?: () => void;
  /** Called when a memory entry is written from this panel (via the
   *  "Summarize" header action). The host uses it to bump the sidebar's
   *  refresh key + show a notice. */
  onMemoryWritten?: (entry: { relPath: string; title: string }) => void;
  /** Open the Memory modal (to its drafts) — used by the "review draft"
   *  pencil under the last reply once an auto-draft is ready. */
  onOpenMemory?: () => void;
  /** Called when a skill is generated from this panel (via the
   *  "Save as skill" header action). The host uses it to reload the
   *  filesystem-skill list. */
  onSkillGenerated?: (skill: { relPath: string; name: string }) => void;
};

const menuActionIconStyle: CSSProperties = {
  width: 18,
  display: "grid",
  placeItems: "center",
  flexShrink: 0,
};

function menuActionStyle(disabled: boolean): CSSProperties {
  return {
    width: "100%",
    height: 30,
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "0 8px",
    border: "none",
    borderRadius: "var(--radius-sm)",
    background: "transparent",
    color: disabled ? "var(--fg-dim)" : "var(--fg-strong)",
    font: "inherit",
    fontSize: 12,
    textAlign: "left",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.58 : 1,
  };
}

function formatContextTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return tokens.toLocaleString();
}

const REFLECTION_BAR_HEIGHTS = [4, 7, 10, 13];
const XHIGH_BAR_INDEX = REFLECTION_BAR_HEIGHTS.length - 1;

function ReflectionBars({ level, size = "compact" }: { level: number; size?: "compact" | "menu" }) {
  const isAuto = level === 0;
  const isXhigh = level > REFLECTION_BAR_HEIGHTS.length;
  const activeCount = isAuto ? 0 : Math.min(level, REFLECTION_BAR_HEIGHTS.length);
  const barWidth = 2;
  const gap = 2;
  return (
    <span
      aria-hidden="true"
      style={{
        height: size === "menu" ? 15 : 14,
        display: "inline-flex",
        alignItems: "end",
        gap,
        flexShrink: 0,
      }}
    >
      {REFLECTION_BAR_HEIGHTS.map((height, idx) => {
        const active = isAuto || idx < activeCount;
        const isTip = isXhigh && idx === XHIGH_BAR_INDEX;
        return (
          <span
            key={idx}
            style={{
              width: barWidth,
              height,
              borderRadius: 1,
              background: isTip
                ? "var(--accent)"
                : active
                  ? "var(--fg)"
                  : "var(--border-strong)",
              opacity: isAuto ? 0.35 : active ? 0.88 : 0.32,
            }}
          />
        );
      })}
    </span>
  );
}

function normalizeReflectionLevel(level: string | undefined | null): string | undefined {
  switch (level) {
    case "off":
    case "minimal":
      return "minimal";
    case "low":
    case "medium":
    case "high":
      return level;
    case "max":
    case "xhigh":
      return "xhigh";
    default:
      return undefined;
  }
}

/** `klide.model.<provider>` when it holds a value this Provider can actually
 *  use — the guards in `storedModelForProvider` reject another Provider's id
 *  that leaked in, and a rejected value is no evidence of a pick. */
function rememberedModelForProvider(id: ProviderId): string | null {
  const raw = localStorage.getItem(`klide.model.${id}`);
  if (!raw) return null;
  return storedModelForProvider(id) === raw ? raw : null;
}

// The model a provider SWITCH lands on — see `providerSwitchModel` for why the
// remembered pick outranks the stars. Continuing an existing conversation still
// restores that conversation's own model; this only seeds fresh provider picks.
// If the seed turns out not to be served, the models-load effect corrects it
// through `unavailableModelFallback`.
function switchModelForProvider(id: ProviderId): string {
  return providerSwitchModel({
    remembered: rememberedModelForProvider(id),
    favourites: favModelsFor(id),
    providerDefault: defaultModelForProvider(id),
  });
}

// One-time migration, v2 (2026-07): delegate CLIs used to force a --model on
// every spawn, and Klide itself auto-wrote models into storage (the old
// "clobber to list head" effect picked dated ids like
// "claude-sonnet-4-6-20251114" without the user ever touching the picker —
// which is why v1's exact-match against the seed missed). No stored delegate
// model predating the sentinel can be trusted as a deliberate pick, so reset
// them ALL to "default" once. A model picked after this sticks: the flag
// never lets this run again.
(() => {
  const FLAG = "klide.model.delegate-default-migrated-v2";
  if (localStorage.getItem(FLAG)) return;
  const delegates = ["claude-code", "codex", "opencode", "omp"];
  for (const id of delegates) {
    if (localStorage.getItem(`klide.model.${id}`)) {
      localStorage.setItem(`klide.model.${id}`, CLI_DEFAULT_MODEL);
    }
  }
  // Panels persist their own provider+model in the layout store — reset
  // those too, or a saved Claude Code panel would keep its seeded model.
  try {
    const raw = localStorage.getItem("klide-panel-layouts");
    if (raw) {
      const layouts = JSON.parse(raw) as Record<string, { ai?: { provider?: string; model?: string }[] }>;
      for (const layout of Object.values(layouts)) {
        for (const panel of layout?.ai ?? []) {
          if (panel.provider && delegates.includes(panel.provider) && panel.model) {
            panel.model = CLI_DEFAULT_MODEL;
          }
        }
      }
      localStorage.setItem("klide-panel-layouts", JSON.stringify(layouts));
    }
  } catch {
    // Malformed store — the layout loader tolerates it; so do we.
  }
  localStorage.setItem(FLAG, "1");
})();

function storedModelForProvider(id: ProviderId): string {
  const stored = localStorage.getItem(`klide.model.${id}`);
  if (id === "mlx" && stored) {
    // MLX expects Hugging Face-style ids or local paths. Ignore stale
    // Ollama-style tags such as `gemma4:12b-mlx` from earlier shared-model UI.
    const looksLikeMlx = stored.includes("/") || stored.startsWith(".");
    if (!looksLikeMlx || stored.includes(":")) return defaultModelForProvider(id);
  }
  if ((id === "claude-code" || id === "codex") && stored) {
    // These CLIs take bare model names ("opus", "gpt-5.3-codex") — a stored
    // value with a repo prefix or tag (`pierreprudh/lfm2.5-8b-a1b:latest`) is
    // another provider's model that leaked in via a stale-persist bug; never
    // hand it to the CLI. (OpenCode/omp legitimately use provider/model ids,
    // so they are exempt.)
    if (stored.includes("/") || stored.includes(":")) return defaultModelForProvider(id);
  }
  return stored || defaultModelForProvider(id);
}

type ModelInspection = {
  supportsTools: boolean;
  supportsReflection: boolean;
  supportsVision: boolean;
  contextLimit: number;
};

/**
 * Model metadata is intentionally inspected as one unit. Ollama's reflection
 * fallback is not just metadata: it can issue a tiny probe chat, which loads a
 * cold model. Keeping the calls behind this function lets a resumed transcript
 * remain a passive reader until send() explicitly activates it.
 */
async function inspectModelForRun(
  provider: ProviderId,
  model: string,
  allowActivationProbe = true,
): Promise<ModelInspection> {
  const [tools, reflection, vision, context] = await Promise.allSettled([
    queryModelSupportsTools(provider, model),
    allowActivationProbe ? queryModelSupportsReflection(provider, model) : Promise.resolve(false),
    queryModelSupportsVision(provider, model),
    readProviderContextWindow(provider, model),
  ]);
  return {
    supportsTools:
      tools.status === "fulfilled" ? tools.value : !isManagedLocalProvider(provider),
    supportsReflection: reflection.status === "fulfilled" ? reflection.value : false,
    supportsVision: vision.status === "fulfilled" ? vision.value : false,
    contextLimit:
      context.status === "fulfilled" && Number.isFinite(context.value) && context.value > 0
        ? context.value
        : 128_000,
  };
}

export function AiPanel({
  workspaceRoot,
  worktreeName,
  workspaceBranch,
  onFileWritten,
  onWorkspaceChanged,
  onReviewChanges,
  onOpenArtifact,
  onPreviewArtifact,
  visible,
  width,
  fill,
  panelId,
  model: hostModel,
  onModelChange,
  availableModels,
  onAvailableModelsChange,
  apiKeyVersion = 0,
  requireDiffReview,
  onRequireDiffReviewChange,
  autoApproveCommands = false,
  onAutoApproveCommandsChange,
  onOpenDiff,
  stopAfterRejection,
  skills,
  projectContext,
  harnessSettings,
  onDuplicate,
  onForkConversationInWorktree,
  onOpenPeerConversation,
  provider: hostProvider,
  onProviderChange,
  onOpenSettingsSection,
  onClose,
  resumeConversation,
  onResumeConsumed,
  initialProvider,
  initialConversationId,
  initialResumeSessionId,
  initialTask,
  initialStartFresh,
  onInitialConsumed,
  initialMessage,
  initialAttachments,
  onInitialMessageConsumed,
  followUpMessage,
  onFollowUpConsumed,
  onSendToRace,
  variant = "panel",
  onMemoryWritten,
  onOpenMemory,
  onSkillGenerated,
}: Props) {
  const requestedProviderRef = useRef<ProviderId>(
    initialProvider ??
      (panelId
        ? (localStorage.getItem(`klide.provider.${panelId}`) as ProviderId | null)
        : null) ??
      (localStorage.getItem("klide.provider") as ProviderId | null) ??
      "ollama",
  );
  const [conversationSession, dispatchConversationSession] = useReducer(
    conversationSessionReducer,
    undefined,
    () =>
      restoreConversationSession({
        panelId,
        initialConversationId,
        provider: requestedProviderRef.current,
        model: hostModel,
        workspaceRoot,
        workspaceBranch,
        // The Focus hero is a new-task surface. Its first message must start
        // from the Provider/model displayed in that composer, never from this
        // panel's previous durable binding (which may belong to OpenRouter).
        // A handoff says the same thing for the same reason.
        startFresh: !!initialMessage?.trim() || !!initialStartFresh,
      }),
  );
  // Async Run callbacks need the latest identity even before React commits the
  // reducer update. This ref and the message ref are advanced synchronously by
  // the one transition function below.
  const conversationSessionRef = useRef(conversationSession);
  const msgsRef = useRef<Msg[]>(conversationSession.messages);
  function transitionConversation(action: ConversationSessionAction) {
    // The apply carries the durable panel-binding write for identity-changing
    // transitions; the pure reducer below only mirrors the same action into
    // React state. Never persist the binding by hand next to a call site.
    const next = applyConversationSessionTransition(
      conversationSessionRef.current,
      action,
      panelId,
    );
    conversationSessionRef.current = next;
    msgsRef.current = next.messages;
    dispatchConversationSession(action);
    return next;
  }
  function setMsgs(messages: Msg[]) {
    transitionConversation({ type: "messages-replaced", messages });
  }
  function startConversationRun(
    activity: ConversationRunActivity = null,
    dispatched?: { provider: ProviderId; model: string },
  ) {
    transitionConversation({
      type: "run-started",
      activity,
      provider: dispatched?.provider,
      model: dispatched?.model,
    });
  }
  function settleConversationRun() {
    transitionConversation({ type: "run-settled" });
  }
  const currentId = conversationSession.conversationId;
  const msgs = conversationSession.messages;
  const provider = conversationSession.provider;
  const model = conversationSession.model;
  const currentForkedFrom = conversationSession.forkedFrom;
  // The mark for a response whose own turn carries no stamp — everything
  // stored before the fold started recording one. The thread's origin is the
  // best available answer there, and it is a better one than the picker's
  // current pair: relabelling every old turn each time the model changes is
  // precisely what this stopped doing.
  // Who asked, drawn once so it can sit against every user turn: a thread with
  // a mark on one side only reads as a log of answers, and this is a
  // discussion — two participants, each turn attributed to the one who made it.
  const { username, avatarUrl } = useUserInfo();
  // …unless you'd rather not look at yourself. Off, the mark and its gutter
  // both go: the bubbles keep the right edge to themselves.
  const [showAskerAvatar] = useSetting(SETTINGS.showAskerAvatar);
  /** The mark for one response: what produced THAT turn. A thread continued on
   *  another model shows both, each against the turn it actually ran.
   *
   *  Each half falls back on its own. The rule used to be all-or-nothing —
   *  a turn missing *both* halves borrowed the thread's, a turn missing one
   *  got a null in its place — so a turn stamped with a runner and no model
   *  drew the runner alone while the turn under it drew the pair. Same
   *  conversation, same agent, two different marks; nothing about the run had
   *  changed, only what that turn happened to record. Replayed CLI transcripts
   *  are the common case: they know which delegate produced them and never a
   *  per-turn model.
   *
   *  The thread's origin is the right filler, and a better one than the
   *  picker's current pair: relabelling every old turn each time the model
   *  changes is precisely what stamping stopped doing. */
  function responseMark(stamp: { provider?: ProviderId; model?: string }) {
    return conversationMark(
      stamp.model ?? conversationSession.originModel ?? model,
      stamp.provider ?? conversationSession.originProvider ?? provider,
      22,
    );
  }
  const conversationGitMeta = useMemo(
    () => ({
      branch: conversationSession.branch,
      worktree: conversationSession.worktree,
    }),
    [conversationSession.branch, conversationSession.worktree],
  );
  const displayedBranch = displayedConversationBranch(conversationGitMeta.branch);
  /** Index of the last message that is part of the exchange — queued turns are
   *  parked below it and don't move the tail. */
  const lastExchangeIndex = useMemo(() => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === "user" && m.queueState === "queued") continue;
      return i;
    }
    return -1;
  }, [msgs]);
  const streaming = conversationSession.run.active;
  const activity = conversationSession.run.activity;
  void activity;
  function changeModel(nextModel: string) {
    transitionConversation({ type: "configured", model: nextModel });
    onModelChange(nextModel);
  }
  /** The model the Provider substituted for a pick it no longer serves. Read
   *  and cleared by the persist effect, so a substitution is never written
   *  back as this Provider's remembered model. */
  const autoPickedModelRef = useRef<string | null>(null);
  /** Move off a model the Provider retired. Same transition as a human pick —
   *  the session and the host both have to follow — but not remembered as one. */
  function retireModel(nextModel: string) {
    autoPickedModelRef.current = nextModel;
    changeModel(nextModel);
  }
  // A restored Conversation owns its Provider/model pair. Notify the host on
  // first mount instead of letting the host's stale panel preferences overwrite
  // that pair; subsequent host model *changes* are ordinary configuration edits.
  // Only changes: `onModelChange` is a fresh closure on every App render, so
  // this effect re-runs constantly, and "differs from the session" would make
  // each of those re-runs an edit — a host stuck on a stale layout model then
  // rewrites the model of a Conversation that already ran on another one
  // (`modelSelection.ts` records the thread this cost).
  const modelSyncStartedRef = useRef(false);
  const lastHostModelRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const adopted = hostModelAdoption({
      hostModel,
      lastHostModel: lastHostModelRef.current,
      sessionModel: conversationSessionRef.current.model,
    });
    const firstSync = !modelSyncStartedRef.current;
    modelSyncStartedRef.current = true;
    lastHostModelRef.current = hostModel;
    if (firstSync) {
      if (conversationSessionRef.current.model !== hostModel) {
        onModelChange(conversationSessionRef.current.model);
      }
      return;
    }
    if (adopted) transitionConversation({ type: "configured", model: adopted });
  }, [hostModel, onModelChange]);
  // The Provider follows the same rule as the model above, and for a sharper
  // reason: the Focus hero edits this panel's provider+model pair from outside
  // while the panel is mounted behind it. The model was the only live prop, so
  // a hero pick landed the new Provider's model on the OLD Provider — that is
  // how `qwen3.6:latest` went out to OpenRouter and came back a 400. Applying
  // both in one transition keeps the pair honest; mount is exempt, since a
  // restored Conversation owns its pair and pushes it UP instead.
  const providerSyncStartedRef = useRef(false);
  useEffect(() => {
    if (!providerSyncStartedRef.current) {
      providerSyncStartedRef.current = true;
      return;
    }
    if (!hostProvider || hostProvider === conversationSessionRef.current.provider) return;
    // hostModel is this render's value, so a host that moved both (the hero)
    // is already offering the matching model; a host that moved only the
    // Provider falls back to that Provider's own remembered model.
    const pairedModel =
      hostModel && hostModel !== conversationSessionRef.current.model
        ? hostModel
        : switchModelForProvider(hostProvider);
    transitionConversation({ type: "configured", provider: hostProvider, model: pairedModel });
    if (pairedModel !== hostModel) onModelChange(pairedModel);
    if (panelId) localStorage.setItem(`klide.provider.${panelId}`, hostProvider);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostProvider]);
  useEffect(() => {
    const restoredProvider = conversationSessionRef.current.provider;
    if (restoredProvider === requestedProviderRef.current) return;
    if (panelId) localStorage.setItem(`klide.provider.${panelId}`, restoredProvider);
    onProviderChange?.(restoredProvider);
    // Restore notification is intentionally mount-only; live Provider changes
    // go through selectProvider below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [input, setInput] = useState("");
  const [composerFocused, setComposerFocused] = useState(false);
  // Mode / reflection / context popovers live in `usePortalMenu` (declared
  // with the mode + reflection menus below) — same names, so render is unchanged.
  const [summarizing, setSummarizing] = useState(false);
  const [generatingSkill, setGeneratingSkill] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  // Subtle inline "Auto-saved to memory" line under the composer. Surfaces for
  // ~4s after a run completes, then fades. Cleared on the next send or abort.
  const [autoMemoryNotice, setAutoMemoryNotice] = useState<string | null>(null);
  // Index of the assistant message whose Copy button just fired, for a brief
  // "Copied" confirmation. Reset on the next copy or render of a new message.
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  // Inline editing of a user message: index being edited + draft text.
  // Editing happens in place — the bubble swaps to a textarea, the
  // trailing conversation stays untouched. Commit on ⌘/Ctrl+Enter or
  // blur; Escape cancels and restores the original.
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const autoMemoryTimerRef = useRef<number | null>(null);

  const lastPublishRef = useRef({ count: -1, streaming: false, meta: "" });
  useEffect(() => {
    if (msgs.length === 0) {
      // Active chat is empty — explicitly settle the MC row for this
      // panel so a user-initiated "new chat" doesn't leave a stale
      // "running" entry behind. View switches don't hit this branch
      // (msgs stays non-empty in the persisted store), so they no
      // longer kill the live row.
      settleKlideConvo(currentId);
      lastPublishRef.current = { count: -1, streaming: false, meta: "" };
      return;
    }
    const last = lastPublishRef.current;
    const metaKey = JSON.stringify({
      id: currentId,
      provider,
      model: model ?? null,
      cwd: workspaceRoot,
      branch: conversationGitMeta.branch,
      worktree: conversationGitMeta.worktree,
      forkedFrom: currentForkedFrom ?? null,
    });
    if (streaming && last.streaming && last.count === msgs.length && last.meta === metaKey) return;
    lastPublishRef.current = { count: msgs.length, streaming, meta: metaKey };
    // The Mission Control row derives from the same Stored conversation
    // snapshot the history index persists (`conversationToConvo`) — one shape,
    // one title rule, not a third inline copy of either.
    const snapshot = snapshotConversationSession(conversationSessionRef.current);
    const convo = snapshot ? conversationToConvo(snapshot) : null;
    if (!convo) return;
    publishKlideConvo({
      ...convo,
      // An idle convo that finished its turn is "done", not "waiting" — a
      // genuine pause (diff approval) keeps `streaming` true, so non-streaming
      // always means the turn completed. Marking it "waiting" wrongly filed
      // every answered chat under Mission Control's "Blocked / Needs you".
      status: streaming ? "running" : "done",
    });
  }, [msgs, streaming, provider, model, workspaceRoot, currentId, currentForkedFrom, conversationGitMeta]);

  // Git status can arrive after the panel mounts. Until the first message is
  // sent, keep the new Conversation's branch snapshot aligned with the branch
  // it would actually run on; once messages exist, the snapshot is immutable.
  useEffect(() => {
    const current = conversationSessionRef.current;
    if (
      current.messages.length === 0 &&
      workspaceBranch &&
      current.branch !== workspaceBranch
    ) {
      transitionConversation({ type: "branch-captured", branch: workspaceBranch });
    }
  }, [workspaceBranch]);

  const [contextLimit, setContextLimit] = useState(128_000);
  // The provider's own prompt-token count from the latest finished turn — the
  // authoritative "how full is the context" number (it's exactly what the
  // model counted: system prompt + tools + history). `null` until the first
  // turn reports usage, or for providers that don't (subscription CLIs); we
  // fall back to a char-length estimate then.
  const [measuredPromptTokens, setMeasuredPromptTokens] = useState<number | null>(null);
  const [measuredUsageTokens, setMeasuredUsageTokens] = useState<{ prompt: number; completion: number } | null>(null);
  // Per-model list price (USD / million in+out tokens), or null for local /
  // subscription / unknown models. Fetched per model; drives per-message and
  // per-conversation cost from each turn's token usage.
  const [pricing, setPricing] = useState<{ inputPerMillion: number; outputPerMillion: number } | null>(null);
  // Auto-compact: when the context gauge crosses the threshold we offer to
  // summarize older turns into a transcript marker (see agent_compact_context),
  // freeing the window while keeping recent turns verbatim.
  const [compacting, setCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  // Layout of the in-flight compaction: "manual" (/compact) → full-width row,
  // "agent" (inline/automatic) → slim tool-style row.
  const [compactSource, setCompactSource] = useState<"manual" | "agent">("manual");
  const [contextMode] = useState<ProjectContextMode>(
    () => (localStorage.getItem("klide.contextMode") as ProjectContextMode) || "auto"
  );
  const [connected, setConnected] = useState(false);
  const [serverRunning, setServerRunning] = useState(false);
  const [serverStarting, setServerStarting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  // Distinct files this run has written, so the composer can offer a one-click
  // "undo what this run did" without a round-trip to Mission Control. Reset
  // when the conversation changes (a loaded-from-history run reverts via the
  // CheckpointPanel instead). Set is the source of truth; count drives render.
  const runChangedPathsRef = useRef<Set<string>>(new Set());
  const [revertableFiles, setRevertableFiles] = useState(0);
  const [reverting, setReverting] = useState(false);
  const [acceptingChanges, setAcceptingChanges] = useState(false);
  // Set when the user hits Stop while a local server is still warming up —
  // there is no harness run to abort yet, so we flag the pending send to bail
  // once the server is ready instead of launching a turn they backed out of.
  const cancelledWarmupRef = useRef(false);
  const [serverRefresh] = useState(0);
  const [agentMode, setAgentMode] = useState<AgentMode>(
    () => normalizeAgentMode(localStorage.getItem("klide.agentMode"))
  );
  const agentModeRef = useRef(agentMode);
  const [modelSupportsTools, setModelSupportsTools] = useState(true);
  const [modelSupportsReflection, setModelSupportsReflection] = useState(false);
  const [modelSupportsVision, setModelSupportsVision] = useState(false);
  // A saved transcript is view-only until the user sends again. In particular,
  // don't let Ollama's reflection probe or historical token-count pass load a
  // cold model merely because the user browsed history.
  const [modelActivationDeferred, setModelActivationDeferred] = useState(
    () => Boolean(resumeConversation) || conversationSession.messages.length > 0,
  );
  const manuallyInspectedModelRef = useRef<string | null>(null);
  // Photos and documents pasted/dropped into the composer, staged until the
  // turn is sent. A photo needs a model that can see it; a document is text
  // and reaches every model, so the two are gated separately (see stageFiles).
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  // Whether a file is being dragged over the panel (drives the drop overlay).
  const [fileDragOver, setFileDragOver] = useState(false);
  // A conversation image opened full-size (data URI), or null when closed.
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  // The OS file picker behind the + menu's attach row — for a photo or
  // document that isn't in the workspace, so it can't be reached with `@`.
  const filePickerRef = useRef<HTMLInputElement>(null);
  const {
    open: modeOpen,
    pos: modeMenuPos,
    triggerRef: modeTriggerRef,
    menuRef: modeMenuRef,
    openMenu: openModeMenu,
    close: closeModeMenu,
  } = usePortalMenu({
    computePos: (rect) => {
      const width = 204;
      return {
        bottom: Math.round(window.innerHeight - rect.top + 8),
        left: Math.round(Math.min(Math.max(8, rect.left), window.innerWidth - width - 8)),
      };
    },
    closeOnOutsideClick: true,
  });
  const {
    open: reflectionOpen,
    pos: reflectionMenuPos,
    triggerRef: reflectionTriggerRef,
    menuRef: reflectionMenuRef,
    openMenu: openReflectionMenu,
    close: closeReflectionMenu,
  } = usePortalMenu({
    computePos: (rect) => {
      const width = 176;
      return {
        bottom: Math.round(window.innerHeight - rect.top + 8),
        left: Math.round(Math.min(Math.max(8, rect.left), window.innerWidth - width - 8)),
      };
    },
    closeOnOutsideClick: true,
  });
  const {
    open: contextHover,
    pos: contextTooltipPos,
    triggerRef: contextTriggerRef,
    openMenu: openContextTooltip,
    close: closeContextTooltip,
  } = usePortalMenu({
    computePos: (rect) => {
      const viewportPad = 8;
      const width = Math.min(360, Math.max(272, window.innerWidth - viewportPad * 2));
      const idealLeft = rect.right - width;
      return {
        bottom: Math.round(window.innerHeight - rect.top + 8),
        left: Math.round(Math.min(Math.max(viewportPad, idealLeft), window.innerWidth - width - viewportPad)),
        width: Math.round(width),
        compact: width < 330,
      };
    },
  });
  const toggleMode = () => {
    setNextSendMode(null);
    setAgentMode((m) => {
      const order: AgentMode[] = modelSupportsTools || providerDelegatesWork ? ["chat", "plan", "goal"] : ["chat", "plan"];
      const next = order[(order.indexOf(m) + 1) % order.length] ?? "chat";
      agentModeRef.current = next;
      localStorage.setItem("klide.agentMode", next);
      return next;
    });
  };
  function selectMode(mode: AgentMode) {
    setNextSendMode(null);
    agentModeRef.current = mode;
    setAgentMode(mode);
    localStorage.setItem("klide.agentMode", mode);
    closeModeMenu();
  }
  useEffect(() => { agentModeRef.current = agentMode; }, [agentMode]);
  // Outside-click + scroll/resize auto-close for all three popovers now lives
  // in usePortalMenu, not five hand-rolled effects here.

  const [fileList, setFileList] = useState<string[]>([]);
  const [mention, setMention] = useState<{ query: string; atStart: boolean } | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  // When `@` opens the menu at the very start of the message, offer subagents
  // (above files). Mid-message `@` stays file-only, so the two never clash.
  const subagentMatches = mention?.atStart ? matchSubagents(mention.query) : [];
  const mentionMatches = mention !== null ? fuzzyFiles(fileList, mention.query) : [];
  const mentionTotal = subagentMatches.length + mentionMatches.length;

  // Two different facts, long conflated behind one flag.
  //
  // `providerDelegatesWork` — a *capability*: this provider edits the
  // workspace itself, so Goal mode needs no tool probe, images can't be sent,
  // and the context lens has nothing to add.
  //
  // `delegateSession` — a *surface*: the conversation IS the CLI's interactive
  // session, so the canvas hosts its terminal and the composer types into the
  // PTY. That is right for a workbench panel and wrong for Focus, which is the
  // chat-first surface: there the same delegate runs one-shot and headless
  // (`delegate/chat.rs`, `claude -p --output-format text`) and its answer is
  // rendered as an ordinary Klide message.
  const providerDelegatesWork = isDelegateProvider(provider);
  const delegateSession = providerDelegatesWork && variant !== "focus";
  const isLocalProvider = isManagedLocalProvider(provider);
  // A panel handed an explicit conversation — a Mission Control reattach, a
  // race-watch column — holds that thread from its first frame, but nothing
  // wrote it down: the durable binding is written by identity transitions, and
  // reattaching to a Run that has already settled makes none. The rail derives
  // what is open from those bindings, so a watched racer could sit on the
  // canvas while the history tree said nothing was there. Record it on mount.
  useEffect(() => {
    if (panelId && initialConversationId) {
      persistConversationSessionBinding(panelId, conversationSessionRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A delegate conversation's identity IS its PTY session id
  // (`{convoId}:{provider}`), so persist the panel↔convo pairing the moment
  // the provider/convo binds — not on turn start like hosted chats, because a
  // delegate session is driven through the PTY, never through the harness
  // turn path that writes this record. Without it, an app relaunch rotates
  // the panel to a fresh convo id and spawns a brand-new CLI instead of
  // reattaching to the same session — which, with the ptyd daemon on, is
  // still alive and waiting.
  useEffect(() => {
    if (panelId && delegateSession) {
      persistConversationSessionBinding(panelId, conversationSessionRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelId, delegateSession, currentId]);
  // A stretch of uninterrupted tool work folds into one row (see toolRuns.ts).
  // The message loop below is untouched: this rewrites its *output*, dropping a
  // closed run's nodes and putting a summary in their place. Doing it there
  // rather than inside the loop keeps one renderer for a tool row — the rows
  // you get back on open are the very same elements, not a second drawing of
  // them.
  const toolPairing = useMemo(() => pairToolResults(msgs), [msgs]);
  const toolRuns = useMemo(() => groupToolRuns(msgs, toolPairing), [msgs, toolPairing]);
  // Constant-time "is this message inside a folded run?" for the message loop:
  // a message in a run hands its thought process to the run's header
  // (`stackToolRuns` hoists it above the "N tool calls" row) and must not draw
  // a second copy inside the fold.
  const toolRunAt = useMemo(() => toolRunIndex(toolRuns), [toolRuns]);
  // Which messages have handed their mark to a folded row's header. A turn
  // that opens with tool work keeps its mark on the header in *both* states —
  // a mark that appears and disappears as you click reads as the row moving,
  // and the eye follows the mark, not the text. The message underneath must
  // therefore not draw a second one when the run opens.
  const toolRunMarkOwners = useMemo(() => {
    const owners = new Set<number>();
    for (const run of toolRuns) {
      const first = msgs[run.start];
      const before = msgs[run.start - 1];
      if (
        first?.role === "assistant" &&
        (!before || (before.role !== "assistant" && before.role !== "tool"))
      ) {
        owners.add(run.start);
      }
    }
    return owners;
  }, [toolRuns, msgs]);
  const [openToolRuns, setOpenToolRuns] = useState<Set<number>>(() => new Set());
  function toggleToolRun(start: number) {
    setOpenToolRuns((prev) => {
      const next = new Set(prev);
      if (!next.delete(start)) next.add(start);
      return next;
    });
  }
  function stackToolRuns(nodes: ReactNode[]): ReactNode[] {
    if (toolRuns.length === 0) return nodes;
    const out: ReactNode[] = [];
    let cursor = 0;
    for (const run of toolRuns) {
      for (; cursor < run.start; cursor++) out.push(nodes[cursor]);
      // The runs are computed from *messages*, but this function rewrites the
      // loop's *output* — and the loop sometimes draws nothing for a message
      // (a result its call already drew underneath itself renders null). A
      // run whose rows were all withheld folds nothing: emitting its header
      // would put a "3 tool calls" row over an empty body.
      if (nodes.slice(run.start, run.end).every((n) => n == null)) {
        cursor = run.end;
        continue;
      }
      // Work still happening stays open. Collapsing a run the agent is in the
      // middle of would hide the only thing moving on screen; it folds itself
      // once the answer it was gathering for arrives.
      const working = streaming && run.end === msgs.length;
      const open = openToolRuns.has(run.start) || working;
      const { count, names } = toolRunLabel(run);
      // When a turn opens with tool work, the message wearing the agent's mark
      // is the one this row folds away — and a response with no mark reads as
      // nobody's. The row wears it instead, open or closed, and the message
      // underneath stands down (`toolRunMarkOwners`).
      const first = msgs[run.start];
      const startsResponse = toolRunMarkOwners.has(run.start);
      const mark = startsResponse && first.role === "assistant" ? responseMark(first) : null;
      // The reasoning that drove this stretch of tool work is the agent's
      // voice, not tool machinery — it stays visible above the fold, in
      // arrival order, whether the run is open or closed. The messages inside
      // render with `hideThinking` so opening the run never shows it twice.
      const thinkingNodes: ReactNode[] = [];
      for (let i = run.start; i < run.end; i++) {
        const m = msgs[i];
        const t = extractThinking(m);
        if (t) thinkingNodes.push(<ThinkingBlock key={`think-${i}`} text={t} streaming={false} thinkingMs={m.role === "assistant" ? m.thinkingMs : undefined} />);
      }
      out.push(
        <div
          key={`tool-run-${run.start}`}
          style={{ display: "flex", gap: 10, margin: startsResponse ? "14px 0 0" : "6px 0 0" }}
        >
          <div
            aria-hidden="true"
            style={{
              flexShrink: 0,
              width: 22,
              height: 22,
              marginTop: 1,
              display: "grid",
              placeItems: "center",
            }}
          >
            {startsResponse ? mark?.node ?? <KlideMark size={20} /> : null}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {thinkingNodes}
            <ToolRunRow
              count={count}
              names={names}
              expanded={open}
              onToggle={() => toggleToolRun(run.start)}
            />
          </div>
        </div>,
      );
      // The rows stay mounted either way and the wrapper animates its height
      // (see `.klide-tool-run-body`). Mounting them only when open would make
      // the close instant — there is nothing left to animate once the content
      // is gone — and it saves nothing: the loop above already built them.
      out.push(
        <div
          key={`tool-run-body-${run.start}`}
          className="klide-tool-run-body"
          data-open={open ? "true" : "false"}
          // Not `aria-hidden`: the rows it hides hold focusable disclosure
          // controls, and hiding a focusable element from assistive tech
          // without taking it out of the tab order strands the keyboard on a
          // control nobody can see. `inert` does both.
          inert={!open}
        >
          <div>
            {nodes.slice(run.start, run.end)}
          </div>
        </div>,
      );
      cursor = run.end;
    }
    for (; cursor < nodes.length; cursor++) out.push(nodes[cursor]);
    return out;
  }

  // Portalled to <body> like the composer popovers: the menu is taller than
  // the panel's clip region (`.floating-panel` is overflow: hidden), so an
  // in-tree absolute menu gets cut off and its own scrollbar never engages.
  // Standard panels open down from the header; Focus mode moves this same
  // control into the bottom composer and opens it upward instead.
  const {
    open: providerOpen,
    pos: providerMenuPos,
    triggerRef: providerTriggerRef,
    menuRef: providerMenuRef,
    openMenu: openProviderMenu,
    close: closeProviderMenu,
  } = usePortalMenu<{ top?: number; bottom?: number; left: number; maxHeight: number }>({
    computePos: (rect) => {
      const pad = 8;
      const width = 200; // menu minWidth — used for the viewport clamp
      if (variant === "focus") {
        return {
          bottom: Math.round(window.innerHeight - rect.top + 6),
          left: Math.round(Math.min(Math.max(pad, rect.left), window.innerWidth - width - pad)),
          maxHeight: Math.round(Math.min(440, rect.top - 6 - pad)),
        };
      }
      return {
        top: Math.round(rect.bottom + 6),
        left: Math.round(Math.min(Math.max(pad, rect.left), window.innerWidth - width - pad)),
        maxHeight: Math.round(Math.min(440, window.innerHeight - rect.bottom - 6 - pad)),
      };
    },
    closeOnOutsideClick: true,
  });
  // Self-hosted endpoints, read from the shared store. It refreshes on mount
  // and whenever the picker opens (so endpoints added in Settings show up
  // without a panel reload), and it publishes changes — a rename in Settings
  // repaints the header name and the picker while the panel stays open.
  const customProviders = useCustomProviders();
  const [customCli, setCustomCli] = useState<CustomCli[]>([]);
  useEffect(() => {
    void refreshCustomCli().then(setCustomCli).catch(() => {});
  }, []);
  const providerGroups = useMemo(
    () => providerGroupsWithCustom(customProviders, customCli),
    [customProviders, customCli]
  );
  // Focus offers the same stacks the workbench does, delegates included: the
  // canvas hosts their session the same way a panel does, and they are the one
  // route that runs on a subscription instead of an API key.
  const providerGroupsForSurface = providerGroups;
  // Hosted ("API") providers that have no key configured — badged in the picker
  // so a missing key is visible *before* selecting + sending, not after a failed
  // run. Populated when the menu opens.
  const [keylessProviders, setKeylessProviders] = useState<Set<string>>(new Set());
  // Collapsible provider groups ("stacks"). Each opens via the header chevron.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  function toggleGroup(label: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }
  useEffect(() => {
    if (!providerOpen) return;
    void refreshCustomProviders().catch(() => {});
    void refreshCustomCli().then(setCustomCli).catch(() => {});
    // Probe key status for hosted ("API") providers so we can badge the ones
    // that aren't configured yet. Best-effort; a failed probe just isn't badged.
    void (async () => {
      const apiGroup = providerGroupsForSurface.find((g) => g.label === "API");
      if (!apiGroup) return;
      const missing = new Set<string>();
      await Promise.all(
        apiGroup.items.map(async (it) => {
          try {
            const st = await readProviderKeyStatus(it.id);
            if (!st.hasKey) missing.add(it.id);
          } catch { /* unreachable status → leave unbadged */ }
        }),
      );
      setKeylessProviders(missing);
    })();
    // Open compact: expand only the stack holding the active provider.
    // (Outside-click close lives in usePortalMenu.)
    const activeGroup = providerGroupsForSurface.find((g) => g.items.some((it) => it.id === provider));
    setExpandedGroups(new Set(activeGroup ? [activeGroup.label] : []));
  }, [providerOpen]);
  function selectProvider(id: ProviderId) {
    const nextModel = switchModelForProvider(id);
    transitionConversation({ type: "configured", provider: id, model: nextModel });
    onProviderChange?.(id);
    if (panelId) localStorage.setItem(`klide.provider.${panelId}`, id);
    localStorage.setItem("klide.provider", id);
    onModelChange(nextModel);
    closeProviderMenu();
  }
  useEffect(() => { localStorage.setItem("klide.contextMode", contextMode); }, [contextMode]);

  const [slash, setSlash] = useState<{ query: string } | null>(null);
  const [slashIdx, setSlashIdx] = useState(0);
  const [nextSendMode, setNextSendMode] = useState<AgentMode | null>(null);

  // The current mode in words, for the /mode peek. Reads state at call time.
  // Mode changes themselves stay silent: the + menu checkmark and the foot
  // bar's standing note are the state, and a transient line above the
  // composer proved to be chrome nobody needed.
  function currentModeText(): string {
    if (effectiveMode === "chat") return "chat mode · no tools";
    if (effectiveMode === "plan") return "plan mode · read-only";
    if (requireDiffReview) return "reviewing every edit";
    return autoApproveCommands
      ? "full auto · commands run without asking"
      : "auto-accept edits on";
  }
  // /auto-mode and /review-mode imply Goal mode (edits only happen there).
  const goalOrPlan = () => (modelSupportsTools || providerDelegatesWork ? "goal" : "plan") as AgentMode;

  const SLASH_COMMANDS: { name: string; desc: string; run: () => void | Promise<void> }[] = [
    { name: "chat", desc: "Switch to Chat mode (no tools)", run: () => { selectMode("chat"); setInput(""); } },
    { name: "plan", desc: "Switch to Plan mode (read-only, proposes a plan)", run: () => { selectMode("plan"); setInput(""); } },
    { name: "goal", desc: "Switch to Goal mode (can propose edits)", run: () => { selectMode(modelSupportsTools || providerDelegatesWork ? "goal" : "plan"); setInput(""); } },
    { name: "mode", desc: "Show the current mode", run: () => { setInput(""); setSlash(null); notify(currentModeText()); } },
    { name: "auto-mode", desc: "Auto-accept edits — apply without a prompt", run: () => { setInput(""); setSlash(null); selectMode(goalOrPlan()); onRequireDiffReviewChange?.(false); onAutoApproveCommandsChange?.(false); } },
    { name: "review-mode", desc: "Review every edit before it applies (default)", run: () => { setInput(""); setSlash(null); selectMode(goalOrPlan()); onRequireDiffReviewChange?.(true); onAutoApproveCommandsChange?.(false); } },
    { name: "clear", desc: "Start a new conversation", run: () => newConversation() },
    { name: "compact", desc: "Summarize older turns to free up context", run: () => {
      setInput(""); setSlash(null);
      if (!canCompact) {
        const why = providerDelegatesWork
          ? "This provider manages its own context — nothing to compact here."
          : streaming
            ? "Wait for the current turn to finish, then run /compact."
            : "Nothing to compact yet — the conversation is still short.";
        const note: Msg = { role: "system", content: why };
        msgsRef.current = [...msgsRef.current, note];
        setMsgs(msgsRef.current);
        return;
      }
      void compactConversation();
    } },
    { name: "handoff", desc: "Save this task state into Project Memory", run: () => saveHandoffToProjectMemory() },
    { name: "start", desc: "Start the local server (Ollama / MLX) for this provider", run: async () => {
      setInput(""); setSlash(null);
      if (!isLocalProvider) {
        const note: Msg = { role: "system", content: `${providerName(provider)} runs in the cloud — there's no local server to start.` };
        msgsRef.current = [...msgsRef.current, note];
        setMsgs(msgsRef.current);
        return;
      }
      // ensureLocalServerReady() flips `serverStarting`, which drives the
      // centered DotGridLoader row ("Starting MLX local server…"). That row is
      // the in-progress animation; on success it just disappears, and on
      // failure the `serverError` banner surfaces the reason — so no extra
      // mode-flash is needed here (that's reserved for /auto-mode etc.).
      await ensureLocalServerReady();
    } },
    { name: "explain", desc: "Explain a file — pick one next (read-only)", run: () => {
      setInput("Explain what this file does and how it works: @");
      setNextSendMode("plan");
      setMention({ query: "", atStart: false }); setMentionIdx(0);
      void ensureFileList();
      requestAnimationFrame(() => taRef.current?.focus());
    }},
    { name: "init", desc: "Analyze the repo and create a CLAUDE.md", run: () => void send({ mode: "goal", text: "Explore this project (read key files like package.json, README, and the main source folders) and create a concise CLAUDE.md at the workspace root documenting what the project is, its stack, how to run it, and the repo layout. Use create_file so I can review the diff." }) },
    { name: "interview", desc: "Interview me about this codebase — Q&A, one question at a time", run: () => {
      // /interview starts a structured code interview. Plan mode (read-only)
      // keeps the agent from accidentally editing while it reads. The prompt
      // is self-contained so the skill works even if the user hasn't
      // installed the SKILL.md yet — installing it just gives the model
      // extra system-prompt context.
      if (!modelSupportsTools && !providerDelegatesWork) selectMode("plan");
      void send({
        mode: "plan",
        text:
          "Run the codebase interview. Read README.md (and the top-level package manifest / entry point if there's no README) to ground yourself, then identify 5-10 high-signal things you don't understand about the project — ambiguous naming, surprising structure, missing docs, design tensions, historical choices. For each one, call the `userAnswerQuestion` tool with a single short question (one sentence, focused on what only I can answer). Wait for each answer, use it as-is, and move to the next. After all questions, write a structured doc to docs/codebase-decisions.md with one section per Q&A (Question / Answer / Why it matters). End the run when the doc is written.",
      });
    } },
  ];
  const slashMatches = slash !== null ? SLASH_COMMANDS.filter((c) => c.name.startsWith(slash.query.toLowerCase())) : [];

  function acceptSlash(idx: number) { const cmd = slashMatches[idx]; setSlash(null); if (cmd) cmd.run(); }

  async function saveHandoffToProjectMemory() {
    if (!workspaceRoot) {
      setInput("");
      const msg: Msg = { role: "assistant", content: "Open a workspace before saving a project handoff." };
      msgsRef.current = [...msgsRef.current, msg];
      setMsgs(msgsRef.current);
      return;
    }
    const handoff = buildHandoffSummary(msgsRef.current, projectContext);
    setInput("");
    try {
      const entry = await writeMemory(workspaceRoot, {
        title: handoff.title,
        kind: "handoff",
        tags: [],
        sourceRefs: [{ sourceType: "run", id: currentId, label: "Source Run" }],
        supersedes: null,
        goal: handoff.goal,
        plan: [],
        decisions: [],
        filesTouched: handoff.filesTouched,
        nextSteps: handoff.nextSteps,
        notes: handoff.body.replace(/^# /gm, "## "),
        runId: currentId,
        provider,
        model,
        mode: normalizeAgentMode(agentMode),
        status: streaming ? "running" : "done",
      });
      const msg: Msg = {
        role: "assistant",
        content: `Saved Project Memory handoff: ${entry.title}`,
      };
      msgsRef.current = [...msgsRef.current, msg];
      setMsgs(msgsRef.current);
      onMemoryWritten?.({ relPath: entry.relPath, title: entry.title });
    } catch (err) {
      const msg: Msg = {
        role: "assistant",
        content: `Handoff failed: ${err instanceof Error ? err.message : String(err)}`,
      };
      msgsRef.current = [...msgsRef.current, msg];
      setMsgs(msgsRef.current);
    }
  }

  useEffect(() => { setFileList([]); }, [workspaceRoot]);

  const [projectRules, setProjectRules] = useState("");
  useEffect(() => {
    let cancelled = false;
    async function loadRules() {
      if (!workspaceRoot) { setProjectRules(""); return; }
      for (const name of ["AGENTS.md", "CLAUDE.md"]) {
        try {
          if (!(await workspacePathExists(workspaceRoot, name))) continue;
          let text = await readWorkspaceTextFile(workspaceRoot, name);
          if (text.length > 6000) text = text.slice(0, 6000) + "\n…(truncated)";
          if (!cancelled) setProjectRules(text.trim());
          return;
        } catch {}
      }
      if (!cancelled) setProjectRules("");
    }
    void loadRules();
    return () => { cancelled = true; };
  }, [workspaceRoot]);

  async function ensureFileList() {
    if (!workspaceRoot || fileList.length > 0) return;
    try { setFileList(await listWorkspaceFiles(workspaceRoot)); } catch {}
  }

  function handleComposerChange(value: string, caret: number) {
    setInput(value);
    const slashMatch = value.match(/^\/(\w*)$/);
    if (slashMatch) { setSlash({ query: slashMatch[1] }); setSlashIdx(0); setMention(null); return; }
    else if (slash !== null) setSlash(null);
    const before = value.slice(0, caret);
    const m = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (m) { setMention({ query: m[1], atStart: /^@[^\s@]*$/.test(before) }); setMentionIdx(0); void ensureFileList(); }
    else if (mention !== null) setMention(null);
  }

  function acceptMention(path: string) {
    const ta = taRef.current;
    const caret = ta ? ta.selectionStart : input.length;
    const before = input.slice(0, caret);
    const at = before.lastIndexOf("@");
    const newBefore = before.slice(0, at) + "@" + path + " ";
    const next = newBefore + input.slice(caret);
    setInput(next);
    setMention(null);
    requestAnimationFrame(() => { ta?.focus(); ta?.setSelectionRange(newBefore.length, newBefore.length); });
  }

  // Insert a subagent directive at the start of the composer, preserving any
  // text the user already typed after the `@query`.
  function acceptSubagent(label: string) {
    const ta = taRef.current;
    const caret = ta ? ta.selectionStart : input.length;
    const next = `@${label} `;
    setInput(next + input.slice(caret));
    setMention(null);
    requestAnimationFrame(() => { ta?.focus(); ta?.setSelectionRange(next.length, next.length); });
  }

  // The menu lists subagents first, then files. Route an absolute index.
  function acceptMentionAt(idx: number) {
    if (idx < subagentMatches.length) { acceptSubagent(subagentMatches[idx].label); return; }
    const path = mentionMatches[idx - subagentMatches.length];
    if (path) acceptMention(path);
  }

  // "Add file" in the + menu just primes an @-mention: append " @" and let the
  // existing mention detection (handleComposerChange) open the file picker.
  function addFileMention() {
    closeModeMenu();
    const next = input.length === 0 ? "@" : input.endsWith(" ") ? input + "@" : input + " @";
    handleComposerChange(next, next.length);
    requestAnimationFrame(() => { const ta = taRef.current; if (ta) { ta.focus(); ta.setSelectionRange(next.length, next.length); } });
  }
  function openCommandsMenu() {
    closeModeMenu();
    handleComposerChange("/", 1);
    requestAnimationFrame(() => { const ta = taRef.current; if (ta) { ta.focus(); ta.setSelectionRange(1, 1); } });
  }

  // Stage pasted/dropped files through the one set of attachment rules
  // (src/components/ai/attachments.ts): a photo becomes a data URI for a
  // vision-capable model, a document becomes text every model can read, and
  // anything Klide has no wire for is refused by name rather than attached as
  // garbage.
  async function addFiles(files: File[]) {
    if (!canAttachFiles || files.length === 0) return;
    const { attachments, notices } = await stageFiles(files, {
      allowPhotos: modelSupportsVision,
      alreadyStaged: pendingAttachments.length,
      alreadyImageBytes: stagedImageBytes(pendingAttachments),
    });
    for (const notice of notices) notify(notice.text, { tone: notice.tone });
    if (attachments.length) setPendingAttachments((prev) => [...prev, ...attachments]);
  }

  // A delegate CLI takes text on its stdin and nothing else, so attaching is
  // off there entirely. Everywhere else the composer accepts files and lets
  // the staging rules decide what each one becomes.
  const canAttachFiles = !providerDelegatesWork;

  function onComposerPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length && canAttachFiles) {
      e.preventDefault();
      void addFiles(files);
    }
  }

  function onComposerDrop(e: React.DragEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length && canAttachFiles) {
      e.preventDefault();
      void addFiles(files);
    }
  }

  async function collectAttachments(text: string): Promise<Attachment[]> {
    if (!workspaceRoot) return [];
    const known = new Set(fileList);
    const tokens = [...text.matchAll(/@([^\s@]+)/g)].map((m) => m[1]);
    const paths = [...new Set(tokens)].filter((p) => (fileList.length ? known.has(p) : p.includes("."))).filter((p) => !p.includes("..")).slice(0, 6);
    const out: Attachment[] = [];
    for (const p of paths) {
      try {
        if (!(await workspacePathExists(workspaceRoot, p))) continue;
        let content = await readWorkspaceTextFile(workspaceRoot, p);
        if (content.length > 12000) content = content.slice(0, 12000) + "\n…(truncated)";
        out.push({ path: p, content });
      } catch {}
    }
    return out;
  }

  const lensProjectContext = useMemo(
    () => (providerDelegatesWork ? [] : lensItemsForPrompt(projectContext, input, contextMode)),
    [providerDelegatesWork, projectContext, input, contextMode],
  );
  const activeMode = nextSendMode ?? agentMode;
  const effectiveMode = effectiveModeFor({
    mode: activeMode,
    modelSupportsTools,
    providerDelegatesWork,
  });
  // + menu: Goal disabled when the model has no tools. The Goal policy
  // (review / auto-accept / full auto) lives in the foot bar, not here.
  const goalDisabled = !modelSupportsTools && !providerDelegatesWork;
  const goalPolicy = goalPolicyOf(requireDiffReview, autoApproveCommands);
  // Effective window: a per-model override (Settings → Harness, Ollama only)
  // genuinely caps the runtime window, so the gauge must measure against it —
  // otherwise a dialed-down model reads near-empty when it's actually full.
  // Everyone else measures against the model's detected trained window.
  const ctxOverride = harnessSettings?.contextWindows?.[model];
  const effectiveContextLimit =
    provider === "ollama" && ctxOverride && ctxOverride > 0 ? ctxOverride : contextLimit;
  const contextLimitNote = provider === "ollama"
    ? ctxOverride && ctxOverride > 0
      ? "Ollama override active: Klide sends this window as num_ctx."
      : "Ollama auto: Klide chooses a stable working window up to the detected model limit."
    : isCustomProvider(provider)
      ? "Self-hosted endpoint: Klide cannot set context here. Configure the server/model window upstream."
      : isLocalProvider
        ? "Local OpenAI-compatible server: context is controlled by the server, not by Klide."
        : "API provider: context is provider-controlled; Klide tracks usage against the advertised limit.";
  const effortBudget = provider === "ollama" ? harnessSettings?.effortBudgets?.[model] : undefined;
  const reflectionStorageKey = `klide.reflectionLevel.${panelId ?? "ai-main"}.${provider}.${model}`;
  const [panelReflectionLevel, setPanelReflectionLevel] = useState<string | undefined>(undefined);
  useEffect(() => {
    try {
      const stored = normalizeReflectionLevel(localStorage.getItem(reflectionStorageKey));
      setPanelReflectionLevel(stored ?? normalizeReflectionLevel(harnessSettings?.reflectionLevels?.[model]));
    } catch {
      setPanelReflectionLevel(normalizeReflectionLevel(harnessSettings?.reflectionLevels?.[model]));
    }
  }, [reflectionStorageKey, harnessSettings?.reflectionLevels?.[model], model]);
  const reflectionLevel = modelSupportsReflection ? panelReflectionLevel : undefined;
  const reflectionOptions: ReflectionOption[] = [
    { value: undefined, label: "Auto", level: 0, desc: "Provider default" },
    { value: "minimal", label: "minimal", level: 1, desc: "Smallest reasoning effort" },
    { value: "low", label: "low", level: 2, desc: "Lower reasoning effort" },
    { value: "medium", label: "medium", level: 3, desc: "Default reasoning effort" },
    { value: "high", label: "high", level: 4, desc: "Higher reasoning effort" },
    { value: "xhigh", label: "xhigh", level: 5, desc: "Highest reasoning effort" },
  ];
  const activeReflection = reflectionOptions.find((o) => o.value === reflectionLevel) ?? reflectionOptions[0];
  function selectReflectionLevel(level: string | undefined) {
    if (!modelSupportsReflection) return;
    setPanelReflectionLevel(level);
    try {
      if (level === undefined) localStorage.removeItem(reflectionStorageKey);
      else localStorage.setItem(reflectionStorageKey, level);
    } catch {}
    closeReflectionMenu();
  }
  const [toolSchemaTokens, setToolSchemaTokens] = useState(0);
  const toolsAvailableForDraft =
    !providerDelegatesWork && modelSupportsTools && effectiveMode !== "chat";
  const systemPromptForDraft = useMemo(() => {
    let prompt: string;
    if (effectiveMode === "chat" && (provider === "mlx" || provider === "ollama")) {
      prompt = `You are Kit, Klide's coding assistant — a calm, warm pair-programmer. Answer the user's latest message directly and concisely. You have no tools in this turn, so do not claim you can inspect or edit files unless file text was attached in the conversation. If asked who you are, you're Kit; never claim to be Claude, GPT, or any other product.

If the user asks about folders, files, the current directory, repository structure, git state, or anything that requires inspecting the workspace, do not answer from memory or earlier conversation. Say that this needs Plan or Goal mode so Klide can use read-only tools.

Important: do not output JSON, structured plans, or fake tool-call blocks. Just answer in natural language. The chat surface in this app renders any JSON you emit as raw noise, and the user won't see a clean answer.`;
    } else {
      prompt = buildSystemPrompt(
        workspaceRoot,
        stopAfterRejection,
        skills,
        effectiveMode,
        toolsAvailableForDraft,
        projectRules,
        harnessSettings,
        model
      );
    }
    if (effectiveMode !== "chat" && toolsAvailableForDraft && asksForWorkspaceInspection(input)) {
      prompt += `

This user request requires workspace inspection. Before answering, you MUST call list_dir with path "." (or the requested relative directory) and wait for its tool result. Do not answer from memory, do not infer from prior conversation, and do not say you used list_dir unless an actual list_dir tool result appears in this turn. For folder questions, answer only from the tool result's Folders section.`;
    }
    return prompt;
  }, [
    effectiveMode,
    harnessSettings,
    input,
    model,
    projectRules,
    provider,
    skills,
    stopAfterRejection,
    toolsAvailableForDraft,
    workspaceRoot,
  ]);

  useEffect(() => {
    let cancelled = false;
    async function countToolSchemas() {
      if (!toolsAvailableForDraft) {
        setToolSchemaTokens(0);
        return;
      }
      const tools = await toolsForMode(effectiveMode);
      if (cancelled) return;
      const disabled = new Set(
        Object.entries(harnessSettings?.toolOverrides ?? {})
          .filter(([, enabled]) => enabled === false)
          .map(([name]) => name)
      );
      const activeTools = (tools ?? []).filter((tool) => {
        const name = tool?.function?.name ?? tool?.name;
        return typeof name !== "string" || !disabled.has(name);
      });
      setToolSchemaTokens(estimateTokens(JSON.stringify(activeTools)));
    }
    void countToolSchemas();
    return () => { cancelled = true; };
  }, [effectiveMode, harnessSettings?.toolOverrides, toolsAvailableForDraft]);

  // The window's arithmetic lives in `ai/contextBudget.ts` — values in, values
  // out, and tested. It used to sit inline here, which meant the automatic
  // compaction threshold (and the compaction-marker exclusion that stops it
  // firing in a loop) could only be exercised by mounting the panel against a
  // live stream.
  //
  // Memoized in two halves. The message walk stringifies every tool call in
  // the thread and depends on `msgs` alone; the rest moves with each keystroke
  // of the draft. Unmemoized, the whole walk ran ~28 times a second while a
  // Run streamed and once more per keystroke while the user typed.
  const skillsPrompt = useMemo(() => enabledSkillsPrompt(skills), [skills]);
  const messageTokens = useMemo(() => conversationTokenEstimate(msgs), [msgs]);
  const budget = useMemo(
    () =>
      computeContextBudget({
        msgs,
        messageTokens,
        draft: input,
        systemPrompt: systemPromptForDraft,
        skillsPrompt,
        projectRules,
        lens: lensProjectContext,
        toolSchemaTokens,
        measuredPromptTokens,
        measuredUsageTokens,
        contextLimit: effectiveContextLimit,
        streaming,
      }),
    [
      msgs,
      messageTokens,
      input,
      systemPromptForDraft,
      skillsPrompt,
      projectRules,
      lensProjectContext,
      toolSchemaTokens,
      measuredPromptTokens,
      measuredUsageTokens,
      effectiveContextLimit,
      streaming,
    ],
  );
  const contextUsed = budget.used;
  const contextRatio = budget.ratio;
  const contextTone = contextToneFor(contextRatio);
  const contextBreakdownRows = budget.breakdown;
  const conversationCostUsd = useMemo(() => conversationCost(msgs), [msgs]);
  // Rows above the newest compaction marker draw dimmed. One scan per message
  // list, not two per row per render.
  const compactionMarkerIdx = useMemo(() => lastCompactionIndex(msgs), [msgs]);

  const canCompact = canCompactConversation({
    providerDelegatesWork,
    streaming,
    compacting,
    messageCount: msgs.length,
  });
  const showCompactPrompt = canCompact && contextRatio >= COMPACT_PROMPT_RATIO;

  // One-shot model calls (compaction, memory notes, skill detection) go
  // straight to `ai_chat`, which has no router. An Auto conversation asks the
  // model its turns actually ran on — the origin `RunStarted` stamped; before
  // a first run there is nothing to summarize anyway.
  const oneShotProvider = isAutoProvider(provider) ? (conversationSession.originProvider ?? provider) : provider;
  const oneShotModel = isAutoProvider(provider) ? (conversationSession.originModel ?? model) : model;

  async function compactConversation(
    source: "manual" | "agent" = "manual",
    contextWindow = effectiveContextLimit,
  ): Promise<boolean> {
    if (!canCompact) return false;
    setCompactSource(source);
    setCompacting(true);
    setCompactError(null);
    try {
      const older = msgs.slice(0, msgs.length - COMPACT_KEEP_RECENT);
      const recent = msgs.slice(msgs.length - COMPACT_KEEP_RECENT);
      if (older.length === 0) return false;
      const summary = await summarizeForCompaction(oneShotProvider, oneShotModel, older, contextWindow);
      if (!summary) throw new Error("Could not build a summary to compact with.");
      // Write the marker into the transcript the harness replays from — this
      // is what actually shrinks the next turn's context.
      await invoke("agent_compact_context", { runId: currentId, summary });
      // Mirror it in the panel so the view + gauge reflect the new state.
      // Break the folded slice into the two things the marker reports:
      // conversation messages (user + assistant turns) and tool calls.
      const compactedMessages = older.filter((m) => m.role === "user" || m.role === "assistant").length;
      const compactedToolCalls = older.reduce(
        (n, m) => n + (m.role === "assistant" ? m.toolCalls?.length ?? 0 : 0),
        0,
      );
      const summaryMsg: Msg = {
        role: "system",
        content: `Compacted ${older.length} earlier message${older.length === 1 ? "" : "s"}:\n${summary}`,
        compaction: { count: older.length, summary, source, messages: compactedMessages, toolCalls: compactedToolCalls },
      };
      // Keep the whole conversation in the panel for reference; the marker is
      // just a divider. The model's context is freed via the transcript marker
      // (replay collapses everything before it), and the token gauge counts
      // only from the marker onward — so nothing visible is lost.
      const next: Msg[] = [...older, summaryMsg, ...recent];
      setMsgs(next);
      msgsRef.current = next;
      // Drop the stale measured usage so the gauge falls back to the (now
      // smaller) estimate until the next turn re-measures.
      setMeasuredPromptTokens(null);
      setMeasuredUsageTokens(null);
      return true;
    } catch (e) {
      setCompactError(String(e));
      return false;
    } finally {
      setCompacting(false);
    }
  }

  const [conversations, setConversations] = useState<Conversation[]>(() => loadConversations<Conversation>());
  const [historyOpen, setHistoryOpen] = useState(false);
  // Every panel renders the same durable Conversation index. Same-window
  // localStorage writes do not emit the browser's `storage` event, so consume
  // the focused event published by persistConversation and refresh metadata
  // written by sibling panels instead of keeping a stale per-panel copy.
  useEffect(() => {
    const reload = () => setConversations(loadConversations<Conversation>());
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, reload);
  }, []);
  const queueRef = useRef<QueuedTurn[]>([]);
  const processingQueueRef = useRef(false);
  const queueGenerationRef = useRef(0);
  const activeHarnessRunRef = useRef<string | null>(null);
  // Live subscription to a run that was still going when this panel mounted
  // (see the mount reconnect effect). Held so we can detach on unmount / when
  // the run settles, and so a conversation switch doesn't leave it listening.
  const reattachRef = useRef<RunReattachment | null>(null);
  // MLX's port can be up while the model is still cold (false readiness), which
  // makes the first message stream-error. We warm the model on the first send
  // for a given model and remember it here so later sends skip the round-trip;
  // a model switch or a stream error clears it to force a re-warm.
  const mlxWarmedRef = useRef<string | null>(null);

  // Fill in an exact per-message token count for user messages, using the
  // active model's own tokenizer (Ollama / Anthropic) where available. User
  // messages are append-only, so their index is stable once created — we patch
  // by index after verifying the row is still the same message. The seen-set is
  // keyed by index + length + model so a model switch re-counts.
  const tokenCountedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!mayActivateModel({ deferred: modelActivationDeferred, managedLocal: isLocalProvider })) return;
    let cancelled = false;
    msgs.forEach((m, i) => {
      if (m.role !== "user" || m.tokenInfo || !m.content.trim()) return;
      const text = m.content;
      const key = `${i}:${text.length}:${provider}:${model}`;
      if (tokenCountedRef.current.has(key)) return;
      tokenCountedRef.current.add(key);
      void countMessageTokens(provider, model, text)
        .then((info) => {
          if (cancelled) return;
          const cur = msgsRef.current[i];
          if (cur?.role === "user" && cur.content === text && !cur.tokenInfo) {
            const next = [...msgsRef.current];
            next[i] = { ...cur, tokenInfo: info };
            msgsRef.current = next;
            setMsgs(next);
          }
        })
        .catch(() => {});
    });
    return () => {
      cancelled = true;
    };
  }, [msgs, provider, model, modelActivationDeferred, isLocalProvider]);

  function abortActiveHarnessRun() {
    const runId = activeHarnessRunRef.current;
    if (!runId) return;
    activeHarnessRunRef.current = null;
    void stopAgentRun(runId).catch((e) => console.error("Failed to abort harness run:", e));
  }

  function stopCurrentStream() {
    // Stop pressed during warm-up: no harness run exists yet, so flag the
    // pending send to bail once the server is ready (see send()).
    if (serverStarting) cancelledWarmupRef.current = true;
    abortActiveHarnessRun();
    if (delegateSession) { void stopDelegatePty(delegateSessionId(currentId, provider)); }
    // Bump the queue generation so any in-flight runProcessQueue sees its
    // tokens as stale and bails before it can start another turn.
    queueGenerationRef.current += 1;
    processingQueueRef.current = false;
    settleConversationRun();
    // The harness is being aborted; the run loop will emit a paused-state
    // exit on its own. Clear any visible Q&A card so the UI doesn't show a
    // question whose answer can never arrive.
    setPendingQuestion(null);
    setPendingPermission(null);
    setQuestionAnswer("");
  }

  // Switching conversations (or loading one from history) starts a fresh
  // revert scope — the previous run's changes are no longer "what I just did".
  // Also drop any mount-time reattach listener bound to the previous id (the
  // reconnect effect is mount-only, so it won't re-follow the new one — the
  // adopt guard already blocks stale writes; this just stops the leak).
  useEffect(() => {
    runChangedPathsRef.current = new Set();
    setRevertableFiles(0);
    reattachRef.current?.detach();
    reattachRef.current = null;
  }, [currentId]);

  // One-click undo of every file this run wrote, then re-sync the open editors
  // and workbench to the reverted on-disk state. `revertRunCheckpoints` rolls
  // the run's whole checkpoint set back; the per-file/per-turn granularity
  // still lives in the Mission Control CheckpointPanel.
  async function revertThisRun() {
    const count = revertableFiles;
    if (count === 0 || reverting) return;
    if (!window.confirm(`Revert ${count} file change${count === 1 ? "" : "s"} this run made?`)) return;
    const paths = Array.from(runChangedPathsRef.current);
    setReverting(true);
    try {
      await revertRunCheckpoints(currentId);
      runChangedPathsRef.current = new Set();
      setRevertableFiles(0);
      if (workspaceRoot && onFileWritten) {
        for (const p of paths) {
          try {
            onFileWritten(p, await readWorkspaceTextFile(workspaceRoot, p));
          } catch {
            /* the run created this file → it's gone again after revert */
          }
        }
      }
      onWorkspaceChanged?.();
    } catch (e) {
      console.error("Failed to revert run:", e);
    } finally {
      setReverting(false);
    }
  }

  // File edits are already on disk by the time the run finishes. Accepting
  // them consumes the rollback checkpoints without touching those files, so a
  // later turn's Revert can never reach back across this accepted boundary.
  async function acceptThisRunChanges() {
    if (revertableFiles === 0 || streaming || reverting || acceptingChanges) return;
    setAcceptingChanges(true);
    try {
      await acceptRunCheckpoints(currentId);
      runChangedPathsRef.current = new Set();
      setRevertableFiles(0);
    } catch (e) {
      console.error("Failed to accept run changes:", e);
      notify(`Couldn't accept the modifications: ${e instanceof Error ? e.message : String(e)}`, { tone: "error" });
    } finally {
      setAcceptingChanges(false);
    }
  }

  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);

  // Smart auto-scroll: only follow the latest token when the user is
  // already at (or within a few pixels of) the bottom. If they've scrolled
  // up to read earlier context, new tokens don't yank them back — the
  // panel surfaces a "Jump to latest" pill instead. We use a ref for the
  // sticky flag (no re-render on every scroll event) and a state mirror
  // (drives the pill's visibility).
  //
  // The flag is forced to true at every "the user is at the start of
  // something new" boundary: new user message, new assistant turn,
  // conversation switch. See `forceStickToBottom` below.
  const STICK_THRESHOLD_PX = 48;
  const stickToBottomRef = useRef(true);
  const [stickToBottom, setStickToBottom] = useState(true);
  const [todoDockHeight, setTodoDockHeight] = useState(0);
  // In Focus the plan is an island at the canvas' top-right; while it is up
  // the conversation column is centred in the space to its left instead of
  // under it (see `focusGutterLeft` / `focusGutterRight`).
  const [planSlot, setPlanSlot] = useState<TodoStripSlot>("none");

  function forceStickToBottom() {
    stickToBottomRef.current = true;
    setStickToBottom(true);
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }

  function updateStickFromScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isStuck = distanceFromBottom <= STICK_THRESHOLD_PX;
    if (stickToBottomRef.current !== isStuck) {
      stickToBottomRef.current = isStuck;
      setStickToBottom(isStuck);
    }
  }

  // There is deliberately no `msgsRef.current = msgs` effect here. Every
  // mutation already goes through `transitionConversation`, which advances the
  // ref synchronously — ahead of the React commit, on purpose, because the run
  // callbacks are async and need the latest array before React has rendered it.
  // Mirroring the *rendered* `msgs` back into the ref could therefore only ever
  // move it backwards, and a rewound ref is not a cosmetic lag: the turn
  // driver's region splice compares the array it is handed against the rows it
  // last projected, by reference, and detaches for the rest of the run when
  // they disagree. That is one way a run's final answer ends up on disk and
  // never on screen.

  /**
   * Reconnect a conversation to the Harness Run still working on it, if there
   * is one. The harness keeps running in Rust and writing its transcript, but
   * the request-scoped event channel from `startAgentRun` belongs to the mount
   * — and the turn generation — that opened it. So we (1) rebuild from the
   * on-disk transcript, which has the (possibly finished) reply, and (2) if the
   * run is STILL going, follow the global reattach stream so it keeps updating
   * instead of freezing at a stale snapshot.
   *
   * Called on mount and on every conversation adoption. Leaving a thread no
   * longer stops its agent (see `detachFromActiveRun`), so coming back to one
   * has to pick its live stream up again — otherwise the row animates in the
   * rail while the panel shows a frozen transcript.
   *
   * Klide runs only: conversation id == transcript id. A delegate *session*
   * streams through the PTY and has no transcript to re-read; a delegate run
   * on the headless Focus path does, and follows like any other.
   */
  function followConversationRun(conversationId: string, runProvider: ProviderId) {
    if (isDelegateProvider(runProvider) && variant !== "focus") return;
    {
      const reattachId = conversationId;
      const baseLen = msgsRef.current.length;
      void (async () => {
        // Re-read the transcript and adopt the replay, guarding against a
        // conversation switch mid-await and against clobbering typing. Reports
        // the event count and whether the transcript *tail* is terminal — the
        // harness writes RunResult/RunError to disk before it flips the run's
        // status, so the tail is the authoritative "is this turn done" signal.
        const adopt = async (
          guardBaseLen?: number,
        ): Promise<{ len: number; terminal: boolean; events: AgentEvent[] }> => {
          const events = await readAgentRunEvents(reattachId);
          // Turns queued locally (waiting for this external run to settle)
          // aren't in the transcript yet — carry them across the replay or a
          // long-running race run would silently swallow an "ask both" send.
          // That rule, and the refusal to adopt a replay shorter than what is
          // on screen, live in `replayForAdoption`: the post-turn heal in
          // `runHarnessTurn` adopts on exactly the same terms.
          const replayed = replayForAdoption(events, msgsRef.current);
          const safe =
            replayed !== null &&
            conversationSessionRef.current.conversationId === reattachId &&
            (guardBaseLen === undefined || msgsRef.current.length === guardBaseLen);
          if (safe) setMsgs(replayed);
          const tail = events[events.length - 1]?.type;
          return {
            len: events.length,
            terminal: tail === "run_result" || tail === "run_error",
            events,
          };
        };

        /**
         * Put back whatever the run is parked on. The card is drawn by the
         * panel and answered by the panel, so a run that asked while nobody was
         * watching would otherwise wait on a question with no surface — and the
         * queue waits with it, since a parked run never settles.
         *
         * Only ever called for a run Rust still holds. A transcript can end on
         * an unanswered request with no terminal event — that is exactly what a
         * run killed with the app looks like — and restoring a card for a run
         * that no longer exists would offer an approval nothing is listening
         * for. See agent/pendingGates.ts.
         */
        const restoreGates = (events: AgentEvent[]) => {
          if (conversationSessionRef.current.conversationId !== reattachId) return;
          const gates = pendingGatesFromEvents(events);
          setPendingPermission((current) =>
            gates.permission
              ? current?.requestId === gates.permission.id
                ? current
                : permissionCard(reattachId, gates.permission)
              : current?.runId === reattachId
                ? null
                : current,
          );
          setPendingDiff((current) =>
            gates.diff
              ? current?.id === gates.diff.id
                ? current
                : gates.diff
              : current?.runId === reattachId
                ? null
                : current,
          );
          setPendingQuestion((current) =>
            gates.question
              ? current?.requestId === gates.question.requestId
                ? current
                : gates.question
              : current?.runId === reattachId
                ? null
                : current,
          );
        };

        let snapshot: { len: number; terminal: boolean; events: AgentEvent[] };
        try {
          snapshot = await adopt(baseLen);
        } catch {
          return; // no transcript for this id (brand-new chat) — nothing to reconnect
        }
        if (snapshot.terminal) return; // already finished — snapshot is the final word

        // Is the run still live in Rust? If not, the snapshot is the final word
        // — including any request it ends on, which belongs to a run that died
        // with the process and can no longer be answered.
        let status: string | null = null;
        try { status = await getAgentRunStatus(reattachId); } catch { /* ignore */ }
        if (
          !isActiveRunStatus(status) ||
          conversationSessionRef.current.conversationId !== reattachId
        ) return;

        // Follow it live. Every persisted event just signals "re-read the
        // transcript" — disk is the source of truth, so there are no gaps to
        // reconcile and dedup is implicit in the full replay.
        startConversationRun();
        activeHarnessRunRef.current = reattachId;
        restoreGates(snapshot.events);
        const settle = () => {
          settleConversationRun();
          if (activeHarnessRunRef.current === reattachId) activeHarnessRunRef.current = null;
          reattachRef.current?.detach();
          reattachRef.current = null;
        };
        const reatt = await reattachAgentRun(reattachId, snapshot.len, (event) => {
          void adopt().then((next) => restoreGates(next.events)).catch(() => {});
          if (event.type === "run_result" || event.type === "run_error") settle();
        });
        // A conversation switch during the listen await would have moved
        // currentId — drop the fresh listener instead of leaking it.
        if (conversationSessionRef.current.conversationId !== reattachId) {
          reatt.detach();
          settleConversationRun();
          return;
        }
        reattachRef.current = reatt;
        // Close the snapshot→subscribe race: a terminal event emitted while we
        // were registering the listener won't arrive live. Re-read the tail
        // (authoritative) and settle if the run already finished.
        try {
          const post = await adopt();
          restoreGates(post.events);
          if (post.terminal) settle();
        } catch { /* ignore transient read error */ }
      })();
    }
  }

  /**
   * Stop following this panel's run — without stopping the run.
   *
   * Leaving a conversation is navigation, not a decision to kill the agent
   * working in it. The loop lives in Rust, so the panel only has to stop
   * listening: the live channel from `startAgentRun` can't be closed from
   * here, so its turn generation is retired instead (`handleEvent` drops
   * everything from the old turn) and any reattach listener is dropped. The
   * run keeps going, its rail row keeps animating, and `followConversationRun`
   * picks it back up when you return.
   *
   * A run parked on a diff, a permission or a question survives too: the panel
   * drops its card here and rebuilds it from the transcript on return (see
   * `agent/pendingGates.ts`). Returns the decision from `ai/leavingRun.ts` so
   * the caller can keep the run board in step with it.
   */
  function detachFromActiveRun(): RunLeaveDecision {
    const decision = decideOnLeavingRun({
      hasActiveRun: activeHarnessRunRef.current !== null,
    });
    // Retire the turn generation: the live channel's events now fall out of
    // `handleEvent` instead of landing in whatever conversation is adopted
    // next, and any queue drain for the thread we're leaving bails.
    queueGenerationRef.current += 1;
    processingQueueRef.current = false;
    if (decision.abort) abortActiveHarnessRun();
    else activeHarnessRunRef.current = null;
    reattachRef.current?.detach();
    reattachRef.current = null;
    settleConversationRun();
    return decision;
  }

  // Restoration itself is synchronous and atomic in Conversation Session. This
  // mount-only effect reconnects the restored identity to its run, if it has
  // one. Intentionally only the *initial* conversation matters — subsequent
  // edits (loadConversation, newConversation) follow their own.
  useEffect(() => {
    const restored = conversationSessionRef.current;
    followConversationRun(restored.conversationId, restored.provider);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clear any pending auto-save notice when the panel unmounts (timer would
  // otherwise fire setState on a dead component). Also drop any live reattach
  // listener — the run keeps going in Rust and the next mount reattaches fresh.
  useEffect(() => () => {
    if (autoMemoryTimerRef.current !== null) {
      clearTimeout(autoMemoryTimerRef.current);
      autoMemoryTimerRef.current = null;
    }
    reattachRef.current?.detach();
    reattachRef.current = null;
  }, []);

  useEffect(() => {
    if (!actionsOpen) return;
    function onDown(e: MouseEvent) {
      if (actionsRef.current && !actionsRef.current.contains(e.target as Node)) {
        setActionsOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [actionsOpen]);

  function newConversation() {
    if (delegateSession) { void stopDelegatePty(delegateSessionId(currentId, provider)); }
    setHistoryOpen(false);
    // Mark the previous chat as done on the run board so a "new chat" doesn't
    // leave a stale "running" row — unless it really is still running, which it
    // now can be: starting a fresh chat leaves the previous agent working.
    const leaving = detachFromActiveRun();
    if (leaving.settle) settleKlideConvo(currentId);
    const nid = genId();
    setModelActivationDeferred(false);
    manuallyInspectedModelRef.current = null;
    transitionConversation({ type: "fresh-started", conversationId: nid, branch: workspaceBranch });
    setMeasuredPromptTokens(null);
    setMeasuredUsageTokens(null);
    setCompactError(null);
    queueRef.current = [];
    queueGenerationRef.current += 1;
    processingQueueRef.current = false;
    setInput("");
    // The auto-save notice belongs to the previous conversation — clear it
    // so the fresh chat starts on a clean slate.
    if (autoMemoryTimerRef.current !== null) {
      clearTimeout(autoMemoryTimerRef.current);
      autoMemoryTimerRef.current = null;
    }
    setAutoMemoryNotice(null);
    // Same for any in-flight Q&A card — a fresh chat shouldn't inherit
    // the previous turn's question.
    setPendingQuestion(null);
    setPendingPermission(null);
    setQuestionAnswer("");
    // Fresh id per chat — the prior "reset to panelId" pattern was
    // re-threading the previous transcript into the new run via the
    // agent harness's replay path, so "new conversation" silently
    // inherited the old one's memory. The first conversation in a
    // panel is restored through Conversation Session, while every subsequent
    // chat gets its own transcript identity. The fresh identity was persisted
    // by the `fresh-started` transition above, so a view switch cannot rotate
    // it again before the first Run starts.
  }

  // Focus-home handoff: the hero composer's text arrives as `initialMessage`.
  // Two-phase on purpose — `newConversation()` mints the fresh conversation id
  // via state, so the actual send waits one render for that id to commit
  // before going through the normal composer path (warmup, modes, queueing).
  const [pendingHeroSend, setPendingHeroSend] = useState<{
    text: string;
    attachments: Attachment[];
  } | null>(null);
  const consumedInitialMessageRef = useRef<string | null>(null);
  // Read at consumption time rather than through the effect's deps: the
  // attachments arrive in the same render as the text, and re-running on a new
  // array identity would re-send the same opening turn.
  const initialAttachmentsRef = useRef<Attachment[]>([]);
  initialAttachmentsRef.current = initialAttachments ?? [];
  useEffect(() => {
    const text = initialMessage?.trim() ?? "";
    const staged = initialAttachmentsRef.current;
    // An attachment-only handoff is a real turn — a dropped screenshot with no
    // words — so the guard is "nothing at all", not "no text".
    if (!text && staged.length === 0) return;
    const receipt = `${text}::${staged.map((a) => a.path).join("|")}`;
    if (consumedInitialMessageRef.current === receipt) return;
    consumedInitialMessageRef.current = receipt;
    onInitialMessageConsumed?.();
    if (msgsRef.current.length > 0) newConversation();
    setPendingHeroSend({ text, attachments: staged });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessage, initialAttachments]);
  useEffect(() => {
    if (pendingHeroSend === null) return;
    const turn = pendingHeroSend;
    setPendingHeroSend(null);
    void send({ text: turn.text, attachments: turn.attachments });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingHeroSend]);

  // Race "ask both" handoff: a follow-up for the CURRENT conversation. Goes
  // through the normal composer path (send → enqueue → drain), so if the
  // racer's externally-started run is still streaming the turn waits its
  // turn in the queue instead of racing it.
  const consumedFollowUpRef = useRef<number>(0);
  useEffect(() => {
    if (!followUpMessage || consumedFollowUpRef.current === followUpMessage.nonce) return;
    consumedFollowUpRef.current = followUpMessage.nonce;
    const text = followUpMessage.text.trim();
    onFollowUpConsumed?.();
    if (!text) return;
    void send({ text });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followUpMessage]);

  // Messages other agents have queued for this thread that its Run has not
  // taken in yet — read from the journal, refreshed on its change event, so
  // they show here the moment they are sent rather than at the next turn.
  const pendingInbox = useCoordinationInbox(workspaceRoot, currentId);
  // The one conversation this thread is talking to right now: whoever has
  // something waiting for it, else the peer it last exchanged with. One link,
  // not a row of every peer it ever met.
  const coordinationPeers = useMemo(() => {
    const senders = inboxSenders(pendingInbox);
    const latest = senders.length > 0 ? senders[senders.length - 1] : latestCoordinationPeer(msgs);
    return latest ? [latest] : [];
  }, [msgs, pendingInbox]);
  const peerIndex = usePeerIndex();

  // Write a structured memory note to .klide/memory/. Delegates to
  // summarizeAndHandoff so the prompt + parsing live in one place; we
  // just feed it the conversation + show the user a transient state.
  async function runSummarize() {
    if (!workspaceRoot || summarizing || msgs.length === 0) return;
    setSummarizing(true);
    try {
      const entry = await summarizeAndHandoff({
        workspaceRoot,
        provider: oneShotProvider,
        model: oneShotModel,
        mode: normalizeAgentMode(agentMode),
        msgs,
        runId: null,
        status: null,
      });
      onMemoryWritten?.({ relPath: entry.relPath, title: entry.title });
    } catch (err) {
      // The Summarize button sits in the header with no slot for an
      // inline error — log to the console for the curious user and let
      // the icon's title attribute carry a one-line message on hover.
      // (A toast/notice system would be the right place for this, but
      // it's not in scope for v1.)
      console.error("Summarize failed:", err);
    } finally {
      setSummarizing(false);
    }
  }

  // Auto-summarize a finished run. Fire-and-forget — the run is already
  // done, the user has moved on, and the worst case is a model call that
  // fails silently. The call is keyed to the run's `currentId` and
  // status "done" so the entry's frontmatter tells a future agent when
  // and why it was written. The inline notice under the composer is the
  // only UI feedback — a one-line ✓ Auto-saved to memory, fades after a
  // few seconds, distinct from the manual Summarize button's text.
  //
  // Skips when there are fewer than two messages: a single user message
  // with no assistant reply isn't a conversation worth summarising.
  async function runAutoSummarize(turn: QueuedTurn) {
    if (!workspaceRoot || summarizing) return;
    const snapshot = msgsRef.current;
    if (snapshot.length < 2) return;
    setSummarizing(true);
    try {
      // Reviewable memory: generate the note but DON'T write it. Park it as a
      // draft the user accepts / edits / skips from the Memory modal before it
      // becomes durable. The manual "Summarize" action still writes directly.
      // The note is written by the model that ran the turn; on Auto that is
      // the origin the run stamped, not the picker's sentinel.
      const origin = conversationSessionRef.current;
      const note = await generateMemoryNote({
        workspaceRoot,
        provider: isAutoProvider(turn.provider) ? (origin.originProvider ?? turn.provider) : turn.provider,
        model: isAutoProvider(turn.provider) ? (origin.originModel ?? turn.model) : turn.model,
        mode: normalizeAgentMode(turn.mode),
        msgs: snapshot,
        runId: currentId,
        status: "done",
      });
      addMemoryDraft(note, workspaceRoot);
      // Signal a draft is ready; the "review draft" pencil under the last
      // reply surfaces it (no fading pill, no timer). Cleared on the next
      // turn / cancel / history load via the existing reset paths.
      setAutoMemoryNotice(note.title);
    } catch (err) {
      console.error("Auto-summarize failed:", err);
    } finally {
      setSummarizing(false);
    }
  }

  // Detect a reusable pattern in the current conversation and write a
  // SKILL.md to .klide/skills/. Two model calls (classify, then draft);
  // the file loader picks the new skill up on the next refresh.
  async function runGenerateSkill() {
    if (!workspaceRoot || generatingSkill || msgs.length < 2) return;
    setGeneratingSkill(true);
    try {
      const skill = await detectAndGenerateSkill({
        workspaceRoot,
        provider: oneShotProvider,
        model: oneShotModel,
        mode: normalizeAgentMode(agentMode),
        msgs,
      });
      if (skill) {
        onSkillGenerated?.({ relPath: skill.relPath, name: skill.name });
      } else {
        // No reusable pattern detected — surface to the console + tooltip.
        console.info("No reusable pattern detected for this session.");
      }
    } catch (err) {
      console.error("Generate skill failed:", err);
    } finally {
      setGeneratingSkill(false);
    }
  }

  function loadConversation(c: Conversation) {
    setHistoryOpen(false);
    // Re-selecting the thread already on screen while its run is streaming
    // here must not re-adopt it: detaching would drop the one channel that
    // carries token deltas (the reattach broadcast is structural events
    // only), freezing the view between tool calls until whole messages land.
    // The click asked for exactly what is showing — jump to the tail and out.
    if (
      !shouldReadoptConversation({
        sameConversation: c.id === conversationSessionRef.current.conversationId,
        followingLiveRun: activeHarnessRunRef.current !== null,
      })
    ) {
      forceStickToBottom();
      return;
    }
    // Opening another thread used to abort whatever this one was running —
    // clicking a sibling row in the rail silently killed a working agent. The
    // run is left alone now; only this panel's subscription to it ends.
    detachFromActiveRun();
    // Adopting history must not become an implicit model request. The saved
    // Provider/model pair is shown immediately, but inspection + warm-up wait
    // for the first real send from this transcript.
    setModelActivationDeferred(true);
    manuallyInspectedModelRef.current = null;
    transitionConversation({ type: "resumed", conversation: c });
    // Keep the host's panel record aligned with the atomically adopted
    // Conversation configuration.
    if (c.provider && c.provider !== provider) {
      if (panelId) localStorage.setItem(`klide.provider.${panelId}`, c.provider);
      onProviderChange?.(c.provider);
    }
    if (c.model && c.model !== model) onModelChange(c.model);
    // Explicit resume is intent to continue this Conversation across a
    // remount; the `resumed` transition above persisted that binding.
    // No usage stored with history → estimate until this chat's next turn.
    setMeasuredPromptTokens(null);
    setMeasuredUsageTokens(null);
    setCompactError(null);
    queueRef.current = [];
    queueGenerationRef.current += 1;
    // Drop the previous chat's auto-save notice so the loaded history
    // doesn't display a stale "Auto-saved" pill.
    if (autoMemoryTimerRef.current !== null) {
      clearTimeout(autoMemoryTimerRef.current);
      autoMemoryTimerRef.current = null;
    }
    setAutoMemoryNotice(null);
    // Loaded history can't have a live Q&A pending — clear the card so
    // we don't show a question the new run hasn't asked yet.
    setPendingQuestion(null);
    setPendingPermission(null);
    setQuestionAnswer("");
    // Switching conversations is a navigation event: jump to the bottom
    // of the new chat. Without this, an old scroll position from the
    // previous chat sticks, and the user has to scroll to find the
    // latest message.
    forceStickToBottom();
    // The adopted thread may itself have a run still going — one you started
    // here and walked away from, or one another panel left behind. Pick its
    // live stream back up rather than showing the transcript as it stood when
    // you left.
    followConversationRun(c.id, c.provider ?? provider);
  }

  function deleteConversation(id: string, e: ReactMouseEvent) {
    e.stopPropagation();
    // Deletion is another whole-index write, so base it on the durable store
    // rather than this panel's possibly stale rendered copy. Forgetting it
    // publishes the deletion, and the listener below is what lets go of the
    // thread if it is the one this panel is showing — the same path the rail
    // and Settings storage take, so there is one reaction, not three.
    setConversations(forgetStoredConversation(id));
    deleteKlideConvo(id);
  }

  // The thread this panel is showing was deleted — here, from the rail, or
  // from Settings storage. Start fresh rather than keep rendering a snapshot
  // that the next persist would quietly write back into history. Read through
  // a ref so the subscription is made once yet always sees the live identity.
  const onConversationDeletedRef = useRef<(deletedId: string) => void>(() => {});
  onConversationDeletedRef.current = (deletedId) => {
    if (deletedId !== currentId) return;
    const nid = genId();
    transitionConversation({ type: "fresh-started", conversationId: nid, branch: workspaceBranch });
    setMeasuredPromptTokens(null);
    setMeasuredUsageTokens(null);
  };
  useEffect(() => {
    const onDeleted = (event: Event) => {
      const detail = (event as CustomEvent<ConversationDeletedDetail | undefined>).detail;
      if (detail) onConversationDeletedRef.current(detail.conversationId);
    };
    window.addEventListener(CONVERSATION_DELETED_EVENT, onDeleted);
    return () => window.removeEventListener(CONVERSATION_DELETED_EVENT, onDeleted);
  }, []);

  // Only auto-scroll on token updates when the user is at the bottom.
  // The ref read is intentional — we don't want a state dependency here,
  // which would re-arm the effect on every scroll event and create a
  // feedback loop. See the `stickToBottomRef` block above.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nextHeight = el.scrollHeight;
    if (stickToBottomRef.current) el.scrollTo({ top: nextHeight });
  }, [msgs]);

  // The todo strip docks *over* the bottom of this list, so the list pads its
  // foot by the strip's height (see the scroll container's padding) — the last
  // message can always scroll clear of it. When that height changes, a reader
  // who was at the bottom stays there.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) el.scrollTo({ top: el.scrollHeight });
  }, [todoDockHeight]);

  // Load a resumed conversation from Mission Control. After loading, ping
  // the parent so it can clear `resumeConversation` — otherwise re-clicking
  // the same run from Mission Control is a no-op (the effect would bail
  // on the same id).
  const prevResumeRef = useRef<string | null>(null);
  useEffect(() => {
    if (resumeConversation && resumeConversation.id !== prevResumeRef.current) {
      prevResumeRef.current = resumeConversation.id;
      loadConversation(resumeConversation);
      onResumeConsumed?.();
    }
    if (!resumeConversation) prevResumeRef.current = null;
  }, [resumeConversation, onResumeConsumed]);

  // Drain the App-level "spawn me a new panel" queue entry on mount, after
  // the initial provider + resume/task have been wired through. Fires once.
  const initialDrainedRef = useRef(false);
  useEffect(() => {
    if (initialDrainedRef.current) return;
    if (!initialProvider) return;
    initialDrainedRef.current = true;
    onInitialConsumed?.();
    // Intentional: only the *presence* of initialProvider matters. Subsequent
    // edits should not re-fire the consume callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialProvider]);

  // Grow the composer with what is typed into it — but never from a
  // measurement taken while the box has no width to measure in. Two rules,
  // both learned from a composer that came up at its 160px cap and stayed
  // there: an EMPTY composer is never measured (WebKit lays the placeholder
  // out inside the box, so in a narrow pane the placeholder wraps and the
  // "content" height is the placeholder's, not the caret's — `rows={1}` and
  // the min-height own that case), and a box that has not been laid out yet
  // is left alone until it has been. The old effect re-ran only on `input`,
  // so one bad measurement was permanent.
  const autosizeComposer = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    if (ta.value === "") {
      ta.style.height = "";
      return;
    }
    if (ta.clientWidth === 0) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, []);

  useEffect(() => {
    autosizeComposer();
  }, [input, autosizeComposer]);

  // A composer whose pane changes width has to be re-measured: the same text
  // wraps to a different number of lines in a Focus half than it did in the
  // full canvas. Width only — reacting to the height we just set ourselves
  // would be a loop.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta || typeof ResizeObserver === "undefined") return;
    let lastWidth = ta.clientWidth;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width === lastWidth) return;
      lastWidth = width;
      autosizeComposer();
    });
    observer.observe(ta);
    return () => observer.disconnect();
  }, [autosizeComposer]);

  // Persist the conversation — debounced (trailing). Streaming commits a new
  // session object every ~50 ms, and each persist is a full index round-trip
  // (JSON.parse + stringify of up to 100 conversations) on the main thread;
  // only the last commit in a burst matters. The unmount flush below covers
  // a panel that goes away inside the debounce window.
  const persistTimerRef = useRef<number | null>(null);
  useEffect(() => {
    const snapshot = snapshotConversationSession(conversationSession);
    if (!snapshot) return;
    if (persistTimerRef.current !== null) window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      setConversations(persistConversation(snapshot));
    }, 1_000);
    return () => {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [conversationSession]);

  // Flush whatever the latest commit was on unmount so a view switch
  // mid-stream doesn't drop the in-flight conversation. `msgsRef` is
  // already kept in sync above, and the persist effect above will
  // have run for the most recent state when React re-rendered.
  useEffect(() => () => {
    const snapshot = snapshotConversationSession(conversationSessionRef.current);
    if (snapshot) persistConversation(snapshot);
    // Everything mutable reads through the Conversation Session ref: this []
    // cleanup otherwise sees first-render values after a history or Provider
    // switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!historyOpen) return;
    function onDown(e: MouseEvent) { if (historyRef.current && !historyRef.current.contains(e.target as Node)) setHistoryOpen(false); }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [historyOpen]);

  // Persist the per-provider model memory — but never on mount: at mount the
  // provider was restored from this panel's own storage while `model` is
  // App's last value for the panel, and after a relaunch those can belong to
  // DIFFERENT providers (an Ollama tag under `klide.model.claude-code` is how
  // a delegate once spawned with `--model pierreprudh/lfm2.5…`). Only picks
  // made after mount — always provider-consistent — are worth remembering.
  const modelPersistArmed = useRef(false);
  useEffect(() => {
    if (!modelPersistArmed.current) {
      modelPersistArmed.current = true;
      return;
    }
    // A model the *Provider* chose (the current pick was retired from its
    // list) reaches this effect indistinguishably from one a human picked, and
    // writing it makes the substitute the remembered default forever. That is
    // how one stale pick became a permanent one: the panel landed on the
    // oldest star for the Provider, wrote it here, and every later mount read
    // it back. Retirements announce themselves through this ref and are not
    // remembered; the pick they replace stays the last human answer.
    if (autoPickedModelRef.current === model) {
      autoPickedModelRef.current = null;
      return;
    }
    localStorage.setItem(`klide.model.${provider}`, model);
  }, [model, provider]);

  useEffect(() => {
    let cancelled = false;
    async function loadProviderModels() {
      try {
        const names = await listProviderModels(provider);
        if (cancelled) return;
        if (!isLocalProvider) setConnected(true);
        const fallbackModel = defaultModelForProvider(provider);
        const next = names.length > 0 ? [...names] : fallbackModel ? [fallbackModel] : [];
        // Built-in delegate CLIs always offer "default" first: spawn with no
        // model flag, so the CLI opens on its own configured default model.
        if (isDelegateId(provider) && !next.includes(CLI_DEFAULT_MODEL)) {
          next.unshift(CLI_DEFAULT_MODEL);
        }
        onAvailableModelsChange(next);
        // The Provider does not serve the current pick, so it has to move —
        // but to the best-evidenced model, not to whichever star is oldest
        // (`unavailableModelFallback` records what that cost).
        const retired = unavailableModelFallback({
          available: next,
          sessionModel: model,
          rememberedModel: storedModelForProvider(provider),
          providerDefault: fallbackModel,
          favourites: favModelsFor(provider),
        });
        if (retired) retireModel(retired);
      } catch {
        if (cancelled) return;
        setConnected(false);
        // A list that failed to load has said nothing about which models this
        // Provider has, so it cannot retire the one the panel is on. Falling
        // back to the remembered model here used to turn a network blip into a
        // model pick — and the remembered value can belong to another Provider
        // (an Ollama tag under a self-hosted endpoint), which is how a Qwen
        // conversation ended up saved as an LFM one.
        const fallback = offlineModelFallback(model, storedModelForProvider(provider));
        onAvailableModelsChange([fallback]);
        if (model !== fallback) retireModel(fallback);
      }
    }
    void loadProviderModels();
    return () => { cancelled = true; };
  }, [provider, apiKeyVersion, serverRefresh, model]);

  useEffect(() => {
    if (!isLocalProvider) {
      setServerRunning(false);
      return;
    }
    let timer: ReturnType<typeof setInterval>;
    async function check() {
      try {
        const running = await readLocalProviderStatus(provider);
        setServerRunning(running);
        setConnected(running);
        if (running) setServerError(null);
      } catch {
        setServerRunning(false);
        setConnected(false);
      }
    }
    check();
    timer = setInterval(check, 4000);
    return () => clearInterval(timer);
  }, [provider]);

  function applyModelInspection(inspection: ModelInspection) {
    setModelSupportsTools(inspection.supportsTools);
    setModelSupportsReflection(inspection.supportsReflection);
    setModelSupportsVision(inspection.supportsVision);
    setContextLimit(inspection.contextLimit);
    // Losing vision (a model switch) invalidates staged photos only. The
    // documents alongside them are text, and every model still reads those.
    if (!inspection.supportsVision) {
      setPendingAttachments((prev) => prev.filter((a) => !isPhotoAttachment(a)));
    }
  }

  async function activateModelInspectionForSend(): Promise<ModelInspection> {
    if (!modelActivationDeferred || !isLocalProvider) {
      return {
        supportsTools: modelSupportsTools,
        supportsReflection: modelSupportsReflection,
        supportsVision: modelSupportsVision,
        contextLimit,
      };
    }
    const inspection = await inspectModelForRun(provider, model);
    // Clearing the gate re-arms the ordinary effect below. Mark this exact
    // pair so it does not immediately repeat the same probes we just awaited.
    manuallyInspectedModelRef.current = `${provider}\u0000${model}`;
    applyModelInspection(inspection);
    setModelActivationDeferred(false);
    return inspection;
  }

  useEffect(() => {
    const allowActivationProbe = mayActivateModel({
      deferred: modelActivationDeferred,
      managedLocal: isLocalProvider,
    });
    const inspectionKey = `${provider}\u0000${model}`;
    if (manuallyInspectedModelRef.current === inspectionKey) {
      manuallyInspectedModelRef.current = null;
      return;
    }
    let cancelled = false;
    void inspectModelForRun(provider, model, allowActivationProbe).then((inspection) => {
      if (!cancelled) applyModelInspection(inspection);
    });
    return () => { cancelled = true; };
  }, [provider, model, modelActivationDeferred, isLocalProvider]);

  useEffect(() => {
    if (!lightboxImage) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setLightboxImage(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxImage]);

  useEffect(() => {
    let cancelled = false;
    async function loadPricing() {
      try {
        const p = await invoke<{ inputPerMillion: number; outputPerMillion: number } | null>(
          "ai_model_pricing",
          { model }
        );
        if (!cancelled) setPricing(p ?? null);
      } catch { if (!cancelled) setPricing(null); }
    }
    void loadPricing();
    return () => { cancelled = true; };
  }, [provider, model]);

  // ── Agent loop (harness-only) ──
  const [pendingDiff, setPendingDiff] = useState<DiffProposal | null>(null);
  // A free-form Q&A the model is asking via the `userAnswerQuestion` tool.
  // The harness is paused waiting for the answer; this card collects it
  // and calls `agent_resolve_question` to unblock. Cleared on submit,
  // skip, abort, and conversation reset.
  const [pendingQuestion, setPendingQuestion] = useState<{
    runId: string;
    requestId: string;
    question: string;
  } | null>(null);
  const [questionAnswer, setQuestionAnswer] = useState("");

  // The Focus variant's reading column: instead of restructuring the
  // transcript/composer DOM, the horizontal padding grows to center a
  // ~760px column — one computed gutter, no wrapper churn. The column sits
  // centred in the canvas — or, with the island column up, centred in what is
  // left of the canvas beside it, the islands' width plus their two 18px
  // margins moved to the right gutter. A question island holds that column
  // open on its own, so the conversation makes room for it the same way it
  // does for the plan.
  // The whole column, hidden. Two windows that each close one card still left
  // the corner standing, and there was no way back to the plain canvas — so
  // the column itself takes a switch. A parked question overrides it: that
  // card holds the run, and hiding the run's own question would strand it.
  const [sidePanelHidden, setSidePanelHidden] = useState(false);

  // The result is not dismissible: what a run produced stays in the corner for
  // as long as the run is the latest one. The column's close folds it to its
  // mark like everything else, and the next run replaces it — but there is no
  // way to lose the files a run made while looking at that run.

  // The newest turn whose evidence is worth opening — what "the result" means
  // on the canvas, where there is room for one entry, not one per turn.
  const latestCompletion = useMemo(() => {
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const message = msgs[i];
      const candidate = message.role === "system" ? message.completion : undefined;
      if (candidate && hasCompletionReview(candidate)) return candidate;
    }
    return undefined;
  }, [msgs]);

  function requestCompletionChanges(completion: RunCompletion) {
    setInput((previous) => previous || (completion.stopped
      ? `Please finish this unfinished work:\n${completion.outcome}\n\nRequested changes: `
      : `Please revise this completed work:\n${completion.outcome}\n\nRequested changes: `));
    taRef.current?.focus();
  }

  // The canvas' own width, measured: the island column's size is a share of it,
  // not a constant. `width` (the prop) is the panel's assigned width and means
  // nothing in Focus, where the panel fills its host.
  const canvasRef = useRef<HTMLDivElement>(null);
  const islandColumnRef = useRef<HTMLDivElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(0);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const report = () => setCanvasWidth(Math.round(el.getBoundingClientRect().width));
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // One rule for the corner: the islands take what is left once the prose has
  // a readable 560px, clamped to the column's own range. So a smaller window
  // shrinks the plan, the result and the question together instead of pushing
  // the conversation into a gutter — and under 260px the result entry drops
  // its words for its mark, since a column that narrow is a corner, not a
  // panel. Width 0 is "not measured yet"; assume the roomy case.


  // Anything in the column holds it open — a result entry on its own counted
  // for nothing here, so the conversation kept the full canvas and the pill
  // floated over the prose in the corner.
  // The corner's geometry is one rule, tested on its own (canvasColumn.ts):
  // what each slot is showing decides the column's width, whether the canvas
  // gives up a panel's width or a mark's lane, and whether there is anything
  // for the close control to close.
  const column = columnGeometry({
    planSlot,
    resultUp: latestCompletion !== undefined,
    questionUp: pendingQuestion !== null,
    hidden: sidePanelHidden,
    canvasWidth,
  });

  // A question is the one card in the column that holds the run, and it
  // arrives *under* a plan and an opened result that may already fill the
  // side. So the column scrolls it into view when it appears — the cards
  // above keep their place rather than being pushed off to make room.
  useEffect(() => {
    if (!pendingQuestion) return;
    const column = islandColumnRef.current;
    if (!column) return;
    const frame = requestAnimationFrame(() => {
      column.scrollTo({ top: column.scrollHeight, behavior: "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingQuestion]);
  const focusInset = variant === "focus" ? column.inset : 0;
  const focusGutterLeft = `calc(max(20px, (100% - ${760 + focusInset}px) / 2))`;
  const focusGutterRight = `calc(max(20px, (100% - ${760 + focusInset}px) / 2) + ${focusInset}px)`;
  // Permission gate: the harness pauses and emits a request — a shell command,
  // a network target, or a message to another agent — and the user approves or
  // rejects (approveCommand / rejectCommand) before it runs. The card renders
  // from `pendingPermission`.
  const [pendingPermission, setPendingPermission] = useState<{
    runId: string;
    requestId: string;
    toolName: string;
    kind: "command" | "network" | "message";
    command: string;
    /** For a message: who wrote it, by thread title when known, and which
     *  envelope — so the pre-turn card for the same message is not drawn twice. */
    peer?: string;
    envelopeId?: string;
    summary: string;
    reason: string;
    externalPaths: string[];
    suggestedPattern?: string;
  } | null>(null);

  function suggestCommandPattern(command: string): string | undefined {
    const words = (command.match(/"[^"]+"|'[^']+'|\S+/g) ?? [])
      .map((word) => word.replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    const stop = words.findIndex((word) => word === "&&" || word === "||" || word === ";" || word === "|");
    const head = (stop >= 0 ? words.slice(0, stop) : words).filter(Boolean);
    if (head.length < 2) return undefined;
    const keep = head[0] === "npm" && head[1] === "run" && head[2] ? 3 : 2;
    return `${head.slice(0, keep).join(" ")} *`;
  }

  /** One permission request → the card the panel draws for it. Shared by the
   *  live event and by the transcript recovery, so an approval looks the same
   *  whether it arrived while you were watching or while you were away. */
  function permissionCard(runId: string, req: PermissionRequest) {
    // `input` is the one genuinely open field on the wire — the command gate
    // sends {command, cwd, externalPaths, matchedAllowRule}, a network
    // capability sends whatever it declared. Everything else is typed, and the
    // Rust `frontend_mirror_matches_agent_wire` test keeps it that way.
    const input = (req.input ?? {}) as { command?: string; externalPaths?: string[]; fromRunId?: string; envelopeId?: string; body?: string };
    const isCommand = !!input.command;
    // An incoming-message gate carries the sender and the text; the card shows
    // the text where the command would be and names the peer as the chat does.
    const isMessage = !isCommand && !!input.fromRunId;
    const command = input.command ?? (isMessage ? input.body ?? "" : undefined) ?? req.summary ?? req.toolName ?? "permission request";
    return {
      runId,
      requestId: req.id,
      toolName: req.toolName ?? "permission",
      kind: isCommand ? ("command" as const) : isMessage ? ("message" as const) : ("network" as const),
      command,
      peer: isMessage ? peerName(input.fromRunId!, peerIndex) : undefined,
      envelopeId: isMessage ? input.envelopeId : undefined,
      summary: req.summary ?? command,
      reason: req.reason ?? "",
      externalPaths: Array.isArray(input.externalPaths) ? input.externalPaths : [],
      suggestedPattern: isCommand ? suggestCommandPattern(command) : undefined,
    };
  }

  async function runHarnessTurn(turn: QueuedTurn, generation: number) {
    if (queueGenerationRef.current !== generation) return;
    let userIndex = msgsRef.current.findIndex((m) => m.role === "user" && m.queueId === turn.clientId);
    if (userIndex < 0) return;
    let nextMsgs = [...msgsRef.current];
    const userMsg = nextMsgs[userIndex];
    if (userMsg.role !== "user") return;
    nextMsgs[userIndex] = { ...userMsg, queueState: "running" };
    // A console block is how you read a CLI's raw stdout. The headless
    // one-shot path returns the assistant's prose (`--output-format text`), so
    // in Focus it is rendered as an ordinary message instead — same chat, a
    // different engine behind it.
    const delegateConsole = isDelegateProvider(turn.provider) && variant !== "focus";
    const delegateProvider = providerName(turn.provider);
    nextMsgs.splice(userIndex + 1, 0, { role: "assistant", content: "", delegateConsole, delegateProvider });
    const assistantIndex = userIndex + 1;
    msgsRef.current = nextMsgs;
    setMsgs(nextMsgs);
    // The turn carries the pair it actually dispatches with, which stamps the
    // thread's origin on its first Run.
    startConversationRun("thinking", { provider: turn.provider, model: turn.model });
    // A fresh assistant turn is the one place we want to yank the user
    // back to the bottom even if they were scrolled up reading context.
    // Their action (sending a message) implies "I want to see the reply".
    forceStickToBottom();

    // Why this turn's view is short of the Run's Transcript, when it is. Two
    // things can stop a turn reaching the screen while the Run keeps working:
    // the region splice detaching, and events dropped for a retired turn
    // generation. Both are silent by construction, and both strand the Run's
    // later turns — its *answer*, usually, since a tool phase comes first — on
    // disk and nowhere else. Set by whichever fires, read once the Run settles.
    //
    // Turn-local, not a panel ref: a Run keeps streaming after its turn is
    // retired, so the handler closures of *older* turns are still firing. On a
    // shared ref, one of them could fabricate a signal for whatever turn is
    // live now, or a late settle could clear the signal a live turn just set.
    const viewBehind: { reason: "region-detached" | "generation-retired" | null } = { reason: null };

    let harnessError: Error | null = null;
    // Track user-initiated stops so the auto-memory hook can distinguish a
    // clean run_result from a `run_error` with code "aborted". We don't
    // auto-summarize cancelled runs — the user already knows they stopped
    // the run, and a half-finished note is more noise than signal.
    let abortedByUser = false;

    // All event handling transforms msgsRef.current (the single source of
    // truth, kept in sync by enqueueTurn too) and pushes plain values via
    // commit(). Never use functional setMsgs updaters with side effects
    // here: StrictMode double-invokes updaters, which double-incremented
    // the turn cursor and left tool rows stuck on "Running…" forever.
    const commit = (next: Msg[]) => {
      msgsRef.current = next;
      setMsgs(next);
    };

    const delegate = { delegateConsole, delegateProvider };

    // The streaming state machine for this turn — delta batching, TTFT/turn
    // timing, the assistant-index cursor, flush-before-finalize. See
    // ai/turnDriver.ts; fixture-tested there without React or Tauri.
    const driver = createTurnDriver({
      assistantIndex,
      delegate,
      pricing,
      read: () => msgsRef.current,
      commit,
      onMeasuredPromptTokens: setMeasuredPromptTokens,
      onMeasuredUsage: setMeasuredUsageTokens,
      onDetached: () => {
        viewBehind.reason = "region-detached";
      },
    });

    // The executor (this run's model) called `consult_advisor` and is parked on
    // the shared question oneshot. Put its question to a STRONGER advisor model
    // as a one-shot chat run (no tools), nested by parentId, and resolve the
    // parent with the advice — that text becomes the tool result. The executor
    // then continues its own loop. This is the advisor strategy: small model
    // drives, big model advises only at the fork it flagged.
    const runAdvisorConsult = (event: Extract<AgentEvent, { type: "advisor_requested" }>) =>
      // AI-panel runs use the global advisor setting. (Orchestrator-dispatched
      // runs pass a per-tier advisor to the same helper — see advisorConsult.ts.)
      serviceAdvisorConsult({ event, advisor: resolveAdvisor(harnessSettings), workspaceRoot });

    const handleEvent = (event: AgentEvent) => {
      if (queueGenerationRef.current !== generation) {
        // This turn's generation was retired mid-Run (the panel left the
        // conversation, or a Stop bumped it). Dropping the event is right — it
        // must not land in whatever conversation is adopted next — but the Run
        // is still working, so what we have on screen is now short of the
        // Transcript. Say so, rather than letting the turn look finished.
        viewBehind.reason = "generation-retired";
        return;
      }
      // Transcript events (deltas, finalized messages, tool cards) belong to
      // the turn driver; everything below is panel behaviour.
      if (driver.handleEvent(event)) return;

      switch (event.type) {
        case "context_compacted": {
          // The Rust auto-compactor collapsed the older turns mid-run. Without
          // this the conversation just silently loses its early context and the
          // marker only appears after a reload (via foldEvents).
          const priorMsgs = msgsRef.current;
          commit([...priorMsgs, compactionMsg(priorMsgs.length, event.summary)]);
          break;
        }
        case "diff_proposed": {
          setPendingDiff(event.proposal);
          break;
        }
        case "diff_resolved": {
          setPendingDiff(null);
          break;
        }
        case "user_question_requested": {
          setPendingQuestion({ runId: event.runId, requestId: event.requestId, question: event.question });
          setQuestionAnswer("");
          break;
        }
        case "user_question_resolved": {
          // Only clear if the resolved id matches what we're showing — the
          // harness might have resolved an older request we already moved
          // past, and we don't want to clobber the current question.
          setPendingQuestion((current) => (current && current.requestId === event.requestId ? null : current));
          if (!pendingQuestion || pendingQuestion.requestId === event.requestId) {
            setQuestionAnswer("");
          }
          break;
        }
        // Both halves of a subagent exchange are display-only here: the Rust
        // harness resolves the role, runs the child, and feeds its report back
        // as the tool result, so the pair survives this panel unmounting
        // mid-subagent. The transcript rows come from the turn driver.
        case "subagent_requested": {
          break;
        }
        case "subagent_resolved": {
          break;
        }
        case "advisor_requested": {
          void runAdvisorConsult(event);
          break;
        }
        case "advisor_resolved": {
          break;
        }
        case "permission_requested": {
          setPendingPermission(permissionCard(event.runId, event.request));
          break;
        }
        case "permission_resolved": {
          setPendingPermission((current) =>
            current && current.requestId === event.requestId ? null : current
          );
          break;
        }
        case "file_changed": {
          runChangedPathsRef.current.add(event.path);
          setRevertableFiles(runChangedPathsRef.current.size);
          if (workspaceRoot && onFileWritten) {
            void (async () => {
              try {
                const content = await readWorkspaceTextFile(workspaceRoot, event.path);
                onFileWritten(event.path, content);
              } catch { /* file may not exist yet */ }
            })();
          }
          // Refresh git status (sidebar decorations, project graph) so the
          // edit shows up in the workbench the moment the harness writes it —
          // the watcher would catch it eventually but with a 250ms delay and
          // only on file events, not for create/delete-then-recreate.
          onWorkspaceChanged?.();
          break;
        }
        case "run_result": {
          const next = [...msgsRef.current];
          const existingUser = next[userIndex];
          if (existingUser?.role === "user") {
            next[userIndex] = { ...existingUser, queueState: undefined, queueId: undefined };
            commit(next);
          }
          // Exit the working state as soon as the terminal event is *observed*,
          // not only when `await session.done` resolves — that promise can hang
          // if the channel was disrupted, leaving "Working…" stuck. Safe: this
          // fires once per finished run, never mid-run, so it can't race a
          // queued turn into a concurrent run. The post-await cleanup still runs.
          settleConversationRun();
          break;
        }
        case "run_error": {
          // A user-initiated Stop is delivered as a RunError with
          // `code: "aborted"`. It's not a harness failure — the partial
          // answer should stay on screen with no error banner, and the
          // connection-suggestion copy in the catch block would be wrong.
          if (!isSilentRunError(event.error.code)) {
            harnessError = new Error(event.error.message);
          } else {
            abortedByUser = true;
          }
          // Same safety as run_result: leave the working state on the observed
          // terminal event, not only via `await session.done`.
          settleConversationRun();
          break;
        }
      }
    };

    try {
      const toolsAvailable = turn.modelSupportsTools;
      const overrides = harnessSettings?.toolOverrides;
      const disabledTools = overrides ? Object.keys(overrides).filter((k) => overrides[k] === false) : undefined;
      let systemPrompt = turn.mode === "chat" && (turn.provider === "mlx" || turn.provider === "ollama")
        ? `You are Klide's local chat assistant. Answer the user's latest message directly and concisely. You have no tools in this turn, so do not claim you can inspect or edit files unless file text was attached in the conversation.

If the user asks about folders, files, the current directory, repository structure, git state, or anything that requires inspecting the workspace, do not answer from memory or earlier conversation. Say that this needs Plan or Goal mode so Klide can use read-only tools.

Important: do not output JSON, structured plans, or fake tool-call blocks. Just answer in natural language. The chat surface in this app renders any JSON you emit as raw noise, and the user won't see a clean answer.`
        : buildSystemPrompt(workspaceRoot, stopAfterRejection, skills, turn.mode, toolsAvailable && turn.mode !== "chat", projectRules, harnessSettings, turn.model);
      // Subagent turn: append the role specialisation to the base prompt.
      const subagentDef = turn.subagent ? resolveSubagent(turn.subagent) : undefined;
      if (subagentDef) systemPrompt = buildSubagentSystemPrompt(subagentDef, systemPrompt);
      if (turn.mode !== "chat" && toolsAvailable && asksForWorkspaceInspection(turn.text)) {
        systemPrompt += `

This user request requires workspace inspection. Before answering, you MUST call list_dir with path "." (or the requested relative directory) and wait for its tool result. Do not answer from memory, do not infer from prior conversation, and do not say you used list_dir unless an actual list_dir tool result appears in this turn. For folder questions, answer only from the tool result's Folders section.`;
      }
      // Context window: num_ctx only matters for Ollama (other adapters
      // ignore it). Prefer an explicit per-model override from settings,
      // else the model's detected trained window (contextLimit), so each
      // model runs at its real size instead of a hardcoded floor.
      const ctxOverride = harnessSettings?.contextWindows?.[turn.model];
      const numCtx =
        turn.provider === "ollama"
          ? ctxOverride && ctxOverride > 0
            ? ctxOverride
            : contextLimit > 0
              ? contextLimit
              : undefined
          : undefined;
      const effortBudget = harnessSettings?.effortBudgets?.[turn.model];
      const numPredict =
        turn.provider === "ollama" && effortBudget && effortBudget > 0 ? effortBudget : undefined;
      const reflectionLevel = turn.modelSupportsReflection ? turn.reflectionLevel : undefined;
      const maxParallelTools = harnessSettings?.maxParallelTools;
      const maxTurns = harnessSettings?.maxTurns;
      const commandTimeoutSecs = harnessSettings?.commandTimeoutSecs;
      const testAfterEditCommand = harnessSettings?.testAfterEditCommand?.trim();
      // The binding is durable before the Run starts — the `run-started`
      // transition at the top of this turn persisted it — so a mid-run view
      // switch reattaches to this Conversation.
      // A subagent turn runs as its OWN child run (parentId = the conversation
      // run), so Mission Control nests it under the convo. Events still stream
      // through `handleEvent`, so the delegation + any diffs render inline here.
      const turnRunId = turn.subagent ? `${currentId}-at-${turn.clientId}` : currentId;
      const session = await startAgentRun({
        runId: turnRunId,
        parentId: turn.subagent ? currentId : undefined,
        workspaceRoot, mode: turn.mode, provider: turn.provider, model: turn.model,
        text: turn.text, attachments: turn.attachments,
        context: { workspaceRoot, attachments: turn.attachments, lensItems: turn.projectContext?.items ?? [], estimatedTokens: 0, omitted: [] },
        systemPrompt,
        disabledTools: disabledTools && disabledTools.length > 0 ? disabledTools : undefined,
        numCtx,
        numPredict,
        reflectionLevel,
        maxParallelTools: maxParallelTools && maxParallelTools > 1 ? maxParallelTools : undefined,
        maxTurns: maxTurns && maxTurns > 0 ? maxTurns : undefined,
        commandTimeoutSecs: commandTimeoutSecs && commandTimeoutSecs > 0 ? commandTimeoutSecs : undefined,
        requireDiffReview,
        autoApproveCommands: autoApproveCommands || undefined,
        testAfterEditCommand: testAfterEditCommand || undefined,
        // Stars are the router's strongest preference and live only in this
        // renderer's storage, so an `auto` turn carries them along.
        preferredModels: isAutoProvider(turn.provider) ? allFavModels() : undefined,
      }, handleEvent);
      activeHarnessRunRef.current = session.runId;
      try { await session.done; } finally { activeHarnessRunRef.current = null; }
      if (harnessError) throw harnessError;
    } catch (e) {
      if (queueGenerationRef.current !== generation) return;
      const located = driver.ensureAssistant();
      const next = [...located.msgs];
      const i = located.index;
      const failedUser = next[userIndex];
      if (failedUser?.role === "user") next[userIndex] = { ...failedUser, queueState: undefined, queueId: undefined };
      // `providerFailureMessage` also drops the `(e as Error)` cast: a rejected
      // Tauri command throws a bare string, which rendered as "undefined".
      next[i] = { role: "assistant", content: `⚠ ${providerFailureMessage(e, providerName(turn.provider))}` };
      // A failed MLX stream may mean the model went cold — re-warm next send.
      if (turn.provider === "mlx") mlxWarmedRef.current = null;
      commit(next);
    }
    // Cancel the batch timer + render any delta still pending.
    driver.finish();
    // The turn stopped reaching the screen partway through. The Run itself kept
    // going in Rust and wrote every turn to its Transcript, so the answer is not
    // lost — it is simply not here. Re-read the Transcript and adopt it, the
    // same heal a remount gets from `followConversationRun`, instead of leaving
    // a conversation that ends on a tool call and looks like a model that said
    // nothing.
    //
    // Two Runs are deliberately not healed this way. A Delegate conversation
    // outside Focus has no Transcript of its own to read. And a subagent turn
    // is its OWN child Run: its events stream into this panel but land in the
    // child's Transcript, so the conversation's own Transcript is not the
    // record of what was on screen and adopting it would be a different kind of
    // wrong from the one being fixed.
    if (driver.isDetached()) viewBehind.reason ??= "region-detached";
    const behind = viewBehind.reason;
    // The conditions — and what is pointedly not one of them — live in
    // `shouldHealFromTranscript`, where they are tested.
    if (
      shouldHealFromTranscript({
        behind,
        stillOnConversation: conversationSessionRef.current.conversationId === currentId,
        subagent: Boolean(turn.subagent),
        delegateWithoutTranscript: isDelegateProvider(turn.provider) && variant !== "focus",
      })
    ) {
      // Loud on purpose. This is the diagnostic that was missing: the last time
      // a turn went dark, the only evidence was a conversation that looked like
      // it ended on a tool call, and finding out why meant reading the
      // Transcript off disk by hand.
      console.warn(`Klide: turn stopped reaching the view (${behind}) — healing from the transcript.`);
      try {
        const healed = replayForAdoption(await readAgentRunEvents(currentId), msgsRef.current);
        if (healed) commit(healed);
      } catch {
        // A Transcript that cannot be read leaves the view as it stands. The
        // turn is already over; failing loudly here would replace a short
        // conversation with an error about a file the user never asked about.
      }
    }
    settleConversationRun();
    setPendingDiff(null);
    if (isDelegateProvider(turn.provider)) onWorkspaceChanged?.();
    // Auto-summarize on a clean `run_result` (no harness error, not user-
    // cancelled, harness feature flag on, at least one real exchange).
    // Delegate providers have their own session memory on disk; skip them.
    if (
      !harnessError &&
      !abortedByUser &&
      harnessSettings?.autoMemoryOnRunDone !== false &&
      !providerDelegatesWork
    ) {
      void runAutoSummarize(turn);
    }
  }

  function enqueueTurn(turn: QueuedTurn) {
    queueRef.current = [...queueRef.current, turn];
    // Stamped at send, not at dispatch: a turn can sit queued behind a running
    // one, and the conversation's start time is when the user actually asked.
    const queuedMessage: Msg = { role: "user", content: turn.text, attachments: turn.attachments.length ? turn.attachments : undefined, projectContext: turn.projectContext, queueState: "queued", queueId: turn.clientId, subagent: turn.subagent, wake: turn.wake, ts: Date.now() };
    msgsRef.current = [...msgsRef.current, queuedMessage];
    setMsgs(msgsRef.current);
    // The user just hit send. Even if they were scrolled up reading old
    // context, "send" is a clear navigation signal — pull them to the
    // bottom so they can watch their message + the reply.
    forceStickToBottom();
    void drainQueue();
  }

  async function drainQueue() {
    if (processingQueueRef.current) return;
    processingQueueRef.current = true;
    const generation = queueGenerationRef.current;
    try {
      while (queueRef.current.length > 0 && queueGenerationRef.current === generation) {
        // An externally-started run (race watch, resumed live run) is still
        // streaming into this conversation via the reattach follower.
        // Starting a queued turn now would run two harness loops over one
        // transcript — wait for it to settle, then re-check the queue.
        const follow = reattachRef.current;
        if (follow) {
          await follow.done;
          continue;
        }
        const [turn, ...rest] = queueRef.current;
        queueRef.current = rest;
        await runHarnessTurn(turn, generation);
      }
    } finally { processingQueueRef.current = false; }
  }

  async function ensureLocalServerReady(): Promise<boolean> {
    if (!isLocalProvider) return true;
    setServerError(null);
    try {
      const running = await readLocalProviderStatus(provider);
      // For MLX, "port is up" isn't enough — the model may still be cold. Only
      // take the fast path once we've warmed this exact model; otherwise fall
      // through to start, which warms it (and shows the starting animation).
      if (running && (provider !== "mlx" || mlxWarmedRef.current === model)) {
        setServerRunning(true);
        setConnected(true);
        return true;
      }
    } catch {
      // Try to start it below.
    }

    setServerStarting(true);
    try {
      const started = await startLocalProvider({
        provider,
        model,
        concurrency: harnessSettings?.serverConcurrency,
      });
      setServerRunning(started);
      setConnected(started);
      if (!started) {
        setServerError(`${providerName(provider)} did not start.`);
        return false;
      }
      // ai_local_server_start blocks on an MLX warm-up before returning true.
      if (provider === "mlx") mlxWarmedRef.current = model;
      return true;
    } catch (e) {
      const message = String(e);
      setServerRunning(false);
      setConnected(false);
      setServerError(message);
      return false;
    } finally {
      setServerStarting(false);
    }
  }

  // Per-message actions (Retry / Edit / Branch / Delete). All assume the
  // harness is idle — the chip row renders them disabled while `streaming`.
  // Retrying or editing drops everything *after* the target and reuses the
  // composer's `send` path so attachments/context-mode re-evaluation run
  // again. Attachments from the original send are not re-attached (v1).
  function retryFromMessage(i: number) {
    if (streaming) return;
    const m = msgs[i];
    if (!m) return;
    let userText: string | null = null;
    let truncateAt: number;
    if (m.role === "user") {
      userText = m.content;
      truncateAt = i;
    } else {
      let j = i - 1;
      while (j >= 0 && msgs[j].role !== "user") j -= 1;
      if (j < 0) return;
      userText = (msgs[j] as Msg & { role: "user" }).content;
      truncateAt = j;
    }
    if (!userText || !userText.trim()) return;
    setMsgs(msgs.slice(0, truncateAt));
    void send({ text: userText });
  }

  function editMessage(i: number) {
    if (streaming) return;
    const m = msgs[i];
    if (m?.role !== "user") return;
    setEditingIdx(i);
    setEditingDraft(m.content);
  }

  function commitEdit(i: number) {
    const m = msgs[i];
    if (m?.role !== "user") return;
    const text = editingDraft;
    setEditingIdx(null);
    setEditingDraft("");
    if (!text.trim() || text === m.content) return;
    // Replace the bubble in place, drop everything after, and resend —
    // same path as `retryFromMessage` so attachments/context-mode are
    // re-evaluated. The conversation id stays, so this is an in-place
    // edit-and-regenerate, not a new chat.
    const next = [...msgsRef.current].slice(0, i + 1);
    next[i] = { ...(msgsRef.current[i] as Msg & { role: "user" }), content: text, queueState: undefined, queueId: undefined };
    msgsRef.current = next;
    setMsgs(next);
    void send({ text });
  }

  function cancelEdit() {
    setEditingIdx(null);
    setEditingDraft("");
  }

  function branchFromMessage(i: number) {
    if (streaming) return;
    const newMsgs = msgs.slice(0, i + 1);
    if (newMsgs.length === 0) return;
    const nid = genId();
    transitionConversation({
      type: "branched",
      conversationId: nid,
      messageIndex: i,
      mode: "chat",
      createdAt: Date.now(),
    });
    setMeasuredPromptTokens(null);
    setMeasuredUsageTokens(null);
    // The msgs/currentId persist effect will write the branched chat; the
    // previous one stays in localStorage untouched.
  }

  function branchMessageInWorktree(i: number) {
    if (streaming) return;
    const newMsgs = msgs.slice(0, i + 1);
    if (newMsgs.length === 0) return;
    const nid = genId();
    const lineage: Conversation["forkedFrom"] = {
      conversationId: currentId,
      title: deriveTitle(msgsRef.current),
      messageIndex: i,
      createdAt: Date.now(),
      mode: "worktree",
    };
    onForkConversationInWorktree?.(
      {
        id: nid,
        title: `Branch: ${deriveTitle(newMsgs)}`,
        msgs: newMsgs,
        updatedAt: Date.now(),
        provider,
        model,
        cwd: workspaceRoot,
        forkedFrom: lineage,
      },
      workspaceRoot,
    );
  }

  function deleteMessage(i: number) {
    if (streaming) return;
    const m = msgs[i];
    if (m?.role !== "user") return;
    setMsgs(msgs.slice(0, i));
  }

  async function send(opts?: { text?: string; mode?: AgentMode; attachments?: Attachment[] }) {
    const text = opts?.text ?? input;
    const stagedFiles = opts?.attachments ?? pendingAttachments;
    if (serverStarting) return;
    // An attachment-only turn (no text) is valid; a bare empty turn is not.
    if (!text.trim() && stagedFiles.length === 0) return;
    // Delegate TUIs do not accept image-only turns.
    if (delegateSession && !text.trim()) return;
    if (delegateSession) {
      // Delegate TUIs take text only — attachments aren't wired to their stdin.
      setInput(""); setMention(null); setSlash(null); setNextSendMode(null);
      await writeDelegatePty(delegateSessionId(currentId, provider), `${text}\r`);
      return;
    }
    cancelledWarmupRef.current = false;
    if (!(await ensureLocalServerReady())) return;
    // User hit Stop while the server was warming up — back out before launching.
    if (cancelledWarmupRef.current) { cancelledWarmupRef.current = false; return; }
    // This is the activation boundary for a resumed local conversation. The
    // transcript itself stays passive; only a genuine send may inspect/warm
    // its saved model. Await the result so this first turn gets the correct
    // tool/reflection flags instead of the previous conversation's values.
    const modelInspection = await activateModelInspectionForSend();
    const supportsToolsForTurn = modelInspection.supportsTools;
    const supportsReflectionForTurn = modelInspection.supportsReflection;
    // Opening a large saved transcript is passive. If it no longer fits, fold
    // its older turns only now — after an actual message was submitted, and
    // before that message is appended or dispatched. On failure keep the draft
    // intact so retry cannot accidentally send an overflowing context.
    const contextLimitForTurn =
      provider === "ollama" && ctxOverride && ctxOverride > 0
        ? ctxOverride
        : modelInspection.contextLimit;
    const ratioAfterSend = contextLimitForTurn > 0 ? budget.used / contextLimitForTurn : 0;
    if (shouldAutoCompact({ trigger: "send", canCompact, ratioAfterSend })) {
      if (!(await compactConversation("agent", contextLimitForTurn))) return;
    }
    // `@<subagent> <task>` re-flavors this turn with a named subagent's role +
    // mode. The directive's mode wins over the picker; the rest of the turn
    // (the task text) runs through the normal harness path, badged in the chat.
    const directive = parseSubagentDirective(text);
    const effectiveText = directive ? directive.task : text;
    const subagentModel = directive?.subagent.model;
    const requestedMode = directive
      ? directive.subagent.mode
      : opts?.mode ?? nextSendMode ?? agentModeRef.current;
    const availableMode: AgentMode =
      !supportsToolsForTurn && !providerDelegatesWork && requestedMode === "goal" ? "chat" : requestedMode;
    const mode: AgentMode =
      availableMode === "chat" && supportsToolsForTurn && asksForWorkspaceInspection(effectiveText)
        ? "plan"
        : availableMode;
    setInput(""); setMention(null); setSlash(null); setNextSendMode(null);
    setPendingAttachments([]);
    const collected = await collectAttachments(effectiveText);
    // Staged photos/documents ride ahead of @-mention file attachments.
    const attachments = [...stagedFiles, ...collected];
    const activeProjectContext = lensItemsForPrompt(projectContext, effectiveText, contextMode);
    enqueueTurn({ clientId: genId(), text: effectiveText, mode, provider, model: subagentModel ?? model, modelSupportsTools: supportsToolsForTurn, modelSupportsReflection: supportsReflectionForTurn, reflectionLevel: supportsReflectionForTurn ? panelReflectionLevel : undefined, attachments, subagent: directive?.subagent.id, projectContext: activeProjectContext.length > 0 ? { mode: contextMode, items: activeProjectContext } : undefined });
    // A subagent named *inside* a larger message (not a leading directive) runs
    // in the background, concurrent with the main answer above.
    if (!directive) {
      for (const call of extractInlineSubagentCalls(text)) {
        void runBackgroundSubagent(call.subagent, call.task);
      }
    }
  }

  // Run a named subagent in the background alongside the main conversation: drop
  // a pending report bubble, run a child run (parentId = conversation, so
  // Mission Control nests it), and fill the bubble in when it finishes. Updates
  // are keyed by runId — never by index — so they never collide with the main
  // turn's streaming. Read-only roles report; edits auto-apply (checkpointed),
  // since a background run has no diff-review surface.
  async function runBackgroundSubagent(def: Subagent, task: string) {
    const runId = `${currentId}-bg-${genId()}`;
    const placeholder: Msg = { role: "assistant", content: "", subagent: def.label, subagentRunId: runId, subagentPending: true };
    msgsRef.current = [...msgsRef.current, placeholder];
    setMsgs(msgsRef.current);
    const base = buildSystemPrompt(workspaceRoot, stopAfterRejection, skills, def.mode, modelSupportsTools && def.mode !== "chat", projectRules, harnessSettings, model);
    const systemPrompt = buildSubagentSystemPrompt(def, base);
    let report = "";
    try {
      const session = await startAgentRun({
        runId, parentId: currentId, workspaceRoot, mode: def.mode,
        provider, model: def.model ?? model, text: task, attachments: [],
        context: { workspaceRoot, attachments: [], lensItems: [], estimatedTokens: 0, omitted: [] },
        systemPrompt,
        requireDiffReview: false,
        // A child of an Auto panel routes on the same stars as its parent.
        preferredModels: isAutoProvider(provider) ? allFavModels() : undefined,
        maxTurns: harnessSettings?.maxTurns && harnessSettings.maxTurns > 0 ? harnessSettings.maxTurns : undefined,
      }, (ev) => {
        if (ev.type === "assistant_message") {
          const t = extractAssistantText(ev.content);
          if (t.trim()) report = t;
        } else if (ev.type === "run_error") {
          report = `Subagent error: ${ev.error.message}`;
        }
      });
      await session.done;
    } catch (e) {
      report = `Subagent run failed: ${(e as Error).message}`;
    }
    const next = msgsRef.current.map((m) =>
      m.role === "assistant" && m.subagentRunId === runId
        ? { ...m, content: report.trim() || "(subagent produced no output)", subagentPending: false }
        : m
    );
    msgsRef.current = next;
    setMsgs(next);
  }

  async function handleDiffApply() {
    if (!pendingDiff || acceptingChanges) return;
    const proposal = pendingDiff;
    setAcceptingChanges(true);
    try {
      await resolveDiff({ runId: proposal.runId, proposalId: proposal.id, decision: { behavior: "apply" } });
    } catch (e) {
      console.error("Failed to accept proposed modification:", e);
      notify(`Couldn't accept the modification: ${e instanceof Error ? e.message : String(e)}`, { tone: "error" });
    } finally {
      setAcceptingChanges(false);
    }
  }

  // "Validate all" — apply this edit AND stop asking: scope "run" covers the
  // rest of the live run in the harness, and flipping the rung to auto-accept
  // covers every later turn (plus lights the right rung in the + menu).
  async function handleDiffApplyAll() {
    if (!pendingDiff || acceptingChanges) return;
    const proposal = pendingDiff;
    setAcceptingChanges(true);
    try {
      await resolveDiff({ runId: proposal.runId, proposalId: proposal.id, decision: { behavior: "apply", scope: "run" } });
      onRequireDiffReviewChange?.(false);
    } catch (e) {
      console.error("Failed to accept proposed modification:", e);
      notify(`Couldn't accept the modification: ${e instanceof Error ? e.message : String(e)}`, { tone: "error" });
    } finally {
      setAcceptingChanges(false);
    }
  }

  async function handleDiffReject() {
    if (!pendingDiff) return;
    await resolveDiff({ runId: pendingDiff.runId, proposalId: pendingDiff.id, decision: { behavior: "reject" } });
  }

  // "Request changes" — reject with the user's review note attached, so the
  // model revises the edit toward the feedback instead of abandoning course.
  async function handleDiffRequestChanges(note: string) {
    if (!pendingDiff) return;
    await resolveDiff({
      runId: pendingDiff.runId,
      proposalId: pendingDiff.id,
      decision: { behavior: "reject", note },
    });
  }

  // Q&A submit: send the typed answer to the harness and let the
  // user_question_resolved event clear the card. The Rust side replaces
  // the literal "(skipped)" with a friendlier marker before returning it
  // to the model — we send the sentinel ourselves for Skip.
  async function submitQuestion() {
    if (!pendingQuestion) return;
    const snapshot = pendingQuestion;
    setPendingQuestion(null);
    setPendingPermission(null);
    setQuestionAnswer("");
    try {
      await resolveUserQuestion({ runId: snapshot.runId, requestId: snapshot.requestId, answer: questionAnswer });
    } catch (err) {
      console.error("Failed to submit answer:", err);
      notify(`Couldn't send your answer: ${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
    }
  }

  function skipQuestion() {
    if (!pendingQuestion) return;
    const snapshot = pendingQuestion;
    setPendingQuestion(null);
    setPendingPermission(null);
    setQuestionAnswer("");
    void resolveUserQuestion({ runId: snapshot.runId, requestId: snapshot.requestId, answer: "(skipped)" }).catch((err) => {
      console.error("Failed to skip question:", err);
      notify(`Couldn't skip the question: ${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
    });
  }

  // Letting a peer's message in should not leave it waiting for the user to
  // find something else to say: start a turn with no words of the user's own,
  // so the Run reads it now. Only when the conversation is idle — a live turn
  // reaches the boundary on its own. Chat has no coordination, so a Chat
  // picker wakes as Plan, the quietest mode that can read the inbox.
  async function wakeForInbox() {
    if (streaming || queueRef.current.length > 0 || reattachRef.current) return;
    const current = agentModeRef.current;
    const mode: AgentMode = current === "chat" ? "plan" : current;
    const modelInspection = await activateModelInspectionForSend();
    enqueueTurn({
      clientId: genId(),
      text: "",
      wake: true,
      mode,
      provider,
      model,
      modelSupportsTools: modelInspection.supportsTools,
      modelSupportsReflection: modelInspection.supportsReflection,
      reflectionLevel: modelInspection.supportsReflection ? panelReflectionLevel : undefined,
      attachments: [],
    });
  }

  function approveCommand(scope: "once" | "run" | "project" = "once", pattern?: string) {
    if (!pendingPermission) return;
    const snapshot = pendingPermission;
    setPendingPermission(null);
    void resolvePermission({
      runId: snapshot.runId,
      requestId: snapshot.requestId,
      decision: pattern ? { behavior: "allow", scope, pattern } : { behavior: "allow", scope },
    }).catch((err) => {
      console.error("Failed to approve command:", err);
      notify(`Couldn't approve the command: ${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
    });
  }

  function rejectCommand() {
    if (!pendingPermission) return;
    const snapshot = pendingPermission;
    setPendingPermission(null);
    void resolvePermission({
      runId: snapshot.runId,
      requestId: snapshot.requestId,
      decision: { behavior: "deny" },
    }).catch((err) => {
      console.error("Failed to reject command:", err);
      notify(`Couldn't reject the command: ${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
    });
  }

  // ── RENDER ──

  const canSend = !!input.trim() && !serverStarting && !compacting;
  // Hover-revealed "Send to both" over the send button (race panels only).
  const [raceSendHover, setRaceSendHover] = useState(false);
  const acceptanceMode = modificationAcceptanceMode(
    pendingDiff !== null,
    revertableFiles,
    streaming,
  );
  // One provider selector, placed in the panel header normally and in the
  // composer footer for Focus mode. Keeping a single JSX value ensures the
  // menu state, trigger ref, and provider mutation path never drift.
  const providerControl = (
    <div style={{ position: "relative", minWidth: 0, textTransform: "none", letterSpacing: 0 }}>
      <button ref={providerTriggerRef} onClick={() => (providerOpen ? closeProviderMenu() : openProviderMenu())}
        title={isLocalProvider ? (connected ? `${providerName(provider)} · connected` : `${providerName(provider)} · not reachable`) : isDelegateProvider(provider) ? (connected ? `${providerName(provider)} · CLI available` : `${providerName(provider)} · check CLI install/auth`) : (connected ? `${providerName(provider)} · connected` : `${providerName(provider)} · check API key`)}
        aria-label={`Provider: ${providerName(provider)}`}
        aria-haspopup="menu" aria-expanded={providerOpen}
        style={{ display: "flex", alignItems: "center", gap: 7, maxWidth: 200, height: 24, padding: "0 6px", borderRadius: "var(--radius-sm)", background: providerOpen ? "var(--bg-hover)" : "transparent", color: providerOpen ? "var(--fg-strong)" : "var(--fg-subtle)", cursor: "pointer", transition: "color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)" }}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--fg-strong)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { if (!providerOpen) { e.currentTarget.style.color = "var(--fg-subtle)"; e.currentTarget.style.background = "transparent"; } }}>
        <ProviderLogo id={provider} size={14} />
        <span style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{providerName(provider)}</span>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: "var(--fg-dim)" }}><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {providerOpen && providerMenuPos && createPortal(
        <div ref={providerMenuRef} role="menu" className="popover-enter menu-scroll menu-glass" style={{ position: "fixed", top: providerMenuPos.top, bottom: providerMenuPos.bottom, left: providerMenuPos.left, minWidth: 200, maxHeight: providerMenuPos.maxHeight, overflowY: "auto", overscrollBehavior: "contain", padding: 5, zIndex: Z.popover }}>
          {providerGroupsForSurface.map((group) => {
            const expanded = expandedGroups.has(group.label);
            const hasActive = group.items.some((it) => it.id === provider);
            // A whole stack with no keys anywhere reads as quiet as its rows.
            const stackKeyless = group.items.every((it) => keylessProviders.has(it.id));
            return (
            <div key={group.label} style={{ marginBottom: 2 }}>
              <button type="button" onClick={() => toggleGroup(group.label)} aria-expanded={expanded}
                /* The card itself is frosted now, so this sticky eyebrow only
                   has to mask the rows scrolling under it — a nested
                   backdrop-filter would be a second blur over the first and
                   renders muddy in the webview. A near-opaque elevated fill
                   does the masking instead. */
                style={{ position: "sticky", top: 0, zIndex: 1, width: "100%", display: "flex", alignItems: "center", gap: 6, background: "color-mix(in srgb, var(--bg-elevated) 92%, transparent)", border: "none", cursor: "pointer", fontSize: 9.5, fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase", color: !expanded && hasActive ? "var(--fg-strong)" : "var(--fg-dim)", padding: "6px 8px 5px", textAlign: "left", opacity: stackKeyless ? 0.5 : 1, transition: "color 120ms ease, opacity var(--motion-fast) var(--ease-out)" }}
                onMouseEnter={(e) => { if (!(!expanded && hasActive)) e.currentTarget.style.color = "var(--fg-subtle)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = !expanded && hasActive ? "var(--fg-strong)" : "var(--fg-dim)"; }}>
                <span style={{ display: "grid", placeItems: "center", flexShrink: 0, transform: expanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 140ms cubic-bezier(0.4, 0, 0.2, 1)" }}>
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
                </span>
                <span style={{ flex: 1 }}>{group.label}</span>
              </button>
              {expanded && group.items.map((item) => {
                const active = item.id === provider;
                // No key Rust can resolve → the row can't run. Quiet it and
                // (when the host wired Settings) send the click to API keys
                // instead of selecting a provider that would fail on send.
                const keyless = item.available && keylessProviders.has(item.id);
                const routesToSettings = keyless && !!onOpenSettingsSection;
                return (
                  <button key={item.id} role="menuitem" disabled={!item.available}
                    title={keyless ? `${item.name} has no API key — open Settings` : undefined}
                    onClick={() => {
                      if (!item.available) return;
                      if (routesToSettings) { closeProviderMenu(); onOpenSettingsSection?.("api"); return; }
                      selectProvider(item.id);
                    }}
                    style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: "var(--radius-sm)", background: active ? "var(--menu-row-active)" : "transparent", color: item.available ? "var(--fg-strong)" : "var(--fg-dim)", cursor: item.available ? "pointer" : "default", fontSize: 12, textAlign: "left", transition: "background 120ms ease" }}
                    onMouseEnter={(e) => { if (item.available && !active) e.currentTarget.style.background = "var(--menu-row-hover)"; }}
                    onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}>
                    <span style={{ display: "grid", placeItems: "center", flexShrink: 0, color: item.available ? "var(--fg-subtle)" : "var(--fg-dim)", opacity: keyless ? 0.4 : 1 }}><ProviderLogo id={item.id} size={15} /></span>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: keyless ? 0.45 : 1 }}>{item.name}</span>
                    {routesToSettings && (
                      /* Leads out to Settings rather than choosing anything. */
                      <svg className="menu-leadout" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}><path d="M7 17 17 7" /><path d="M8 7h9v9" /></svg>
                    )}
                    {active && !routesToSettings && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--fg-subtle)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>}
                  </button>
                );
              })}
            </div>
            );
          })}
        </div>,
        document.body
      )}
    </div>
  );

  return (
    <>
    {lightboxImage && createPortal(
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Image preview"
        onClick={() => setLightboxImage(null)}
        // One definite grid track, not an auto one: a percentage max-height on
        // the image resolves against the track, and an auto track sized by a
        // tall screenshot would resolve it against the image itself — so the
        // picture kept its natural height and spilled past the window.
        style={{ position: "fixed", inset: 0, zIndex: Z.modal, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gridTemplateRows: "minmax(0, 1fr)", placeItems: "center", background: "var(--modal-scrim)", padding: 40, cursor: "zoom-out" }}
      >
        <img src={lightboxImage} alt="Attached image" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 8, boxShadow: "0 12px 48px rgba(0, 0, 0, 0.4)" }} />
      </div>,
      document.body,
    )}
    <aside
      className={variant === "focus" ? "klide-focus-ai-surface" : "floating-panel"}
      aria-label="AI conversation"
      style={{ width: fill ? "100%" : width, height: fill ? "100%" : undefined, margin: fill ? 0 : "4px 4px 4px 0", display: fill || visible ? "flex" : "none", flexDirection: "column", flexShrink: 0, overflow: "hidden" }}
      onDragOver={(e) => { if (canAttachFiles && Array.from(e.dataTransfer?.types ?? []).includes("Files")) { e.preventDefault(); setFileDragOver(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFileDragOver(false); }}
      onDrop={(e) => {
        if (!canAttachFiles) return;
        e.preventDefault();
        setFileDragOver(false);
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length) void addFiles(files);
      }}>
      {fileDragOver && canAttachFiles && (
        <div aria-hidden="true" style={{ position: "absolute", inset: 0, zIndex: 45, pointerEvents: "none", display: "grid", placeItems: "center", background: "color-mix(in srgb, var(--accent-soft) 55%, transparent)", border: "2px dashed var(--accent)", borderRadius: "inherit" }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: "var(--accent)", background: "var(--bg-elevated)", padding: "6px 12px", borderRadius: "var(--radius-md)", border: "1px solid var(--border)" }}>{modelSupportsVision ? "Drop an image or document to attach" : "Drop a document to attach"}</div>
        </div>
      )}
      {variant !== "focus" ? (
      <header
        style={{ padding: "8px 10px", fontSize: 11, color: "var(--fg-subtle)", letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 500, borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, position: "relative", zIndex: 40 }}
      >
        {providerControl}
        {isLocalProvider && (serverError || (!serverStarting && !serverRunning)) ? (
          <div
            title={serverError ?? `${providerName(provider)} stopped`}
            style={{
              justifySelf: "center",
              display: "flex",
              alignItems: "center",
              gap: 5,
              fontSize: 9.5,
              letterSpacing: "0.04em",
              color: serverError ? "var(--danger)" : "var(--fg-dim)",
            }}
          >
            {serverError ?? "Stopped"}
          </div>
        ) : null}
        <div style={{ display: "flex", alignItems: "center", gap: 2, textTransform: "none", letterSpacing: 0 }}>
          <div ref={actionsRef} style={{ position: "relative" }}>
            <button
              onClick={() => setActionsOpen((open) => !open)}
              title="More actions"
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={actionsOpen}
              style={{ width: 26, height: 22, display: "grid", placeItems: "center", borderRadius: "var(--radius-sm)", color: actionsOpen ? "var(--fg-strong)" : "var(--fg-subtle)", background: actionsOpen ? "var(--bg-hover)" : "transparent" }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--fg-strong)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { if (!actionsOpen) { e.currentTarget.style.color = "var(--fg-subtle)"; e.currentTarget.style.background = "transparent"; } }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="12" r="1.6" />
                <circle cx="12" cy="12" r="1.6" />
                <circle cx="19" cy="12" r="1.6" />
              </svg>
            </button>
            {actionsOpen && (
              <div
                role="menu"
                className="popover-enter"
                style={{
                  position: "absolute",
                  right: 0,
                  top: "calc(100% + 8px)",
                  width: 218,
                  padding: 5,
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--border-strong)",
                  background: "var(--bg-elevated)",
                  boxShadow: "0 14px 34px rgba(38, 38, 32, 0.16)",
                  zIndex: 35,
                }}
              >
                {onDuplicate && (
                  <button
                    role="menuitem"
                    onClick={() => { onDuplicate({ provider, model }); setActionsOpen(false); }}
                    style={menuActionStyle(false)}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  >
                    <span style={menuActionIconStyle}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2" /></svg>
                    </span>
                    <span style={{ flex: 1 }}>Duplicate panel</span>
                  </button>
                )}
                {workspaceRoot && onMemoryWritten && (
                  <button
                    role="menuitem"
                    disabled={summarizing || msgs.length === 0}
                    title={msgs.length === 0 ? "Start a conversation first" : "Summarize and write to .klide/memory/"}
                    onClick={() => { if (msgs.length === 0 || summarizing) return; setActionsOpen(false); void runSummarize(); }}
                    style={menuActionStyle(summarizing || msgs.length === 0)}
                    onMouseEnter={(e) => { if (msgs.length > 0 && !summarizing) e.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  >
                    <span style={{ ...menuActionIconStyle, color: summarizing ? "var(--accent)" : "currentColor" }}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" />
                        <path d="M9 8h6" />
                        <path d="M9 12h4" />
                      </svg>
                    </span>
                    <span style={{ flex: 1 }}>{summarizing ? "Writing memory..." : "Summarize to Memory"}</span>
                  </button>
                )}
                {workspaceRoot && (
                  <button
                    role="menuitem"
                    disabled={generatingSkill || msgs.length < 2}
                    title={msgs.length < 2 ? "Need at least one exchange to detect a pattern" : "Save this session as a reusable skill"}
                    onClick={() => { if (msgs.length < 2 || generatingSkill) return; setActionsOpen(false); void runGenerateSkill(); }}
                    style={menuActionStyle(generatingSkill || msgs.length < 2)}
                    onMouseEnter={(e) => { if (msgs.length >= 2 && !generatingSkill) e.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  >
                    <span style={{ ...menuActionIconStyle, color: generatingSkill ? "var(--accent)" : "currentColor" }}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M12 3l1.8 4.2L18 9l-3.3 2.9L15.7 16 12 13.6 8.3 16l1-4.1L6 9l4.2-1.8z" />
                      </svg>
                    </span>
                    <span style={{ flex: 1 }}>{generatingSkill ? "Generating skill..." : "Save as skill"}</span>
                  </button>
                )}
              </div>
            )}
          </div>
          <ConversationHistory conversations={conversations} currentId={currentId} historyOpen={historyOpen} setHistoryOpen={setHistoryOpen} onSelect={loadConversation} onDelete={deleteConversation} />
          <button onClick={newConversation} title="New conversation" aria-label="New conversation" style={{ width: 26, height: 22, display: "grid", placeItems: "center", borderRadius: "var(--radius-sm)", color: "var(--fg-subtle)", background: "transparent" }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--fg-strong)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-subtle)"; e.currentTarget.style.background = "transparent"; }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
          </button>
          {onClose && (
            <button onClick={onClose} title="Close panel" aria-label="Close panel" style={{ width: 26, height: 22, display: "grid", placeItems: "center", borderRadius: "var(--radius-sm)", color: "var(--fg-subtle)", background: "transparent" }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--fg-strong)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-subtle)"; e.currentTarget.style.background = "transparent"; }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          )}
        </div>
      </header>
      ) : null}

      <div ref={canvasRef} style={{ position: "relative", flex: 1, minHeight: 0, display: "flex" }}>
        <div
          ref={scrollRef}
          onScroll={updateStickFromScroll}
          style={{ flex: 1, overflowX: "hidden", overflowY: delegateSession ? "hidden" : "auto", padding: delegateSession ? 0 : variant === "focus" ? `14px ${focusGutterRight} ${16 + todoDockHeight}px ${focusGutterLeft}` : `10px 12px ${12 + todoDockHeight}px`, transition: "padding 420ms cubic-bezier(0.32, 0.72, 0, 1)", fontSize: variant === "focus" ? 13.5 : 13, display: delegateSession ? "flex" : msgs.length === 0 ? "grid" : "block", placeItems: !delegateSession && msgs.length === 0 ? "center" : undefined, minWidth: 0, minHeight: 0, overscrollBehavior: "contain" }}
        >
        {delegateSession ? (
          <DelegateTerminalSurface
            sessionId={delegateSessionId(currentId, provider)}
            providerId={provider}
            provider={providerName(provider)}
            workspaceRoot={workspaceRoot}
            parentRunId={activeHarnessRunRef.current ?? currentId}
            resumeSessionId={initialResumeSessionId ?? null}
            // The spawn model comes from the per-provider store, NOT the
            // `model` prop: on relaunch the prop is App's last value for the
            // panel and can belong to another provider entirely (`claude
            // --model pierreprudh/lfm2.5…` shipped that way once), and the
            // surface spawns on mount — before the models-load effect can
            // heal the prop. The store is written on every in-session pick,
            // so it is exactly "the model last used with THIS provider".
            model={storedModelForProvider(provider)}
            task={initialTask ?? null}
          />
        ) : (
          <>
        {msgs.length === 0 && !serverStarting && (
          <div style={{ width: "min(300px, 86%)", textAlign: "center", color: "var(--fg-subtle)", lineHeight: 1.55, transform: "translateY(-10px)" }}>
            <div style={{ width: 38, height: 38, margin: "0 auto 14px", display: "grid", placeItems: "center" }}>
              <KlideMark size={34} />
            </div>
            <div style={{ color: "var(--fg-strong)", fontSize: 14, fontWeight: 500, marginBottom: 6 }}>{workspaceRoot ? "Ask Kit" : "Open a workspace"}</div>
            <div style={{ fontSize: 12 }}>{workspaceRoot ? (providerDelegatesWork ? `Delegate workspace tasks to ${providerName(provider)}.` : `Read, reason, and propose edits with ${providerName(provider)}.`) : "Open a folder to enable local agent mode."}</div>
            {workspaceRoot && !providerDelegatesWork && (
              <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 6 }}>
                {[
                  "Explain what this project does and how it's structured",
                  "Find and fix a bug in @",
                  "Add a test for @",
                ].map((p) => (
                  <button
                    key={p}
                    onClick={() => {
                      setInput(p);
                      requestAnimationFrame(() => {
                        const ta = taRef.current;
                        if (ta) { ta.focus(); ta.setSelectionRange(p.length, p.length); }
                      });
                    }}
                    style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 10px", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)", background: "var(--bg-elevated)", color: "var(--fg)", fontSize: 12, lineHeight: 1.4, cursor: "pointer", transition: "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)" }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.borderColor = "var(--border-strong)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-elevated)"; e.currentTarget.style.borderColor = "var(--border)"; }}
                  >
                    {p}
                  </button>
                ))}
                <div style={{ marginTop: 4, fontSize: 11, color: "var(--fg-dim)" }}>Type <b style={{ fontWeight: 600, color: "var(--fg-subtle)" }}>@</b> to attach a file · <b style={{ fontWeight: 600, color: "var(--fg-subtle)" }}>/</b> for commands</div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 12,
                    marginTop: 8,
                    fontSize: 11,
                    color: "var(--fg-dim)",
                  }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <Kbd keys={keysFor("ai-send")} /> Send
                  </span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <Kbd keys={keysFor("ai-toggle-mode")} /> Mode
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
        {stackToolRuns(msgs.map((m, i) => {
          if (m.role === "system" && m.completion) {
            const completion = m.completion;
            // In Focus the latest result waits in the island column instead,
            // under the plan it came from (see the column below). A row per
            // finished turn down the transcript would say it many times.
            if (variant === "focus") return null;
            return <CompletionCard key={i} completion={completion} disabled={streaming}
              compact={canvasWidth > 0 && canvasWidth < 300}
              onReview={onReviewChanges ? (path) => onReviewChanges({ runId: completion.runId, title: "Run changes", path }) : undefined}
              onOpenArtifact={onOpenArtifact ? (path) => onOpenArtifact({ runId: completion.runId, path, documents: documentSet(completion) }) : undefined}
              onPreviewArtifact={onPreviewArtifact}
              onRequestChanges={() => requestCompletionChanges(completion)}
            />;
          }
          // "Last" means the tail of the *exchange*, not of the array. Turns
          // typed ahead sit below the answer they're waiting on, and counting
          // them here would take the caret off a streaming answer, stop a
          // running tool row from reading as running, and move the revert slot
          // off the run that owns it — all while the run is still going.
          const following = msgs[i + 1];
          const isLast = i === lastExchangeIndex || (i + 1 === lastExchangeIndex && following?.role === "system" && !!following.completion);
          const isAssistantPlaceholder = streaming && m.role === "assistant" && m.content === "" && !m.thinking && !m.toolCalls;
          const activeToolRunning =
            streaming &&
            isLast &&
            m.role === "tool" &&
            /^Running /.test(m.content);
          const isStreamingActive = streaming && isLast && m.role === "assistant" && m.content !== "";
          // A tail that has only reasoned so far is live too — the thinking
          // header wears the shimmer + timer for it. Kept apart from
          // `isStreamingActive`, which also draws the text caret.
          const isThinkingActive = streaming && isLast && m.role === "assistant" && m.content === "" && !!m.thinking;
          // Messages above the last compaction marker are kept for reference but
          // no longer in the model's context — dim them so that's legible.
          const dimmed = compactionMarkerIdx > 0 && i < compactionMarkerIdx;

          if (m.role === "user") {
            // A wake turn has nothing to show; the response it produces opens
            // with the received line that explains it.
            if (m.wake) return null;
            const queued = m.queueState === "queued";
            const running = m.queueState === "running";
            const isEditing = editingIdx === i;
            const imageAtts = m.attachments?.filter((a) => a.dataUri) ?? [];
            // Documents that rode along without being named in the text — a
            // dropped or pasted file. An `@mention` attachment already shows
            // in the message itself, so repeating it here would be noise.
            const docAtts = (m.attachments ?? []).filter(
              (a) => !a.dataUri && !a.mime?.startsWith("image/") && !m.content.includes(a.path),
            );
            // A photo whose bytes the local cache dropped, so that one
            // screenshot could not evict a month of history (see
            // SNAPSHOT_IMAGE_BUDGET). Name it rather than let it vanish: the
            // full image is still in this run's transcript on disk.
            const omittedAtts = (m.attachments ?? []).filter(
              (a) => !a.dataUri && a.mime?.startsWith("image/"),
            );
            const hasText = m.content.trim().length > 0;
            // The mark belongs to the message, not to the top of the turn. It
            // rides beside the bubble — or beside the attachment strip when a
            // turn carries no text — the way the response mark rides beside an
            // answer's first line, nudged down so it centres on that line
            // rather than on the bubble's padding.
            const asker = showAskerAvatar ? (
              <div style={{ flexShrink: 0, marginTop: hasText || isEditing ? 6 : 0 }}>
                <AskerMark username={username} avatarUrl={avatarUrl} />
              </div>
            ) : null;
            // Everything the mark does not sit beside keeps its right edge in
            // line with the bubble's, so the column stays one edge, not two.
            // No mark, no gutter — the bubbles take the edge back.
            const askerGutter = showAskerAvatar ? 32 : 0;
            const beside = (node: ReactNode) => (
              <div style={{ display: "flex", width: "100%", maxWidth: "88%", gap: 10, alignItems: "flex-start", justifyContent: "flex-end" }}>
                {node}
                {asker}
              </div>
            );
            const imagesBlock = imageAtts.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "flex-end", maxWidth: hasText ? "88%" : "100%", paddingRight: hasText ? askerGutter : 0, marginBottom: hasText || docAtts.length > 0 ? 6 : 0 }}>
                {imageAtts.map((a, gi) => (
                  <button
                    key={gi}
                    type="button"
                    title="Open image"
                    aria-label={`Open ${a.path || "image"}`}
                    onClick={() => setLightboxImage(a.dataUri ?? null)}
                    style={{ padding: 0, width: 92, height: 92, border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", background: "var(--bg-elevated)", cursor: "zoom-in", flexShrink: 0, display: "block" }}
                  >
                    <img src={a.dataUri} alt={a.path || "Attached image"} loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                  </button>
                ))}
              </div>
            );
            const omittedBlock = omittedAtts.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "flex-end", maxWidth: hasText ? "88%" : "100%", paddingRight: hasText ? askerGutter : 0, marginBottom: hasText || docAtts.length > 0 ? 6 : 0 }}>
                {omittedAtts.map((a, gi) => (
                  <div
                    key={gi}
                    title={`${a.path} — kept in this run's transcript, not in local history`}
                    style={{ width: 92, height: 92, display: "grid", placeContent: "center", justifyItems: "center", gap: 5, padding: 8, border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-elevated)", color: "var(--fg-subtle)", fontSize: 10.5, lineHeight: 1.3, textAlign: "center", overflow: "hidden", flexShrink: 0 }}
                  >
                    <FileTypeIcon name={a.path} size={18} />
                    <span style={{ maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {a.path.split("/").pop() || a.path}
                    </span>
                  </div>
                ))}
              </div>
            );
            const docsBlock = docAtts.length > 0 && (
              <div
                style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end", maxWidth: hasText ? "88%" : "100%", paddingRight: hasText ? askerGutter : 0, marginBottom: hasText ? 6 : 0, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-subtle)" }}>
                {docAtts.map((a, gi) => (
                  <span key={gi} title={`${a.path} — sent as text`}>
                    {a.path.split("/").pop() || a.path}
                  </span>
                ))}
              </div>
            );
            return (
              <div key={i} className="ai-msg-in" style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", margin: "14px 0 12px", opacity: dimmed ? 0.4 : undefined, transition: "opacity var(--motion-med) var(--ease-out)" }}>
                {m.subagent && (
                  <div style={{ marginBottom: 4, paddingRight: askerGutter + 2, fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 500, letterSpacing: "0.01em", color: "var(--accent)", userSelect: "none" }}>
                    @{m.subagent}
                  </div>
                )}
                {isEditing ? (
                  beside(
                    <textarea
                      autoFocus
                      value={editingDraft}
                      onChange={(e) => setEditingDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); commitEdit(i); }
                        else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
                      }}
                      onBlur={() => commitEdit(i)}
                      rows={Math.max(1, Math.min(10, editingDraft.split("\n").length))}
                      style={{ maxWidth: "100%", width: "min(440px, 100%)", minWidth: 0, resize: "none", font: "inherit", fontSize: 13, lineHeight: 1.55, padding: "8px 12px", borderRadius: "12px 12px 4px 12px", border: "1px solid color-mix(in srgb, var(--accent) 50%, var(--border))", background: "var(--accent-soft)", color: "var(--fg-strong)", whiteSpace: "pre-wrap", wordBreak: "break-word", boxSizing: "border-box" }}
                    />,
                  )
                ) : (
                  <>
                    {hasText ? imagesBlock : null}
                    {hasText ? omittedBlock : null}
                    {hasText ? docsBlock : null}
                    {hasText ? (
                      beside(
                        <div
                          style={{ minWidth: 0, background: queued ? "color-mix(in srgb, var(--accent-soft) 48%, var(--bg))" : "var(--accent-soft)", color: queued ? "var(--fg-subtle)" : "var(--fg-strong)", border: (queued || running) ? "1px solid color-mix(in srgb, var(--accent) 36%, var(--border))" : "1px solid transparent", borderRadius: "12px 12px 4px 12px", padding: "8px 12px", fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word", opacity: queued ? 0.82 : 1 }}>
                          {m.content}
                        </div>,
                      )
                    ) : (
                      beside(
                        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                          {imagesBlock}
                          {omittedBlock}
                          {docsBlock}
                        </div>,
                      )
                    )}
                  </>
                )}
                {!queued && !running && hasText && !isEditing && (
                  <div style={{ paddingRight: askerGutter }}>
                    <MessageActions
                      role="user"
                      copied={copiedIdx === i}
                      disabled={streaming}
                      onCopy={() => { void navigator.clipboard?.writeText(m.content); setCopiedIdx(i); window.setTimeout(() => setCopiedIdx((c) => (c === i ? null : c)), 1400); }}
                      onRetry={() => retryFromMessage(i)}
                      onBranch={() => branchFromMessage(i)}
                      onBranchInWorktree={onForkConversationInWorktree ? () => branchMessageInWorktree(i) : undefined}
                      onEdit={() => editMessage(i)}
                      onDelete={() => deleteMessage(i)}
                    />
                  </div>
                )}
                {!isEditing && m.tokenInfo && hasText && (
                  <div
                    className="klide-msg-meta"
                    title={m.tokenInfo.exact ? "Exact count from the model's tokenizer" : "Estimate — this provider has no tokenizer endpoint"}
                    style={{ marginTop: 3, paddingRight: askerGutter, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-dim)", letterSpacing: "0.02em", userSelect: "none" }}
                  >
                    {m.tokenInfo.exact ? "" : "~"}{m.tokenInfo.count.toLocaleString()} tokens
                  </div>
                )}
              </div>
            );
          }

          if (m.role === "tool") {
            // The call above already drew this result under itself.
            if (toolPairing.claimed.has(i)) return null;
            return <div key={i} className="ai-msg-in" style={{ margin: activeToolRunning ? "2px 0 3px 32px" : "1px 0 2px 32px", opacity: dimmed ? 0.4 : undefined, transition: "opacity var(--motion-med) var(--ease-out)" }}>{renderMessageBody(m, activeToolRunning)}</div>;
          }

          // Steering marker: a loop-monitor intervention, not an assistant
          // utterance — render it indented to align with tool output. A
          // delivered agent message is the exception: it opens the response
          // that follows, so that response draws it at its top, under one
          // mark, and nothing is drawn here.
          if (m.role === "system" && m.steering) {
            if (parseDeliveryReason(m.steering.reason) && msgs[i + 1]?.role === "assistant") return null;
            return (
              <div key={i} className="ai-msg-in" style={{ margin: "8px 0 8px 32px" }}>
                {renderMessageBody(m, false, { workspaceRoot })}
              </div>
            );
          }

          // Run-failure marker: a terminal event, not an assistant utterance —
          // rendered as its own centered hairline row (the local-server
          // starting line's family), full width, no gutter.
          if (m.role === "system" && m.runError) {
            return (
              <div key={i} className="ai-msg-in" style={{ display: "flex", justifyContent: "center", margin: "16px 0 10px" }}>
                {renderMessageBody(m)}
              </div>
            );
          }

          // Compaction marker: a system event, not an assistant utterance —
          // render it gutter-less and indented to align with tool output.
          if (m.role === "system" && m.compaction) {
            const manual = m.compaction.source === "manual";
            return (
              <div key={i} className="ai-msg-in" style={{ margin: manual ? "4px 0" : "10px 0 10px 32px" }}>
                {renderMessageBody(m)}
              </div>
            );
          }

          // One avatar per response: multi-turn tool runs produce several
          // consecutive assistant/tool messages — only the first assistant
          // message after a user message carries Kit's K mark; the rest get a
          // 22px spacer so bodies stay column-aligned with tool rows.
          const prevMsg = msgs[i - 1];
          // The agent messages delivered right before this response, hoisted
          // in from the marker above (which drew nothing for itself). For the
          // "one mark per response" rule the marker is transparent: what came
          // before it decides.
          const hoistedInbox =
            m.role === "assistant" && prevMsg?.role === "system" && prevMsg.steering && parseDeliveryReason(prevMsg.steering.reason)
              ? prevMsg
              : null;
          const before = hoistedInbox ? msgs[i - 2] : prevMsg;
          const isResponseStart =
            (!before || (before.role !== "assistant" && before.role !== "tool")) &&
            // …unless a folded run's header is already wearing this turn's
            // mark, in which case this row draws the spacer and keeps the
            // column aligned without a second one.
            !toolRunMarkOwners.has(i);
          // Per-message actions belong on the *final* answer of a response, not
          // on intermediate narration turns ("OK, let me look…") that are
          // followed by more tool calls — otherwise the icon row appears in the
          // middle of a multi-turn run. A response ends when the next message is
          // a user turn (or there is none) — but a *queued* turn hasn't been
          // asked yet. Typing ahead while the agent works would otherwise stamp
          // the running answer as finished and hand it its copy/retry row
          // mid-run, which is the one thing this rule exists to prevent.
          const nextMsg = msgs[i + 1];
          const isResponseEnd = !nextMsg || (nextMsg.role === "system" && !!nextMsg.completion) || (nextMsg.role === "user" && nextMsg.queueState !== "queued");
          const mark = isResponseStart && m.role === "assistant" ? responseMark(m) : null;
          // This turn's results, handed to its call rows. A result is live
          // while it is the exchange's tail and still says "Running".
          let attachedResults: Map<string, AttachedResult> | undefined;
          const mine = toolPairing.byCall.get(i);
          if (mine) {
            attachedResults = new Map();
            for (const [key, j] of mine) {
              const r = msgs[j];
              if (r.role !== "tool") continue;
              attachedResults.set(key, { msg: r, active: streaming && j === lastExchangeIndex && /^Running /.test(r.content) });
            }
          }
          return (
            <div key={i} className="ai-msg-in" style={{ display: "flex", gap: 10, margin: isResponseStart ? "14px 0 8px" : "3px 0", opacity: dimmed ? 0.4 : undefined, transition: "opacity var(--motion-med) var(--ease-out)" }}>
              {isResponseStart ? (
                // A brand mark is worn bare — no disc, no ring, no tile, the
                // rule every other pairing in the app follows. Klide's own mark
                // is a brand mark too, so an unstamped response wears the app
                // logo bare rather than a hand-typed initial in a sage disc.
                // Same 22px box either way, so bodies stay column-aligned with
                // the tool rows below them.
                <div aria-hidden="true" style={{ flexShrink: 0, width: 22, height: 22, marginTop: 1, display: "grid", placeItems: "center" }}>
                  {mark ? mark.node : <KlideMark size={20} />}
                </div>
              ) : (
                <div aria-hidden="true" style={{ flexShrink: 0, width: 22 }} />
              )}
              <div style={{ flex: 1, minWidth: 0, color: "var(--fg-strong)", fontSize: 13, lineHeight: 1.6 }}>
                {hoistedInbox && <div style={{ margin: "0 0 4px" }}>{renderMessageBody(hoistedInbox, false, { workspaceRoot })}</div>}
                {isAssistantPlaceholder && !msgs.some((msg, idx) => idx > i && msg.role === "tool" && /^Running /.test(msg.content)) ? <AssistantPlaceholderLoader /> : <>{renderMessageBody(m, isStreamingActive || isThinkingActive, { hideThinking: toolRunAt(i) !== null, results: attachedResults })}{isStreamingActive && <span className="ai-caret" />}</>}
                {!isStreamingActive && !isAssistantPlaceholder && isResponseEnd && m.content?.trim() && (
                  <>
                    <MessageActions
                      role="assistant"
                      copied={copiedIdx === i}
                      disabled={streaming}
                      onCopy={() => { void navigator.clipboard?.writeText(m.content); setCopiedIdx(i); window.setTimeout(() => setCopiedIdx((c) => (c === i ? null : c)), 1400); }}
                      onRetry={() => retryFromMessage(i)}
                      onBranch={() => branchFromMessage(i)}
                      onBranchInWorktree={onForkConversationInWorktree ? () => branchMessageInWorktree(i) : undefined}
                      revert={
                        isLast && !streaming && revertableFiles > 0
                          ? {
                              files: revertableFiles,
                              busy: reverting,
                              onRevert: () => void revertThisRun(),
                              onReview: onReviewChanges
                                ? () =>
                                    onReviewChanges({
                                      runId: currentId,
                                      title:
                                        msgs.find((msg) => msg.role === "user")?.content.split("\n")[0].slice(0, 80) ??
                                        "Run changes",
                                    })
                                : undefined,
                            }
                          : undefined
                      }
                    />
                    {autoMemoryNotice && onOpenMemory && isLast && (
                      <button
                        type="button"
                        className="ai-msg-actions"
                        title={`Review memory draft: ${autoMemoryNotice}`}
                        aria-label="Review memory draft"
                        onClick={() => onOpenMemory()}
                        style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 22, marginTop: 6, padding: "0 7px", borderRadius: "var(--radius-sm)", border: "none", background: "transparent", color: "var(--fg-subtle)", fontSize: 11, cursor: "pointer", transition: "color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)" }}
                        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-subtle)"; e.currentTarget.style.background = "transparent"; }}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                        Review draft
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        }))}
        {/* "Working" heartbeat — shown while a run is in progress but nothing
            else is animating. Covers the gap where the model is generating the
            next turn (esp. providers that don't stream token deltas, so there's
            no typing caret): without this the completed tool calls just sit
            there and the agent looks stuck. Hidden when a tool is mid-run, a
            placeholder/caret is already animating, or we're waiting on the user
            (diff / permission / question). */}
        {(() => {
          // The exchange's tail, not the array's: turns typed ahead park below
          // it and say nothing about whether the run is alive.
          const last = msgs[lastExchangeIndex];
          const tailPendingTool = last?.role === "tool" && /^Running /.test(last.content);
          const tailPlaceholder = last?.role === "assistant" && !last.content && !last.thinking && !last.toolCalls;
          const tailStreamingText = last?.role === "assistant" && !!last.content;
          // A reasoning-only tail already wears its own shimmer + timer in the
          // thinking header; a second heartbeat under it would say it twice.
          const tailThinking = last?.role === "assistant" && !last.content && !!last.thinking;
          // A running user bubble already carries its own activity hint, so the
          // heartbeat under it is just noise.
          const tailQueuedUser = last?.role === "user" && !!last.queueState;
          const showWorking =
            streaming && !pendingDiff && !pendingPermission && !pendingQuestion &&
            !tailPendingTool && !tailPlaceholder && !tailStreamingText && !tailThinking && !tailQueuedUser;
          if (!showWorking) return null;
          // The timer counts from the turn's own send time, so it survives the
          // row unmounting while a tool runs and remounting after.
          let turnStartedAt: number | undefined;
          for (let i = lastExchangeIndex; i >= 0; i--) {
            const m = msgs[i];
            if (m.role === "user") { turnStartedAt = m.ts; break; }
          }
          return <WorkingRow label="Working" since={turnStartedAt} />;
        })()}
        {pendingInbox.some((e) => e.deliveryState !== "queued") && (
          <div className="ai-msg-in" style={{ display: "grid", gap: 4, margin: "8px 0 8px 32px" }}>
            <PendingInboxRow pending={pendingInbox.filter((e) => e.deliveryState !== "queued")} />
          </div>
        )}
        {serverStarting && (
          <div
            className="ai-msg-in"
            style={{
              display: "flex",
              justifyContent: "center",
              margin: msgs.length === 0 ? 0 : "12px 0",
              width: "100%",
              textAlign: msgs.length === 0 ? "center" : undefined,
            }}
          >
            <LocalServerStartingRow providerLabel={providerName(provider)} centered={msgs.length === 0} />
          </div>
        )}
        {(compacting || compactError) && (
          <div className="ai-msg-in" style={{ margin: compactSource === "manual" ? "6px 0" : "6px 0 8px 32px" }}>
            <CompactionRow status="running" error={compactError} source={compactSource} />
          </div>
        )}
        {pendingDiff && (
          <div style={{ margin: "2px 0 4px 32px" }}>
            <InlineDiffReview
              edit={{
                path: pendingDiff.path,
                oldContent: pendingDiff.oldContent,
                newContent: pendingDiff.newContent,
                isCreate: pendingDiff.isCreate,
                reason: pendingDiff.reason,
              }}
              onApply={handleDiffApply}
              onApplyAll={onRequireDiffReviewChange ? handleDiffApplyAll : undefined}
              onReject={handleDiffReject}
              onRequestChanges={handleDiffRequestChanges}
              onOpenChanges={onOpenDiff ? () => onOpenDiff({
                path: pendingDiff.path,
                oldContent: pendingDiff.oldContent,
                newContent: pendingDiff.newContent,
                isCreate: pendingDiff.isCreate,
              }) : undefined}
            />
          </div>
        )}
          </>
        )}
        </div>

        {/* Jump-to-latest — a static chevron anchored to the visible
            bottom of the panel (sibling of the scroll div, inside the
            position:relative wrapper). This is the standard chat-app
            pattern: a small icon pinned to the viewport bottom that
            only appears when the user is scrolled up, regardless of
            where they are in the scroll content.

            Crucially this is OUTSIDE the scroll container — a position
            absolute chevron inside the scrollable area would scroll
            along with the content and end up sitting in the middle of
            a long conversation when the user scrolls up. Anchoring
            here means it always sits at the bottom of the visible
            viewport, even mid-scroll. */}
        {!delegateSession && !stickToBottom && msgs.length > 0 && (
          <span
            role="button"
            tabIndex={0}
            onClick={forceStickToBottom}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                forceStickToBottom();
              }
            }}
            title="Jump to latest message"
            aria-label="Jump to latest message"
            style={{
              position: "absolute",
              // The conversation column is centred in the space left of the
              // island (see `focusGutterLeft`), so the chevron centres on
              // that column, not on the whole canvas.
              left: `calc((100% - ${focusInset}px) / 2)`,
              bottom: todoDockHeight + 8,
              transform: "translateX(-50%)",
              zIndex: 7,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: 4,
              borderRadius: 6,
              color: streaming ? "var(--accent)" : "var(--fg-subtle)",
              cursor: "pointer",
              opacity: 0.7,
              transition: "opacity var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), bottom var(--motion-med) var(--ease-out), left 420ms cubic-bezier(0.32, 0.72, 0, 1)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.opacity = "1";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.opacity = "0.7";
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 5v14" />
              <path d="m6 13 6 6 6-6" />
            </svg>
          </span>
        )}
        {variant !== "focus" && (
          <TodoStrip
            workspaceRoot={workspaceRoot}
            conversationId={currentId}
            goal={msgs.find((m) => m.role === "user")?.content.trim() || undefined}
            running={streaming}
            variant="dock"
            onDockHeightChange={setTodoDockHeight}
            onPresenceChange={setPlanSlot}
          />
        )}
      </div>

      {/* The side column. Focus keeps its windows here — the plan, under
          it the run's result, and under that a question the run is parked
          on — one absolutely positioned column so they stack with a gap
          instead of each measuring the other's height. It is a child of the
          panel rather than of the canvas, so it runs the whole side: the
          canvas ends above the composer, and a column that stopped there cut
          an open card off mid-content against that seam. The composer is
          already inset by `focusGutterRight` for this width, so the side
          below the canvas is the column's to use.
          Everywhere else the plan docks over the composer and this column
          does not exist. */}
      {variant === "focus" && (
        <div
          ref={islandColumnRef}
          className="klide-island-column"
          style={{
            position: "absolute",
            top: 16,
            right: 18,
            zIndex: 6,
            width: `min(${column.width}px, calc(100% - 36px))`,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            // A short window cannot fit a long plan, a result and a question
            // at once, and the question is the one that must stay reachable
            // — it holds the run. So the column spans the side and scrolls
            // inside it: a wheel over any card bubbles to this scroller even
            // though the column itself takes no hits. The height is definite
            // rather than a cap, so a card that opens (the result) can claim
            // the space the others are not using instead of standing as a
            // block of its own; the others keep their natural size, since a
            // flex item does not shrink below its content.
            bottom: 16,
            overflowY: "auto",
            overscrollBehavior: "contain",
            // The column is only geometry; each card takes its own clicks
            // back so the conversation stays reachable around them.
            pointerEvents: "none",
          }}
        >
          {/* Open, the column heads with one control: close. Closed, the corner
              is marks — the plan's own reopen pill and, beside it, the result's
              — the way the plan has always folded. So the main view carries
              icons rather than a panel, and either icon opens the panel. */}
          {/* The close control keeps its place at the head of the column and
              slides in and out of it, rather than appearing and vanishing: the
              cards below it move by the height of one row either way, and a
              row that pops takes the whole stack with it. Its slot stays
              mounted so both directions animate (tokens.css owns the curve and
              the reduced-motion guard). */}
          <div className="klide-island-close-slot" data-shown={column.showClose ? "1" : undefined}>
            <div style={{ display: "flex", justifyContent: "flex-end", flexShrink: 0 }}>
              <button
                tabIndex={column.showClose ? undefined : -1}
                aria-hidden={column.showClose ? undefined : true}
                type="button"
                onClick={() => setSidePanelHidden(true)}
                aria-label="Close the side panel"
                title="Close the side panel"
                style={{
                  pointerEvents: "auto",
                  width: 24,
                  height: 24,
                  display: "grid",
                  placeItems: "center",
                  padding: 0,
                  border: "none",
                  borderRadius: "var(--radius-sm)",
                  background: "transparent",
                  color: "var(--fg-dim)",
                  cursor: "pointer",
                  transition: "color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--fg-strong)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-dim)"; e.currentTarget.style.background = "transparent"; }}
              >
                <CloseIcon size={14} />
              </button>
            </div>
          </div>
          {(
          <TodoStrip
            workspaceRoot={workspaceRoot}
            conversationId={currentId}
            goal={msgs.find((m) => m.role === "user")?.content.trim() || undefined}
            running={streaming}
            variant="island"
            folded={column.planFolded}
            onUnfold={() => setSidePanelHidden(false)}
            onDockHeightChange={setTodoDockHeight}
            onPresenceChange={setPlanSlot}
          />
          )}
          {/* The result lives in the corner whether the column is open or
              folded — "a document or review should stay in icons" — and its
              own resting state is that icon. The card draws that mark itself
              when the column is folded; a second pill here drew the same
              result twice. */}
          {latestCompletion && (
            <CompletionCard
              variant="island"
              folded={column.planFolded}
              onUnfold={() => setSidePanelHidden(false)}
              completion={latestCompletion}
              disabled={streaming}
              onReview={onReviewChanges ? (path) => onReviewChanges({ runId: latestCompletion.runId, title: "Run changes", path }) : undefined}
              onOpenArtifact={onOpenArtifact ? (path) => onOpenArtifact({ runId: latestCompletion.runId, path, documents: documentSet(latestCompletion) }) : undefined}
              onPreviewArtifact={onPreviewArtifact}
              onRequestChanges={() => requestCompletionChanges(latestCompletion)}
            />
          )}
          {pendingQuestion && (
            <QuestionCard
              variant="island"
              question={pendingQuestion.question}
              answer={questionAnswer}
              onAnswerChange={setQuestionAnswer}
              onSubmit={() => void submitQuestion()}
              onSkip={skipQuestion}
            />
          )}
        </div>
      )}

      {!delegateSession && (
      <div style={{ padding: variant === "focus" ? `0 ${focusGutterRight} 16px ${focusGutterLeft}` : "0 10px 10px", transition: "padding 420ms cubic-bezier(0.32, 0.72, 0, 1)" }}>
        {/* Another agent's words wait here for the user before this
            conversation may read them — the same card as a shell command,
            answered into the journal. While the run itself is paused on one
            of them, that card comes from the harness instead. */}
        {workspaceRoot && pendingInbox
          .filter((e) => e.deliveryState === "queued" && e.envelope.id !== pendingPermission?.envelopeId)
          .map(({ envelope: e }) => (
            <InlineCommandReview
              key={e.id}
              kind="message"
              peer={peerName(e.from.type === "run" ? e.from.runId : "operator", peerIndex)}
              command={e.body}
              detail={`${e.kind} · read by this conversation at its next turn once approved`}
              onReject={() => { void reviewEnvelope(workspaceRoot, currentId, e.id, false).catch((err) => notify(`Couldn't decline the message: ${errMessage(err)}`, { tone: "error" })); }}
              onApproveOnce={() => {
                void reviewEnvelope(workspaceRoot, currentId, e.id, true)
                  .then(() => wakeForInbox())
                  .catch((err) => notify(`Couldn't approve the message: ${errMessage(err)}`, { tone: "error" }));
              }}
            />
          ))}
        {pendingPermission && (
          <InlineCommandReview
            command={pendingPermission.command}
            kind={pendingPermission.kind}
            detail={pendingPermission.reason}
            externalPaths={pendingPermission.externalPaths}
            onReject={rejectCommand}
            onApproveOnce={() => approveCommand("once")}
            peer={pendingPermission.peer}
            onApproveForRun={() => approveCommand("run")}
            onApproveForProject={pendingPermission.kind === "message" ? undefined : () => approveCommand("project")}
            pattern={pendingPermission.suggestedPattern}
            onApprovePattern={(pattern) => approveCommand("project", pattern)}
          />
        )}
        {/* Everywhere but Focus the question waits above the composer: those
            layouts have no canvas margin to put a window in. On the Focus
            canvas it is an island instead — see the column beside the
            conversation. */}
        {pendingQuestion && variant !== "focus" && (
          <QuestionCard
            question={pendingQuestion.question}
            answer={questionAnswer}
            onAnswerChange={setQuestionAnswer}
            onSubmit={() => void submitQuestion()}
            onSkip={skipQuestion}
          />
        )}
        {showCompactPrompt && (
          <div style={{ padding: "0 2px 6px" }}>
            <button type="button" onClick={() => void compactConversation()} title="Summarize older turns to free up context"
              style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "2px 8px", borderRadius: "var(--radius-sm)", border: "1px solid transparent", background: "transparent", color: "var(--fg-subtle)", fontFamily: "var(--font-mono)", fontSize: 11.5, cursor: "pointer", transition: "color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)" }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--fg-strong)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-subtle)"; e.currentTarget.style.background = "transparent"; }}>
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 4h10" /><path d="M5 8h6" /><path d="M6.5 12h3" />
              </svg>
              Compact
              <span style={{ opacity: 0.55 }}>{Math.round(contextRatio * 100)}%</span>
            </button>
          </div>
        )}
        {/* The run's changed-files outcome lives in the final answer's
            MessageActions row (revert slot) — no standalone strip here. */}
        <div style={{ position: "relative", border: `1px solid ${composerFocused ? "var(--accent)" : "var(--border-strong)"}`, borderRadius: "var(--radius-lg)", background: "var(--bg-elevated)", boxShadow: composerFocused ? "0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent), 0 4px 16px rgba(38, 38, 32, 0.08)" : "0 1px 3px rgba(38, 38, 32, 0.05)", transition: "border-color var(--motion-med) var(--ease-out), box-shadow var(--motion-med) var(--ease-out)" }}>
          {slash !== null && slashMatches.length > 0 && (
            <div role="listbox" style={{ position: "absolute", bottom: "calc(100% + 6px)", left: 0, right: 0, maxHeight: 240, overflowY: "auto", background: "var(--bg-elevated)", border: "1px solid var(--border-strong)", borderRadius: "var(--radius-md)", boxShadow: "0 6px 24px rgba(38, 38, 32, 0.14)", padding: 4, zIndex: 20 }}>
              {slashMatches.map((cmd, idx) => (
                <div key={cmd.name} role="option" aria-selected={idx === slashIdx}
                  onMouseDown={(e) => { e.preventDefault(); acceptSlash(idx); }}
                  onMouseEnter={() => setSlashIdx(idx)}
                  style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "6px 8px", borderRadius: "var(--radius-sm)", cursor: "pointer", background: idx === slashIdx ? "var(--bg-hover)" : "transparent" }}>
                  <span style={{ color: "var(--fg-strong)", fontSize: 12, fontWeight: 500 }}>/{cmd.name}</span>
                  <span style={{ color: "var(--fg-dim)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cmd.desc}</span>
                </div>
              ))}
            </div>
          )}
          {mention !== null && mentionTotal > 0 && (
            <div role="listbox" style={{ position: "absolute", bottom: "calc(100% + 6px)", left: 0, right: 0, maxHeight: 220, overflowY: "auto", background: "var(--bg-elevated)", border: "1px solid var(--border-strong)", borderRadius: "var(--radius-md)", boxShadow: "0 6px 24px rgba(38, 38, 32, 0.14)", padding: 4, zIndex: 20 }}>
              {subagentMatches.length > 0 && (
                <div style={{ padding: "4px 8px 2px", fontSize: 10, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--fg-dim)", userSelect: "none" }}>Subagents</div>
              )}
              {subagentMatches.map((sub, i) => (
                <div key={sub.id} role="option" aria-selected={i === mentionIdx}
                  onMouseDown={(e) => { e.preventDefault(); acceptSubagent(sub.label); }}
                  onMouseEnter={() => setMentionIdx(i)}
                  style={{ display: "flex", alignItems: "baseline", gap: 6, padding: "5px 8px", borderRadius: "var(--radius-sm)", fontSize: 12, cursor: "pointer", background: i === mentionIdx ? "var(--bg-hover)" : "transparent", whiteSpace: "nowrap", overflow: "hidden" }}>
                  <span style={{ color: "var(--fg-strong)", fontWeight: 500 }}>@{sub.label}</span>
                  <span style={{ color: "var(--fg-dim)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis" }}>{sub.blurb}</span>
                </div>
              ))}
              {mentionMatches.length > 0 && subagentMatches.length > 0 && (
                <div style={{ padding: "6px 8px 2px", fontSize: 10, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--fg-dim)", userSelect: "none" }}>Files</div>
              )}
              {mentionMatches.map((path, idx) => {
                const absIdx = subagentMatches.length + idx;
                const slash = path.lastIndexOf("/");
                const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
                const base = slash >= 0 ? path.slice(slash + 1) : path;
                return (
                  <div key={path} role="option" aria-selected={absIdx === mentionIdx}
                    onMouseDown={(e) => { e.preventDefault(); acceptMention(path); }}
                    onMouseEnter={() => setMentionIdx(absIdx)}
                    style={{ display: "flex", alignItems: "baseline", gap: 2, padding: "5px 8px", borderRadius: "var(--radius-sm)", fontSize: 12, cursor: "pointer", background: absIdx === mentionIdx ? "var(--bg-hover)" : "transparent", whiteSpace: "nowrap", overflow: "hidden" }}>
                    <span style={{ color: "var(--fg-strong)" }}>{base}</span>
                    <span style={{ color: "var(--fg-dim)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis" }}>{dir && ` ${dir}`}</span>
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ overflow: "hidden", borderRadius: "var(--radius-lg)" }}>
          <input
            ref={filePickerRef}
            type="file"
            multiple
            accept={ATTACH_ACCEPT}
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = ""; // picking the same file twice still fires
              if (files.length) void addFiles(files);
            }}
          />
          <AttachmentTray
            attachments={pendingAttachments}
            onRemove={(i) => setPendingAttachments((prev) => prev.filter((_, j) => j !== i))}
            onOpenPhoto={(dataUri) => setLightboxImage(dataUri)}
          />
          <textarea ref={taRef} className="klide-composer-textarea" value={input}
            onChange={(e) => handleComposerChange(e.target.value, e.target.selectionStart)}
            onKeyDown={(e) => {
              if (slash !== null && slashMatches.length > 0) {
                if (e.key === "ArrowDown") { e.preventDefault(); setSlashIdx((i) => (i + 1) % slashMatches.length); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setSlashIdx((i) => (i - 1 + slashMatches.length) % slashMatches.length); return; }
                if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); acceptSlash(slashIdx); return; }
                if (e.key === "Escape") { e.preventDefault(); setSlash(null); return; }
              }
              if (mention !== null && mentionTotal > 0) {
                if (e.key === "ArrowDown") { e.preventDefault(); setMentionIdx((i) => (i + 1) % mentionTotal); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setMentionIdx((i) => (i - 1 + mentionTotal) % mentionTotal); return; }
                if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); acceptMentionAt(mentionIdx); return; }
                if (e.key === "Escape") { e.preventDefault(); setMention(null); return; }
              }
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
              else if (e.key === "Tab" && !delegateSession) { e.preventDefault(); toggleMode(); }
              else if (e.key === "Escape" && (streaming || serverStarting)) { e.preventDefault(); stopCurrentStream(); }
            }}
            onFocus={() => { setComposerFocused(true); }}
            onBlur={() => { setComposerFocused(false); setMention(null); setSlash(null); }}
            onPaste={onComposerPaste}
            onDrop={onComposerDrop}
            onDragOver={(e) => { if (canAttachFiles && Array.from(e.dataTransfer?.items ?? []).some((i) => i.kind === "file")) e.preventDefault(); }}
            placeholder={serverStarting ? `Starting ${providerName(provider)}...` : streaming ? "Queue another message…" : canAttachFiles ? "Ask anything, @ to attach a file, drop a photo or document…" : "Ask anything, @ to attach a file…"}
            rows={1}
            data-ai-composer
            style={{ width: "100%", minHeight: 40, maxHeight: 168, resize: "none", background: "transparent", border: "none", color: "var(--fg-strong)", font: "inherit", fontSize: 13.5, lineHeight: 1.55, padding: "12px 14px 8px", outline: "none", display: "block" }}
          />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: width < 360 ? 4 : 6, padding: "6px 8px", borderTop: "1px solid color-mix(in srgb, var(--border) 30%, transparent)", flexWrap: "nowrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: variant === "focus" ? 1 : width < 360 ? 4 : 6, minWidth: 0, flex: "0 0 auto", flexWrap: "nowrap", overflow: "hidden" }}>
              {delegateSession ? (
                // A live CLI session owns its own mode and context, so the
                // composer names who is listening instead of offering controls
                // that would not reach it. (Never in Focus: `delegateSession`
                // is false there, and the full control row applies.)
                <div title={`Speaking to ${providerName(provider)} delegate`} style={{ height: 24, display: "inline-flex", alignItems: "center", gap: 6, padding: "0 4px", color: "var(--fg-subtle)", fontSize: 11, fontWeight: 500, flexShrink: 0 }}>
                  <ProviderLogo id={provider} size={13} /><span>{providerName(provider)}</span>
                </div>
              ) : (
                <div style={{ position: "relative", flexShrink: 0 }}>
                  <button ref={modeTriggerRef} type="button" onClick={() => { if (!streaming) { if (modeOpen) closeModeMenu(); else openModeMenu(); } }} disabled={streaming}
                    title="Add context · choose mode"
                    aria-haspopup="menu" aria-expanded={modeOpen} aria-label="Add context and choose mode"
                    style={{ display: "grid", placeItems: "center", height: 26, width: 26, flexShrink: 0, padding: 0, border: "none", background: "transparent", color: modeOpen ? "var(--fg-strong)" : "var(--fg-subtle)", cursor: streaming ? "default" : "pointer", transform: modeOpen ? "rotate(45deg)" : "none", transition: "color var(--motion-fast) var(--ease-out), transform var(--motion-med) var(--ease-out)" }}
                    onMouseEnter={(e) => { if (!streaming) e.currentTarget.style.color = "var(--fg-strong)"; }}
                    onMouseLeave={(e) => { if (!modeOpen) e.currentTarget.style.color = "var(--fg-subtle)"; }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                  </button>
                  {modeOpen && modeMenuPos && createPortal(
                    <div ref={modeMenuRef} role="menu" aria-label="Add context and mode" className="popover-enter" style={{ position: "fixed", left: modeMenuPos.left, bottom: modeMenuPos.bottom, width: 204, padding: 5, borderRadius: "var(--radius-md)", border: "1px solid var(--border)", background: "var(--bg-elevated)", boxShadow: "0 18px 44px rgba(0, 0, 0, 0.28)", zIndex: Z.popover }}>
                      <button type="button" role="menuitem" onClick={addFileMention} title="Add a file to the conversation context"
                        style={{ width: "100%", display: "flex", alignItems: "center", height: 32, padding: "0 10px", border: "none", borderRadius: "var(--radius-sm)", background: "transparent", color: "var(--fg)", font: "inherit", fontSize: 13, cursor: "pointer" }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                        <span style={{ flex: 1, textAlign: "left" }}>Add file</span>
                        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-dim)" }}>@</span>
                      </button>
                      {/* `@` reaches workspace files by path; this reaches a
                          photo or document from anywhere on disk. */}
                      <button type="button" role="menuitem" disabled={!canAttachFiles}
                        onClick={() => { closeModeMenu(); filePickerRef.current?.click(); }}
                        title={canAttachFiles
                          ? modelSupportsVision
                            ? "Attach a photo or a text document"
                            : `${model} can't see images — attach a text document`
                          : "This CLI takes text only"}
                        style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, height: 32, padding: "0 10px", border: "none", borderRadius: "var(--radius-sm)", background: "transparent", color: canAttachFiles ? "var(--fg)" : "var(--fg-dim)", font: "inherit", fontSize: 13, cursor: canAttachFiles ? "pointer" : "default" }}
                        onMouseEnter={(e) => { if (canAttachFiles) e.currentTarget.style.background = "var(--bg-hover)"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                        <span style={{ flex: 1, textAlign: "left" }}>{modelSupportsVision ? "Photo or document" : "Document"}</span>
                        <AttachIcon size={14} />
                      </button>
                      <div style={{ height: 1, background: "var(--border)", margin: "4px 8px" }} />
                      {MODE_CHOICES.map((rung) => {
                        const disabled = rung.mode === "goal" && goalDisabled;
                        const active = rung.mode === effectiveMode;
                        return (
                          <button key={rung.mode} type="button" role="menuitemradio" aria-checked={active} disabled={disabled}
                            onClick={() => { if (!disabled) selectMode(rung.mode); }}
                            title={disabled ? `${model} cannot use edit tools.` : rung.description}
                            style={{ width: "100%", display: "flex", alignItems: "center", height: 32, padding: "0 10px", border: "none", borderRadius: "var(--radius-sm)", background: "transparent", font: "inherit", fontSize: 13, cursor: disabled ? "default" : "pointer" }}
                            onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = "var(--bg-hover)"; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                            <span style={{ flex: 1, textAlign: "left", color: disabled ? "var(--fg-dim)" : active ? "var(--fg-strong)" : "var(--fg-subtle)", fontWeight: active ? 500 : 400, whiteSpace: "nowrap" }}>{rung.label}</span>
                            {active && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}><path d="M20 6 9 17l-5-5" /></svg>}
                          </button>
                        );
                      })}
                      <div style={{ height: 1, background: "var(--border)", margin: "4px 8px" }} />
                      <button type="button" role="menuitem" onClick={openCommandsMenu} title="Browse slash commands"
                        style={{ width: "100%", display: "flex", alignItems: "center", height: 32, padding: "0 10px", border: "none", borderRadius: "var(--radius-sm)", background: "transparent", color: "var(--fg)", font: "inherit", fontSize: 13, cursor: "pointer" }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                        <span style={{ flex: 1, textAlign: "left" }}>Commands</span>
                        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-dim)" }}>/</span>
                      </button>
                    </div>,
                    document.body
                  )}
                </div>
              )}
              {/* Focus keeps the same footer order as the start-stage composer
                  (FocusMode.tsx): the "+" leads, the provider follows — firing
                  the first message must not shuffle the controls. */}
              {variant === "focus" ? (
                <div className="klide-focus-provider-control">
                  {providerControl}
                </div>
              ) : null}
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: width < 360 ? 1 : 2, flex: "1 1 auto", minWidth: 0 }}>
              {!isLocalProvider && conversationCostUsd > 0 && width >= 380 && (
                <span
                  title={`This conversation has cost about $${conversationCostUsd.toFixed(conversationCostUsd < 1 ? 4 : 2)} (${modelLabel(model)} list price)`}
                  style={{ height: 20, display: "inline-flex", alignItems: "center", gap: 5, padding: "0 4px", color: "var(--fg-subtle)", fontSize: 10.5, fontFamily: "var(--font-mono)", fontWeight: 500, whiteSpace: "nowrap" }}
                >
                  {conversationCostUsd < 0.01 ? "<$0.01" : `$${conversationCostUsd.toFixed(conversationCostUsd < 1 ? 3 : 2)}`}
                </span>
              )}
              {/* Auto has nothing to pick: the model is Rust's to choose, and
                  the turn's meta line names it once the run starts. */}
              {!isAutoProvider(provider) && (
                <ModelPicker
                  provider={provider}
                  model={model}
                  availableModels={availableModels}
                  disabled={streaming}
                  onChange={changeModel}
                />
              )}
              {(
                <div style={{ position: "relative", flexShrink: 0 }}>
                  <button
                    ref={reflectionTriggerRef}
                    type="button"
                    disabled={streaming || !modelSupportsReflection}
                    onClick={() => {
                      if (streaming || !modelSupportsReflection) return;
                      if (reflectionOpen) closeReflectionMenu();
                      else openReflectionMenu();
                    }}
                    aria-haspopup="menu"
                    aria-expanded={reflectionOpen}
                    aria-label={`Reflection: ${activeReflection.label}`}
                    title={modelSupportsReflection ? "Choose reflection level for this model" : "This model doesn't support reasoning effort"}
                    style={{
	                      display: "flex",
	                      alignItems: "center",
	                      justifyContent: "center",
	                      height: 24,
	                      width: width < 360 ? 28 : 32,
	                      padding: 0,
	                      borderRadius: 999,
	                      border: "1px solid transparent",
	                      background: reflectionOpen ? "var(--bg-hover)" : "transparent",
	                      boxShadow: "none",
                      color: !modelSupportsReflection ? "var(--fg-dim)" : reflectionOpen ? "var(--fg-strong)" : "var(--fg-subtle)",
                      fontSize: 11,
                      fontWeight: 500,
                      letterSpacing: 0,
                      cursor: streaming || !modelSupportsReflection ? "default" : "pointer",
	                      transition: "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
                    }}
                    onMouseEnter={(e) => { if (!streaming && modelSupportsReflection) e.currentTarget.style.color = "var(--fg-strong)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = !modelSupportsReflection ? "var(--fg-dim)" : reflectionOpen ? "var(--fg-strong)" : "var(--fg-subtle)"; }}
                  >
	                    <span style={{ opacity: modelSupportsReflection ? 1 : 0.4, display: "inline-flex" }}><ReflectionBars level={activeReflection.level} /></span>
	                  </button>
                  {reflectionOpen && reflectionMenuPos && createPortal(
	                    <div ref={reflectionMenuRef} role="menu" aria-label="Reflection level" className="popover-enter" style={{ position: "fixed", left: reflectionMenuPos.left, bottom: reflectionMenuPos.bottom, width: 166, padding: 4, borderRadius: "var(--radius-md)", border: "1px solid var(--border-strong)", background: "var(--bg-elevated)", boxShadow: "0 10px 26px rgba(38, 38, 32, 0.14)", zIndex: Z.popover + 5 }}>
                      {reflectionOptions.map((option) => {
                        const active = option.value === reflectionLevel;
                        return (
                          <button
                            key={option.value ?? "auto"}
                            type="button"
                            role="menuitemradio"
                            aria-checked={active}
	                            onClick={() => selectReflectionLevel(option.value)}
		                            style={{ width: "100%", minHeight: 30, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "4px 7px", border: "none", borderRadius: "var(--radius-sm)", background: active ? "var(--bg-hover)" : "transparent", color: active ? "var(--fg-strong)" : "var(--fg-subtle)", font: "inherit", textAlign: "left", cursor: "pointer" }}
		                          >
		                            <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
	                              <ReflectionBars level={option.level} size="menu" />
	                              <span style={{ display: "grid", gap: 1, minWidth: 0 }}>
	                              <span style={{ fontSize: 12, fontWeight: 500 }}>{option.label}</span>
	                              {option.value === undefined && (
	                                <span style={{ fontSize: 10.5, color: "var(--fg-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{option.desc}</span>
	                              )}
	                              </span>
	                            </span>
                            {active && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}><path d="M20 6 9 17l-5-5" /></svg>}
                          </button>
                        );
                      })}
                    </div>,
                    document.body
                  )}
                </div>
              )}
              <button ref={contextTriggerRef} type="button" aria-label={`Context window usage ${Math.round(contextRatio * 100)} percent`}
                style={{ width: 28, height: 28, flexShrink: 0, display: "grid", placeItems: "center", borderRadius: "50%", background: contextHover ? "var(--bg-hover)" : "transparent", color: contextTone, cursor: "default", position: "relative", zIndex: 2, transition: "background var(--motion-fast) var(--ease-out), color var(--motion-med) var(--ease-out)" }}
                onMouseEnter={(e) => { openContextTooltip(); e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { closeContextTooltip(); e.currentTarget.style.background = "transparent"; }}
                onFocus={openContextTooltip}
                onBlur={closeContextTooltip}>
                <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
                  <circle cx="11" cy="11" r="7.5" fill="none" stroke="var(--border)" strokeWidth="1.6" />
                  <circle cx="11" cy="11" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" pathLength="100" strokeDasharray={`${Math.max(2, Math.round(contextRatio * 100))} 100`} transform="rotate(-90 11 11)" style={{ transition: "stroke-dasharray var(--motion-med) var(--ease-out), stroke var(--motion-med) var(--ease-out)" }} />
                </svg>
                {contextHover && contextTooltipPos && createPortal(
                  <div role="tooltip" className="popover-enter" style={{ position: "fixed", left: contextTooltipPos.left, bottom: contextTooltipPos.bottom, width: contextTooltipPos.width, maxWidth: "calc(100vw - 16px)", padding: contextTooltipPos.compact ? "10px 10px 9px" : "12px 12px 11px", borderRadius: "var(--radius-lg)", border: "1px solid var(--border-strong)", background: "var(--bg-elevated)", boxShadow: "0 14px 38px rgba(38, 38, 32, 0.18)", color: "var(--fg)", textAlign: "left", pointerEvents: "none", zIndex: Z.tooltip }}>
                    <div style={{ display: "flex", alignItems: contextTooltipPos.compact ? "start" : "baseline", justifyContent: "space-between", gap: 12, marginBottom: 9 }}>
                      <span style={{ color: "var(--fg-strong)", fontSize: 13, fontWeight: 600 }}>Context window</span>
                      <span style={{ color: "var(--fg-subtle)", fontSize: contextTooltipPos.compact ? 11.5 : 13, fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", textAlign: "right", lineHeight: 1.25 }}>{formatContextTokens(contextUsed)} / {formatContextTokens(effectiveContextLimit)} ({Math.round(contextRatio * 100)}%)</span>
                    </div>
                    <div style={{ height: 7, borderRadius: 999, background: "var(--bg-hover)", overflow: "hidden", marginBottom: 11, display: "flex", gap: 1 }}>
                      {contextBreakdownRows.filter((row) => row.id !== "free" && row.tokens > 0).map((row) => (
                        <div
                          key={row.id}
                          title={`${row.label}: ${row.tokens.toLocaleString()} tokens`}
                          style={{
                            width: `${Math.max(1.4, (row.tokens / effectiveContextLimit) * 100)}%`,
                            maxWidth: `${Math.max(0, (row.tokens / effectiveContextLimit) * 100)}%`,
                            height: "100%",
                            background: row.color,
                            opacity: row.muted ? 0.7 : 1,
                          }}
                        />
                      ))}
                    </div>
                    <div style={{ display: "grid", gap: 7, color: "var(--fg-subtle)", fontSize: 12, lineHeight: 1.25 }}>
                      {contextBreakdownRows.map((row) => {
                        const pct = effectiveContextLimit > 0 ? (row.tokens / effectiveContextLimit) * 100 : 0;
                        return (
                          <div key={row.id} style={{ display: "grid", gridTemplateColumns: contextTooltipPos.compact ? "12px minmax(0, 1fr) 58px 42px" : "14px minmax(0, 1fr) 70px 54px", alignItems: "center", gap: contextTooltipPos.compact ? 6 : 8, opacity: row.muted ? 0.72 : 1 }}>
                            <span style={{ width: 8, height: 8, borderRadius: 2, background: row.color, boxShadow: row.id === "free" ? "inset 0 0 0 1px var(--border)" : undefined }} />
                            <span style={{ color: row.id === "free" ? "var(--fg-dim)" : "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.label}</span>
                            <span style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", color: row.id === "free" ? "var(--fg-dim)" : "var(--fg-subtle)", fontSize: contextTooltipPos.compact ? 11 : 12 }}>{formatContextTokens(row.tokens)}</span>
                            <span style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", color: row.id === "free" ? "var(--fg-dim)" : "var(--fg-subtle)" }}>{pct.toFixed(pct >= 10 || pct === 0 ? 0 : 1)}%</span>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ height: 1, background: "var(--border)", margin: "10px 0 8px" }} />
                    <div style={{ display: "grid", gap: 4, color: "var(--fg-dim)", fontSize: 10.5, lineHeight: 1.35 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                        <span>Prompt + draft</span>
                        <span style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>{budget.promptUsed.toLocaleString()}</span>
                      </div>
                      <div>
                        {measuredPromptTokens !== null && !streaming ? "Headline measured from provider usage; category split is estimated." : "Estimated before the next turn."}
                      </div>
                      <div>{contextLimitNote}</div>
                      {(effortBudget || modelSupportsReflection) && (
                        <div>
                          {effortBudget ? `${effortBudget.toLocaleString()} reply budget` : ""}
                          {effortBudget && modelSupportsReflection ? " · " : ""}
                          {modelSupportsReflection ? `reflection ${reflectionLevel ?? "auto"}` : ""}
                        </div>
                      )}
                    </div>
                  </div>,
                  document.body
                )}
              </button>
            {streaming || serverStarting ? (
              <button onClick={stopCurrentStream} aria-label="Stop generation" title={serverStarting ? "Cancel (Esc)" : "Stop (Esc)"}
                style={{ width: 30, height: 30, flexShrink: 0, display: "grid", placeItems: "center", borderRadius: "50%", color: "var(--fg-strong)", background: "var(--bg-elevated)", border: "1px solid var(--border)", cursor: "pointer", transition: "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)" }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.borderColor = "var(--border-strong)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-elevated)"; e.currentTarget.style.borderColor = "var(--border)"; }}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
              </button>
            ) : (
              /* Race panels grow a hover flyout over the send button: "Send
                 to both" fans the composed text out to every racer via the
                 host. The wrapper span carries the hover so the pointer can
                 travel from button to flyout without a dead zone. */
              <span
                style={{ position: "relative", flexShrink: 0 }}
                onMouseEnter={() => { if (onSendToRace) setRaceSendHover(true); }}
                onMouseLeave={() => setRaceSendHover(false)}
              >
                {onSendToRace && raceSendHover && canSend && (
                  <span style={{ position: "absolute", bottom: 30, right: 0, paddingBottom: 6, zIndex: 30 }}>
                    <button
                      type="button"
                      onClick={() => {
                        const t = input.trim();
                        if (!t) return;
                        onSendToRace(t);
                        setInput("");
                        setRaceSendHover(false);
                      }}
                      title="Send this message to every racer in this race"
                      className="klide-enter-rise"
                      style={{ whiteSpace: "nowrap", fontSize: 11.5, fontFamily: "inherit", color: "var(--fg-strong)", background: "var(--bg-elevated)", border: "1px solid var(--border-strong)", borderRadius: "var(--radius-sm)", padding: "4px 9px", cursor: "pointer", transition: "background var(--motion-fast) var(--ease-out)" }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-elevated)"; }}
                    >
                      Send to both
                    </button>
                  </span>
                )}
                <button onClick={() => send()} disabled={!canSend} aria-label="Send message" title={serverStarting ? `Starting ${providerName(provider)}...` : "Send (Enter)"}
                  style={{ width: 30, height: 30, flexShrink: 0, display: "grid", placeItems: "center", borderRadius: "50%", color: canSend ? "var(--control-primary-fg)" : "var(--fg-dim)", background: canSend ? "var(--accent)" : "var(--bg-elevated)", border: canSend ? "none" : "1px solid var(--border)", cursor: canSend ? "pointer" : "default", transition: "background var(--motion-med) var(--ease-out), color var(--motion-med) var(--ease-out), filter var(--motion-fast) var(--ease-out)" }}
                  onMouseEnter={(e) => { if (canSend) e.currentTarget.style.filter = "brightness(1.08)"; }}
                  onMouseLeave={(e) => (e.currentTarget.style.filter = "none")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5" /><path d="M6 11l6-6 6 6" /></svg>
                </button>
              </span>
            )}
            </div>
          </div>
          </div>
        </div>
        <div className="klide-ai-conversation-status">
          {worktreeName ? (
            <div
              className="klide-ai-worktree-label"
              title={`This panel runs in the git worktree "${worktreeName}" — its edits and commands stay on that branch, not the main checkout.`}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M6 9v6" /><path d="M18 6a9 9 0 0 1-9 9" /><circle cx="18" cy="6" r="3" /></svg>
              <span>worktree {worktreeName}</span>
            </div>
          ) : displayedBranch ? (
            <span
              className="klide-ai-local-branch"
              title={`Conversation branch: ${displayedBranch}`}
            >
              {displayedBranch}
            </span>
          ) : null}
          {/* The Goal policy's decider. The + menu picks the Mode; this note
              names the policy and a click cycles it (review → auto-accept →
              full auto → review). Review is the calm default and stays
              branch-label monochrome; the two silenced-gate rungs carry the
              accent so they never read as default. */}
          {effectiveMode === "goal" && onRequireDiffReviewChange && (
            <button
              type="button"
              className={
                goalPolicy.key === "review"
                  ? "klide-ai-mode-note klide-ai-mode-note--muted"
                  : "klide-ai-mode-note"
              }
              onClick={() => {
                const next = nextGoalPolicy(goalPolicy.key);
                onRequireDiffReviewChange(next.review);
                onAutoApproveCommandsChange?.(next.commands);
              }}
              title={
                goalPolicy.key === "review"
                  ? "Review: each edit pauses for your approval; commands ask too. Click: auto-accept edits."
                  : goalPolicy.key === "auto"
                    ? "Auto-accept: edits apply without a prompt (still checkpointed); commands still ask. Click: full auto."
                    : "Full auto: edits apply and shell commands run without asking. Click: back to reviewing every edit."
              }
            >
              <span key={goalPolicy.key} className="klide-ai-mode-note-label">
                {goalPolicy.label}
              </span>
            </button>
          )}
          {/* Only while there is something to act on. The idle placeholder
              used to sit here disabled, permanently saying "Accept
              modification" — which read as a review-mode promise even in the
              auto rungs, not as the dormant action it was. */}
          {acceptanceMode && (
            <button
              type="button"
              className="klide-ai-accept-modification"
              onClick={() => {
                void (
                  acceptanceMode === "pending-diff"
                    ? handleDiffApply()
                    : acceptThisRunChanges()
                );
              }}
              disabled={reverting || acceptingChanges}
              title={
                acceptanceMode === "pending-diff"
                  ? `Apply the proposed modification to ${pendingDiff?.path ?? "this file"}`
                  : `Keep ${revertableFiles} modified file${revertableFiles === 1 ? "" : "s"} and dismiss the rollback shortcut`
              }
            >
              {acceptingChanges ? "Accepting…" : "Accept modification"}
            </button>
          )}
          {/* Who this thread is talking to, at the right end of the same line
              as the branch and the Goal policy: this thread's mark, a hairline,
              the peer's mark and title. The dot moves only while this thread
              streams — out first, then back. */}
          <PeerLink
            peers={coordinationPeers}
            index={peerIndex}
            selfId={currentId}
            selfTitle={peerIndex.get(currentId)?.title ?? deriveTitle(msgs)}
            workspaceRoot={workspaceRoot}
            provider={provider}
            model={model}
            active={streaming}
            onOpen={onOpenPeerConversation}
          />
        </div>
      </div>
      )}
    </aside>
    </>
  );
}

function buildHandoffSummary(
  msgs: Msg[],
  projectContext: ProjectContextSnapshot | null | undefined
): HandoffSummary {
  const contextItems = projectContext?.lens.slice(0, 8) ?? [];
  const files = msgs
    .filter((m): m is Extract<Msg, { role: "user" }> => m.role === "user")
    .flatMap((turn) => turn.attachments?.map((attachment) => attachment.path) ?? []);
  const tools = msgs
    .filter((m): m is Extract<Msg, { role: "tool" }> => m.role === "tool")
    .map((turn) => turn.toolName);
  return buildRunHandoff({
    messages: msgs.flatMap((m) =>
      (m.role === "user" || (m.role === "assistant" && !m.delegateConsole)) && m.content.trim()
        ? [{ role: m.role, text: m.content }]
        : []
    ),
    contextItems: contextItems.map((item) => ({
      label: item.label,
      path: item.path,
      detail: item.detail,
    })),
    files,
    tools,
    sourceLabel: "Klide",
  });
}
