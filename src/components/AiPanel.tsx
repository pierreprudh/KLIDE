import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { usePortalMenu } from "../hooks/usePortalMenu";
import { InlineDiffReview } from "./InlineDiffReview";
import { InlineCommandReview } from "./InlineCommandReview";
import { deleteKlideConvo, publishKlideConvo, settleKlideConvo } from "../klideConvos";
import {
  estimateProjectContextTokens,
  lensItemsForPrompt,
  type ProjectContextMode,
  type ProjectContextSnapshot,
} from "../contextTray";
import { startAgentRun, stopAgentRun, resolveDiff, resolveUserQuestion, resolvePermission, revertRunCheckpoints } from "../agent/client";
import { toolsForMode } from "../agent/tools";
import { readWorkspaceTextFile, workspacePathExists } from "../workspaceFs";
import { TodoStrip } from "./TodoStrip";
import {
  DEFAULT_MODELS,
  isDelegateProvider,
  normalizeAgentMode,
  providerGroupsWithCustom,
  providerName,
} from "../agent/providers";
import {
  customDefaultModel,
  isCustomProvider,
  refreshCustomProviders,
  type CustomProvider,
} from "../customProviders";
import type {
  AgentAttachment as Attachment,
  AgentEvent,
  AgentMode,
  ProviderId,
  DiffProposal,
} from "../agent/types";
import { enabledSkillsPrompt, type Skill } from "../skills";

import { ProviderLogo, AssistantPlaceholderLoader, DotGridLoader } from "./ai/icons";
import { DelegateTerminalSurface } from "./ai/DelegateTerminal";
import { renderMessageBody, CompactionRow } from "./ai/ChatMessage";
import { MessageActions } from "./ai/MessageActions";
import { ConversationHistory } from "./ai/ConversationHistory";
import { ModelPicker, modelLabel } from "./ai/ModelPicker";
import { buildSystemPrompt } from "./ai/system-prompt";
import { summarizeAndHandoff, generateMemoryNote, detectAndGenerateSkill, summarizeForCompaction } from "./ai/summarize";
import { addMemoryDraft } from "../memoryDrafts";
import { writeMemory } from "../memory";
import { eventsToMsgs } from "./ai/eventsToMsgs";
import { buildRunHandoff, type HandoffSummary } from "../agentHandoff";
import {
  genId,
  deriveTitle,
  messagesForPersist,
  estimateTokens,
  messageTokenEstimate,
  countMessageTokens,
  fuzzyFiles,
  loadConversations,
  persistConversation,
  saveConversations,
  loadPanelSession,
  savePanelSession,
} from "./ai/utils";

import type { Msg, QueuedTurn, Conversation } from "./ai/types";
import { Z } from "../zLayers";

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
};

