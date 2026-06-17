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
import { DiffModal } from "./DiffModal";
import { publishKlideConvo, settleKlideConvo } from "../klideConvos";
import {
  estimateProjectContextTokens,
  lensItemsForPrompt,
  type ProjectContextMode,
  type ProjectContextSnapshot,
} from "../contextTray";
import { startAgentRun, stopAgentRun, resolveDiff, resolveUserQuestion, resolvePermission } from "../agent/client";
import { toolsForMode } from "../agent/tools";
import { readWorkspaceTextFile, workspacePathExists } from "../workspaceFs";
import { TodoStrip } from "./TodoStrip";
import {
  DEFAULT_MODELS,
  MODE_OPTIONS,
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

import { ProviderLogo, AssistantPlaceholderLoader } from "./ai/icons";
import { DelegateTerminalSurface } from "./ai/DelegateTerminal";
import { renderMessageBody } from "./ai/ChatMessage";
import { ConversationHistory } from "./ai/ConversationHistory";
import { ModelPicker, modelLabel } from "./ai/ModelPicker";
import { buildSystemPrompt } from "./ai/system-prompt";
import { summarizeAndHandoff, generateMemoryNote, detectAndGenerateSkill, summarizeForCompaction } from "./ai/summarize";
import { addMemoryDraft } from "../memoryDrafts";
import { eventsToMsgs } from "./ai/eventsToMsgs";
import {
  genId,
  deriveTitle,
  messagesForPersist,
  estimateTokens,
  messageTokenEstimate,
  fuzzyFiles,
  loadConversations,
  saveConversations,
  loadPanelSession,
  savePanelSession,
} from "./ai/utils";

import type { Msg, QueuedTurn, Conversation } from "./ai/types";

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
  stopAfterRejection: boolean;
  skills: Skill[];
  projectContext?: ProjectContextSnapshot | null;
  harnessSettings?: AiHarnessSettings;
  onDuplicate?: (snapshot: { provider: ProviderId; model: string }) => void;
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
  requireDiffReview: _requireDiffReview,
  stopAfterRejection,
  skills,
  projectContext,
  harnessSettings,
  onDuplicate,
  onProviderChange,
  onClose,
  resumeConversation,
  onResumeConsumed,
  initialProvider,
  initialResumeSessionId,
  initialTask,
  onInitialConsumed,
  onMemoryWritten,
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
  const [input, setInput] = useState("");
  const [queuedTurns, setQueuedTurns] = useState<QueuedTurn[]>([]);
  const [composerFocused, setComposerFocused] = useState(false);
  const [contextHover, setContextHover] = useState(false);
  const [contextTooltipPos, setContextTooltipPos] = useState<{ bottom: number; left: number; width: number; compact: boolean } | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [generatingSkill, setGeneratingSkill] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  // Subtle inline "Auto-saved to memory" line under the composer. Surfaces for
  // ~4s after a run completes, then fades. Cleared on the next send or abort.
  const [autoMemoryNotice, setAutoMemoryNotice] = useState<string | null>(null);
  const autoMemoryTimerRef = useRef<number | null>(null);

  const lastPublishRef = useRef({ count: -1, streaming: false });
  useEffect(() => {
    if (msgs.length === 0) {
      // Active chat is empty — explicitly settle the MC row for this
      // panel so a user-initiated "new chat" doesn't leave a stale
      // "running" entry behind. View switches don't hit this branch
      // (msgs stays non-empty in the persisted store), so they no
      // longer kill the live row.
      settleKlideConvo(currentId);
      lastPublishRef.current = { count: -1, streaming: false };
      return;
    }
    const last = lastPublishRef.current;
    if (streaming && last.streaming && last.count === msgs.length) return;
    lastPublishRef.current = { count: msgs.length, streaming };
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
      messages: msgs.flatMap((m) =>
        (m.role === "user" || (m.role === "assistant" && !m.delegateConsole)) && m.content.trim()
          ? [{ role: m.role, text: m.content }]
          : []
      ),
      updatedMs: Date.now(),
    });
  }, [msgs, streaming, model, workspaceRoot, currentId]);

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
  const [contextMode] = useState<ProjectContextMode>(
    () => (localStorage.getItem("klide.contextMode") as ProjectContextMode) || "auto"
  );
  const [connected, setConnected] = useState(false);
  const [serverRunning, setServerRunning] = useState(false);
  const [serverStarting, setServerStarting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [serverRefresh] = useState(0);
  const [agentMode, setAgentMode] = useState<AgentMode>(
    () => normalizeAgentMode(localStorage.getItem("klide.agentMode"))
  );
  const agentModeRef = useRef(agentMode);
  const [modelSupportsTools, setModelSupportsTools] = useState(true);
  const [modelSupportsReflection, setModelSupportsReflection] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  // Portalled to <body> with viewport coordinates (same pattern as
  // ModelPicker) so the menu escapes the composer's `overflow: hidden` +
  // the floating panel's `transform: translateZ(0)`, which would otherwise
  // clip an `position: absolute` dropdown to the composer box.
  const [modeMenuPos, setModeMenuPos] = useState<{ bottom: number; left: number } | null>(null);
  const modeTriggerRef = useRef<HTMLButtonElement>(null);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const [reflectionOpen, setReflectionOpen] = useState(false);
  const [reflectionMenuPos, setReflectionMenuPos] = useState<{ bottom: number; left: number } | null>(null);
  const reflectionTriggerRef = useRef<HTMLButtonElement>(null);
  const reflectionMenuRef = useRef<HTMLDivElement>(null);
  const contextTriggerRef = useRef<HTMLButtonElement>(null);
  function openModeMenu() {
    const trigger = modeTriggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    setModeMenuPos({
      bottom: Math.round(window.innerHeight - rect.top + 8),
      left: Math.round(rect.left),
    });
    setModeOpen(true);
  }
  function closeModeMenu() { setModeOpen(false); setModeMenuPos(null); }
  function openReflectionMenu() {
    const trigger = reflectionTriggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = 176;
    setReflectionMenuPos({
      bottom: Math.round(window.innerHeight - rect.top + 8),
      left: Math.round(Math.min(Math.max(8, rect.left), window.innerWidth - width - 8)),
    });
    setReflectionOpen(true);
  }
  function closeReflectionMenu() { setReflectionOpen(false); setReflectionMenuPos(null); }
  function openContextTooltip() {
    const trigger = contextTriggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportPad = 8;
    const width = Math.min(360, Math.max(272, window.innerWidth - viewportPad * 2));
    const idealLeft = rect.right - width;
    setContextTooltipPos({
      bottom: Math.round(window.innerHeight - rect.top + 8),
      left: Math.round(Math.min(Math.max(viewportPad, idealLeft), window.innerWidth - width - viewportPad)),
      width: Math.round(width),
      compact: width < 330,
    });
    setContextHover(true);
  }
  function closeContextTooltip() {
    setContextHover(false);
    setContextTooltipPos(null);
  }
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
  // Outside click — the trigger and the portalled menu are in different
  // subtrees, so test both explicitly.
  useEffect(() => {
    if (!modeOpen) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (modeTriggerRef.current?.contains(t)) return;
      if (modeMenuRef.current?.contains(t)) return;
      closeModeMenu();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [modeOpen]);
  // The portalled menu can't follow the trigger across scroll/resize, so
  // close it rather than let it drift.
  useEffect(() => {
    if (!modeOpen) return;
    function onMove() { closeModeMenu(); }
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [modeOpen]);
  useEffect(() => {
    if (!reflectionOpen) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (reflectionTriggerRef.current?.contains(t)) return;
      if (reflectionMenuRef.current?.contains(t)) return;
      closeReflectionMenu();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [reflectionOpen]);
  useEffect(() => {
    if (!reflectionOpen) return;
    function onMove() { closeReflectionMenu(); }
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [reflectionOpen]);
  useEffect(() => {
    if (!contextHover) return;
    function onMove() { closeContextTooltip(); }
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [contextHover]);

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

  const SLASH_COMMANDS: { name: string; desc: string; run: () => void }[] = [
    { name: "chat", desc: "Switch to Chat mode (no tools)", run: () => { selectMode("chat"); setInput(""); } },
    { name: "plan", desc: "Switch to Plan mode (read-only, proposes a plan)", run: () => { selectMode("plan"); setInput(""); } },
    { name: "goal", desc: "Switch to Goal mode (can propose edits)", run: () => { selectMode(modelSupportsTools || providerDelegatesWork ? "goal" : "plan"); setInput(""); } },
    { name: "clear", desc: "Start a new conversation", run: () => newConversation() },
    { name: "handoff", desc: "Save this task state into Project Memory", run: () => saveHandoffToProjectMemory() },
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

  function saveHandoffToProjectMemory() {
    if (!workspaceRoot) {
      setInput("");
      const msg: Msg = { role: "assistant", content: "Open a workspace before saving a project handoff." };
      msgsRef.current = [...msgsRef.current, msg];
      setMsgs(msgsRef.current);
      return;
    }
    const handoff = buildHandoffSummary(msgsRef.current, projectContext);
    setInput("");
    const msg: Msg = {
      role: "assistant",
      content: `Saved Project Memory handoff: ${handoff.title}`,
    };
    msgsRef.current = [...msgsRef.current, msg];
    setMsgs(msgsRef.current);
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
    if (effectiveMode === "chat" && (provider === "mlx" || provider === "ollama")) {
      return `You are Klide's local chat assistant. Answer the user's latest message directly and concisely. You have no tools in this turn, so do not claim you can inspect or edit files unless file text was attached in the conversation.

Important: do not output JSON, structured plans, or fake tool-call blocks. Just answer in natural language. The chat surface in this app renders any JSON you emit as raw noise, and the user won't see a clean answer.`;
    }
    return buildSystemPrompt(
      workspaceRoot,
      stopAfterRejection,
      skills,
      effectiveMode,
      toolsAvailableForDraft,
      projectRules,
      harnessSettings,
      model
    );
  }, [
    effectiveMode,
    harnessSettings,
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
  const messageTokens = msgs.reduce((sum, m) => sum + messageTokenEstimate(m), 0);
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

  async function compactConversation() {
    if (!canCompact) return;
    setCompacting(true);
    setCompactError(null);
    try {
      const older = msgs.slice(0, msgs.length - COMPACT_KEEP_RECENT);
      const recent = msgs.slice(msgs.length - COMPACT_KEEP_RECENT);
      if (older.length === 0) return;
      const summary = await summarizeForCompaction(provider, model, older);
      if (!summary) throw new Error("The model returned an empty summary.");
      // Write the marker into the transcript the harness replays from — this
      // is what actually shrinks the next turn's context.
      await invoke("agent_compact_context", { runId: currentId, summary });
      // Mirror it in the panel so the view + gauge reflect the new state.
      const summaryMsg: Msg = {
        role: "system",
        content: `Compacted ${older.length} earlier message${older.length === 1 ? "" : "s"}:\n${summary}`,
      };
      const next: Msg[] = [summaryMsg, ...recent];
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

  const [conversations, setConversations] = useState<Conversation[]>(() => loadConversations<Conversation>());
  const [historyOpen, setHistoryOpen] = useState(false);
  const msgsRef = useRef<Msg[]>([]);
  const queueRef = useRef<QueuedTurn[]>([]);
  const processingQueueRef = useRef(false);
  const queueGenerationRef = useRef(0);
  const activeHarnessRunRef = useRef<string | null>(null);

  function abortActiveHarnessRun() {
    const runId = activeHarnessRunRef.current;
    if (!runId) return;
    activeHarnessRunRef.current = null;
    void stopAgentRun(runId).catch((e) => console.error("Failed to abort harness run:", e));
  }

  function stopCurrentStream() {
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
      setAutoMemoryNotice(`✎ Memory draft ready to review: ${note.title}`);
      if (autoMemoryTimerRef.current !== null) {
        clearTimeout(autoMemoryTimerRef.current);
      }
      autoMemoryTimerRef.current = window.setTimeout(() => {
        setAutoMemoryNotice(null);
        autoMemoryTimerRef.current = null;
      }, 4000);
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
    setMsgs(c.msgs);
    msgsRef.current = c.msgs;
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
    if (id === currentId) {
      setMsgs([]);
      const nid = genId();
      setCurrentId(nid);
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
      const conv: Conversation = { id: currentId, title: deriveTitle(toSave), msgs: toSave, updatedAt: Date.now() };
      const next = [conv, ...prev.filter((c) => c.id !== currentId)];
      saveConversations(next);
      return next;
    });
  }, [msgs, currentId]);

  // Flush whatever the latest commit was on unmount so a view switch
  // mid-stream doesn't drop the in-flight conversation. `msgsRef` is
  // already kept in sync above, and the persist effect above will
  // have run for the most recent state when React re-rendered.
  useEffect(() => () => {
    const snapshot = messagesForPersist(msgsRef.current);
    if (snapshot.length === 0) return;
    const raw = (() => {
      try { return localStorage.getItem("klide.conversations"); } catch { return null; }
    })();
    let list: Conversation[] = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) list = parsed as Conversation[];
      } catch { /* corrupt store — overwrite below */ }
    }
    const conv: Conversation = { id: currentId, title: deriveTitle(snapshot), msgs: snapshot, updatedAt: Date.now() };
    const next = [conv, ...list.filter((c) => c.id !== currentId)];
    saveConversations(next);
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
    command: string;
    summary: string;
  } | null>(null);

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
          // Per-message cost from this turn's real token usage × the model's
          // list price. Only when the provider reported both counts AND the
          // model has a known price (hosted, non-subscription) — local and
          // subscription turns leave costUsd undefined (no per-token bill).
          const costUsd =
            pricing && usage?.promptTokens !== undefined && usage?.completionTokens !== undefined
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
          const req = event.request as { id: string; summary?: string; input?: { command?: string } };
          setPendingPermission({
            runId: event.runId,
            requestId: req.id,
            command: req.input?.command ?? "",
            summary: req.summary ?? req.input?.command ?? "command",
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
          break;
        }
      }
    };

    try {
      const toolsAvailable = turn.modelSupportsTools;
      const overrides = harnessSettings?.toolOverrides;
      const disabledTools = overrides ? Object.keys(overrides).filter((k) => overrides[k] === false) : undefined;
      const systemPrompt = turn.mode === "chat" && (turn.provider === "mlx" || turn.provider === "ollama")
        ? `You are Klide's local chat assistant. Answer the user's latest message directly and concisely. You have no tools in this turn, so do not claim you can inspect or edit files unless file text was attached in the conversation.

Important: do not output JSON, structured plans, or fake tool-call blocks. Just answer in natural language. The chat surface in this app renders any JSON you emit as raw noise, and the user won't see a clean answer.`
        : buildSystemPrompt(workspaceRoot, stopAfterRejection, skills, turn.mode, toolsAvailable && turn.mode !== "chat", projectRules, harnessSettings, turn.model);
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
      if (running) {
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

  async function send(opts?: { text?: string; mode?: AgentMode }) {
    const text = opts?.text ?? input;
    if (!text.trim() || serverStarting) return;
    if (providerDelegatesWork) {
      setInput(""); setMention(null); setSlash(null); setNextSendMode(null);
      await invoke("delegate_pty_write", { sessionId: `${currentId}:${provider}`, data: `${text}\r` });
      return;
    }
    if (!(await ensureLocalServerReady())) return;
    const requestedMode = opts?.mode ?? nextSendMode ?? agentModeRef.current;
    const mode: AgentMode = !modelSupportsTools && !providerDelegatesWork && requestedMode === "goal" ? "chat" : requestedMode;
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

  function approveCommand() {
    if (!pendingPermission) return;
    const snapshot = pendingPermission;
    setPendingPermission(null);
    void resolvePermission({
      runId: snapshot.runId,
      requestId: snapshot.requestId,
      decision: { behavior: "allow", scope: "once" },
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
        {isLocalProvider && (serverError || serverStarting || !serverRunning) && (
          <div
            title={serverError ?? (serverStarting ? `Starting ${providerName(provider)}` : `${providerName(provider)} stopped`)}
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
                opacity: serverStarting ? 0.45 : 0.7,
              }}
            />
            {serverError ?? (serverStarting ? "Starting" : "Stopped")}
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
          style={{ flex: 1, overflow: providerDelegatesWork ? "hidden" : "auto", padding: providerDelegatesWork ? 0 : "10px 12px 12px", fontSize: 13, display: providerDelegatesWork ? "flex" : msgs.length === 0 ? "grid" : "block", placeItems: !providerDelegatesWork && msgs.length === 0 ? "center" : undefined, minHeight: 0, overscrollBehavior: "contain" }}
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
        {msgs.length === 0 && (
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

          if (m.role === "user") {
            const queued = m.queueState === "queued";
            const running = m.queueState === "running";
            return (
              <div key={i} className="ai-msg-in" style={{ display: "flex", justifyContent: "flex-end", margin: "14px 0 12px" }}>
                <div className={running ? "ai-user-bubble-running" : queued ? "ai-user-bubble-queued" : undefined}
                  style={{ maxWidth: "88%", background: running ? "linear-gradient(110deg, var(--accent-soft), color-mix(in srgb, var(--accent-soft) 68%, var(--bg)), var(--accent-soft))" : queued ? "color-mix(in srgb, var(--accent-soft) 48%, var(--bg))" : "var(--accent-soft)", color: queued ? "var(--fg-subtle)" : "var(--fg-strong)", border: (queued || running) ? "1px solid color-mix(in srgb, var(--accent) 36%, var(--border))" : "1px solid transparent", borderRadius: "13px 13px 4px 13px", padding: "8px 12px", fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word", opacity: queued ? 0.82 : 1, backgroundSize: running ? "220% 100%" : undefined }}>
                  {m.content}
                </div>
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
            return <div key={i} className="ai-msg-in" style={{ margin: activeToolRunning ? "2px 0 3px 32px" : "1px 0 2px 32px" }}>{renderMessageBody(m, activeToolRunning)}</div>;
          }

          // One avatar per response: multi-turn tool runs produce several
          // consecutive assistant/tool messages — only the first assistant
          // bubble after a user message carries the K mark, the rest get a
          // spacer so bodies stay column-aligned.
          const prevMsg = msgs[i - 1];
          const showAvatar = !prevMsg || (prevMsg.role !== "assistant" && prevMsg.role !== "tool");
          return (
            <div key={i} className="ai-msg-in" style={{ display: "flex", gap: 10, margin: showAvatar ? "14px 0 8px" : "3px 0" }}>
              {showAvatar ? (
                <div aria-hidden="true" style={{ flexShrink: 0, width: 22, height: 22, marginTop: 1, borderRadius: "50%", display: "grid", placeItems: "center", color: "var(--accent)", background: "color-mix(in srgb, var(--accent-soft) 80%, transparent)" }}>
                  <span style={{ fontFamily: "var(--font-ui)", fontSize: 12, fontWeight: 700, lineHeight: 1, letterSpacing: "-0.02em" }}>K</span>
                </div>
              ) : (
                <div aria-hidden="true" style={{ flexShrink: 0, width: 22 }} />
              )}
              <div style={{ flex: 1, minWidth: 0, color: "var(--fg-strong)", fontSize: 13, lineHeight: 1.6 }}>
                {isAssistantPlaceholder && !msgs.some((msg, idx) => idx > i && msg.role === "tool" && /^Running /.test(msg.content)) ? <AssistantPlaceholderLoader /> : <>{renderMessageBody(m, isStreamingActive)}{isStreamingActive && <span className="ai-caret" />}</>}
              </div>
            </div>
          );
        })}
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
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
              Run command?
            </div>
            <div
              style={{
                color: "var(--fg-strong)",
                fontSize: 12.5,
                fontFamily: "var(--font-mono)",
                lineHeight: 1.5,
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                padding: "8px 10px",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border-strong)",
                background: "var(--bg)",
              }}
            >
              {pendingPermission.command}
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
              <button
                type="button"
                onClick={rejectCommand}
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
              >
                Reject
              </button>
              <button
                type="button"
                onClick={approveCommand}
                style={{
                  height: 26,
                  padding: "0 12px",
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: "var(--accent-fg, #fff)",
                  background: "var(--accent)",
                  border: "1px solid var(--accent)",
                  borderRadius: "var(--radius-sm)",
                  cursor: "pointer",
                }}
              >
                Approve &amp; run
              </button>
            </div>
          </div>
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
        {(showCompactPrompt || compacting || compactError) && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 2px 6px", fontSize: 11.5 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0, height: 24, padding: "0 10px", borderRadius: 999, border: "1px solid color-mix(in srgb, #A15C00 40%, var(--border))", background: "color-mix(in srgb, #A15C00 12%, var(--bg-elevated))", color: "var(--fg-strong)" }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#A15C00", flexShrink: 0 }} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {compactError
                  ? `Compact failed: ${compactError}`
                  : compacting
                    ? "Compacting older turns…"
                    : `Context ${Math.round(contextRatio * 100)}% full — compact older turns to free room?`}
              </span>
              {showCompactPrompt && !compacting && (
                <button type="button" onClick={() => void compactConversation()}
                  style={{ flexShrink: 0, height: 18, padding: "0 8px", borderRadius: 999, border: "none", background: "#A15C00", color: "#fff", fontSize: 10.5, fontWeight: 600, cursor: "pointer" }}>
                  Compact
                </button>
              )}
            </span>
          </div>
        )}
        {(queuedTurns.length > 0 || autoMemoryNotice) && (
          <div style={{ minHeight: 18, display: "flex", alignItems: "center", gap: 6, color: "var(--fg-subtle)", fontSize: 11, padding: "0 2px 6px", flexWrap: "wrap" }}>
            {queuedTurns.length > 0 && (
              <span title={queuedTurns.map((t) => t.text).join("\n\n")} style={{ display: "inline-flex", alignItems: "center", maxWidth: "100%", minWidth: 0, height: 18, padding: "0 7px", borderRadius: 999, border: "1px solid var(--border)", background: "var(--bg-elevated)", color: "var(--fg-subtle)" }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{queuedTurns.length} queued</span>
              </span>
            )}
            {autoMemoryNotice && (
              <span style={{ display: "inline-flex", alignItems: "center", minWidth: 0, height: 18, padding: "0 7px", borderRadius: 999, border: "1px solid color-mix(in srgb, var(--accent) 36%, var(--border))", background: "color-mix(in srgb, var(--accent-soft) 60%, transparent)", color: "var(--fg-strong)" }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{autoMemoryNotice}</span>
              </span>
            )}
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
              else if (e.key === "Escape" && streaming) { e.preventDefault(); stopCurrentStream(); }
            }}
            onFocus={() => { setComposerFocused(true); }}
            onBlur={() => { setComposerFocused(false); setMention(null); setSlash(null); }}
            placeholder={serverStarting ? `Starting ${providerName(provider)}...` : streaming ? "Queue another message…" : "Ask anything, @ to attach a file…"}
            rows={1}
            style={{ width: "100%", minHeight: 40, maxHeight: 168, resize: "none", background: "transparent", border: "none", color: "var(--fg-strong)", font: "inherit", fontSize: 13.5, lineHeight: 1.55, padding: "12px 14px 8px", outline: "none", display: "block" }}
          />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: width < 360 ? 4 : 6, padding: "6px 8px", borderTop: "1px solid color-mix(in srgb, var(--border) 70%, transparent)", flexWrap: "nowrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: width < 360 ? 4 : 6, minWidth: 0, flex: "1 1 auto", flexWrap: "nowrap", overflow: "hidden" }}>
              {providerDelegatesWork ? (
                <div title={`Speaking to ${providerName(provider)} delegate`} style={{ height: 24, display: "inline-flex", alignItems: "center", gap: 6, padding: "0 8px", borderRadius: 999, border: "1px solid var(--border-strong)", background: "color-mix(in srgb, var(--panel) 88%, transparent)", color: "var(--fg-subtle)", fontSize: 11, fontWeight: 560, flexShrink: 0 }}>
                  <ProviderLogo id={provider} size={13} /><span>{providerName(provider)}</span>
                </div>
              ) : (
                <div style={{ position: "relative", flexShrink: 0 }}>
                  <button ref={modeTriggerRef} type="button" onClick={() => { if (!streaming) { if (modeOpen) closeModeMenu(); else openModeMenu(); } }} disabled={streaming}
                    title={`${MODE_OPTIONS.find((o) => o.id === effectiveMode)?.title ?? ""} Click to choose Chat, Plan, or Goal. Press Tab to cycle.`}
                    aria-haspopup="menu" aria-expanded={modeOpen} aria-label={`AI mode: ${MODE_OPTIONS.find((o) => o.id === effectiveMode)?.label ?? "Chat"}`}
                    style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", gap: 0, height: 24, width: width < 360 ? 58 : 64, padding: width < 360 ? "0 17px 0 7px" : "0 19px 0 9px", borderRadius: 999, border: "1px solid var(--border-strong)", background: modeOpen ? "var(--bg-hover)" : "color-mix(in srgb, var(--panel) 88%, transparent)", boxShadow: modeOpen ? "0 6px 18px rgba(38, 38, 32, 0.10)" : "inset 0 1px 0 rgba(255,255,255,0.05)", color: modeOpen ? "var(--fg-strong)" : "var(--fg-subtle)", fontSize: 11, fontWeight: 560, letterSpacing: 0, cursor: streaming ? "default" : "pointer", transition: "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)" }}
                    onMouseEnter={(e) => { if (!streaming) e.currentTarget.style.color = "var(--fg-strong)"; }}
                    onMouseLeave={(e) => { if (!modeOpen) e.currentTarget.style.color = "var(--fg-subtle)"; }}>
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "center" }}>{MODE_OPTIONS.find((o) => o.id === effectiveMode)?.label ?? "Chat"}</span>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ position: "absolute", right: width < 360 ? 5 : 7, opacity: 0.65, transform: modeOpen ? "rotate(180deg)" : "none", transition: "transform var(--motion-fast) var(--ease-out)" }}><path d="M6 9l6 6 6-6" /></svg>
                  </button>
                  {modeOpen && modeMenuPos && createPortal(
                    <div ref={modeMenuRef} role="menu" aria-label="AI mode" className="popover-enter" style={{ position: "fixed", left: modeMenuPos.left, bottom: modeMenuPos.bottom, width: 132, padding: 4, borderRadius: "var(--radius-md)", border: "1px solid var(--border-strong)", background: "var(--bg-elevated)", boxShadow: "0 14px 34px rgba(38, 38, 32, 0.16)", zIndex: 200 }}>
                      {MODE_OPTIONS.map((option) => {
                        const disabled = option.id === "goal" && !modelSupportsTools && !providerDelegatesWork;
                        const active = option.id === effectiveMode;
                        return (
                          <button key={option.id} type="button" role="menuitemradio" aria-checked={active} disabled={disabled}
                            onClick={() => { if (!disabled) selectMode(option.id); }}
                            title={disabled ? `${model} cannot use edit tools.` : option.title}
                            style={{ width: "100%", height: 28, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "0 8px", border: "none", borderRadius: "var(--radius-sm)", background: active ? "var(--bg-hover)" : "transparent", color: disabled ? "var(--fg-dim)" : active ? "var(--fg-strong)" : "var(--fg-subtle)", font: "inherit", fontSize: 12, cursor: disabled ? "default" : "pointer" }}>
                            <span>{option.label}</span>
                            {active && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>}
                          </button>
                        );
                      })}
                    </div>,
                    document.body
                  )}
                </div>
              )}
              <ModelPicker
                provider={provider}
                model={model}
                availableModels={availableModels}
                disabled={streaming}
                onChange={onModelChange}
              />
              {modelSupportsReflection && (
                <div style={{ position: "relative", flexShrink: 0 }}>
                  <button
                    ref={reflectionTriggerRef}
                    type="button"
                    disabled={streaming}
                    onClick={() => {
                      if (streaming) return;
                      if (reflectionOpen) closeReflectionMenu();
                      else openReflectionMenu();
                    }}
                    aria-haspopup="menu"
                    aria-expanded={reflectionOpen}
                    aria-label={`Reflection: ${activeReflection.label}`}
                    title="Choose reflection level for this model"
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
                      color: reflectionOpen ? "var(--fg-strong)" : "var(--fg-subtle)",
                      fontSize: 11,
                      fontWeight: 560,
                      letterSpacing: 0,
                      cursor: streaming ? "default" : "pointer",
	                      transition: "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
                    }}
                    onMouseEnter={(e) => { if (!streaming) e.currentTarget.style.color = "var(--fg-strong)"; }}
                    onMouseLeave={(e) => { if (!reflectionOpen) e.currentTarget.style.color = "var(--fg-subtle)"; }}
                  >
	                    <ReflectionBars level={activeReflection.level} />
	                  </button>
                  {reflectionOpen && reflectionMenuPos && createPortal(
	                    <div ref={reflectionMenuRef} role="menu" aria-label="Reflection level" className="popover-enter" style={{ position: "fixed", left: reflectionMenuPos.left, bottom: reflectionMenuPos.bottom, width: 166, padding: 4, borderRadius: "var(--radius-md)", border: "1px solid var(--border-strong)", background: "var(--bg-elevated)", boxShadow: "0 10px 26px rgba(38, 38, 32, 0.14)", zIndex: 205 }}>
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
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "initial", gap: width < 360 ? 3 : 4, flex: "0 0 auto", minWidth: 0 }}>
              {conversationCostUsd > 0 && width >= 380 && (
                <span
                  title={`This conversation has cost about $${conversationCostUsd.toFixed(conversationCostUsd < 1 ? 4 : 2)} (${modelLabel(model)} list price)`}
                  style={{ height: 20, display: "inline-flex", alignItems: "center", padding: "0 7px", borderRadius: 999, border: "1px solid var(--border)", background: "var(--bg-elevated)", color: "var(--fg-subtle)", fontSize: 10.5, fontFamily: "var(--font-mono)", fontWeight: 500, whiteSpace: "nowrap" }}
                >
                  {conversationCostUsd < 0.01 ? "<$0.01" : `$${conversationCostUsd.toFixed(conversationCostUsd < 1 ? 3 : 2)}`}
                </span>
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
                  <div role="tooltip" className="popover-enter" style={{ position: "fixed", left: contextTooltipPos.left, bottom: contextTooltipPos.bottom, width: contextTooltipPos.width, maxWidth: "calc(100vw - 16px)", padding: contextTooltipPos.compact ? "10px 10px 9px" : "12px 12px 11px", borderRadius: "var(--radius-lg)", border: "1px solid var(--border-strong)", background: "var(--bg-elevated)", boxShadow: "0 14px 38px rgba(38, 38, 32, 0.18)", color: "var(--fg)", textAlign: "left", pointerEvents: "none", zIndex: 220 }}>
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
              {streaming ? (
                <button onClick={stopCurrentStream} aria-label="Stop generation" title="Stop (Esc)"
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
      </div>
      )}
    </aside>
    {pendingDiff && (
      <DiffModal
        edit={{
          path: pendingDiff.path,
          oldContent: pendingDiff.oldContent,
          newContent: pendingDiff.newContent,
          isCreate: pendingDiff.isCreate,
          reason: pendingDiff.reason,
        }}
        onApply={handleDiffApply}
        onReject={handleDiffReject}
      />
    )}
    </>
  );
}

function buildHandoffSummary(
  msgs: Msg[],
  projectContext: ProjectContextSnapshot | null | undefined
): { title: string; body: string } {
  const userTurns = msgs.filter((m): m is Extract<Msg, { role: "user" }> => m.role === "user");
  const assistantTurns = msgs.filter((m): m is Extract<Msg, { role: "assistant" }> => m.role === "assistant" && !m.delegateConsole);
  const toolTurns = msgs.filter((m): m is Extract<Msg, { role: "tool" }> => m.role === "tool");
  const firstUser = userTurns[0]?.content.trim() || "Continue the current task.";
  const lastUser = userTurns[userTurns.length - 1]?.content.trim() || firstUser;
  const lastAssistant = assistantTurns[assistantTurns.length - 1]?.content.trim();
  const contextItems = projectContext?.lens.slice(0, 8) ?? [];
  const touched = [
    ...new Set([
      ...contextItems.map((item) => item.path),
      ...userTurns.flatMap((turn) => turn.attachments?.map((attachment) => attachment.path) ?? []),
    ].filter((path) => path && path !== "."))
  ].slice(0, 10);
  const toolNames = [...new Set(toolTurns.map((turn) => turn.toolName))].slice(0, 8);
  const title = deriveTitle([{ role: "user", content: firstUser } as Msg]);
  const body = [
    `Goal: ${firstUser}`,
    `Last user request: ${lastUser}`,
    lastAssistant ? `Current state: ${lastAssistant.slice(0, 1200)}` : "Current state: no assistant summary yet.",
    touched.length ? `Relevant files/areas:\n${touched.map((path) => `- ${path}`).join("\n")}` : "Relevant files/areas: none captured yet.",
    contextItems.length
      ? `Context lens:\n${contextItems.slice(0, 6).map((item) => `- ${item.label}: ${item.path} - ${item.detail.slice(0, 180)}`).join("\n")}`
      : "Context lens: no active lens snapshot.",
    toolNames.length ? `Tools used: ${toolNames.join(", ")}` : "Tools used: none.",
    "Next pickup: read this handoff, inspect the relevant files, then continue from the last user request.",
  ].join("\n\n");
  return { title, body };
}
