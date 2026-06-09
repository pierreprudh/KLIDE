import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { exists, readTextFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { DiffModal } from "./DiffModal";
import { publishKlideConvo, settleKlideConvo } from "../klideConvos";
import {
  estimateProjectContextTokens,
  lensItemsForPrompt,
  type ProjectContextMode,
  type ProjectContextSnapshot,
} from "../contextTray";
import { startAgentRun, stopAgentRun, resolveDiff } from "../agent/client";
import { TodoStrip } from "./TodoStrip";
import {
  DEFAULT_MODELS,
  MLX_MODEL_PRESETS,
  MODE_OPTIONS,
  PROVIDER_GROUPS,
  isDelegateProvider,
  normalizeAgentMode,
  providerName,
} from "../agent/providers";
import type {
  AgentAttachment as Attachment,
  AgentEvent,
  AgentMode,
  ProviderId,
  DiffProposal,
} from "../agent/types";
import type { Skill } from "../skills";

import { ProviderLogo, AssistantPlaceholderLoader } from "./ai/icons";
import { DelegateTerminalSurface } from "./ai/DelegateTerminal";
import { renderMessageBody } from "./ai/ChatMessage";
import { ConversationHistory } from "./ai/ConversationHistory";
import { buildSystemPrompt } from "./ai/system-prompt";
import { summarizeAndHandoff, detectAndGenerateSkill } from "./ai/summarize";
import {
  genId,
  deriveTitle,
  estimateTokens,
  messageTokenEstimate,
  fuzzyFiles,
  loadConversations,
  saveConversations,
} from "./ai/utils";

import type { Msg, QueuedTurn, Conversation } from "./ai/types";

type Props = {
  workspaceRoot: string | null;
  onFileWritten?: (path: string, newContent: string) => void;
  onWorkspaceChanged?: () => void;
  visible: boolean;
  width: number;
  fill?: boolean;
  /**
   * Stable identity for this panel. When the workbench view is unmounted
   * (user switches to Settings / Mission Control) the AiPanel component
   * unmounts with it; passing a stable `panelId` lets us re-attach to the
   * same conversation history on the next mount, so the user does not lose
   * their in-flight thread when they come back. Defaults to a fresh id.
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
  harnessSettings?: { chatPrompt?: string; planPrompt?: string; goalPrompt?: string; toolOverrides?: Record<string, boolean> };
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

function storedModelForProvider(id: ProviderId): string {
  const stored = localStorage.getItem(`klide.model.${id}`);
  if (id === "mlx" && stored) {
    // MLX expects Hugging Face-style ids or local paths. Ignore stale
    // Ollama-style tags such as `gemma4:12b-mlx` from earlier shared-model UI.
    const looksLikeMlx = stored.includes("/") || stored.startsWith(".");
    if (!looksLikeMlx || stored.includes(":")) return DEFAULT_MODELS[id];
  }
  return stored || DEFAULT_MODELS[id];
}

function modelOptionsFor(provider: ProviderId, model: string, availableModels: string[]): string[] {
  const options = [...availableModels];
  if (model && !options.includes(model)) options.unshift(model);
  if (provider === "mlx") {
    for (const preset of MLX_MODEL_PRESETS) {
      if (!options.includes(preset)) options.push(preset);
    }
  }
  return options;
}

function modelLabel(name: string): string {
  // The selector is narrow and we want the user to recognise the model at
  // a glance. Strip noisy repo prefixes that Hugging Face / Ollama-style
  // tags both use. Value stays the same; only the display is shortened.
  const slash = name.indexOf("/");
  return slash >= 0 ? name.slice(slash + 1) : name;
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
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [activity, setActivity] = useState<"thinking" | "waiting" | null>(null);
  void activity;
  const [queuedTurns, setQueuedTurns] = useState<QueuedTurn[]>([]);
  const [composerFocused, setComposerFocused] = useState(false);
  const [contextHover, setContextHover] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [generatingSkill, setGeneratingSkill] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);

  const convoIdRef = useRef<string | null>(null);
  const lastPublishRef = useRef({ count: -1, streaming: false });
  useEffect(() => {
    if (msgs.length === 0) {
      if (convoIdRef.current) settleKlideConvo(convoIdRef.current);
      convoIdRef.current = null;
      lastPublishRef.current = { count: -1, streaming: false };
      return;
    }
    const last = lastPublishRef.current;
    if (streaming && last.streaming && last.count === msgs.length) return;
    lastPublishRef.current = { count: msgs.length, streaming };
    if (!convoIdRef.current) convoIdRef.current = crypto.randomUUID();
    const firstUser = msgs.find((m) => m.role === "user");
    publishKlideConvo({
      id: convoIdRef.current,
      title: (firstUser?.content.trim() || "Untitled chat").slice(0, 120),
      status: streaming ? "running" : "waiting",
      model: model ?? null,
      cwd: workspaceRoot,
      messages: msgs.flatMap((m) =>
        (m.role === "user" || (m.role === "assistant" && !m.delegateConsole)) && m.content.trim()
          ? [{ role: m.role, text: m.content }]
          : []
      ),
      updatedMs: Date.now(),
    });
  }, [msgs, streaming, model, workspaceRoot]);
  useEffect(() => () => { if (convoIdRef.current) settleKlideConvo(convoIdRef.current); }, []);

  const [contextLimit, setContextLimit] = useState(128_000);
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
  const [modeOpen, setModeOpen] = useState(false);
  const modeRef = useRef<HTMLDivElement>(null);
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
    setModeOpen(false);
  }
  useEffect(() => { agentModeRef.current = agentMode; }, [agentMode]);
  useEffect(() => {
    if (!modeOpen) return;
    function onDown(e: MouseEvent) { if (modeRef.current && !modeRef.current.contains(e.target as Node)) setModeOpen(false); }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [modeOpen]);

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
  useEffect(() => {
    if (!providerOpen) return;
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
          const full = `${workspaceRoot}/${name}`;
          if (!(await exists(full))) continue;
          let text = await readTextFile(full);
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
        const full = `${workspaceRoot}/${p}`;
        if (!(await exists(full))) continue;
        let content = await readTextFile(full);
        if (content.length > 12000) content = content.slice(0, 12000) + "\n…(truncated)";
        out.push({ path: p, content });
      } catch {}
    }
    return out;
  }

  const lensProjectContext = providerDelegatesWork ? [] : lensItemsForPrompt(projectContext, input, contextMode);
  const contextUsed = msgs.reduce((sum, m) => sum + messageTokenEstimate(m), 0) + estimateTokens(input) + estimateTokens(projectRules) + estimateProjectContextTokens(lensProjectContext);
  const contextRatio = Math.min(1, contextUsed / contextLimit);
  const contextTone = contextRatio > 0.85 ? "var(--danger, #B42318)" : contextRatio > 0.65 ? "#A15C00" : "var(--accent)";

  const [conversations, setConversations] = useState<Conversation[]>(() => loadConversations<Conversation>());
  const [currentId, setCurrentId] = useState<string>(() => panelId ?? genId());
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
  }

  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);

  useEffect(() => { msgsRef.current = msgs; }, [msgs]);

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
    setHistoryOpen(false);
    abortActiveHarnessRun();
    setMsgs([]);
    msgsRef.current = [];
    queueRef.current = [];
    queueGenerationRef.current += 1;
    setQueuedTurns([]);
    processingQueueRef.current = false;
    setStreaming(false);
    setActivity(null);
    setInput("");
    setCurrentId(panelId ?? genId());
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
    queueRef.current = [];
    queueGenerationRef.current += 1;
    setQueuedTurns([]);
  }

  function deleteConversation(id: string, e: ReactMouseEvent) {
    e.stopPropagation();
    setConversations((prev) => { const next = prev.filter((c) => c.id !== id); saveConversations(next); return next; });
    if (id === currentId) { setMsgs([]); setCurrentId(genId()); }
  }

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [msgs]);

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
    if (streaming || msgs.length === 0) return;
    const lastMsg = msgs[msgs.length - 1];
    if (lastMsg.role === "assistant" && lastMsg.content === "" && !lastMsg.thinking && !lastMsg.toolCalls) return;
    setConversations((prev) => {
      const conv: Conversation = { id: currentId, title: deriveTitle(msgs), msgs, updatedAt: Date.now() };
      const next = [conv, ...prev.filter((c) => c.id !== currentId)];
      saveConversations(next);
      return next;
    });
  }, [msgs, streaming, currentId]);

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
        const next = names.length > 0 ? names : [DEFAULT_MODELS[provider]];
        onAvailableModelsChange(next);
        if (!next.includes(model)) onModelChange(next[0]);
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
    async function loadContextWindow() {
      try {
        const windowSize = await invoke<number>("ai_context_window", { provider, model });
        if (!cancelled && Number.isFinite(windowSize) && windowSize > 0) setContextLimit(windowSize);
      } catch { if (!cancelled) setContextLimit(128_000); }
    }
    void loadContextWindow();
    return () => { cancelled = true; };
  }, [provider, model]);

  // ── Agent loop (harness-only) ──
  const [pendingDiff, setPendingDiff] = useState<DiffProposal | null>(null);

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

    let harnessError: Error | null = null;
    let nextAssistantIdx = assistantIndex;

    // Throttle assistant_delta state updates to ~20 fps — avoids flooding
    // React with one setState per token (60+/s), which clones the whole msgs
    // array and re-renders the entire message list on every chunk.
    let pendingDelta = { content: "", thinking: "" };
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushDelta = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        const c = pendingDelta.content;
        const t = pendingDelta.thinking;
        pendingDelta = { content: "", thinking: "" };
        if (c || t) {
          setMsgs((prev) => {
            const next = [...prev];
            if (!next[nextAssistantIdx] || next[nextAssistantIdx].role !== "assistant") return prev;
            const existing = next[nextAssistantIdx] as Msg & { role: "assistant" };
            const newContent = (existing.content || "") + c;
            const newThinking = [existing.thinking, t].filter(Boolean).join("") || undefined;
            next[nextAssistantIdx] = { ...existing, content: newContent, thinking: newThinking, delegateConsole, delegateProvider };
            return next;
          });
        }
      }, 50);
    };

    const handleEvent = (event: AgentEvent) => {
      if (queueGenerationRef.current !== generation) return;
      const cur = msgsRef.current;

      switch (event.type) {
        case "assistant_delta": {
          pendingDelta.content += event.text;
          pendingDelta.thinking += event.thinking ?? "";
          flushDelta();
          break;
        }
        case "assistant_message": {
          if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
          // Flush any pending delta before finalising
          if (pendingDelta.content || pendingDelta.thinking) {
            setMsgs((prev) => {
              const next = [...prev];
              if (!next[nextAssistantIdx] || next[nextAssistantIdx].role !== "assistant") return prev;
              const existing = next[nextAssistantIdx] as Msg & { role: "assistant" };
              const newContent = (existing.content || "") + pendingDelta.content;
              const newThinking = [existing.thinking, pendingDelta.thinking].filter(Boolean).join("") || undefined;
              next[nextAssistantIdx] = { ...existing, content: newContent, thinking: newThinking, delegateConsole, delegateProvider };
              return next;
            });
          }
          pendingDelta = { content: "", thinking: "" };
          const text = event.content.filter((b) => b.type === "text").map((b) => b.text).join("");
          const thinking = event.content.filter((b) => b.type === "thinking").map((b) => b.text).join("").trim();
          const tcBlocks = event.content.filter((b) => b.type === "tool_call");
          const tcCalls = tcBlocks.map((b) => ({ id: ("toolCallId" in b ? b.toolCallId : "") as string, name: "name" in b ? b.name as string : "", args: "input" in b ? b.input : {} }));
          const msgContent = text || (cur[nextAssistantIdx] as Msg & { role: "assistant" })?.content || "";
          setMsgs((prev) => {
            const next = [...prev];
            if (!next[nextAssistantIdx] || next[nextAssistantIdx].role !== "assistant") return prev;
            next[nextAssistantIdx] = { role: "assistant", content: msgContent, thinking: thinking || undefined, toolCalls: tcCalls.length ? tcCalls : undefined, delegateConsole, delegateProvider };
            return next;
          });
          break;
        }
        case "tool_call_started": {
          setMsgs((prev) => {
            const next = [...prev];
            next.splice(nextAssistantIdx + 1, 0, { role: "tool", content: `Running ${event.name}...`, toolName: event.name, toolCallId: event.toolCallId, tool_call_id: event.toolCallId });
            nextAssistantIdx += 1;
            return next;
          });
          break;
        }
        case "tool_call_finished": {
          setMsgs((prev) => {
            const next = [...prev];
            for (let i = nextAssistantIdx + 1; i < next.length; i++) {
              const msg = next[i];
              if (msg.role === "tool" && (msg.toolCallId === event.toolCallId || msg.tool_call_id === event.toolCallId)) {
                next[i] = { role: "tool" as const, content: event.result.content, toolName: msg.toolName, toolCallId: event.toolCallId, tool_call_id: event.toolCallId };
                break;
              }
            }
            return next;
          });
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
        case "file_changed": {
          if (workspaceRoot && onFileWritten) {
            void (async () => {
              try {
                const content = await readTextFile(`${workspaceRoot}/${event.path}`);
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
          const existingUser = cur[userIndex];
          if (existingUser?.role === "user") {
            setMsgs((prev) => {
              const next = [...prev];
              next[userIndex] = { ...existingUser, queueState: undefined, queueId: undefined };
              return next;
            });
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
          }
          break;
        }
      }
      // Keep msgsRef in sync with latest msgs
      msgsRef.current = cur;
    };

    try {
      const toolsAvailable = turn.modelSupportsTools;
      const overrides = harnessSettings?.toolOverrides;
      const disabledTools = overrides ? Object.keys(overrides).filter((k) => overrides[k] === false) : undefined;
      const systemPrompt = turn.mode === "chat" && (turn.provider === "mlx" || turn.provider === "ollama")
        ? `You are Klide's local chat assistant. Answer the user's latest message directly and concisely. You have no tools in this turn, so do not claim you can inspect or edit files unless file text was attached in the conversation.`
        : buildSystemPrompt(workspaceRoot, stopAfterRejection, skills, turn.mode, toolsAvailable && turn.mode !== "chat", projectRules, harnessSettings);
      const session = await startAgentRun({
        workspaceRoot, mode: turn.mode, provider: turn.provider, model: turn.model,
        text: turn.text, attachments: turn.attachments,
        context: { workspaceRoot, attachments: turn.attachments, lensItems: turn.projectContext?.items ?? [], estimatedTokens: 0, omitted: [] },
        systemPrompt,
        disabledTools: disabledTools && disabledTools.length > 0 ? disabledTools : undefined,
      }, handleEvent);
      activeHarnessRunRef.current = session.runId;
      try { await session.done; } finally { activeHarnessRunRef.current = null; }
      if (harnessError) throw harnessError;
    } catch (e) {
      if (queueGenerationRef.current !== generation) return;
      setMsgs((prev) => {
        const next = [...prev];
        if (!next[nextAssistantIdx] || next[nextAssistantIdx].role !== "assistant") return prev;
        const failedUser = next[userIndex];
        if (failedUser?.role === "user") next[userIndex] = { ...failedUser, queueState: undefined, queueId: undefined };
        next[nextAssistantIdx] = { role: "assistant", content: `⚠ ${(e as Error).message}. Check ${providerName(turn.provider)} connection and credentials.` };
        return next;
      });
    }
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    // Flush any pending delta that hasn't been rendered yet
    if (pendingDelta.content || pendingDelta.thinking) {
      setMsgs((prev) => {
        const next = [...prev];
        if (!next[nextAssistantIdx] || next[nextAssistantIdx].role !== "assistant") return prev;
        const existing = next[nextAssistantIdx] as Msg & { role: "assistant" };
        next[nextAssistantIdx] = { ...existing, content: (existing.content || "") + pendingDelta.content, thinking: existing.thinking ? existing.thinking + (pendingDelta.thinking ?? "") : pendingDelta.thinking || undefined, delegateConsole, delegateProvider };
        return next;
      });
    }
    setStreaming(false);
    setActivity(null);
    setPendingDiff(null);
    if (isDelegateProvider(turn.provider)) onWorkspaceChanged?.();
  }

  function enqueueTurn(turn: QueuedTurn) {
    queueRef.current = [...queueRef.current, turn];
    setQueuedTurns(queueRef.current);
    const queuedMessage: Msg = { role: "user", content: turn.text, attachments: turn.attachments.length ? turn.attachments : undefined, projectContext: turn.projectContext, queueState: "queued", queueId: turn.clientId };
    msgsRef.current = [...msgsRef.current, queuedMessage];
    setMsgs(msgsRef.current);
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
      const started = await invoke<boolean>("ai_local_server_start", { provider, model });
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
    enqueueTurn({ clientId: genId(), text, mode, provider, model, modelSupportsTools, attachments, projectContext: activeProjectContext.length > 0 ? { mode: contextMode, items: activeProjectContext } : undefined });
  }

  async function handleDiffApply() {
    if (!pendingDiff) return;
    await resolveDiff({ runId: pendingDiff.runId, proposalId: pendingDiff.id, decision: { behavior: "apply" } });
  }

  async function handleDiffReject() {
    if (!pendingDiff) return;
    await resolveDiff({ runId: pendingDiff.runId, proposalId: pendingDiff.id, decision: { behavior: "reject" } });
  }

  // ── RENDER ──

  const activeMode = nextSendMode ?? agentMode;
  const effectiveMode = !modelSupportsTools && !providerDelegatesWork && activeMode === "goal" ? "chat" : activeMode;
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
            <div role="menu" style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, minWidth: 200, background: "var(--bg-elevated)", border: "1px solid var(--border-strong)", borderRadius: "var(--radius-md)", boxShadow: "0 6px 24px rgba(38, 38, 32, 0.14)", padding: 4, zIndex: 30 }}>
              {PROVIDER_GROUPS.map((group) => (
                <div key={group.label} style={{ marginBottom: 2 }}>
                  <div style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase", color: "var(--fg-dim)", padding: "6px 8px 3px" }}>{group.label}</div>
                  {group.items.map((item) => {
                    const active = item.id === provider;
                    return (
                      <button key={item.id} role="menuitem" disabled={!item.available} onClick={() => item.available && selectProvider(item.id)}
                        style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: "var(--radius-sm)", background: active ? "var(--bg-hover)" : "transparent", color: item.available ? "var(--fg-strong)" : "var(--fg-dim)", cursor: item.available ? "pointer" : "default", fontSize: 12, textAlign: "left" }}
                        onMouseEnter={(e) => { if (item.available && !active) e.currentTarget.style.background = "var(--bg-hover)"; }}
                        onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}>
                        <span style={{ display: "grid", placeItems: "center", flexShrink: 0, color: item.available ? "var(--fg-subtle)" : "var(--fg-dim)" }}><ProviderLogo id={item.id} size={15} /></span>
                        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
                        {active && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>}
                      </button>
                    );
                  })}
                </div>
              ))}
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

      <TodoStrip workspaceRoot={workspaceRoot} />
      <div ref={scrollRef} style={{ flex: 1, overflow: providerDelegatesWork ? "hidden" : "auto", padding: providerDelegatesWork ? 0 : 12, fontSize: 13, display: providerDelegatesWork ? "flex" : msgs.length === 0 ? "grid" : "block", placeItems: !providerDelegatesWork && msgs.length === 0 ? "center" : undefined, minHeight: 0 }}>
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
          const isStreamingActive = streaming && isLast && m.role === "assistant" && m.content !== "";

          if (m.role === "user") {
            const queued = m.queueState === "queued";
            const running = m.queueState === "running";
            return (
              <div key={i} className="ai-msg-in" style={{ display: "flex", justifyContent: "flex-end", margin: "16px 0" }}>
                <div className={running ? "ai-user-bubble-running" : queued ? "ai-user-bubble-queued" : undefined}
                  style={{ maxWidth: "88%", background: running ? "linear-gradient(110deg, var(--accent-soft), color-mix(in srgb, var(--accent-soft) 68%, var(--bg)), var(--accent-soft))" : queued ? "color-mix(in srgb, var(--accent-soft) 48%, var(--bg))" : "var(--accent-soft)", color: queued ? "var(--fg-subtle)" : "var(--fg-strong)", border: (queued || running) ? "1px solid color-mix(in srgb, var(--accent) 36%, var(--border))" : "1px solid transparent", borderRadius: "13px 13px 4px 13px", padding: "8px 12px", fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word", opacity: queued ? 0.82 : 1, backgroundSize: running ? "220% 100%" : undefined }}>
                  {m.content}
                </div>
              </div>
            );
          }

          if (m.role === "tool") {
            return <div key={i} className="ai-msg-in" style={{ margin: "8px 0 8px 32px" }}>{renderMessageBody(m)}</div>;
          }

          return (
            <div key={i} className="ai-msg-in" style={{ display: "flex", gap: 10, margin: "16px 0" }}>
              <div aria-hidden="true" style={{ flexShrink: 0, width: 22, height: 22, marginTop: 1, borderRadius: "50%", display: "grid", placeItems: "center", color: "var(--accent)", background: "color-mix(in srgb, var(--accent-soft) 80%, transparent)" }}>
                <span style={{ fontFamily: "var(--font-ui)", fontSize: 12, fontWeight: 700, lineHeight: 1, letterSpacing: "-0.02em" }}>K</span>
              </div>
              <div style={{ flex: 1, minWidth: 0, color: "var(--fg-strong)", fontSize: 13, lineHeight: 1.6 }}>
                {isAssistantPlaceholder ? <AssistantPlaceholderLoader /> : <>{renderMessageBody(m, isStreamingActive)}{isStreamingActive && <span className="ai-caret" />}</>}
              </div>
            </div>
          );
        })}
          </>
        )}
      </div>

      {!providerDelegatesWork && (
      <div style={{ padding: 10 }}>
        {queuedTurns.length > 0 && (
          <div style={{ minHeight: 18, display: "flex", alignItems: "center", gap: 6, color: "var(--fg-subtle)", fontSize: 11, padding: "0 2px 6px", flexWrap: "wrap" }}>
            <span title={queuedTurns.map((t) => t.text).join("\n\n")} style={{ display: "inline-flex", alignItems: "center", maxWidth: "100%", minWidth: 0, height: 18, padding: "0 7px", borderRadius: 999, border: "1px solid var(--border)", background: "var(--bg-elevated)", color: "var(--fg-subtle)" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{queuedTurns.length} queued</span>
            </span>
          </div>
        )}
        <div style={{ position: "relative", border: `1px solid ${composerFocused ? "var(--accent)" : "var(--border-strong)"}`, borderRadius: "var(--radius-md)", background: "var(--bg)", boxShadow: composerFocused ? "0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent), 0 1px 2px rgba(38, 38, 32, 0.05)" : "0 1px 2px rgba(38, 38, 32, 0.04)", transition: "border-color var(--motion-med) var(--ease-out), box-shadow var(--motion-med) var(--ease-out)" }}>
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
                    <span style={{ color: "var(--fg-dim)", fontSize: 11, textOverflow: "ellipsis", overflow: "hidden" }}>{dir && ` ${dir}`}</span>
                  </div>
                );
              })}
            </div>
          )}
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
            style={{ width: "100%", minHeight: 38, maxHeight: 160, resize: "none", background: "transparent", border: "none", color: "var(--fg-strong)", font: "inherit", fontSize: 13, lineHeight: 1.5, padding: "10px 10px 2px", outline: "none", display: "block" }}
          />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, padding: "2px 6px 6px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
              {providerDelegatesWork ? (
                <div title={`Speaking to ${providerName(provider)} delegate`} style={{ height: 24, display: "inline-flex", alignItems: "center", gap: 6, padding: "0 8px", borderRadius: 999, border: "1px solid var(--border-strong)", background: "color-mix(in srgb, var(--panel) 88%, transparent)", color: "var(--fg-subtle)", fontSize: 11, fontWeight: 560, flexShrink: 0 }}>
                  <ProviderLogo id={provider} size={13} /><span>{providerName(provider)}</span>
                </div>
              ) : (
                <div ref={modeRef} style={{ position: "relative", flexShrink: 0 }}>
                  <button type="button" onClick={() => { if (!streaming) setModeOpen((o) => !o); }} disabled={streaming}
                    title={`${MODE_OPTIONS.find((o) => o.id === effectiveMode)?.title ?? ""} Click to choose Chat, Plan, or Goal. Press Tab to cycle.`}
                    aria-haspopup="menu" aria-expanded={modeOpen} aria-label={`AI mode: ${MODE_OPTIONS.find((o) => o.id === effectiveMode)?.label ?? "Chat"}`}
                    style={{ display: "flex", alignItems: "center", gap: 5, height: 24, minWidth: 66, padding: "0 8px", borderRadius: 999, border: "1px solid var(--border-strong)", background: modeOpen ? "var(--bg-hover)" : "color-mix(in srgb, var(--panel) 88%, transparent)", boxShadow: modeOpen ? "0 6px 18px rgba(38, 38, 32, 0.10)" : "inset 0 1px 0 rgba(255,255,255,0.05)", color: modeOpen ? "var(--fg-strong)" : "var(--fg-subtle)", fontSize: 11, fontWeight: 560, letterSpacing: 0, cursor: streaming ? "default" : "pointer", transition: "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)" }}
                    onMouseEnter={(e) => { if (!streaming) e.currentTarget.style.color = "var(--fg-strong)"; }}
                    onMouseLeave={(e) => { if (!modeOpen) e.currentTarget.style.color = "var(--fg-subtle)"; }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: effectiveMode === "goal" ? "var(--accent)" : effectiveMode === "plan" ? "#A15C00" : "var(--fg-dim)", flexShrink: 0 }} />
                    <span>{MODE_OPTIONS.find((o) => o.id === effectiveMode)?.label ?? "Chat"}</span>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ opacity: 0.65, transform: modeOpen ? "rotate(180deg)" : "none", transition: "transform var(--motion-fast) var(--ease-out)" }}><path d="M6 9l6 6 6-6" /></svg>
                  </button>
                  {modeOpen && (
                    <div role="menu" aria-label="AI mode" style={{ position: "absolute", left: 0, bottom: "calc(100% + 8px)", width: 132, padding: 4, borderRadius: "var(--radius-md)", border: "1px solid var(--border-strong)", background: "var(--bg-elevated)", boxShadow: "0 14px 34px rgba(38, 38, 32, 0.16)", zIndex: 20 }}>
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
                    </div>
                  )}
                </div>
              )}
              <div style={{ position: "relative", display: "flex", alignItems: "center", width: 118, flex: "0 1 118px", minWidth: 72 }}>
                <select value={model} onChange={(e) => onModelChange(e.target.value)} disabled={streaming}
                  title={model}
                  style={{ appearance: "none", WebkitAppearance: "none", MozAppearance: "none", width: "100%", height: 24, color: "var(--fg-subtle)", background: "transparent", border: "none", borderRadius: "var(--radius-xs)", font: "inherit", fontSize: 11, outline: "none", padding: "0 18px 0 6px", cursor: streaming ? "default" : "pointer", textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap", transition: "color var(--motion-fast) var(--ease-out)" }}
                  onMouseEnter={(e) => { if (!streaming) e.currentTarget.style.color = "var(--fg-strong)"; }}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "var(--fg-subtle)")}>
                  {modelOptionsFor(provider, model, availableModels).map((name) => <option key={name} value={name}>{modelLabel(name)}</option>)}
                </select>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ position: "absolute", right: 4, pointerEvents: "none", color: "var(--fg-dim)" }}><path d="M6 9l6 6 6-6" /></svg>
              </div>
              <button type="button" aria-label={`Context window usage ${Math.round(contextRatio * 100)} percent`}
                style={{ width: 28, height: 28, flexShrink: 0, display: "grid", placeItems: "center", borderRadius: "50%", background: contextHover ? "var(--bg-hover)" : "transparent", color: contextTone, cursor: "default", position: "relative", zIndex: 2, transition: "background var(--motion-fast) var(--ease-out), color var(--motion-med) var(--ease-out)" }}
                onMouseEnter={(e) => { setContextHover(true); e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { setContextHover(false); e.currentTarget.style.background = "transparent"; }}>
                <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
                  <circle cx="11" cy="11" r="7.5" fill="none" stroke="var(--border)" strokeWidth="1.6" />
                  <circle cx="11" cy="11" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" pathLength="100" strokeDasharray={`${Math.max(2, Math.round(contextRatio * 100))} 100`} transform="rotate(-90 11 11)" style={{ transition: "stroke-dasharray var(--motion-med) var(--ease-out), stroke var(--motion-med) var(--ease-out)" }} />
                </svg>
                {contextHover && (
                  <div role="tooltip" style={{ position: "absolute", right: -2, bottom: "calc(100% + 8px)", width: 218, padding: "10px 11px", borderRadius: "var(--radius-md)", border: "1px solid var(--border-strong)", background: "var(--bg-elevated)", boxShadow: "0 10px 30px rgba(38, 38, 32, 0.16)", color: "var(--fg)", textAlign: "left", pointerEvents: "none" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 8 }}><span style={{ color: "var(--fg-strong)", fontSize: 12, fontWeight: 600 }}>Context</span><span style={{ color: contextTone, fontSize: 12, fontWeight: 600 }}>{Math.round(contextRatio * 100)}%</span></div>
                    <div style={{ height: 4, borderRadius: 999, background: "var(--bg-hover)", overflow: "hidden", marginBottom: 8 }}><div style={{ width: `${Math.max(2, contextRatio * 100)}%`, height: "100%", borderRadius: 999, background: contextTone }} /></div>
                    <div style={{ color: "var(--fg-subtle)", fontSize: 11, lineHeight: 1.45 }}>{contextUsed.toLocaleString()} / {contextLimit.toLocaleString()} tokens</div>
                  </div>
                )}
              </button>
            </div>
            {streaming ? (
              <button onClick={stopCurrentStream} aria-label="Stop generation" title="Stop (Esc)"
                style={{ width: 28, height: 28, flexShrink: 0, display: "grid", placeItems: "center", borderRadius: "50%", color: "var(--fg-strong)", background: "var(--bg-elevated)", border: "1px solid var(--border)", cursor: "pointer", transition: "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)" }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.borderColor = "var(--border-strong)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-elevated)"; e.currentTarget.style.borderColor = "var(--border)"; }}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
              </button>
            ) : (
              <button onClick={() => send()} disabled={!canSend} aria-label="Send message" title={serverStarting ? `Starting ${providerName(provider)}...` : "Send (Enter)"}
                style={{ width: 28, height: 28, flexShrink: 0, display: "grid", placeItems: "center", borderRadius: "50%", color: canSend ? "#fff" : "var(--fg-dim)", background: canSend ? "var(--accent)" : "var(--bg-elevated)", cursor: canSend ? "pointer" : "default", transition: "background var(--motion-med) var(--ease-out), color var(--motion-med) var(--ease-out), filter var(--motion-fast) var(--ease-out)" }}
                onMouseEnter={(e) => { if (canSend) e.currentTarget.style.filter = "brightness(1.08)"; }}
                onMouseLeave={(e) => (e.currentTarget.style.filter = "none")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5" /><path d="M6 11l6-6 6 6" /></svg>
              </button>
            )}
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