type ContextBreakdownRow = {
  id: string;
  label: string;
  tokens: number;
  color: string;
  muted?: boolean;
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
  onFileWritten?: (path: string, newContent: string) => void;
  onWorkspaceChanged?: () => void;
  visible: boolean;
  width: number;
  fill?: boolean;
  /**
   * Stable identity for this panel (provider/model prefs are keyed by it).
   * When the workbench view is unmounted (user switches to Settings /
   * Mission Control) the AiPanel unmounts with it. On remount we re-attach
   * to the *in-flight* conversation only — see the per-panel `PanelSession`
   * record (`loadPanelSession`/`savePanelSession`). If the previous chat had
   * already finished, the panel starts a fresh conversation instead of
   * reopening it, so quick chats don't pile into one ever-growing transcript.
   * Finished chats remain resumable from the history dropdown.
   */
  panelId?: string;
  model: string;
  onModelChange: (model: string) => void;
  availableModels: string[];
  onAvailableModelsChange: (models: string[]) => void;
  apiKeyVersion?: number;
  requireDiffReview: boolean;
  onRequireDiffReviewChange?: (enabled: boolean) => void;
  /** Open a proposed/applied edit as a full side-by-side diff in the editor. */
  onOpenDiff?: (edit: { path: string; oldContent: string; newContent: string; isCreate: boolean }) => void;
  stopAfterRejection: boolean;
  skills: Skill[];
  projectContext?: ProjectContextSnapshot | null;
  harnessSettings?: AiHarnessSettings;
  onDuplicate?: (snapshot: { provider: ProviderId; model: string }) => void;
  onForkConversationInWorktree?: (conversation: Conversation, baseRoot: string | null) => void;
  onProviderChange?: (provider: ProviderId) => void;
  onClose?: () => void;
  resumeConversation?: Conversation | null;
  onResumeConsumed?: () => void;
  /** When set on first mount, the panel starts pinned to this delegate
   *  provider (claude-code / codex / opencode). Used by Mission Control's
   *  "Resume in {CLI}" / "Open in {CLI}" handoffs to land the user in a
   *  TUI surface that's the natural home for an agent session. */
  initialProvider?: ProviderId;
  /** Pass-through to DelegateTerminalSurface so the TUI continues the
   *  named session instead of starting a fresh one. */
  initialResumeSessionId?: string | null;
  /** First prompt pre-baked into the TUI's spawn — used for Klide handoff. */
  initialTask?: string | null;
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
                ? "linear-gradient(to top, color-mix(in oklab, var(--accent) 70%, transparent), var(--accent))"
                : active
                  ? "linear-gradient(to top, color-mix(in oklab, var(--fg) 65%, transparent), var(--fg))"
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

// The default model for a provider. Built-ins read the static map; custom
// (self-hosted) providers read their configured default from the cache,
// since DEFAULT_MODELS has no entry for a runtime id.
function defaultModelFor(id: ProviderId): string {
  if (isCustomProvider(id)) return customDefaultModel(id);
  return DEFAULT_MODELS[id] ?? "";
}

function storedModelForProvider(id: ProviderId): string {
  const stored = localStorage.getItem(`klide.model.${id}`);
  if (id === "mlx" && stored) {
    // MLX expects Hugging Face-style ids or local paths. Ignore stale
    // Ollama-style tags such as `gemma4:12b-mlx` from earlier shared-model UI.
    const looksLikeMlx = stored.includes("/") || stored.startsWith(".");
    if (!looksLikeMlx || stored.includes(":")) return defaultModelFor(id);
  }
  return stored || defaultModelFor(id);
}

export function AiPanel({
  workspaceRoot,
  worktreeName,
  onFileWritten,
  onWorkspaceChanged,
  visible,
  width,
  fill,
  panelId,
  model,
  onModelChange,
  availableModels,
  onAvailableModelsChange,
  apiKeyVersion = 0,
  requireDiffReview,
  onRequireDiffReviewChange,
  onOpenDiff,
  stopAfterRejection,
  skills,
  projectContext,
  harnessSettings,
  onDuplicate,
  onForkConversationInWorktree,
  onProviderChange,
  onClose,
  resumeConversation,
  onResumeConsumed,
  initialProvider,
  initialResumeSessionId,
  initialTask,
  onInitialConsumed,
  onMemoryWritten,
  onOpenMemory,
  onSkillGenerated,
}: Props) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [activity, setActivity] = useState<"thinking" | "waiting" | null>(null);
  void activity;
  // Declared near the top because the publish effect below (which keeps
  // Mission Control's "running" / "waiting" row alive) closes over it.
  // Was further down; the view-switch bug surfaced when we replaced a
  // random UUID with this stable id and TypeScript started complaining.
  const [currentId, setCurrentId] = useState<string>(() => {
    // Re-attach to the panel's last conversation on remount (e.g. after a view
    // switch), whether it's still in-flight or already finished — so the chat
    // you were looking at, and its answer, is still on screen when you come
    // back. The hydration effect below reloads that conversation's messages.
    // Each chat already gets its own id (the "+" / new-chat action rotates it
    // and persists the new one via savePanelSession), so re-attaching shows
    // the *current* thread rather than piling every chat into one. Panel
    // identity (provider/model prefs) still lives under `panelId` separately.
    const prior = panelId ? loadPanelSession(panelId) : null;
    return prior ? prior.convoId : genId();
  });
  const [currentForkedFrom, setCurrentForkedFrom] = useState<Conversation["forkedFrom"]>(null);
  const currentForkedFromRef = useRef<Conversation["forkedFrom"]>(null);
  const [conversationGitMeta, setConversationGitMeta] = useState<{ branch: string | null; worktree: string | null }>({
    branch: null,
    worktree: null,
  });
  const conversationGitMetaRef = useRef<{ branch: string | null; worktree: string | null }>({
    branch: null,
    worktree: null,
  });
  const [input, setInput] = useState("");
  const [queuedTurns, setQueuedTurns] = useState<QueuedTurn[]>([]);
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
      model: model ?? null,
      cwd: workspaceRoot,
      branch: conversationGitMeta.branch,
      worktree: conversationGitMeta.worktree,
      forkedFrom: currentForkedFrom ?? null,
    });
    if (streaming && last.streaming && last.count === msgs.length && last.meta === metaKey) return;
    lastPublishRef.current = { count: msgs.length, streaming, meta: metaKey };
    const firstUser = msgs.find((m) => m.role === "user");
    publishKlideConvo({
      id: currentId,
      // An idle convo that finished its turn is "done", not "waiting" — a
      // genuine pause (diff approval) keeps `streaming` true, so non-streaming
      // always means the turn completed. Marking it "waiting" wrongly filed
      // every answered chat under Mission Control's "Blocked / Needs you".
      title: (firstUser?.content.trim() || "Untitled chat").slice(0, 120),
      status: streaming ? "running" : "done",
      model: model ?? null,
      cwd: workspaceRoot,
      branch: conversationGitMeta.branch,
      worktree: conversationGitMeta.worktree,
      forkedFrom: currentForkedFrom ?? null,
      messages: msgs.flatMap((m) =>
        (m.role === "user" || (m.role === "assistant" && !m.delegateConsole)) && m.content.trim()
          ? [{ role: m.role, text: m.content }]
          : []
      ),
      updatedMs: Date.now(),
    });
  }, [msgs, streaming, model, workspaceRoot, currentId, currentForkedFrom, conversationGitMeta]);

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
  const [mention, setMention] = useState<{ query: string } | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const mentionMatches = mention !== null ? fuzzyFiles(fileList, mention.query) : [];

  const [provider, setProvider] = useState<ProviderId>(() => {
    if (initialProvider) return initialProvider;
    if (panelId) {
      const perPanel = localStorage.getItem(`klide.provider.${panelId}`) as ProviderId | null;
      if (perPanel) return perPanel;
    }
    return (localStorage.getItem("klide.provider") as ProviderId) || "ollama";
  });
  const providerDelegatesWork = isDelegateProvider(provider);
  const isLocalProvider = provider === "ollama" || provider === "mlx";
  const [providerOpen, setProviderOpen] = useState(false);
  const providerRef = useRef<HTMLDivElement>(null);
  // Self-hosted endpoints, loaded from the Rust store. Refreshed on mount
  // and whenever the picker opens, so endpoints added in Settings show up
  // without a panel reload.
  const [customProviders, setCustomProviders] = useState<CustomProvider[]>([]);
  useEffect(() => { void refreshCustomProviders().then(setCustomProviders).catch(() => {}); }, []);
  const providerGroups = useMemo(
    () => providerGroupsWithCustom(customProviders),
    [customProviders]
  );
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
    void refreshCustomProviders().then(setCustomProviders).catch(() => {});
    // Open compact: expand only the stack holding the active provider.
    const activeGroup = providerGroups.find((g) => g.items.some((it) => it.id === provider));
    setExpandedGroups(new Set(activeGroup ? [activeGroup.label] : []));
    function onDown(e: MouseEvent) { if (providerRef.current && !providerRef.current.contains(e.target as Node)) setProviderOpen(false); }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [providerOpen]);
  function selectProvider(id: ProviderId) {
    setProvider(id);
    onProviderChange?.(id);
    if (panelId) localStorage.setItem(`klide.provider.${panelId}`, id);
    localStorage.setItem("klide.provider", id);
    onModelChange(storedModelForProvider(id));
    setProviderOpen(false);
  }
  useEffect(() => { localStorage.setItem("klide.contextMode", contextMode); }, [contextMode]);

  const [slash, setSlash] = useState<{ query: string } | null>(null);
  const [slashIdx, setSlashIdx] = useState(0);
  const [nextSendMode, setNextSendMode] = useState<AgentMode | null>(null);

  // Transient "mode line" — the review/auto/plan state is normally invisible.
  // A slash command (or /mode peek) flashes it above the composer for ~2.4s,
  // then it fades. No persistent chrome at rest.
  type ModeTone = "accent" | "warning" | "muted";
  const [modeFlash, setModeFlash] = useState<{ text: string; tone: ModeTone } | null>(null);
  const modeFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function flashMode(text: string, tone: ModeTone = "muted") {
    setModeFlash({ text, tone });
    if (modeFlashTimer.current) clearTimeout(modeFlashTimer.current);
    modeFlashTimer.current = setTimeout(() => setModeFlash(null), 2400);
  }
  useEffect(() => () => { if (modeFlashTimer.current) clearTimeout(modeFlashTimer.current); }, []);
  // Snapshot the current mode for the /mode peek. Reads state at call time.
  function currentModeFlash(): { text: string; tone: ModeTone } {
    if (effectiveMode === "chat") return { text: "chat mode · no tools", tone: "muted" };
    if (effectiveMode === "plan") return { text: "plan mode · read-only", tone: "warning" };
    return requireDiffReview
      ? { text: "reviewing every edit", tone: "muted" }
      : { text: "auto-accept edits on", tone: "accent" };
  }
  // /auto-mode and /review-mode imply Goal mode (edits only happen there).
  const goalOrPlan = () => (modelSupportsTools || providerDelegatesWork ? "goal" : "plan") as AgentMode;

  const SLASH_COMMANDS: { name: string; desc: string; run: () => void | Promise<void> }[] = [
    { name: "chat", desc: "Switch to Chat mode (no tools)", run: () => { selectMode("chat"); setInput(""); } },
    { name: "plan", desc: "Switch to Plan mode (read-only, proposes a plan)", run: () => { selectMode("plan"); setInput(""); } },
    { name: "goal", desc: "Switch to Goal mode (can propose edits)", run: () => { selectMode(modelSupportsTools || providerDelegatesWork ? "goal" : "plan"); setInput(""); } },
    { name: "mode", desc: "Show the current mode", run: () => { setInput(""); setSlash(null); const f = currentModeFlash(); flashMode(f.text, f.tone); } },
    { name: "auto-mode", desc: "Auto-accept edits — apply without a prompt", run: () => { setInput(""); setSlash(null); selectMode(goalOrPlan()); onRequireDiffReviewChange?.(false); flashMode("auto-accept edits on", "accent"); } },
    { name: "review-mode", desc: "Review every edit before it applies (default)", run: () => { setInput(""); setSlash(null); selectMode(goalOrPlan()); onRequireDiffReviewChange?.(true); flashMode("reviewing every edit", "muted"); } },
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
      setMention({ query: "" }); setMentionIdx(0);
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
    try { setFileList(await (await import("./ai/workspaceFiles")).listWorkspaceFiles(workspaceRoot)); } catch {}
  }

  function handleComposerChange(value: string, caret: number) {
    setInput(value);
    const slashMatch = value.match(/^\/(\w*)$/);
    if (slashMatch) { setSlash({ query: slashMatch[1] }); setSlashIdx(0); setMention(null); return; }
    else if (slash !== null) setSlash(null);
    const before = value.slice(0, caret);
    const m = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (m) { setMention({ query: m[1] }); setMentionIdx(0); void ensureFileList(); }
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
  // The autonomy ladder shown in the + menu, lowest → highest. The last two
  // are both Goal mode; they differ only in requireDiffReview (review vs auto).
  const MODE_RUNGS: { mode: AgentMode; review: boolean | null; label: string; desc: string }[] = [
    { mode: "chat", review: null, label: "Chat", desc: "no tools" },
    { mode: "plan", review: null, label: "Plan", desc: "read-only, proposes" },
    { mode: "goal", review: true, label: "Goal · review", desc: "approve each edit" },
    { mode: "goal", review: false, label: "Goal · auto-accept", desc: "applies on its own" },
  ];
  function selectRung(mode: AgentMode, review: boolean | null) {
    selectMode(mode); // persists mode + closes the menu
    if (mode === "goal" && review !== null) onRequireDiffReviewChange?.(review);
    if (mode === "chat") flashMode("chat mode · no tools");
    else if (mode === "plan") flashMode("plan mode · read-only", "warning");
    else flashMode(review ? "reviewing every edit" : "auto-accept edits on", review ? "muted" : "accent");
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

  const lensProjectContext = providerDelegatesWork ? [] : lensItemsForPrompt(projectContext, input, contextMode);
  const activeMode = nextSendMode ?? agentMode;
  const effectiveMode = !modelSupportsTools && !providerDelegatesWork && activeMode === "goal" ? "chat" : activeMode;
  // + menu: Goal rungs disabled when the model has no tools; which rung is lit.
  const goalDisabled = !modelSupportsTools && !providerDelegatesWork;
  const currentRungIdx = effectiveMode === "chat" ? 0 : effectiveMode === "plan" ? 1 : requireDiffReview ? 2 : 3;
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
      prompt = `You are Klide's local chat assistant. Answer the user's latest message directly and concisely. You have no tools in this turn, so do not claim you can inspect or edit files unless file text was attached in the conversation.

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

  // Prefer the model's real prompt-token count when we have it: it already
  // accounts for the system prompt, tool schemas, and full history, so we only
  // add the unsent draft on top. Without it, estimate every message by length.
  // Messages above the last compaction marker stay visible for reference but no
  // longer reach the model (the transcript marker collapses them on replay), so
  // the gauge counts only from that marker onward — otherwise it would over-count
  // and the auto-compaction safety net would fire in a loop.
  let lastCompactionIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "system" && (msgs[i] as Extract<Msg, { role: "system" }>).compaction) { lastCompactionIdx = i; break; }
  }
  const tokenCountedMsgs = lastCompactionIdx >= 0 ? msgs.slice(lastCompactionIdx) : msgs;
  const messageTokens = tokenCountedMsgs.reduce((sum, m) => sum + messageTokenEstimate(m), 0);
  const draftTokens = estimateTokens(input);
  const skillsTokens = estimateTokens(enabledSkillsPrompt(skills));
  const projectRulesTokens = estimateTokens(projectRules);
  const contextLensTokens = estimateProjectContextTokens(lensProjectContext);
  const systemPromptTokens = Math.max(
    0,
    estimateTokens(systemPromptForDraft) - skillsTokens - projectRulesTokens
  );
  const estimatedContextUsed =
    messageTokens +
    systemPromptTokens +
    skillsTokens +
    projectRulesTokens +
    toolSchemaTokens +
    contextLensTokens;
  const contextUsed =
    (measuredPromptTokens !== null && !streaming ? measuredPromptTokens : estimatedContextUsed) +
    draftTokens;
  const promptContextUsed =
    (measuredUsageTokens !== null && !streaming ? measuredUsageTokens.prompt : estimatedContextUsed) +
    draftTokens;
  const replyContextUsed =
    measuredUsageTokens !== null && !streaming ? measuredUsageTokens.completion : 0;
  const contextRemaining = Math.max(0, effectiveContextLimit - contextUsed);
  const contextRatio = Math.min(1, contextUsed / effectiveContextLimit);
  const contextTone = contextRatio > 0.85 ? "var(--danger, #B42318)" : contextRatio > 0.65 ? "#A15C00" : "var(--accent)";
  const rawContextRows: ContextBreakdownRow[] = [
    { id: "messages", label: "Messages", tokens: messageTokens, color: "var(--accent)" },
    { id: "tools", label: "System tools", tokens: toolSchemaTokens, color: "#7AA2F7" },
    { id: "system", label: "System prompt", tokens: systemPromptTokens, color: "#9DBCF9" },
    { id: "skills", label: "Skills", tokens: skillsTokens, color: "#B7D0FF" },
    { id: "rules", label: "Project rules", tokens: projectRulesTokens, color: "#C9DAF8" },
    { id: "lens", label: "Context lens", tokens: contextLensTokens, color: "#D7E6FF" },
    { id: "draft", label: "Draft input", tokens: draftTokens, color: "#E5EEFF" },
    { id: "reply", label: "Last reply", tokens: replyContextUsed, color: "#A6C8FF" },
  ];
  const contextRows = rawContextRows.filter((row) => row.tokens > 0);
  const measuredDelta =
    measuredPromptTokens !== null && !streaming
      ? Math.max(0, measuredPromptTokens + draftTokens - estimatedContextUsed - draftTokens)
      : 0;
  const contextBreakdownRows: ContextBreakdownRow[] = [
    ...contextRows,
    ...(measuredDelta > 0
      ? [{ id: "measured-extra", label: "Provider overhead", tokens: measuredDelta, color: "#8A8A85", muted: true }]
      : []),
    { id: "free", label: "Free space", tokens: contextRemaining, color: "var(--border-strong)", muted: true },
  ];
  // Running cost for this conversation = sum of every turn's per-message cost.
  // Stays 0 (chip hidden) for local / subscription / unknown-price models.
  const conversationCostUsd = msgs.reduce(
    (sum, m) => sum + (m.role === "assistant" ? m.meta?.costUsd ?? 0 : 0),
    0
  );

  // How many trailing messages to keep verbatim when compacting. Two exchanges
  // is enough to keep the immediate thread intact; everything older folds into
  // the summary.
  const COMPACT_KEEP_RECENT = 4;
  // Offer compaction once the window is ~80% full, on a real (non-delegate)
  // conversation long enough to have something worth folding. Delegate CLIs
  // manage their own context, so it doesn't apply to them.
  const canCompact =
    !providerDelegatesWork &&
    !streaming &&
    !compacting &&
    msgs.length > COMPACT_KEEP_RECENT + 1;
  const showCompactPrompt = canCompact && contextRatio >= 0.8;

  async function compactConversation(source: "manual" | "agent" = "manual") {
    if (!canCompact) return;
    setCompactSource(source);
    setCompacting(true);
    setCompactError(null);
    try {
      const older = msgs.slice(0, msgs.length - COMPACT_KEEP_RECENT);
      const recent = msgs.slice(msgs.length - COMPACT_KEEP_RECENT);
      if (older.length === 0) return;
      const summary = await summarizeForCompaction(provider, model, older, effectiveContextLimit);
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
    } catch (e) {
      setCompactError(String(e));
    } finally {
      setCompacting(false);
    }
  }

  // Safety net: when the conversation actually outgrows the window (the 0.8
  // prompt was ignored and we're now at/over 100%), compact automatically so it
  // can't balloon to multiples of the limit. Fires once per overflow episode —
  // the ref re-arms only after compaction drops the gauge back under the limit.
  const autoCompactArmedRef = useRef(true);
  useEffect(() => {
    if (streaming || compacting || !canCompact) return;
    // Measure the committed conversation, not the draft being typed.
    const committedUsed = contextUsed - draftTokens;
    const rawRatio = effectiveContextLimit > 0 ? committedUsed / effectiveContextLimit : 0;
    if (rawRatio < 1) {
      autoCompactArmedRef.current = true;
      return;
    }
    if (!autoCompactArmedRef.current) return;
    autoCompactArmedRef.current = false;
    void compactConversation("agent");
  }, [streaming, compacting, canCompact, contextUsed, draftTokens, effectiveContextLimit]);

  const [conversations, setConversations] = useState<Conversation[]>(() => loadConversations<Conversation>());
  const [historyOpen, setHistoryOpen] = useState(false);
  const msgsRef = useRef<Msg[]>([]);
  const queueRef = useRef<QueuedTurn[]>([]);
  const processingQueueRef = useRef(false);
  const queueGenerationRef = useRef(0);
  const activeHarnessRunRef = useRef<string | null>(null);
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
  }, [msgs, provider, model]);

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
    if (providerDelegatesWork) { void invoke("delegate_pty_stop", { sessionId: `${currentId}:${provider}` }); }
    // Bump the queue generation so any in-flight runProcessQueue sees its
    // tokens as stale and bails before it can start another turn.
    queueGenerationRef.current += 1;
    processingQueueRef.current = false;
    setStreaming(false);
    setActivity(null);
    // The harness is being aborted; the run loop will emit a paused-state
    // exit on its own. Clear any visible Q&A card so the UI doesn't show a
    // question whose answer can never arrive.
    setPendingQuestion(null);
    setPendingPermission(null);
    setQuestionAnswer("");
  }

  // Switching conversations (or loading one from history) starts a fresh
  // revert scope — the previous run's changes are no longer "what I just did".
  useEffect(() => {
    runChangedPathsRef.current = new Set();
    setRevertableFiles(0);
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

  useEffect(() => { msgsRef.current = msgs; }, [msgs]);
  useEffect(() => { currentForkedFromRef.current = currentForkedFrom; }, [currentForkedFrom]);
  useEffect(() => { conversationGitMetaRef.current = conversationGitMeta; }, [conversationGitMeta]);

  // Restore the persisted conversation for `currentId` on first mount so a
  // view switch back from Mission Control / Settings / Git Review re-opens
  // the same chat, not an empty panel. The persist effect below keeps this
  // fresh during streaming too. Ref-guarded so loading a different chat
  // from history (which mutates currentId) is not undone on remount.
  const initialRestoreRef = useRef(false);
  useEffect(() => {
    if (initialRestoreRef.current) return;
    initialRestoreRef.current = true;
    const saved = loadConversations<Conversation>().find((c) => c.id === currentId);
    if (saved && saved.msgs.length > 0) {
      setMsgs(saved.msgs);
      msgsRef.current = saved.msgs;
      setCurrentForkedFrom(saved.forkedFrom ?? null);
      setConversationGitMeta({ branch: saved.branch ?? null, worktree: saved.worktree ?? null });
      if (saved.provider && saved.provider !== provider) onProviderChange?.(saved.provider);
      if (saved.model && saved.model !== model) onModelChange(saved.model);
    }
    // Reconnect to a run that progressed while the panel was unmounted: the
    // harness keeps running in Rust and writes the transcript, but the live
    // event stream is per-mount and doesn't survive a view switch. So if a
    // mid-run switch left us with just the user message, rebuild from the
    // on-disk transcript — which has the (possibly finished) assistant reply.
    // Klide runs only (currentId == transcript id); delegates use the PTY.
    if (!providerDelegatesWork) {
      const baseLen = msgsRef.current.length;
      void (async () => {
        try {
          const events = await invoke<AgentEvent[]>("agent_read_run", { runId: currentId });
          const replayed = eventsToMsgs(events);
          // Adopt only if the user did nothing since mount (msgs length is
          // still the restored snapshot) and the transcript is richer —
          // guards against clobbering a chat the user already started typing.
          if (msgsRef.current.length === baseLen && replayed.length > baseLen) {
            setMsgs(replayed);
            msgsRef.current = replayed;
          }
        } catch {
          /* no transcript for this id (brand-new chat) — nothing to reconnect */
        }
      })();
    }
    // Intentionally only the *initial* currentId matters — subsequent
    // edits (loadConversation, newConversation) own the active id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clear any pending auto-save notice when the panel unmounts (timer would
  // otherwise fire setState on a dead component).
  useEffect(() => () => {
    if (autoMemoryTimerRef.current !== null) {
      clearTimeout(autoMemoryTimerRef.current);
      autoMemoryTimerRef.current = null;
    }
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
    if (providerDelegatesWork) { void invoke("delegate_pty_stop", { sessionId: `${currentId}:${provider}` }); }
    // Mark the previous chat as done on Mission Control so a "new chat"
    // doesn't leave a stale "running" row. View switches no longer hit
    // this path (the panel just unmounts/remounts).
    settleKlideConvo(currentId);
    setHistoryOpen(false);
    abortActiveHarnessRun();
    setMsgs([]);
    msgsRef.current = [];
    setMeasuredPromptTokens(null);
    setMeasuredUsageTokens(null);
    setCompactError(null);
    queueRef.current = [];
    queueGenerationRef.current += 1;
    setQueuedTurns([]);
    processingQueueRef.current = false;
    setStreaming(false);
    setActivity(null);
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
    // panel still uses `panelId` (see the `useState` initialiser
    // above) so the panel's persistent identity survives reloads;
    // every subsequent chat gets its own transcript.
    setMeasuredPromptTokens(null);
    setMeasuredUsageTokens(null);
    const nid = genId();
    setCurrentId(nid);
    setCurrentForkedFrom(null);
    setConversationGitMeta({ branch: null, worktree: null });
    // Fresh chat, no run yet → inactive. A remount before the first send
    // simply starts fresh again (nothing to lose); the first send flips it
    // active so a mid-run view switch re-attaches.
    if (panelId) savePanelSession(panelId, nid, false);
  }

  // Write a structured memory note to .klide/memory/. Delegates to
  // summarizeAndHandoff so the prompt + parsing live in one place; we
  // just feed it the conversation + show the user a transient state.
  async function runSummarize() {
    if (!workspaceRoot || summarizing || msgs.length === 0) return;
    setSummarizing(true);
    try {
      const entry = await summarizeAndHandoff({
        workspaceRoot,
        provider,
        model,
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
      const note = await generateMemoryNote({
        workspaceRoot,
        provider: turn.provider,
        model: turn.model,
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
        provider,
        model,
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
    abortActiveHarnessRun();
    setCurrentId(c.id);
    setCurrentForkedFrom(c.forkedFrom ?? null);
    setConversationGitMeta({ branch: c.branch ?? null, worktree: c.worktree ?? null });
    setMsgs(c.msgs);
    msgsRef.current = c.msgs;
    if (c.provider && c.provider !== provider) onProviderChange?.(c.provider);
    if (c.model && c.model !== model) onModelChange(c.model);
    // Explicit resume is intent to continue this thread, so keep it pinned
    // across a remount (view switch) until it finishes or the user starts a
    // new chat — mirrors the in-flight re-attach path.
    if (panelId) savePanelSession(panelId, c.id, true);
    // No usage stored with history → estimate until this chat's next turn.
    setMeasuredPromptTokens(null);
    setMeasuredUsageTokens(null);
    setCompactError(null);
    queueRef.current = [];
    queueGenerationRef.current += 1;
    setQueuedTurns([]);
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
  }

  function deleteConversation(id: string, e: ReactMouseEvent) {
    e.stopPropagation();
    setConversations((prev) => { const next = prev.filter((c) => c.id !== id); saveConversations(next); return next; });
    deleteKlideConvo(id);
    if (id === currentId) {
      setMsgs([]);
      const nid = genId();
      setCurrentId(nid);
      setCurrentForkedFrom(null);
      setConversationGitMeta({ branch: null, worktree: null });
      if (panelId) savePanelSession(panelId, nid, false);
      setMeasuredPromptTokens(null);
      setMeasuredUsageTokens(null);
    }
  }

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

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [input]);

  useEffect(() => {
    // Persist the conversation as it changes, dropping only a trailing empty
    // assistant placeholder — the user message before it must survive a view
    // switch even in the brief pre-token window. See `messagesForPersist`.
    const toSave = messagesForPersist(msgs);
    if (toSave.length === 0) return;
    setConversations((prev) => {
      const conv: Conversation = {
        id: currentId,
        title: deriveTitle(toSave),
        msgs: toSave,
        updatedAt: Date.now(),
        provider,
        model,
        cwd: workspaceRoot,
        branch: conversationGitMeta.branch,
        worktree: conversationGitMeta.worktree,
        forkedFrom: currentForkedFrom ?? null,
      };
      return persistConversation(conv, prev);
    });
  }, [msgs, currentId, provider, model, workspaceRoot, currentForkedFrom, conversationGitMeta]);

  // Flush whatever the latest commit was on unmount so a view switch
  // mid-stream doesn't drop the in-flight conversation. `msgsRef` is
  // already kept in sync above, and the persist effect above will
  // have run for the most recent state when React re-rendered.
  useEffect(() => () => {
    const snapshot = messagesForPersist(msgsRef.current);
    if (snapshot.length === 0) return;
    persistConversation({
      id: currentId,
      title: deriveTitle(snapshot),
      msgs: snapshot,
      updatedAt: Date.now(),
      provider,
      model,
      cwd: workspaceRoot,
      branch: conversationGitMetaRef.current.branch,
      worktree: conversationGitMetaRef.current.worktree,
      forkedFrom: currentForkedFromRef.current ?? null,
    });
    // Intentionally only currentId at unmount matters; msgsRef is the
    // fresh source of truth for the snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!historyOpen) return;
    function onDown(e: MouseEvent) { if (historyRef.current && !historyRef.current.contains(e.target as Node)) setHistoryOpen(false); }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [historyOpen]);

  useEffect(() => { localStorage.setItem(`klide.model.${provider}`, model); }, [model, provider]);

  useEffect(() => {
    let cancelled = false;
    async function loadProviderModels() {
      try {
        const names = await invoke<string[]>("ai_provider_models", { provider });
        if (cancelled) return;
        if (!isLocalProvider) setConnected(true);
        const fallbackModel = defaultModelFor(provider);
        const next = names.length > 0 ? names : fallbackModel ? [fallbackModel] : [];
        onAvailableModelsChange(next);
        if (next.length > 0 && !next.includes(model)) onModelChange(next[0]);
      } catch {
        if (cancelled) return;
        setConnected(false);
        const fallback = storedModelForProvider(provider);
        onAvailableModelsChange([fallback]);
        if (model !== fallback) onModelChange(fallback);
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
        const running = await invoke<boolean>("ai_local_server_status", { provider });
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

  useEffect(() => {
    let cancelled = false;
    async function checkToolSupport() {
      try {
        const supports = await invoke<boolean>("ai_model_supports_tools", { provider, model });
        if (!cancelled) setModelSupportsTools(supports);
      } catch { if (!cancelled) setModelSupportsTools(!isLocalProvider); }
    }
    void checkToolSupport();
    return () => { cancelled = true; };
  }, [provider, model]);

  useEffect(() => {
    let cancelled = false;
    async function checkReflectionSupport() {
      try {
        const supports = await invoke<boolean>("ai_model_supports_reflection", { provider, model });
        if (!cancelled) setModelSupportsReflection(supports);
      } catch { if (!cancelled) setModelSupportsReflection(false); }
    }
    void checkReflectionSupport();
    return () => { cancelled = true; };
  }, [provider, model]);

  useEffect(() => {
    let cancelled = false;
    async function loadContextWindow() {
      try {
        const windowSize = await invoke<number>("ai_context_window", { provider, model });
        if (!cancelled && Number.isFinite(windowSize) && windowSize > 0) setContextLimit(windowSize);
      } catch { if (!cancelled) setContextLimit(128_000); }
    }
    void loadContextWindow();
    return () => { cancelled = true; };
  }, [provider, model]);

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
  // run_command approval: the harness pauses and emits a permission request;
  // the user approves or rejects (approveCommand / rejectCommand) before the
  // command runs. The card renders from `pendingPermission`.
  const [pendingPermission, setPendingPermission] = useState<{
    runId: string;
    requestId: string;
    toolName: string;
    kind: "command" | "network";
    command: string;
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

  async function runHarnessTurn(turn: QueuedTurn, generation: number) {
    if (queueGenerationRef.current !== generation) return;
    let userIndex = msgsRef.current.findIndex((m) => m.role === "user" && m.queueId === turn.clientId);
    if (userIndex < 0) return;
    let nextMsgs = [...msgsRef.current];
    const userMsg = nextMsgs[userIndex];
    if (userMsg.role !== "user") return;
    nextMsgs[userIndex] = { ...userMsg, queueState: "running" };
    const delegateConsole = isDelegateProvider(turn.provider);
    const delegateProvider = providerName(turn.provider);
    nextMsgs.splice(userIndex + 1, 0, { role: "assistant", content: "", delegateConsole, delegateProvider });
    const assistantIndex = userIndex + 1;
    msgsRef.current = nextMsgs;
    setMsgs(nextMsgs);
    setStreaming(true);
    setActivity("thinking");
    // A fresh assistant turn is the one place we want to yank the user
    // back to the bottom even if they were scrolled up reading context.
    // Their action (sending a message) implies "I want to see the reply".
    forceStickToBottom();

    let harnessError: Error | null = null;
    // Track user-initiated stops so the auto-memory hook can distinguish a
    // clean run_result from a `run_error` with code "aborted". We don't
    // auto-summarize cancelled runs — the user already knows they stopped
    // the run, and a half-finished note is more noise than signal.
    let abortedByUser = false;
    let nextAssistantIdx = assistantIndex;
    // Wall-clock start of the current turn, for the per-message meta footer.
    // Reset after each assistant_message so multi-turn runs time each turn.
    let turnStartedAt = Date.now();
    // First streamed token of the current turn → TTFT. Null until the first
    // assistant_delta of the turn arrives.
    let firstTokenAt: number | null = null;

    // Throttle assistant_delta state updates to ~20 fps — avoids flooding
    // React with one setState per token (60+/s), which clones the whole msgs
    // array and re-renders the entire message list on every chunk.
    let pendingDelta = { content: "", thinking: "" };
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    // All event handling transforms msgsRef.current (the single source of
    // truth, kept in sync by enqueueTurn too) and pushes plain values via
    // commit(). Never use functional setMsgs updaters with side effects
    // here: StrictMode double-invokes updaters, which double-incremented
    // nextAssistantIdx and left tool rows stuck on "Running…" forever.
    const commit = (next: Msg[]) => {
      msgsRef.current = next;
      setMsgs(next);
    };

    // Locate the assistant bubble for the current turn inside `next`,
    // creating one when the previous turn ended in tool calls. After a
    // tool_call_started splice, nextAssistantIdx points at a tool card —
    // the old guard (`role !== "assistant" → drop`) silently discarded
    // every assistant update from that point on, so multi-turn tool runs
    // never showed their final answer (the transcript had it; the live
    // view threw it away). Walk past tool cards and insert a fresh bubble
    // for the new turn instead.
    const locateAssistant = (next: Msg[]): number => {
      let i = nextAssistantIdx;
      while (next[i]?.role === "tool") i += 1;
      if (next[i]?.role === "assistant") {
        nextAssistantIdx = i;
        return i;
      }
      next.splice(i, 0, { role: "assistant", content: "", delegateConsole, delegateProvider });
      nextAssistantIdx = i;
      return i;
    };

    const appendPendingDelta = (c: string, t: string) => {
      const next = [...msgsRef.current];
      const i = locateAssistant(next);
      const existing = next[i] as Msg & { role: "assistant" };
      const newContent = (existing.content || "") + c;
      const newThinking = [existing.thinking, t].filter(Boolean).join("") || undefined;
      next[i] = { ...existing, content: newContent, thinking: newThinking, delegateConsole, delegateProvider };
      commit(next);
    };

    const flushDelta = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        const c = pendingDelta.content;
        const t = pendingDelta.thinking;
        pendingDelta = { content: "", thinking: "" };
        if (c || t) appendPendingDelta(c, t);
      }, 50);
    };

    const handleEvent = (event: AgentEvent) => {
      if (queueGenerationRef.current !== generation) return;

      switch (event.type) {
        case "assistant_delta": {
          if (firstTokenAt === null) firstTokenAt = Date.now();
          pendingDelta.content += event.text;
          pendingDelta.thinking += event.thinking ?? "";
          flushDelta();
          break;
        }
        case "assistant_message": {
          if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
          // Flush any pending delta before finalising
          if (pendingDelta.content || pendingDelta.thinking) {
            appendPendingDelta(pendingDelta.content, pendingDelta.thinking);
          }
          pendingDelta = { content: "", thinking: "" };
          const text = event.content.filter((b) => b.type === "text").map((b) => b.text).join("");
          const thinking = event.content.filter((b) => b.type === "thinking").map((b) => b.text).join("").trim();
          const tcBlocks = event.content.filter((b) => b.type === "tool_call");
          const tcCalls = tcBlocks.map((b) => ({ id: ("toolCallId" in b ? b.toolCallId : "") as string, name: "name" in b ? b.name as string : "", args: "input" in b ? b.input : {} }));
          const now = Date.now();
          const turnMs = now - turnStartedAt;
          const ttftMs = firstTokenAt !== null ? firstTokenAt - turnStartedAt : undefined;
          turnStartedAt = now;
          firstTokenAt = null;
          const next = [...msgsRef.current];
          const i = locateAssistant(next);
          const existing = next[i] as Msg & { role: "assistant" };
          // Empty text with streamed deltas → keep the streamed content.
          const msgContent = text || existing.content || "";
          const estimatedTokens = estimateTokens(msgContent) + estimateTokens(thinking);
          // Prefer the provider's real counts when present — Ollama reports
          // eval_count + eval_duration on the final frame, OpenAI/Anthropic
          // send a usage block. The estimate stays as a fallback for
          // providers that don't (e.g. subscription CLIs).
          const usage = event.usage;
          const tokens =
            usage?.completionTokens !== undefined ? usage.completionTokens : estimatedTokens;
          // Capture the real context size for the gauge: the prompt the model
          // just saw (system + tools + full history) plus the reply it added.
          // This is the authoritative "how full" number until the next turn.
          if (usage?.promptTokens !== undefined) {
            const completion = usage.completionTokens ?? tokens;
            setMeasuredPromptTokens(usage.promptTokens + completion);
            setMeasuredUsageTokens({ prompt: usage.promptTokens, completion });
          }
          // tok/s over decode time (turn minus TTFT) — the rate users feel.
          // Prefer the provider's own eval_duration when available: it's
          // pure decode time, wall-clock can be dragged out by tool calls
          // and rendering, which makes local models look slower than they
          // are. Anthropic and OpenAI don't send a duration, so we fall
          // back to the wall-clock decode window.
          const decodeMs = ttftMs !== undefined ? turnMs - ttftMs : turnMs;
          let tps: number | undefined;
          if (
            usage?.completionTokens !== undefined &&
            usage?.evalDurationMs !== undefined &&
            usage.evalDurationMs > 0
          ) {
            tps = Math.round(usage.completionTokens / (usage.evalDurationMs / 1000));
          } else if (tokens > 0 && decodeMs > 100) {
            tps = Math.round(tokens / (decodeMs / 1000));
          }
          const exact = usage?.completionTokens !== undefined;
          // Per-message cost. The provider's own figure wins when present —
          // OpenRouter reports the real charged amount (incl. markup), which
          // beats any table estimate and covers models the table doesn't
          // price. Otherwise fall back to this turn's token counts × the
          // model's list price. Local / subscription turns leave costUsd
          // undefined (no per-token bill).
          const costUsd =
            usage?.costUsd !== undefined
              ? usage.costUsd
              : pricing && usage?.promptTokens !== undefined && usage?.completionTokens !== undefined
                ? (usage.promptTokens * pricing.inputPerMillion +
                    usage.completionTokens * pricing.outputPerMillion) /
                  1_000_000
                : undefined;
          next[i] = { role: "assistant", content: msgContent, thinking: thinking || undefined, toolCalls: tcCalls.length ? tcCalls : undefined, delegateConsole, delegateProvider, meta: { ms: turnMs, tokens, promptTokens: usage?.promptTokens, ttftMs, tps, exact, costUsd } };
          commit(next);
          break;
        }
        case "tool_call_started": {
          const next = [...msgsRef.current];
          next.splice(nextAssistantIdx + 1, 0, { role: "tool", content: `Running ${event.name}...`, toolName: event.name, toolCallId: event.toolCallId, tool_call_id: event.toolCallId });
          nextAssistantIdx += 1;
          commit(next);
          break;
        }
        case "tool_call_finished": {
          // Match by id over the whole list — ids are unique per run, and
          // searching from nextAssistantIdx+1 used to skip the very row the
          // result belongs to.
          const next = [...msgsRef.current];
          for (let i = 0; i < next.length; i++) {
            const msg = next[i];
            if (msg.role === "tool" && (msg.toolCallId === event.toolCallId || msg.tool_call_id === event.toolCallId)) {
              next[i] = { role: "tool" as const, content: event.result.content, toolName: msg.toolName, toolCallId: event.toolCallId, tool_call_id: event.toolCallId };
              break;
            }
          }
          commit(next);
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
        case "permission_requested": {
          const req = event.request as {
            id: string;
            toolName?: string;
            summary?: string;
            reason?: string;
            input?: { command?: string; externalPaths?: string[] };
          };
          const isCommand = !!req.input?.command;
          const command = req.input?.command ?? req.summary ?? req.toolName ?? "permission request";
          setPendingPermission({
            runId: event.runId,
            requestId: req.id,
            toolName: req.toolName ?? "permission",
            kind: isCommand ? "command" : "network",
            command,
            summary: req.summary ?? command,
            reason: req.reason ?? "",
            externalPaths: Array.isArray(req.input?.externalPaths) ? req.input.externalPaths : [],
            suggestedPattern: isCommand ? suggestCommandPattern(command) : undefined,
          });
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
          setStreaming(false);
          setActivity(null);
          break;
        }
        case "run_error": {
          // A user-initiated Stop is delivered as a RunError with
          // `code: "aborted"`. It's not a harness failure — the partial
          // answer should stay on screen with no error banner, and the
          // connection-suggestion copy in the catch block would be wrong.
          if (event.error.code !== "aborted") {
            harnessError = new Error(event.error.message);
          } else {
            abortedByUser = true;
          }
          // Same safety as run_result: leave the working state on the observed
          // terminal event, not only via `await session.done`.
          setStreaming(false);
          setActivity(null);
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
      // Mark this conversation in-flight so a mid-run view switch re-attaches
      // to it rather than starting fresh on remount.
      if (panelId) savePanelSession(panelId, currentId, true);
      const session = await startAgentRun({
        runId: currentId,
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
        testAfterEditCommand: testAfterEditCommand || undefined,
      }, handleEvent);
      activeHarnessRunRef.current = session.runId;
      try { await session.done; } finally { activeHarnessRunRef.current = null; }
      if (harnessError) throw harnessError;
    } catch (e) {
      if (queueGenerationRef.current !== generation) return;
      const next = [...msgsRef.current];
      const i = locateAssistant(next);
      const failedUser = next[userIndex];
      if (failedUser?.role === "user") next[userIndex] = { ...failedUser, queueState: undefined, queueId: undefined };
      next[i] = { role: "assistant", content: `⚠ ${(e as Error).message}. Check ${providerName(turn.provider)} connection and credentials.` };
      // A failed MLX stream may mean the model went cold — re-warm next send.
      if (turn.provider === "mlx") mlxWarmedRef.current = null;
      commit(next);
    }
    // Turn settled (done or errored): record it no longer in-flight. The panel
    // still re-attaches to this conversation on remount (so the answer stays on
    // screen); starting a brand-new chat is the explicit "+" action.
    if (panelId) savePanelSession(panelId, currentId, false);
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    // Flush any pending delta that hasn't been rendered yet
    if (pendingDelta.content || pendingDelta.thinking) {
      appendPendingDelta(pendingDelta.content, pendingDelta.thinking);
    }
    setStreaming(false);
    setActivity(null);
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
    setQueuedTurns(queueRef.current);
    const queuedMessage: Msg = { role: "user", content: turn.text, attachments: turn.attachments.length ? turn.attachments : undefined, projectContext: turn.projectContext, queueState: "queued", queueId: turn.clientId };
    msgsRef.current = [...msgsRef.current, queuedMessage];
    setMsgs(msgsRef.current);
    // The user just hit send. Even if they were scrolled up reading old
    // context, "send" is a clear navigation signal — pull them to the
    // bottom so they can watch their message + the reply.
    forceStickToBottom();
    void drainQueue();
  }

  // Drop a still-queued turn (one that hasn't started running yet). drainQueue
  // pulls turns out of queueRef the moment they start, so anything still in
  // queuedTurns state is safe to cancel: remove it from the pending queue and
  // delete its placeholder user bubble.
  function clearQueue() {
    const pending = new Set(queueRef.current.map((t) => t.clientId));
    queueRef.current = [];
    setQueuedTurns([]);
    msgsRef.current = msgsRef.current.filter(
      (m) => !(m.role === "user" && m.queueState === "queued" && m.queueId && pending.has(m.queueId)),
    );
    setMsgs(msgsRef.current);
  }

  async function drainQueue() {
    if (processingQueueRef.current) return;
    processingQueueRef.current = true;
    const generation = queueGenerationRef.current;
    try {
      while (queueRef.current.length > 0 && queueGenerationRef.current === generation) {
        const [turn, ...rest] = queueRef.current;
        queueRef.current = rest;
        setQueuedTurns(rest);
        await runHarnessTurn(turn, generation);
      }
    } finally { processingQueueRef.current = false; }
  }

  async function ensureLocalServerReady(): Promise<boolean> {
    if (!isLocalProvider) return true;
    setServerError(null);
    try {
      const running = await invoke<boolean>("ai_local_server_status", { provider });
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
      const started = await invoke<boolean>("ai_local_server_start", { provider, model, concurrency: harnessSettings?.serverConcurrency });
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
    const lineage: Conversation["forkedFrom"] = {
      conversationId: currentId,
      title: deriveTitle(msgsRef.current),
      messageIndex: i,
      createdAt: Date.now(),
      mode: "chat",
    };
    setCurrentId(nid);
    setCurrentForkedFrom(lineage);
    setMsgs(newMsgs);
    if (panelId) savePanelSession(panelId, nid, false);
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

  async function send(opts?: { text?: string; mode?: AgentMode }) {
    const text = opts?.text ?? input;
    if (!text.trim() || serverStarting) return;
    if (providerDelegatesWork) {
      setInput(""); setMention(null); setSlash(null); setNextSendMode(null);
      await invoke("delegate_pty_write", { sessionId: `${currentId}:${provider}`, data: `${text}\r` });
      return;
    }
    cancelledWarmupRef.current = false;
    if (!(await ensureLocalServerReady())) return;
    // User hit Stop while the server was warming up — back out before launching.
    if (cancelledWarmupRef.current) { cancelledWarmupRef.current = false; return; }
    const requestedMode = opts?.mode ?? nextSendMode ?? agentModeRef.current;
    const availableMode: AgentMode =
      !modelSupportsTools && !providerDelegatesWork && requestedMode === "goal" ? "chat" : requestedMode;
    const mode: AgentMode =
      availableMode === "chat" && modelSupportsTools && asksForWorkspaceInspection(text)
        ? "plan"
        : availableMode;
    setInput(""); setMention(null); setSlash(null); setNextSendMode(null);
    const attachments = await collectAttachments(text);
    const activeProjectContext = lensItemsForPrompt(projectContext, text, contextMode);
    enqueueTurn({ clientId: genId(), text, mode, provider, model, modelSupportsTools, modelSupportsReflection, reflectionLevel, attachments, projectContext: activeProjectContext.length > 0 ? { mode: contextMode, items: activeProjectContext } : undefined });
  }

  async function handleDiffApply() {
    if (!pendingDiff) return;
    await resolveDiff({ runId: pendingDiff.runId, proposalId: pendingDiff.id, decision: { behavior: "apply" } });
  }

  async function handleDiffReject() {
    if (!pendingDiff) return;
    await resolveDiff({ runId: pendingDiff.runId, proposalId: pendingDiff.id, decision: { behavior: "reject" } });
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
    }).catch((err) => console.error("Failed to approve command:", err));
  }

  function rejectCommand() {
    if (!pendingPermission) return;
    const snapshot = pendingPermission;
    setPendingPermission(null);
    void resolvePermission({
      runId: snapshot.runId,
      requestId: snapshot.requestId,
      decision: { behavior: "deny" },
    }).catch((err) => console.error("Failed to reject command:", err));
  }

  // ── RENDER ──

  const canSend = !!input.trim() && !serverStarting;

  return (
    <>
    <aside className="floating-panel" style={{ width: fill ? "100%" : width, height: fill ? "100%" : undefined, margin: fill ? 0 : "4px 4px 4px 0", display: fill || visible ? "flex" : "none", flexDirection: "column", flexShrink: 0, overflow: "hidden" }}>
      <header style={{ padding: "8px 10px", fontSize: 11, color: "var(--fg-subtle)", letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 500, borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, position: "relative", zIndex: 40 }}>
        <div ref={providerRef} style={{ position: "relative", minWidth: 0, textTransform: "none", letterSpacing: 0 }}>
          <button onClick={() => setProviderOpen((o) => !o)}
            title={isLocalProvider ? (connected ? `${providerName(provider)} · connected` : `${providerName(provider)} · not reachable`) : isDelegateProvider(provider) ? (connected ? `${providerName(provider)} · CLI available` : `${providerName(provider)} · check CLI install/auth`) : (connected ? `${providerName(provider)} · connected` : `${providerName(provider)} · check API key`)}
            aria-haspopup="menu" aria-expanded={providerOpen}
            style={{ display: "flex", alignItems: "center", gap: 7, maxWidth: 200, height: 24, padding: "0 6px", borderRadius: "var(--radius-sm)", background: providerOpen ? "var(--bg-hover)" : "transparent", color: providerOpen ? "var(--fg-strong)" : "var(--fg-subtle)", cursor: "pointer", transition: "color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)" }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--fg-strong)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { if (!providerOpen) { e.currentTarget.style.color = "var(--fg-subtle)"; e.currentTarget.style.background = "transparent"; } }}>
            <ProviderLogo id={provider} size={14} />
            <span style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{providerName(provider)}</span>
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: "var(--fg-dim)" }}><path d="M6 9l6 6 6-6" /></svg>
          </button>
          {providerOpen && (
            <div role="menu" style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, minWidth: 200, maxHeight: "min(60vh, 440px)", overflowY: "auto", overscrollBehavior: "contain", background: "var(--bg-elevated)", border: "1px solid var(--border-strong)", borderRadius: "var(--radius-md)", boxShadow: "0 6px 24px rgba(38, 38, 32, 0.14)", padding: 4, zIndex: 30 }}>
              {providerGroups.map((group) => {
                const expanded = expandedGroups.has(group.label);
                const hasActive = group.items.some((it) => it.id === provider);
                return (
                <div key={group.label} style={{ marginBottom: 2 }}>
                  <button type="button" onClick={() => toggleGroup(group.label)} aria-expanded={expanded}
                    style={{ position: "sticky", top: 0, zIndex: 1, width: "100%", display: "flex", alignItems: "center", gap: 6, background: "color-mix(in srgb, var(--bg-elevated) 72%, transparent)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", border: "none", cursor: "pointer", fontSize: 9.5, fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase", color: "var(--fg-dim)", padding: "6px 8px 5px", textAlign: "left", transition: "color 120ms ease" }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = "var(--fg-subtle)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-dim)"; }}>
                    <span style={{ display: "grid", placeItems: "center", flexShrink: 0, transform: expanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 140ms cubic-bezier(0.4, 0, 0.2, 1)" }}>
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
                    </span>
                    <span style={{ flex: 1 }}>{group.label}</span>
                    {!expanded && hasActive && <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--fg-subtle)", flexShrink: 0 }} />}
                    <span style={{ fontWeight: 500, opacity: 0.5, fontVariantNumeric: "tabular-nums" }}>{group.items.length}</span>
                  </button>
                  {expanded && group.items.map((item) => {
                    const active = item.id === provider;
                    return (
                      <button key={item.id} role="menuitem" disabled={!item.available} onClick={() => item.available && selectProvider(item.id)}
                        style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: "var(--radius-sm)", background: active ? "var(--bg-hover)" : "transparent", color: item.available ? "var(--fg-strong)" : "var(--fg-dim)", cursor: item.available ? "pointer" : "default", fontSize: 12, textAlign: "left", transition: "background 120ms ease" }}
                        onMouseEnter={(e) => { if (item.available && !active) e.currentTarget.style.background = "var(--bg-hover)"; }}
                        onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}>
                        <span style={{ display: "grid", placeItems: "center", flexShrink: 0, color: item.available ? "var(--fg-subtle)" : "var(--fg-dim)" }}><ProviderLogo id={item.id} size={15} /></span>
                        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
                        {active && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--fg-subtle)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>}
                      </button>
                    );
                  })}
                </div>
                );
              })}
            </div>
          )}
        </div>
        {isLocalProvider && (serverError || (!serverStarting && !serverRunning)) && (
          <div
            title={serverError ?? `${providerName(provider)} stopped`}
            style={{
              justifySelf: "center",
              display: "flex",
              alignItems: "center",
              gap: 5,
              fontSize: 9.5,
              letterSpacing: "0.04em",
              color: "var(--fg-dim)",
            }}
          >
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: "50%",
                background: serverError ? "var(--danger)" : "var(--fg-dim)",
                opacity: 0.7,
              }}
            />
            {serverError ?? "Stopped"}
          </div>
        )}
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

      <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex" }}>
        <div
          ref={scrollRef}
          onScroll={updateStickFromScroll}
          style={{ flex: 1, overflowX: "hidden", overflowY: providerDelegatesWork ? "hidden" : "auto", padding: providerDelegatesWork ? 0 : "10px 12px 12px", fontSize: 13, display: providerDelegatesWork ? "flex" : msgs.length === 0 ? "grid" : "block", placeItems: !providerDelegatesWork && msgs.length === 0 ? "center" : undefined, minWidth: 0, minHeight: 0, overscrollBehavior: "contain" }}
        >
        {providerDelegatesWork ? (
          <DelegateTerminalSurface
            sessionId={`${currentId}:${provider}`}
            providerId={provider}
            provider={providerName(provider)}
            workspaceRoot={workspaceRoot}
            parentRunId={activeHarnessRunRef.current ?? currentId}
            resumeSessionId={initialResumeSessionId ?? null}
            task={initialTask ?? null}
          />
        ) : (
          <>
        {msgs.length === 0 && !serverStarting && (
          <div style={{ width: "min(260px, 80%)", textAlign: "center", color: "var(--fg-subtle)", lineHeight: 1.55, transform: "translateY(-10px)" }}>
            <div style={{ width: 38, height: 38, margin: "0 auto 14px", borderRadius: "var(--radius-lg)", display: "grid", placeItems: "center", color: "var(--accent)", background: "color-mix(in srgb, var(--accent-soft) 70%, transparent)", border: "1px solid var(--panel-border)", boxShadow: "inset 0 1px 0 var(--panel-highlight)" }}>
              <span style={{ fontFamily: "var(--font-ui)", fontSize: 19, fontWeight: 700, lineHeight: 1, letterSpacing: "-0.02em" }}>K</span>
            </div>
            <div style={{ color: "var(--fg-strong)", fontSize: 14, fontWeight: 500, marginBottom: 6 }}>{workspaceRoot ? "Ask Klide" : "Open a workspace"}</div>
            <div style={{ fontSize: 12 }}>{workspaceRoot ? (providerDelegatesWork ? `Delegate workspace tasks to ${providerName(provider)}.` : `Read, reason, and propose edits with ${providerName(provider)}.`) : "Open a folder to enable local agent mode."}</div>
          </div>
        )}
        {msgs.map((m, i) => {
          const isLast = i === msgs.length - 1;
          const isAssistantPlaceholder = streaming && m.role === "assistant" && m.content === "" && !m.thinking && !m.toolCalls;
          const activeToolRunning =
            streaming &&
            isLast &&
            m.role === "tool" &&
            /^Running /.test(m.content);
          const isStreamingActive = streaming && isLast && m.role === "assistant" && m.content !== "";
          // Messages above the last compaction marker are kept for reference but
          // no longer in the model's context — dim them so that's legible.
          const dimmed = lastCompactionIdx > 0 && i < lastCompactionIdx;

          if (m.role === "user") {
            const queued = m.queueState === "queued";
            const running = m.queueState === "running";
            const isEditing = editingIdx === i;
            return (
              <div key={i} className="ai-msg-in" style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", margin: "14px 0 12px", opacity: dimmed ? 0.4 : undefined, transition: "opacity var(--motion-med) var(--ease-out)" }}>
                {isEditing ? (
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
                    style={{ maxWidth: "88%", width: "min(440px, 88%)", resize: "none", font: "inherit", fontSize: 13, lineHeight: 1.55, padding: "8px 12px", borderRadius: "13px 13px 4px 13px", border: "1px solid color-mix(in srgb, var(--accent) 50%, var(--border))", background: "var(--accent-soft)", color: "var(--fg-strong)", whiteSpace: "pre-wrap", wordBreak: "break-word", boxSizing: "border-box" }}
                  />
                ) : (
                  <div className={running ? "ai-user-bubble-running" : queued ? "ai-user-bubble-queued" : undefined}
                    style={{ maxWidth: "88%", background: running ? "linear-gradient(110deg, var(--accent-soft), color-mix(in srgb, var(--accent-soft) 68%, var(--bg)), var(--accent-soft))" : queued ? "color-mix(in srgb, var(--accent-soft) 48%, var(--bg))" : "var(--accent-soft)", color: queued ? "var(--fg-subtle)" : "var(--fg-strong)", border: (queued || running) ? "1px solid color-mix(in srgb, var(--accent) 36%, var(--border))" : "1px solid transparent", borderRadius: "13px 13px 4px 13px", padding: "8px 12px", fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word", opacity: queued ? 0.82 : 1, backgroundSize: running ? "220% 100%" : undefined }}>
                    {m.content}
                  </div>
                )}
                {!queued && !running && m.content.trim() && !isEditing && (
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
                )}
                {!isEditing && m.tokenInfo && m.content.trim() && (
                  <div
                    className="klide-msg-meta"
                    title={m.tokenInfo.exact ? "Exact count from the model's tokenizer" : "Estimate — this provider has no tokenizer endpoint"}
                    style={{ marginTop: 3, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-dim)", letterSpacing: "0.02em", userSelect: "none" }}
                  >
                    {m.tokenInfo.exact ? "" : "~"}{m.tokenInfo.count.toLocaleString()} tokens
                  </div>
                )}
              </div>
            );
          }

          if (m.role === "tool") {
            const previousAssistant = [...msgs.slice(0, i)]
              .reverse()
              .find((msg) => msg.role === "assistant");
            const repeatedToolBurst =
              previousAssistant?.role === "assistant" &&
              previousAssistant.toolCalls &&
              previousAssistant.toolCalls.length > 1 &&
              previousAssistant.toolCalls.every((tc) => tc.name === previousAssistant.toolCalls?.[0]?.name);
            if (repeatedToolBurst && previousAssistant.toolCalls?.[0]?.name === m.toolName) return null;
            return <div key={i} className="ai-msg-in" style={{ margin: activeToolRunning ? "2px 0 3px 32px" : "1px 0 2px 32px", opacity: dimmed ? 0.4 : undefined, transition: "opacity var(--motion-med) var(--ease-out)" }}>{renderMessageBody(m, activeToolRunning)}</div>;
          }

          // Compaction marker: a system event, not an assistant utterance —
          // render it avatar-less and indented to align with tool output.
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
          // bubble after a user message carries the K mark, the rest get a
          // spacer so bodies stay column-aligned.
          const prevMsg = msgs[i - 1];
          const showAvatar = !prevMsg || (prevMsg.role !== "assistant" && prevMsg.role !== "tool");
          // Per-message actions belong on the *final* answer of a response, not
          // on intermediate narration turns ("OK, let me look…") that are
          // followed by more tool calls — otherwise the icon row appears in the
          // middle of a multi-turn run. A response ends when the next message is
          // a user turn (or there is none).
          const nextMsg = msgs[i + 1];
          const isResponseEnd = !nextMsg || nextMsg.role === "user";
          return (
            <div key={i} className="ai-msg-in" style={{ display: "flex", gap: 10, margin: showAvatar ? "14px 0 8px" : "3px 0", opacity: dimmed ? 0.4 : undefined, transition: "opacity var(--motion-med) var(--ease-out)" }}>
              {showAvatar ? (
                <div aria-hidden="true" style={{ flexShrink: 0, width: 22, height: 22, marginTop: 1, borderRadius: "50%", display: "grid", placeItems: "center", color: "var(--accent)", background: "color-mix(in srgb, var(--accent-soft) 80%, transparent)" }}>
                  <span style={{ fontFamily: "var(--font-ui)", fontSize: 12, fontWeight: 700, lineHeight: 1, letterSpacing: "-0.02em" }}>K</span>
                </div>
              ) : (
                <div aria-hidden="true" style={{ flexShrink: 0, width: 22 }} />
              )}
              <div style={{ flex: 1, minWidth: 0, color: "var(--fg-strong)", fontSize: 13, lineHeight: 1.6 }}>
                {isAssistantPlaceholder && !msgs.some((msg, idx) => idx > i && msg.role === "tool" && /^Running /.test(msg.content)) ? <AssistantPlaceholderLoader /> : <>{renderMessageBody(m, isStreamingActive)}{isStreamingActive && <span className="ai-caret" />}</>}
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
        })}
        {/* "Working" heartbeat — shown while a run is in progress but nothing
            else is animating. Covers the gap where the model is generating the
            next turn (esp. providers that don't stream token deltas, so there's
            no typing caret): without this the completed tool calls just sit
            there and the agent looks stuck. Hidden when a tool is mid-run, a
            placeholder/caret is already animating, or we're waiting on the user
            (diff / permission / question). */}
        {(() => {
          const last = msgs[msgs.length - 1];
          const tailPendingTool = last?.role === "tool" && /^Running /.test(last.content);
          const tailPlaceholder = last?.role === "assistant" && !last.content && !last.thinking && !last.toolCalls;
          const tailStreamingText = last?.role === "assistant" && !!last.content;
          // A queued/running user bubble already carries its own activity hint
          // (and the queue line sits right below), so the heartbeat is just noise.
          const tailQueuedUser = last?.role === "user" && !!last.queueState;
          const showWorking =
            streaming && !pendingDiff && !pendingPermission && !pendingQuestion &&
            !tailPendingTool && !tailPlaceholder && !tailStreamingText && !tailQueuedUser &&
            queuedTurns.length === 0;
          if (!showWorking) return null;
          return (
            <div className="ai-msg-in" style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 0 6px 32px", color: "var(--fg-dim)" }}>
              <DotGridLoader size={11} label="Working" />
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-subtle)" }}>Working…</span>
            </div>
          );
        })()}
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
              onReject={handleDiffReject}
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
        {!providerDelegatesWork && !stickToBottom && msgs.length > 0 && (
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
              left: "50%",
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
              transition: "opacity var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), bottom var(--motion-med) var(--ease-out)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.opacity = "1";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.opacity = "0.7";
            }}
          >
            {streaming && (
              <span
                aria-hidden
                style={{
                  width: 4,
                  height: 4,
                  borderRadius: "50%",
                  background: "currentColor",
                  animation: "klide-pulse 1.6s ease-in-out infinite",
                }}
              />
            )}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 5v14" />
              <path d="m6 13 6 6 6-6" />
            </svg>
          </span>
        )}
        <TodoStrip
          workspaceRoot={workspaceRoot}
          conversationId={currentId}
          goal={msgs.find((m) => m.role === "user")?.content.trim() || undefined}
          onDockHeightChange={setTodoDockHeight}
        />
      </div>

      {!providerDelegatesWork && (
      <div style={{ padding: "0 10px 10px" }}>
        {pendingPermission && (
          <InlineCommandReview
            command={pendingPermission.command}
            kind={pendingPermission.kind}
            detail={pendingPermission.reason}
            externalPaths={pendingPermission.externalPaths}
            onReject={rejectCommand}
            onApproveOnce={() => approveCommand("once")}
            onApproveForRun={() => approveCommand("run")}
            onApproveForProject={() => approveCommand("project")}
            pattern={pendingPermission.suggestedPattern}
            onApprovePattern={(pattern) => approveCommand("project", pattern)}
          />
        )}
        {pendingQuestion && (
          <div
            className="ai-qa-card"
            style={{
              marginBottom: 8,
              padding: "10px 12px",
              borderRadius: "var(--radius-md)",
              border: "1px solid color-mix(in srgb, var(--accent) 30%, var(--border))",
              background: "color-mix(in srgb, var(--accent-soft) 35%, var(--bg-elevated))",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--fg-strong)", fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase" }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: "var(--accent)" }}>
                <circle cx="12" cy="12" r="10" />
                <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" />
                <path d="M12 17h.01" />
              </svg>
              Question
            </div>
            <div style={{ color: "var(--fg-strong)", fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
              {pendingQuestion.question}
            </div>
            <textarea
              autoFocus
              value={questionAnswer}
              onChange={(e) => setQuestionAnswer(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void submitQuestion();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  skipQuestion();
                }
              }}
              placeholder="Type your answer… (⌘↩ to submit, Esc to skip)"
              rows={3}
              style={{
                width: "100%",
                resize: "vertical",
                minHeight: 56,
                maxHeight: 200,
                font: "inherit",
                fontSize: 13,
                lineHeight: 1.5,
                padding: "8px 10px",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border-strong)",
                background: "var(--bg)",
                color: "var(--fg-strong)",
                outline: "none",
              }}
            />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
              <button
                type="button"
                onClick={skipQuestion}
                style={{
                  height: 26,
                  padding: "0 10px",
                  fontSize: 11.5,
                  fontWeight: 500,
                  color: "var(--fg-subtle)",
                  background: "transparent",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-sm)",
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                Skip
              </button>
              <button
                type="button"
                onClick={() => void submitQuestion()}
                style={{
                  height: 26,
                  padding: "0 12px",
                  fontSize: 11.5,
                  fontWeight: 560,
                  color: "#fff",
                  background: "var(--accent)",
                  border: "1px solid var(--accent)",
                  borderRadius: "var(--radius-sm)",
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.filter = "brightness(1.08)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.filter = "none"; }}
              >
                Submit ⌘↩
              </button>
            </div>
          </div>
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
        {queuedTurns.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "0 4px 6px", color: "var(--fg-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
            <span title={queuedTurns.map((t, i) => `${i + 1}. ${t.text}`).join("\n\n")} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {queuedTurns.length} queued
            </span>
            <button type="button" onClick={clearQueue} title="Clear queue" aria-label="Clear queue"
              style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 15, height: 15, padding: 0, border: "none", background: "transparent", color: "currentColor", opacity: 0.55, cursor: "pointer", transition: "opacity var(--motion-fast) var(--ease-out)" }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.55"; }}>
              <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        )}
        {modeFlash && (
          <div aria-live="polite" className="popover-enter" style={{ display: "flex", alignItems: "center", gap: 7, padding: "0 2px 6px", fontFamily: "var(--font-mono)", fontSize: 11.5, color: modeFlash.tone === "accent" ? "var(--accent)" : modeFlash.tone === "warning" ? "var(--warning)" : "var(--fg-subtle)" }}>
            <span style={{ letterSpacing: "-1px" }} aria-hidden>{modeFlash.tone === "warning" ? "◌" : "⏵⏵"}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{modeFlash.text}</span>
          </div>
        )}
        {!streaming && revertableFiles > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "0 4px 6px", fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--fg-subtle)" }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              This run changed {revertableFiles} file{revertableFiles === 1 ? "" : "s"}
            </span>
            <button type="button" onClick={() => void revertThisRun()} disabled={reverting}
              title="Undo every file change this run made"
              style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 8px", borderRadius: "var(--radius-sm)", border: "1px solid var(--danger, #B42318)", background: "transparent", color: "var(--danger, #B42318)", fontFamily: "var(--font-mono)", fontSize: 11, cursor: reverting ? "default" : "pointer", opacity: reverting ? 0.6 : 1, transition: "background var(--motion-fast) var(--ease-out)" }}
              onMouseEnter={(e) => { if (!reverting) e.currentTarget.style.background = "color-mix(in srgb, var(--danger, #B42318) 12%, transparent)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" />
              </svg>
              {reverting ? "Reverting…" : "Revert"}
            </button>
          </div>
        )}
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
          {mention !== null && mentionMatches.length > 0 && (
            <div role="listbox" style={{ position: "absolute", bottom: "calc(100% + 6px)", left: 0, right: 0, maxHeight: 220, overflowY: "auto", background: "var(--bg-elevated)", border: "1px solid var(--border-strong)", borderRadius: "var(--radius-md)", boxShadow: "0 6px 24px rgba(38, 38, 32, 0.14)", padding: 4, zIndex: 20 }}>
              {mentionMatches.map((path, idx) => {
                const slash = path.lastIndexOf("/");
                const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
                const base = slash >= 0 ? path.slice(slash + 1) : path;
                return (
                  <div key={path} role="option" aria-selected={idx === mentionIdx}
                    onMouseDown={(e) => { e.preventDefault(); acceptMention(path); }}
                    onMouseEnter={() => setMentionIdx(idx)}
                    style={{ display: "flex", alignItems: "baseline", gap: 2, padding: "5px 8px", borderRadius: "var(--radius-sm)", fontSize: 12, cursor: "pointer", background: idx === mentionIdx ? "var(--bg-hover)" : "transparent", whiteSpace: "nowrap", overflow: "hidden" }}>
                    <span style={{ color: "var(--fg-strong)" }}>{base}</span>
                    <span style={{ color: "var(--fg-dim)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis" }}>{dir && ` ${dir}`}</span>
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ overflow: "hidden", borderRadius: "var(--radius-lg)" }}>
          <textarea ref={taRef} value={input}
            onChange={(e) => handleComposerChange(e.target.value, e.target.selectionStart)}
            onKeyDown={(e) => {
              if (slash !== null && slashMatches.length > 0) {
                if (e.key === "ArrowDown") { e.preventDefault(); setSlashIdx((i) => (i + 1) % slashMatches.length); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setSlashIdx((i) => (i - 1 + slashMatches.length) % slashMatches.length); return; }
                if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); acceptSlash(slashIdx); return; }
                if (e.key === "Escape") { e.preventDefault(); setSlash(null); return; }
              }
              if (mention !== null && mentionMatches.length > 0) {
                if (e.key === "ArrowDown") { e.preventDefault(); setMentionIdx((i) => (i + 1) % mentionMatches.length); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setMentionIdx((i) => (i - 1 + mentionMatches.length) % mentionMatches.length); return; }
                if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); acceptMention(mentionMatches[mentionIdx]); return; }
                if (e.key === "Escape") { e.preventDefault(); setMention(null); return; }
              }
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
              else if (e.key === "Tab" && !providerDelegatesWork) { e.preventDefault(); toggleMode(); }
              else if (e.key === "Escape" && (streaming || serverStarting)) { e.preventDefault(); stopCurrentStream(); }
            }}
            onFocus={() => { setComposerFocused(true); }}
            onBlur={() => { setComposerFocused(false); setMention(null); setSlash(null); }}
            placeholder={serverStarting ? `Starting ${providerName(provider)}...` : streaming ? "Queue another message…" : "Ask anything, @ to attach a file…"}
            rows={1}
            style={{ width: "100%", minHeight: 40, maxHeight: 168, resize: "none", background: "transparent", border: "none", color: "var(--fg-strong)", font: "inherit", fontSize: 13.5, lineHeight: 1.55, padding: "12px 14px 8px", outline: "none", display: "block" }}
          />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: width < 360 ? 4 : 6, padding: "6px 8px", borderTop: "1px solid color-mix(in srgb, var(--border) 30%, transparent)", flexWrap: "nowrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: width < 360 ? 4 : 6, minWidth: 0, flex: "0 0 auto", flexWrap: "nowrap", overflow: "hidden" }}>
              {providerDelegatesWork ? (
                <div title={`Speaking to ${providerName(provider)} delegate`} style={{ height: 24, display: "inline-flex", alignItems: "center", gap: 6, padding: "0 8px", borderRadius: 999, border: "1px solid var(--border-strong)", background: "color-mix(in srgb, var(--panel) 88%, transparent)", color: "var(--fg-subtle)", fontSize: 11, fontWeight: 560, flexShrink: 0 }}>
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
                      <div style={{ height: 1, background: "var(--border)", margin: "4px 8px" }} />
                      {MODE_RUNGS.map((rung, i) => {
                        const disabled = rung.mode === "goal" && goalDisabled;
                        const active = i === currentRungIdx;
                        return (
                          <button key={rung.label} type="button" role="menuitemradio" aria-checked={active} disabled={disabled}
                            onClick={() => { if (!disabled) selectRung(rung.mode, rung.review); }}
                            title={disabled ? `${model} cannot use edit tools.` : rung.desc}
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
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: width < 360 ? 1 : 2, flex: "1 1 auto", minWidth: 0 }}>
              {conversationCostUsd > 0 && width >= 380 && (
                <span
                  title={`This conversation has cost about $${conversationCostUsd.toFixed(conversationCostUsd < 1 ? 4 : 2)} (${modelLabel(model)} list price)`}
                  style={{ height: 20, display: "inline-flex", alignItems: "center", padding: "0 7px", borderRadius: 999, border: "1px solid var(--border)", background: "var(--bg-elevated)", color: "var(--fg-subtle)", fontSize: 10.5, fontFamily: "var(--font-mono)", fontWeight: 500, whiteSpace: "nowrap" }}
                >
                  {conversationCostUsd < 0.01 ? "<$0.01" : `$${conversationCostUsd.toFixed(conversationCostUsd < 1 ? 3 : 2)}`}
                </span>
              )}
              <ModelPicker
                provider={provider}
                model={model}
                availableModels={availableModels}
                disabled={streaming}
                onChange={onModelChange}
              />
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
                      fontWeight: 560,
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
	                              <span style={{ fontSize: 12, fontWeight: 560 }}>{option.label}</span>
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
                      <span style={{ color: "var(--fg-strong)", fontSize: 13, fontWeight: 620 }}>Context window</span>
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
                        <span style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>{promptContextUsed.toLocaleString()}</span>
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
              <button onClick={() => send()} disabled={!canSend} aria-label="Send message" title={serverStarting ? `Starting ${providerName(provider)}...` : "Send (Enter)"}
                style={{ width: 30, height: 30, flexShrink: 0, display: "grid", placeItems: "center", borderRadius: "50%", color: canSend ? "#fff" : "var(--fg-dim)", background: canSend ? "var(--accent)" : "var(--bg-elevated)", border: canSend ? "none" : "1px solid var(--border)", cursor: canSend ? "pointer" : "default", transition: "background var(--motion-med) var(--ease-out), color var(--motion-med) var(--ease-out), filter var(--motion-fast) var(--ease-out)" }}
                onMouseEnter={(e) => { if (canSend) e.currentTarget.style.filter = "brightness(1.08)"; }}
                onMouseLeave={(e) => (e.currentTarget.style.filter = "none")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5" /><path d="M6 11l6-6 6 6" /></svg>
              </button>
            )}
            </div>
          </div>
          </div>
        </div>
        {worktreeName && (
          <div
            title={`This panel runs in the git worktree "${worktreeName}" — its edits and commands stay on that branch, not the main checkout.`}
            style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 6, padding: "0 4px", fontSize: 10.5, color: "var(--fg-subtle)", minWidth: 0 }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: "var(--accent)" }}><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M6 9v6" /><path d="M18 6a9 9 0 0 1-9 9" /><circle cx="18" cy="6" r="3" /></svg>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              worktree <strong style={{ color: "var(--fg-strong)", fontWeight: 600 }}>{worktreeName}</strong>
            </span>
          </div>
        )}
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
