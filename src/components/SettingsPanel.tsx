import {
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { THEMES } from "../theme";
import { ProviderLogo } from "./ai/icons";
import type { ProviderId } from "../agent/types";
import { PROVIDER_GROUPS, DEFAULT_MODELS } from "../agent/providers";
import { ModelPicker } from "./ai/ModelPicker";
import { DEFAULT_ADVISOR_PROVIDER, DEFAULT_ADVISOR_MODEL } from "../agent/advisor";
import { refreshCustomCli, type CustomCli } from "../customCli";
import { SETTINGS, useSetting } from "../settingsStore";
import { useFlipIndicator } from "../hooks/useFlipIndicator";
import { LayoutCanvas } from "./LayoutCanvas";
import { GridLayoutBuilder } from "./GridLayoutBuilder";
import {
  BUILTIN_PRESETS,
  emptyDraft,
  makePresetId,
  presetMatchesVisibility,
  resolvePreset,
  summarizePreset,
  type LayoutPreset,
  type RegionConfig,
  type ResolvedLayout,
} from "../layouts";
import {
  CenteredLoader,
  ChoiceCards,
  CodeText,
  GhostButton,
  LinkButton,
  ModelList,
  Panel,
  Range,
  Row,
  Section,
  Segmented,
  Select,
  SettingBlock,
  SizePicker,
  StatusText,
  Stepper,
  ThemeChips,
  ThemeSwatch,
  Toggle,
} from "./settings/controls";
import { API_KEY_PROVIDERS, ApiKeyRow, ApiKeySummary, ProviderBalanceBlock } from "./settings/apiKeys";
import { CustomCliAgentsBlock, CustomEndpointsBlock } from "./settings/customProviders";
import { LocalServerRow } from "./settings/localServers";
import { AccountControl } from "./settings/accounts";
import { StatsSection } from "./settings/stats";
import {
  ArrowLeftIcon,
  BarChartIcon,
  CloudIcon,
  CodeIcon,
  GearIcon,
  GridIcon,
  KeyIcon,
  SearchIcon,
  ServerIcon,
  SparkIcon,
  SunIcon,
  TerminalIcon,
} from "./settings/icons";

type SectionId =
  | "general"
  | "appearance"
  | "layout"
  | "ai"
  | "local-ai"
  | "api"
  | "subscription"
  | "editor"
  | "terminal"
  | "stats";

type Props = {
  aiVisible: boolean;
  onAiVisibleChange: (visible: boolean) => void;
  terminalVisible: boolean;
  onTerminalVisibleChange: (visible: boolean) => void;
  // Bento layout. The user resizes panels directly in the workbench by
  // dragging their edges; the Settings sliders here are a fallback for
  // keyboard-driven / precise control. Each slider writes one rect field.
  panelLayout: { explorer?: { w: number }; ai?: { rect: { w: number } }[]; terminal?: { h: number } };
  onPanelWidthChange: (panel: "explorer" | "ai", width: number) => void;
  onPanelHeightChange: (panel: "terminal", height: number) => void;
  availableAiModels: string[];
  explorerVisible: boolean;
  onExplorerVisibleChange: (visible: boolean) => void;
  customLayouts: LayoutPreset[];
  onCustomLayoutsChange: (next: LayoutPreset[]) => void;
  onApplyLayout: (layout: ResolvedLayout) => void;
  onProviderKeyChange?: (provider: string) => void;
  initialSection?: string | null;
  onBack: () => void;
};

type SubscriptionProviderId = "claude-code" | "codex" | "opencode" | "omp" | `cli:${string}`;

type SubscriptionStatus = {
  provider: SubscriptionProviderId;
  installed: boolean;
  connected: boolean;
  detail: string;
  commandPath?: string | null;
  loginOptions: string[];
};

// The signed-in ollama.com account, read from the local daemon
// (mirrors `local_servers::OllamaAccountStatus` serde camelCase output).
type OllamaAccountStatus = {
  running: boolean;
  signedIn: boolean;
  name?: string | null;
  plan?: string | null;
  detail: string;
};

const subscriptionProviders: {
  id: SubscriptionProviderId;
  title: string;
  command: string;
  description: string;
  /** Klide can snapshot/switch saved logins for this CLI (accounts.rs). */
  accounts: boolean;
  /** One line under "Model Options" saying where the model list comes from. */
  modelNote: string;
}[] = [
  {
    id: "claude-code",
    title: "Claude Code",
    command: "claude",
    description: "Subscription login, Console login, SSO, or long-lived setup token.",
    accounts: true,
    modelNote: "Loaded from Claude Code's local model usage cache.",
  },
  {
    id: "codex",
    title: "Codex",
    command: "codex",
    description: "ChatGPT login, device auth, API key, or access token.",
    accounts: true,
    modelNote: "Loaded from the current Codex model cache when available.",
  },
  {
    id: "opencode",
    title: "OpenCode",
    command: "opencode",
    description: "Interactive OpenCode CLI, launched as a real delegate terminal.",
    accounts: true,
    modelNote: "OpenCode chooses models inside its own interactive CLI.",
  },
  {
    id: "omp",
    title: "Oh My Pi",
    command: "omp",
    description: "Terminal coding agent routing 40+ providers — keys come from your shell environment.",
    accounts: false,
    modelNote: "Loaded from omp's model cache (providers it could actually reach).",
  },
];

const sections: { id: SectionId; label: string; icon: ReactNode }[] = [
  { id: "general", label: "General", icon: <GearIcon /> },
  { id: "appearance", label: "Appearance", icon: <SunIcon /> },
  { id: "layout", label: "Layout", icon: <GridIcon /> },
  { id: "ai", label: "AI Assistant", icon: <SparkIcon /> },
  { id: "local-ai", label: "Local AI", icon: <ServerIcon /> },
  { id: "api", label: "API", icon: <KeyIcon /> },
  { id: "subscription", label: "Subscription", icon: <CloudIcon /> },
  { id: "editor", label: "Editor", icon: <CodeIcon /> },
  { id: "terminal", label: "Terminal", icon: <TerminalIcon /> },
  { id: "stats", label: "Stats", icon: <BarChartIcon /> },
];

// One orienting line per section, shown under the page title. Keeps each pane
// self-explanatory the way Linear / Vercel settings do, without a help click.
const SECTION_SUBTITLES: Record<SectionId, string> = {
  general: "Startup, files, tabs, and workbench-wide defaults.",
  appearance: "Theme and how Klide follows your system light/dark setting.",
  layout: "Panel sizes and saved workbench layout presets.",
  ai: "How the assistant edits files, runs tools, and reasons.",
  "local-ai": "Run models on-device with Ollama and MLX — no key needed.",
  api: "Hosted provider keys, stored in your macOS Keychain.",
  subscription: "Connect Claude Code, Codex, OpenCode, and Oh My Pi CLI logins — plus your ollama.com account.",
  editor: "Monaco editor preferences — font, gutter, and wrapping.",
  terminal: "The built-in shell's appearance and behaviour.",
  stats: "Token usage and cost across your agent runs.",
};

// Searchable index for the "Look for a setting" box. Each entry points at the
// section that holds it; typing surfaces the matching entries so you can jump
// straight there instead of hunting through tabs. Keywords cover the words a
// user is likely to type (synonyms included) rather than the exact label.
type SettingIndexEntry = { label: string; section: SectionId; keywords: string };
const settingsIndex: SettingIndexEntry[] = [
  { label: "Panel visibility", section: "general", keywords: "explorer sidebar terminal ai panel show hide toggle" },
  { label: "Startup", section: "general", keywords: "startup launch reopen restore last project welcome" },
  { label: "Auto-save", section: "general", keywords: "autosave auto save delay focus blur dirty unsaved" },
  { label: "Files & tabs", section: "general", keywords: "hidden files dotfiles confirm close unsaved tabs" },
  { label: "Theme", section: "appearance", keywords: "theme dark light color colour palette appearance" },
  { label: "Automatic light/dark theme", section: "appearance", keywords: "auto theme system light dark switch" },
  { label: "Panel sizes", section: "layout", keywords: "layout width height size resize panel" },
  { label: "Layout presets", section: "layout", keywords: "layout preset bento grid workbench arrange" },
  { label: "AI model", section: "ai", keywords: "ai model assistant provider default" },
  { label: "Diff review before edits", section: "ai", keywords: "diff review approve confirm edits write apply" },
  { label: "Stop after rejection", section: "ai", keywords: "stop reject rejection halt edits" },
  { label: "System prompts", section: "ai", keywords: "prompt system chat plan goal instructions" },
  { label: "Tool overrides", section: "ai", keywords: "tools tool enable disable allow override" },
  { label: "Context window", section: "ai", keywords: "context window tokens length size" },
  { label: "Effort & reflection", section: "ai", keywords: "effort budget reflection thinking reasoning" },
  { label: "Max parallel tools", section: "ai", keywords: "parallel tools concurrency simultaneous" },
  { label: "Max turns", section: "ai", keywords: "max turns loop limit iterations" },
  { label: "Command timeout", section: "ai", keywords: "command timeout shell run seconds" },
  { label: "Test after edit", section: "ai", keywords: "test verify after edit syntax check command" },
  { label: "Auto-draft memory on run done", section: "ai", keywords: "memory draft auto note handoff summarize pending review" },
  { label: "Local servers (Ollama / MLX)", section: "local-ai", keywords: "local ollama mlx server start stop concurrency model" },
  { label: "API keys", section: "api", keywords: "api key keychain anthropic openai mistral xai token secret" },
  { label: "CLI subscriptions", section: "subscription", keywords: "subscription claude code codex opencode omp oh my pi ollama signin login account auth cli" },
  { label: "Editor font size", section: "editor", keywords: "editor font size text monaco" },
  { label: "Line numbers", section: "editor", keywords: "editor line numbers gutter" },
  { label: "Word wrap", section: "editor", keywords: "editor word wrap soft" },
  { label: "Minimap", section: "editor", keywords: "editor minimap overview" },
  { label: "Terminal", section: "terminal", keywords: "terminal shell font xterm" },
  { label: "Usage & stats", section: "stats", keywords: "stats usage tokens cost transcripts runs" },
];

function matchSettings(query: string): SettingIndexEntry[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const sectionLabel = (id: SectionId) => sections.find((s) => s.id === id)?.label ?? "";
  return settingsIndex.filter((entry) => {
    const haystack = `${entry.label} ${entry.keywords} ${sectionLabel(entry.section)}`.toLowerCase();
    return tokens.every((t) => haystack.includes(t));
  });
}

function RegionEditor({
  title,
  axisHint,
  config,
  onChange,
}: {
  title: string;
  axisHint: string;
  config: RegionConfig;
  onChange: (config: RegionConfig) => void;
}) {
  return (
    <Row
      title={title}
      description={config.on ? axisHint : "Hidden in this layout."}
      control={
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {config.on && (
            <SizePicker
              label={`${title} size`}
              value={config.size}
              onChange={(size) => onChange({ ...config, size })}
            />
          )}
          <Toggle
            checked={config.on}
            onChange={(on) => onChange({ ...config, on })}
            label={`Show ${title}`}
          />
        </div>
      }
    />
  );
}

// The advisor pairing: which provider + model answers a `consult_advisor` call.
// A run's own (often cheap or local) model drives the task and escalates one
// hard decision to this stronger advisor. Local, API, and Subscription CLI
// providers are all offered: a hosted model over its wire API, or a Claude Code
// (/ Codex / OpenCode / omp) *session* run headlessly (`claude -p …`) so the
// consult uses your CLI subscription — no API key needed. Switching provider
// seeds its default model and refetches the real model list (`ai_provider_models`);
// the model is chosen from the same premium ModelPicker the AI panel uses.
function AdvisorControl({
  provider,
  model,
  onChange,
}: {
  provider: string;
  model: string;
  onChange: (next: { advisorProvider: string; advisorModel: string }) => void;
}) {
  const groups = PROVIDER_GROUPS.filter(
    (g) => g.label === "Local" || g.label === "API" || g.label === "Subscription"
  );
  // Real model list for the chosen provider (installed Ollama/MLX models, or a
  // hosted catalog), fetched the same way the AI panel does. Refetched whenever
  // the advisor provider changes so the model dropdown always reflects it.
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    invoke<string[]>("ai_provider_models", { provider })
      .then((list) => alive && setModels(list))
      .catch(() => alive && setModels([]));
    return () => {
      alive = false;
    };
  }, [provider]);
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
      <select
        aria-label="Advisor provider"
        className="klide-field"
        value={provider}
        onChange={(e) => {
          const p = e.target.value;
          onChange({ advisorProvider: p, advisorModel: DEFAULT_MODELS[p as ProviderId] ?? "" });
        }}
        style={{ height: 34, padding: "0 10px", fontSize: 12 }}
      >
        {groups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.items
              .filter((it) => it.available)
              .map((it) => (
                <option key={it.id} value={it.id}>
                  {it.name}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
      <ModelPicker
        provider={provider as ProviderId}
        model={model}
        availableModels={models}
        onChange={(m) => onChange({ advisorProvider: provider, advisorModel: m })}
      />
    </div>
  );
}

export function SettingsPanel({
  aiVisible,
  onAiVisibleChange,
  terminalVisible,
  onTerminalVisibleChange,
  panelLayout,
  onPanelWidthChange,
  onPanelHeightChange,
  availableAiModels,
  explorerVisible,
  onExplorerVisibleChange,
  customLayouts,
  onCustomLayoutsChange,
  onApplyLayout,
  onProviderKeyChange,
  initialSection,
  onBack,
}: Props) {
  // Durable settings come from the settings store, not props — App and any
  // other surface on the same setting stay in sync through it. The [value,
  // onChange] pairs keep the names the section JSX always used.
  const [theme, onThemeChange] = useSetting(SETTINGS.theme);
  const [autoTheme, onAutoThemeChange] = useSetting(SETTINGS.autoTheme);
  const [lightTheme, onLightThemeChange] = useSetting(SETTINGS.lightTheme);
  const [darkTheme, onDarkThemeChange] = useSetting(SETTINGS.darkTheme);
  const [editorFontSize, onEditorFontSizeChange] = useSetting(SETTINGS.editorFontSize);
  const [editorLineNumbers, onEditorLineNumbersChange] = useSetting(SETTINGS.editorLineNumbers);
  const [editorWordWrap, onEditorWordWrapChange] = useSetting(SETTINGS.editorWordWrap);
  const [editorMinimap, onEditorMinimapChange] = useSetting(SETTINGS.editorMinimap);
  const [aiModel, onAiModelChange] = useSetting(SETTINGS.aiModel);
  const [requireDiffReview, onRequireDiffReviewChange] = useSetting(SETTINGS.requireDiffReview);
  const [stopAfterRejection, onStopAfterRejectionChange] = useSetting(SETTINGS.stopAfterRejection);
  const [harnessSettings, onHarnessSettingsChange] = useSetting(SETTINGS.harnessSettings);
  const [restoreLastProject, onRestoreLastProjectChange] = useSetting(SETTINGS.restoreLastProject);
  const [autoSaveMode, onAutoSaveModeChange] = useSetting(SETTINGS.autoSaveMode);
  const [showHiddenFiles, onShowHiddenFilesChange] = useSetting(SETTINGS.showHiddenFiles);
  const [confirmCloseDirty, onConfirmCloseDirtyChange] = useSetting(SETTINGS.confirmCloseDirty);
  const isSectionId = (value: string | null | undefined): value is SectionId =>
    sections.some((section) => section.id === value);
  const [settingsProvider, setSettingsProvider] = useState<ProviderId>(
    () => (localStorage.getItem("klide.provider") as ProviderId) || "ollama"
  );

  const [activeSection, setActiveSection] = useState<SectionId>(
    isSectionId(initialSection) ? initialSection : "general"
  );
  // The active-section card + capsule is a single element that FLIP-slides
  // between rows on switch (same hook as the activity bar / tab underline).
  const navFlip = useFlipIndicator(activeSection, { size: 31, active: true });
  // "Look for a setting" query. While non-empty, the nav is replaced by a
  // flat list of matching settings, each labelled with its section.
  const [settingQuery, setSettingQuery] = useState("");
  const settingMatches = useMemo(() => matchSettings(settingQuery), [settingQuery]);
  // Sections that have been opened at least once. Only these mount their
  // subtree (see `Section`); the rest stay unmounted so their per-provider
  // status `invoke`s don't fire on open. The starting section is pre-seeded.
  const [visitedSections, setVisitedSections] = useState<Set<SectionId>>(
    () => new Set([isSectionId(initialSection) ? initialSection : "general"])
  );
  function goToSection(id: SectionId) {
    setVisitedSections((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    setActiveSection(id);
  }
  const [draft, setDraft] = useState(() => emptyDraft());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [subscriptionStatuses, setSubscriptionStatuses] = useState<
    Partial<Record<SubscriptionProviderId, SubscriptionStatus>>
  >({});
  const [subscriptionModels, setSubscriptionModels] = useState<
    Partial<Record<SubscriptionProviderId, string[]>>
  >({});
  const [customCliAgents, setCustomCliAgents] = useState<CustomCli[]>([]);
  const [ollamaAccount, setOllamaAccount] = useState<OllamaAccountStatus | null>(null);
  const [connectionLoading, setConnectionLoading] = useState(false);
  const [modelSupportsReflection, setModelSupportsReflection] = useState(false);

  const subscriptionProviderEntries = useMemo(
    () => [
      ...subscriptionProviders,
      ...customCliAgents.map((agent) => ({
        id: agent.id as SubscriptionProviderId,
        title: agent.label,
        command: agent.loginCommand || agent.commandTemplate,
        description: "Custom terminal coding agent, launched as a real delegate terminal.",
        accounts: false,
        modelNote: agent.models?.length
          ? "Configured manually for this custom CLI agent."
          : "Uses the default model configured for this custom CLI agent.",
      })),
    ],
    [customCliAgents]
  );

  useEffect(() => {
    let cancelled = false;
    async function checkReflectionSupport() {
      try {
        const supports = await invoke<boolean>("ai_model_supports_reflection", {
          provider: settingsProvider,
          model: aiModel,
        });
        if (!cancelled) setModelSupportsReflection(supports);
      } catch {
        if (!cancelled) setModelSupportsReflection(false);
      }
    }
    void checkReflectionSupport();
    return () => {
      cancelled = true;
    };
  }, [settingsProvider, aiModel]);

  const sectionTitle = useMemo(
    () => sections.find((section) => section.id === activeSection)?.label ?? "Settings",
    [activeSection]
  );

  const visibility = {
    explorer: explorerVisible,
    terminal: terminalVisible,
    ai: aiVisible,
  };

  function applyPreset(preset: LayoutPreset) {
    onApplyLayout(
      resolvePreset(preset, {
        width: window.innerWidth,
        height: window.innerHeight,
      })
    );
  }

  function loadIntoBuilder(preset: LayoutPreset) {
    setEditingId(preset.id);
    setDraft({
      name: preset.name,
      files: { ...preset.files },
      ai: { ...preset.ai },
      terminal: { ...preset.terminal },
    });
  }

  function resetBuilder() {
    setEditingId(null);
    setDraft(emptyDraft());
  }

  function saveDraft() {
    const name = draft.name.trim() || "Untitled layout";
    if (editingId && customLayouts.some((preset) => preset.id === editingId)) {
      onCustomLayoutsChange(
        customLayouts.map((preset) =>
          preset.id === editingId ? { ...draft, name, id: editingId } : preset
        )
      );
    } else {
      onCustomLayoutsChange([...customLayouts, { ...draft, name, id: makePresetId() }]);
    }
    resetBuilder();
  }

  function deletePreset(id: string) {
    onCustomLayoutsChange(customLayouts.filter((preset) => preset.id !== id));
    if (editingId === id) resetBuilder();
  }

  async function refreshSubscriptionConnections() {
    setConnectionLoading(true);
    const customAgents = await refreshCustomCli().catch(() => [] as CustomCli[]);
    setCustomCliAgents(customAgents);
    const providers = [
      ...subscriptionProviders,
      ...customAgents.map((agent) => ({
        id: agent.id as SubscriptionProviderId,
        title: agent.label,
        command: agent.loginCommand || agent.commandTemplate,
        description: "Custom terminal coding agent, launched as a real delegate terminal.",
        accounts: false,
        modelNote: agent.models?.length
          ? "Configured manually for this custom CLI agent."
          : "Uses the default model configured for this custom CLI agent.",
      })),
    ];
    const ollamaPromise = invoke<OllamaAccountStatus>("ollama_account_status").then(
      (status) => setOllamaAccount(status),
      () => setOllamaAccount(null)
    );
    const entries = await Promise.all(
      providers.map(async (provider) => {
        const [statusResult, modelsResult] = await Promise.allSettled([
          invoke<SubscriptionStatus>("ai_subscription_status", {
            provider: provider.id,
          }),
          invoke<string[]>("ai_provider_models", { provider: provider.id }),
        ]);
        return {
          id: provider.id,
          status:
            statusResult.status === "fulfilled"
              ? statusResult.value
              : {
                  provider: provider.id,
                  installed: false,
                  connected: false,
                  detail: String(statusResult.reason),
                  commandPath: null,
                  loginOptions: [],
                },
          models: modelsResult.status === "fulfilled" ? modelsResult.value : [],
        };
      })
    );
    setSubscriptionStatuses(
      Object.fromEntries(entries.map((entry) => [entry.id, entry.status]))
    );
    setSubscriptionModels(
      Object.fromEntries(entries.map((entry) => [entry.id, entry.models]))
    );
    await ollamaPromise;
    setConnectionLoading(false);
  }

  useEffect(() => {
    if (activeSection === "subscription") void refreshSubscriptionConnections();
  }, [activeSection]);

  return (
    <main
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "grid",
        gridTemplateColumns: "236px minmax(0, 1fr)",
        background: "var(--bg)",
      }}
    >
      <aside
        style={{
          borderRight: "1px solid var(--border)",
          background: "var(--bg-elevated)",
          padding: "16px 10px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          minHeight: 0,
        }}
      >
        <button
          type="button"
          onClick={onBack}
          style={{
            height: 36,
            padding: "0 10px",
            display: "flex",
            alignItems: "center",
            gap: 9,
            color: "var(--fg-subtle)",
            justifyContent: "flex-start",
          }}
        >
          <ArrowLeftIcon />
          Back to app
        </button>

        <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
          <span
            aria-hidden
            style={{
              position: "absolute",
              left: 9,
              display: "grid",
              placeItems: "center",
              color: "var(--fg-dim)",
              pointerEvents: "none",
            }}
          >
            <SearchIcon />
          </span>
          <input
            type="text"
            value={settingQuery}
            onChange={(e) => setSettingQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setSettingQuery("");
              if (e.key === "Enter" && settingMatches.length > 0) {
                goToSection(settingMatches[0].section);
                setSettingQuery("");
              }
            }}
            placeholder="Look for a setting…"
            aria-label="Look for a setting"
            style={{
              width: "100%",
              height: 32,
              padding: "0 26px 0 30px",
              borderRadius: 9,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--fg-strong)",
              fontSize: 12.5,
              outline: "none",
            }}
          />
          {settingQuery && (
            <button
              type="button"
              onClick={() => setSettingQuery("")}
              aria-label="Clear search"
              style={{
                position: "absolute",
                right: 6,
                width: 18,
                height: 18,
                display: "grid",
                placeItems: "center",
                borderRadius: 5,
                color: "var(--fg-dim)",
                cursor: "pointer",
              }}
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          )}
        </div>

        {settingQuery.trim() ? (
          // Search results replace the nav. Each row jumps to its section.
          <div className="klide-fade-swap" style={{ display: "flex", flexDirection: "column", gap: 3, overflow: "auto", minHeight: 0 }}>
            {settingMatches.length === 0 ? (
              <p style={{ margin: "6px 10px", fontSize: 12, color: "var(--fg-dim)" }}>
                No settings match “{settingQuery.trim()}”.
              </p>
            ) : (
              settingMatches.map((entry) => {
                const sectionLabel = sections.find((s) => s.id === entry.section)?.label ?? "";
                return (
                  <button
                    key={`${entry.section}:${entry.label}`}
                    type="button"
                    className="klide-settings-search-row"
                    onClick={() => {
                      goToSection(entry.section);
                      setSettingQuery("");
                    }}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      gap: 1,
                      padding: "6px 10px",
                      borderRadius: 9,
                      border: "1px solid transparent",
                      background: "transparent",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <span style={{ fontSize: 13, color: "var(--fg-strong)" }}>{entry.label}</span>
                    <span style={{ fontSize: 10.5, color: "var(--fg-dim)", letterSpacing: "0.02em" }}>
                      {sectionLabel}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        ) : (
        <nav
          ref={navFlip.trackRef}
          data-flip={navFlip.flip}
          className="klide-fade-swap"
          style={{ position: "relative", display: "flex", flexDirection: "column", gap: 7 }}
        >
          {/* The single moving card — slides between rows on switch. The
              capsule rides along as its child so both animate together. */}
          <span
            className="klide-flip-indicator"
            aria-hidden="true"
            style={{
              ...navFlip.style,
              left: 22,
              right: 0,
              height: 31,
              boxSizing: "border-box",
              borderRadius: 9,
              background: "var(--bg-elevated)",
              border: "1px solid var(--border)",
              boxShadow: "var(--shadow-raised)",
            }}
          >
            <span
              style={{
                position: "absolute",
                left: -15,
                top: "50%",
                transform: "translateY(-50%)",
                width: 3,
                height: 16,
                borderRadius: 3,
                background: "var(--fg-strong)",
              }}
            />
          </span>
          {sections.map((section) => {
            const active = activeSection === section.id;
            return (
              <button
                key={section.id}
                ref={navFlip.setItemRef(section.id)}
                type="button"
                className="klide-settings-nav-item"
                data-active={active}
                onClick={() => goToSection(section.id)}
                style={{
                  position: "relative",
                  zIndex: 1,
                  height: 29,
                  padding: "0 10px",
                  marginLeft: 22,
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  color: active ? "var(--fg-strong)" : "var(--fg-subtle)",
                  background: "transparent",
                  borderRadius: 9,
                  justifyContent: "flex-start",
                  fontSize: 13,
                  fontWeight: active ? 600 : 400,
                  border: "1px solid transparent",
                  cursor: "pointer",
                }}
              >
                <span style={{ width: 16, height: 16, display: "grid", placeItems: "center", flexShrink: 0 }}>
                  {section.icon}
                </span>
                {section.label}
              </button>
            );
          })}
        </nav>
        )}
      </aside>

      <div
        style={{
          overflow: "auto", minWidth: 0,
        }}
      >
        <div
          className="klide-settings-enter"
          style={{
            // Every section is ragged-left and fills the pane. A generous max
            // keeps line lengths sane on ultra-wide displays; Stats goes fully
            // edge-to-edge since its charts want all the width they can get.
            width: "100%",
            maxWidth: activeSection === "stats" ? "none" : 1280,
            margin: 0,
            padding: "32px 36px 64px",
          }}
        >
          <header style={{ margin: "0 0 32px" }}>
            <h1
              style={{
                margin: 0,
                color: "var(--fg-strong)",
                fontSize: 20,
                lineHeight: 1.2,
                fontWeight: 600,
              }}
            >
              {sectionTitle}
            </h1>
            <p
              style={{
                margin: "6px 0 0",
                color: "var(--fg-subtle)",
                fontSize: 13,
                lineHeight: 1.45,
              }}
            >
              {SECTION_SUBTITLES[activeSection]}
            </p>
          </header>

          <Section id="general" active={activeSection} mounted={visitedSections.has("general")}>
            <SettingBlock title="Startup">
              <Panel>
                <Row
                  title="Reopen last project"
                  description="Open the project you were last working in when Klide launches, instead of the welcome screen."
                  control={
                    <Toggle
                      checked={restoreLastProject}
                      onChange={onRestoreLastProjectChange}
                      label="Reopen last project"
                    />
                  }
                />
              </Panel>
            </SettingBlock>
            <SettingBlock title="Files">
              <Panel>
                <Row
                  title="Auto-save"
                  description="Save edited files after a 1-second typing pause, or when the window loses focus. Files changed on disk are never overwritten silently."
                  control={
                    <Segmented
                      label="Auto-save"
                      value={autoSaveMode}
                      options={[
                        { label: "Off", value: "off" },
                        { label: "After delay", value: "delay" },
                        { label: "On focus loss", value: "blur" },
                      ]}
                      onChange={(v) =>
                        onAutoSaveModeChange(v === "delay" || v === "blur" ? v : "off")
                      }
                    />
                  }
                />
                <Row
                  title="Show hidden files"
                  description="Show dotfiles (.env, .gitignore, .klide) in the file explorer."
                  control={
                    <Toggle
                      checked={showHiddenFiles}
                      onChange={onShowHiddenFilesChange}
                      label="Show hidden files"
                    />
                  }
                />
                <Row
                  title="Confirm before closing unsaved tabs"
                  description="Ask before a tab with unsaved changes is closed and its edits discarded."
                  control={
                    <Toggle
                      checked={confirmCloseDirty}
                      onChange={onConfirmCloseDirtyChange}
                      label="Confirm before closing unsaved tabs"
                    />
                  }
                />
              </Panel>
            </SettingBlock>
            <SettingBlock title="Panels">
              <Panel>
                <Row
                  title="Show explorer"
                  description="Display the file explorer on the left side of the workbench."
                  control={
                    <Toggle
                      checked={explorerVisible}
                      onChange={onExplorerVisibleChange}
                      label="Show explorer"
                    />
                  }
                />
                <Row
                  title="Show AI panel"
                  description="Display the assistant panel on the right side of the workbench."
                  control={
                    <Toggle
                      checked={aiVisible}
                      onChange={onAiVisibleChange}
                      label="Show AI panel"
                    />
                  }
                />
                <Row
                  title="Show terminal"
                  description="Display the built-in terminal at the bottom of the workbench."
                  control={
                    <Toggle
                      checked={terminalVisible}
                      onChange={onTerminalVisibleChange}
                      label="Show terminal"
                    />
                  }
                />
              </Panel>
            </SettingBlock>
          </Section>

          <Section id="appearance" active={activeSection} mounted={visitedSections.has("appearance")}>
              <SettingBlock title="Theme">
                <Panel>
                  <Row
                    title="Auto theme"
                    description="Follow your system's light/dark mode preference."
                    control={
                      <Toggle
                        checked={autoTheme}
                        onChange={onAutoThemeChange}
                        label="Auto theme"
                      />
                    }
                  />
                  {autoTheme ? (
                    <>
                      <Row
                        title="Light theme"
                        description="Theme used when your system is in light mode."
                        control={
                          <ThemeChips
                            label="Light theme"
                            value={lightTheme}
                            onChange={onLightThemeChange}
                            options={THEMES.filter((t) => !t.isDark).map((t) => ({
                              id: t.id,
                              name: t.name,
                              swatches: t.swatches,
                            }))}
                          />
                        }
                      />
                      <Row
                        title="Dark theme"
                        description="Theme used when your system is in dark mode."
                        control={
                          <ThemeChips
                            label="Dark theme"
                            value={darkTheme}
                            onChange={onDarkThemeChange}
                            options={THEMES.filter((t) => t.isDark).map((t) => ({
                              id: t.id,
                              name: t.name,
                              swatches: t.swatches,
                            }))}
                          />
                        }
                      />
                    </>
                  ) : (
                    <ChoiceCards
                      value={theme}
                      onChange={onThemeChange}
                      options={THEMES.map((themeOption) => ({
                        value: themeOption.id,
                        title: themeOption.name,
                        description: themeOption.description,
                        icon: <ThemeSwatch colors={themeOption.swatches} />,
                      }))}
                    />
                  )}
                </Panel>
              </SettingBlock>
              <SettingBlock title="Layout">
                <Panel>
                  <Row
                    title="Explorer width"
                    description="Width of the file explorer panel."
                    control={
                      <Range
                        label="Explorer width"
                        value={panelLayout.explorer?.w ?? 280}
                        min={200}
                        max={600}
                        onChange={(w) => onPanelWidthChange("explorer", w)}
                        suffix="px"
                      />
                    }
                  />
                  <Row
                    title="AI panel width"
                    description="Width of the assistant panel."
                    control={
                      <Range
                        label="AI panel width"
                        value={panelLayout.ai?.[0]?.rect.w ?? 360}
                        min={280}
                        max={720}
                        onChange={(w) => onPanelWidthChange("ai", w)}
                        suffix="px"
                      />
                    }
                  />
                </Panel>
              </SettingBlock>
          </Section>

          <Section id="layout" active={activeSection} mounted={visitedSections.has("layout")}>
              <SettingBlock title="Presets">
                <Panel>
                  {[...BUILTIN_PRESETS, ...customLayouts].map((preset) => {
                    const active = presetMatchesVisibility(preset, visibility);
                    return (
                      <div
                        key={preset.id}
                        style={{
                          minHeight: 64,
                          padding: "14px 18px",
                          borderBottom: "1px solid var(--border)",
                          display: "grid",
                          gridTemplateColumns: "minmax(0, 1fr) auto",
                          alignItems: "center",
                          gap: 16,
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              color: "var(--fg-strong)",
                              fontSize: 14,
                              marginBottom: 4,
                            }}
                          >
                            {preset.name}
                            {preset.builtin ? (
                              <span style={{ color: "var(--fg-subtle)", fontSize: 11 }}>
                                Built-in
                              </span>
                            ) : null}
                            {active ? (
                              <span style={{ color: "var(--accent)", fontSize: 11 }}>
                                · Active
                              </span>
                            ) : null}
                          </div>
                          <div
                            style={{
                              color: "var(--fg-subtle)",
                              fontSize: 13,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {summarizePreset(preset)}
                          </div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          {!preset.builtin && (
                            <>
                              <GhostButton onClick={() => loadIntoBuilder(preset)}>
                                Edit
                              </GhostButton>
                              <GhostButton onClick={() => deletePreset(preset.id)}>
                                Delete
                              </GhostButton>
                            </>
                          )}
                          <button
                            type="button"
                            onClick={() => applyPreset(preset)}
                            className="klide-button klide-button-secondary"
                            style={{
                              height: 32,
                              padding: "0 14px",
                            }}
                          >
                            Apply
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </Panel>
              </SettingBlock>

              <SettingBlock title={editingId ? "Edit layout" : "Build a layout"}>
                <Panel>
                  <Row
                    title="Name"
                    description="What you'll call this layout in the picker."
                    control={
                      <input
                        aria-label="Layout name"
                        value={draft.name}
                        placeholder="e.g. Review"
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                        className="klide-field"
                        style={{
                          minWidth: 220,
                          height: 34,
                          padding: "0 12px",
                        }}
                      />
                    }
                  />
                  <div style={{ borderBottom: "1px solid var(--border)" }}>
                    <LayoutCanvas
                      files={draft.files}
                      ai={draft.ai}
                      terminal={draft.terminal}
                      onFilesChange={(files) => setDraft((d) => ({ ...d, files }))}
                      onAiChange={(ai) => setDraft((d) => ({ ...d, ai }))}
                      onTerminalChange={(terminal) =>
                        setDraft((d) => ({ ...d, terminal }))
                      }
                    />
                  </div>
                  <RegionEditor
                    title="Files"
                    axisHint="Left strip, full height — choose its width."
                    config={draft.files}
                    onChange={(files) => setDraft({ ...draft, files })}
                  />
                  <RegionEditor
                    title="AI"
                    axisHint="Right strip, full height — choose its width."
                    config={draft.ai}
                    onChange={(ai) => setDraft({ ...draft, ai })}
                  />
                  <RegionEditor
                    title="Terminal"
                    axisHint="Bottom strip, full width — choose its height."
                    config={draft.terminal}
                    onChange={(terminal) => setDraft({ ...draft, terminal })}
                  />
                  <div
                    style={{
                      padding: "16px 18px",
                      display: "flex",
                      justifyContent: "flex-end",
                      gap: 10,
                    }}
                  >
                    {editingId && (
                      <GhostButton onClick={resetBuilder}>Cancel</GhostButton>
                    )}
                    <button
                      type="button"
                      onClick={saveDraft}
                      className="klide-button klide-button-primary"
                      style={{
                        height: 34,
                        padding: "0 16px",
                      }}
                    >
                      {editingId ? "Save changes" : "Save layout"}
                    </button>
                  </div>
                </Panel>
              </SettingBlock>

              <SettingBlock title="Workspace grid">
                <div
                  style={{
                    marginBottom: 12,
                    fontSize: 13,
                    lineHeight: 1.45,
                    color: "var(--fg-subtle)",
                  }}
                >
                  Drag predefined shapes onto a blank grid to build a freeform
                  layout — place several AI panels, Git, the terminal, anything,
                  and control height with the rows. Designer + preview for now;
                  driving the live workbench is the next step.
                </div>
                <Panel>
                  <GridLayoutBuilder />
                </Panel>
              </SettingBlock>
          </Section>

          <Section id="ai" active={activeSection} mounted={visitedSections.has("ai")}>
              <SettingBlock title="Provider">
                <Panel>
                  {PROVIDER_GROUPS.map((group, groupIdx) => (
                    <div
                      key={group.label}
                      style={{
                        borderBottom: groupIdx < PROVIDER_GROUPS.length - 1 ? "1px solid var(--border)" : "none",
                        paddingBottom: 2,
                      }}
                    >
                      <div style={{ padding: "12px 18px 5px", fontSize: 11, fontWeight: 700, letterSpacing: 0, color: "var(--fg-dim)" }}>
                        {group.label}
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 7, padding: "4px 14px 14px" }}>
                        {group.items.map((p) => {
                          const isActive = settingsProvider === p.id;
                          return (
                            <button
                              key={p.id}
                              disabled={!p.available}
                              onClick={() => {
                                setSettingsProvider(p.id);
                                localStorage.setItem("klide.provider", p.id);
                              }}
                              className="klide-button"
                              style={{
                                justifyContent: "flex-start",
                                minHeight: 32,
                                padding: "0 9px",
                                border: `1px solid ${isActive ? "color-mix(in srgb, var(--accent) 42%, var(--border))" : "transparent"}`,
                                background: isActive ? "var(--accent-soft)" : "var(--bg-hover)",
                                color: isActive ? "var(--accent)" : !p.available ? "var(--fg-dim)" : "var(--fg-strong)",
                                cursor: p.available ? "pointer" : "not-allowed",
                                opacity: p.available ? 1 : 0.46,
                                fontSize: 12.5,
                                textAlign: "left",
                                boxShadow: isActive ? "inset 0 1px 0 var(--panel-highlight)" : "none",
                              }}
                            >
                              <ProviderLogo id={p.id} size={13} />
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {p.name}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </Panel>
              </SettingBlock>
              <SettingBlock title="Model">
                <Panel>
                  <Row
                    title="AI model"
                    description="Model used by the active provider for chat and agent runs."
                    control={
                      <Select
                        value={aiModel}
                        onChange={onAiModelChange}
                        options={availableAiModels.length > 0 ? availableAiModels : [aiModel]}
                        label="AI model"
                      />
                    }
                  />
                </Panel>
              </SettingBlock>
              <SettingBlock title="Inference">
                <Panel>
                  <Row
                    title="Context window"
                    description={`How much room ${aiModel} gets for the active conversation. Auto lets Klide choose a stable working window up to the model's detected limit; choose a smaller cap when memory matters. Ollama only.`}
                    control={
                      <Segmented
                        label="Context window"
                        value={harnessSettings?.contextWindows?.[aiModel]}
                        options={[
                          { label: "Auto", value: undefined },
                          { label: "8K", value: 8192 },
                          { label: "16K", value: 16384 },
                          { label: "32K", value: 32768 },
                          { label: "64K", value: 65536 },
                          { label: "128K", value: 131072 },
                        ]}
                        onChange={(v) => {
                          const next = { ...(harnessSettings?.contextWindows ?? {}) };
                          if (v === undefined) delete next[aiModel];
                          else next[aiModel] = Number(v);
                          onHarnessSettingsChange?.({ ...harnessSettings, contextWindows: next });
                        }}
                      />
                    }
                  />
                  <Row
                    title="Effort"
                    description={`How much reply budget ${aiModel} gets per turn. Higher effort gives the model more room to reason and explain, but it can be slower and uses more of the window. Ollama only.`}
                    control={
                      <Segmented
                        label="Effort"
                        value={harnessSettings?.effortBudgets?.[aiModel]}
                        options={[
                          { label: "Auto", value: undefined },
                          { label: "Quick", value: 1024 },
                          { label: "Balanced", value: 4096 },
                          { label: "Deep", value: 8192 },
                        ]}
                        onChange={(v) => {
                          const next = { ...(harnessSettings?.effortBudgets ?? {}) };
                          if (v === undefined) delete next[aiModel];
                          else next[aiModel] = Number(v);
                          onHarnessSettingsChange?.({ ...harnessSettings, effortBudgets: next });
                        }}
                      />
                    }
                  />
                  <Row
                    title="Reflection"
                    description={
                      modelSupportsReflection
                        ? `How much internal thinking ${aiModel} is allowed before answering. Auto keeps the provider default; higher levels ask supported models for deeper reflection.`
                        : `${aiModel} does not advertise a thinking capability, so Klide leaves reflection off for this model.`
                    }
                    control={
                      <Segmented
                        label="Reflection"
                        disabled={!modelSupportsReflection}
                        value={modelSupportsReflection ? harnessSettings?.reflectionLevels?.[aiModel] : undefined}
	                        options={[
	                          { label: "Auto", value: undefined },
	                          { label: "minimal", value: "minimal" },
	                          { label: "low", value: "low" },
	                          { label: "medium", value: "medium" },
	                          { label: "high", value: "high" },
	                          { label: "xhigh", value: "xhigh" },
	                        ]}
                        onChange={(v) => {
                          if (!modelSupportsReflection) return;
                          const next = { ...(harnessSettings?.reflectionLevels ?? {}) };
                          if (v === undefined) delete next[aiModel];
                          else next[aiModel] = String(v);
                          onHarnessSettingsChange?.({ ...harnessSettings, reflectionLevels: next });
                        }}
                      />
                    }
                  />
                  <Row
                    title="Parallel tool calls"
                    description="When the agent asks for several read-only tools in one step, run them at once instead of one-by-one. File edits always stay sequential for diff review."
                    control={
                      <Segmented
                        label="Parallel tool calls"
                        value={harnessSettings?.maxParallelTools}
                        options={[
                          { label: "Off", value: undefined },
                          { label: "2", value: 2 },
                          { label: "4", value: 4 },
                          { label: "8", value: 8 },
                        ]}
                        onChange={(v) =>
                          onHarnessSettingsChange?.({ ...harnessSettings, maxParallelTools: v === undefined ? undefined : Number(v) })
                        }
                      />
                    }
                  />
                  <Row
                    title="Max tool turns"
                    description="How many tool rounds the agent runs before handing back to you — a runaway-loop guard, not a task limit. Raise it for big multi-file or multi-agent work. You can always continue past it by sending another message. Default 50."
                    control={
                      <Segmented
                        label="Max tool turns"
                        value={harnessSettings?.maxTurns}
                        options={[
                          { label: "Default", value: undefined },
                          { label: "50", value: 50 },
                          { label: "100", value: 100 },
                          { label: "250", value: 250 },
                          { label: "500", value: 500 },
                        ]}
                        onChange={(v) =>
                          onHarnessSettingsChange?.({ ...harnessSettings, maxTurns: v === undefined ? undefined : Number(v) })
                        }
                      />
                    }
                  />
                  <Row
                    title="Command timeout"
                    description="How long an agent-run shell command (run_command) may run before it's killed — a hang guard against dev servers / watch tasks / prompts. Raise it for slow builds. Default 180s."
                    control={
                      <Segmented
                        label="Command timeout"
                        value={harnessSettings?.commandTimeoutSecs}
                        options={[
                          { label: "Default", value: undefined },
                          { label: "60s", value: 60 },
                          { label: "180s", value: 180 },
                          { label: "300s", value: 300 },
                          { label: "600s", value: 600 },
                        ]}
                        onChange={(v) =>
                          onHarnessSettingsChange?.({ ...harnessSettings, commandTimeoutSecs: v === undefined ? undefined : Number(v) })
                        }
                      />
                    }
                  />
                  <Row
                    title="Test after edit"
                    description="Optional command Klide runs after an accepted file edit or create. Leave empty to rely on the built-in Rust/JSON syntax check only."
                    control={
                      <input
                        aria-label="Test after edit command"
                        value={harnessSettings?.testAfterEditCommand ?? ""}
                        placeholder="e.g. npm test"
                        onChange={(e) =>
                          onHarnessSettingsChange?.({
                            ...harnessSettings,
                            testAfterEditCommand: e.target.value || undefined,
                          })
                        }
                        className="klide-field"
                        style={{
                          minWidth: 260,
                          height: 34,
                          padding: "0 12px",
                          fontFamily: "var(--font-mono)",
                          fontSize: 12,
                        }}
                      />
                    }
                  />
                  <Row
                    title="Concurrent requests"
                    description="How many requests a Klide-launched Ollama serves at once — raise it to run several AI panels in parallel. Restart the local server to apply."
                    control={
                      <Segmented
                        label="Concurrent requests"
                        value={harnessSettings?.serverConcurrency}
                        options={[
                          { label: "Default", value: undefined },
                          { label: "2", value: 2 },
                          { label: "4", value: 4 },
                        ]}
                        onChange={(v) =>
                          onHarnessSettingsChange?.({ ...harnessSettings, serverConcurrency: v === undefined ? undefined : Number(v) })
                        }
                      />
                    }
                  />
                </Panel>
              </SettingBlock>
              <SettingBlock title="Agent Editing">
                <Panel>
                  <Row
                    title="Require diff review"
                    description="When enabled, file edits open an apply/reject modal before writing."
                    control={
                      <Toggle
                        checked={requireDiffReview}
                        onChange={onRequireDiffReviewChange}
                        label="Require diff review"
                      />
                    }
                  />
                  <Row
                    title="Stop after rejection"
                    description="Tell the assistant to stop after you reject a proposed edit."
                    control={
                      <Toggle
                        checked={stopAfterRejection}
                        onChange={onStopAfterRejectionChange}
                        label="Stop after rejection"
                      />
                    }
                  />
                </Panel>
              </SettingBlock>
              <SettingBlock title="Harness">
                <Panel>
                  {/* Tools per mode — one toggle chip per tool. Enabled chips
                      carry the accent tint + check; disabled ones are quiet and
                      hidden from the model entirely. */}
                  <div style={{ padding: "16px 18px", borderBottom: "1px solid var(--border)" }}>
                    <div className="klide-row-title" style={{ marginBottom: 3 }}>Tools per mode</div>
                    <p style={{ margin: "0 0 14px", color: "var(--fg-subtle)", fontSize: 12.5, lineHeight: 1.45 }}>
                      Choose which tools each run mode can call. Disabled tools are hidden from the model entirely.
                    </p>
                    {(["plan", "goal"] as const).map((mode, idx) => (
                      <div key={mode} style={{ marginBottom: idx === 0 ? 16 : 0 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0, color: "var(--fg-dim)", marginBottom: 8 }}>
                          {mode.charAt(0).toUpperCase() + mode.slice(1)} mode
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                          {(["read_file","list_dir","glob","grep","get_git_status","get_git_diff","clean_context","web_search","web_fetch","write_file","create_file","create_skill"] as const).map((tool) => {
                            const key = `${mode}.${tool}`;
                            const enabled = (harnessSettings?.toolOverrides ?? {})[key] !== false;
                            return (
                              <button
                                key={tool}
                                type="button"
                                aria-pressed={enabled}
                                onClick={() => {
                                  const next = { ...(harnessSettings?.toolOverrides ?? {}), [key]: !enabled };
                                  onHarnessSettingsChange?.({ ...harnessSettings, toolOverrides: next });
                                }}
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: 6,
                                  height: 27,
                                  padding: "0 8px",
                                  borderRadius: "var(--radius-sm)",
                                  border: "none",
                                  background: "transparent",
                                  color: enabled ? "var(--fg-strong)" : "var(--fg-dim)",
                                  fontSize: 11.5,
                                  fontWeight: enabled ? 600 : 500,
                                  fontFamily: "var(--font-mono)",
                                  cursor: "pointer",
                                  transition: "background 0.12s ease, color 0.12s ease",
                                }}
                                onMouseEnter={(e) => {
                                  e.currentTarget.style.background = "var(--bg-hover)";
                                }}
                                onMouseLeave={(e) => {
                                  e.currentTarget.style.background = "transparent";
                                }}
                              >
                                <span aria-hidden style={{ display: "grid", placeItems: "center", width: 11, height: 11, flexShrink: 0 }}>
                                  {enabled && (
                                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                                      <path d="M2.5 6.2l2.3 2.3 4.7-5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                                    </svg>
                                  )}
                                </span>
                                {tool}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Advisor pairing — which model a consult_advisor call escalates to */}
                  <Row
                    title="Advisor model"
                    description="Which model answers a consult_advisor call. A run's own (often cheap or local) model drives the task and escalates a hard decision to this stronger advisor — it returns guidance, not a takeover. Available in Plan and Goal."
                    control={
                      <AdvisorControl
                        provider={harnessSettings?.advisorProvider ?? DEFAULT_ADVISOR_PROVIDER}
                        model={harnessSettings?.advisorModel ?? DEFAULT_ADVISOR_MODEL}
                        onChange={(next) => onHarnessSettingsChange?.({ ...harnessSettings, ...next })}
                      />
                    }
                  />

                  {/* Memory drafting */}
                  <Row
                    title="Auto-draft memory on run done"
                    description="When a Klide agent run finishes cleanly, generate a Project Memory note from the conversation and park it as a draft to review (accept / edit / skip) in the Memory modal before it becomes durable. The Summarize header action still writes directly."
                    control={
                      <Toggle
                        checked={harnessSettings?.autoMemoryOnRunDone !== false}
                        onChange={(v) => onHarnessSettingsChange?.({ ...harnessSettings, autoMemoryOnRunDone: v ? undefined : false })}
                        label="Auto-draft memory on run done"
                      />
                    }
                  />

                  {/* System prompts per mode */}
                  <div style={{ padding: "16px 18px" }}>
                    <div className="klide-row-title" style={{ marginBottom: 3 }}>System prompts</div>
                    <p style={{ margin: "0 0 14px", color: "var(--fg-subtle)", fontSize: 12.5, lineHeight: 1.45 }}>
                      Override the system prompt per mode. Leave blank to use the built-in defaults.
                    </p>
                    {(["chat", "plan", "goal"] as const).map((mode, idx) => (
                      <div key={mode} style={{ marginBottom: idx === 2 ? 0 : 14 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0, color: "var(--fg-dim)", marginBottom: 7 }}>
                          {mode.charAt(0).toUpperCase() + mode.slice(1)} mode
                        </div>
                        <textarea
                          value={(harnessSettings as any)?.[`${mode}Prompt`] ?? ""}
                          onChange={(e) => {
                            const next = { ...harnessSettings, [`${mode}Prompt`]: e.target.value || undefined };
                            onHarnessSettingsChange?.(next);
                          }}
                          placeholder={`Use default ${mode} prompt`}
                          rows={3}
                          className="klide-field"
                          style={{
                            width: "100%",
                            resize: "vertical",
                            fontSize: 11.5,
                            fontFamily: "var(--font-mono)",
                            padding: "7px 9px",
                            outline: "none",
                            lineHeight: 1.5,
                            minHeight: 60,
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </Panel>
              </SettingBlock>
              <SettingBlock title="Connections">
                <Panel>
                  <Row
                    title="API providers"
                    description="OpenAI, Mistral, and xAI keys are read by the Tauri backend."
                    control={
                      <LinkButton onClick={() => goToSection("api")}>
                        Open API
                      </LinkButton>
                    }
                  />
                  <Row
                    title="Subscription providers"
                    description="Claude Code and Codex use your local CLI login."
                    control={
                      <LinkButton onClick={() => goToSection("subscription")}>
                        Open Subscription
                      </LinkButton>
                    }
                  />
                </Panel>
              </SettingBlock>
          </Section>

          <Section id="local-ai" active={activeSection} mounted={visitedSections.has("local-ai")}>
              <SettingBlock title="Local Servers">
                <Panel>
                  <LocalServerRow provider="ollama" title="Ollama" defaultModel="llama3.1:8b" />
                  <LocalServerRow provider="mlx" title="MLX" defaultModel="mlx-community/Llama-3.1-8B-Instruct-4bit" />
                </Panel>
              </SettingBlock>
              <SettingBlock title="Notes">
                <Panel>
                  <Row
                    title="Managed by Klide"
                    description="Klide can start and stop the server process. If the server is already running externally, it will be detected and left alone."
                    control={<CodeText>Process</CodeText>}
                  />
                  <Row
                    title="MLX default model"
                    description="The Start button uses the default model. Change the active model in the AI panel dropdown after the server is running."
                    control={<CodeText>Model</CodeText>}
                  />
                </Panel>
              </SettingBlock>
          </Section>

          <Section id="api" active={activeSection} mounted={visitedSections.has("api")}>
              <SettingBlock title="API Keys">
                <ApiKeySummary />
                <Panel>
                  {API_KEY_PROVIDERS.map((provider) => (
                    <ApiKeyRow
                      key={provider.id}
                      id={provider.id}
                      title={provider.title}
                      envVar={provider.envVar}
                      placeholder={provider.placeholder}
                      onChange={onProviderKeyChange}
                    />
                  ))}
                </Panel>
              </SettingBlock>
              <SettingBlock title="Balance">
                <ProviderBalanceBlock />
              </SettingBlock>
              <SettingBlock title="Self-hosted endpoints">
                <CustomEndpointsBlock onProviderKeyChange={onProviderKeyChange} />
              </SettingBlock>
              <SettingBlock title="Notes">
                <Panel>
                  <Row
                    title="Secret boundary"
                    description="Keys are stored in the OS keychain and read only by Rust — they never enter the React webview."
                    control={<CodeText>src-tauri</CodeText>}
                  />
                  <Row
                    title="Tool support"
                    description="These providers support chat and tool calls over the OpenAI-compatible API."
                    control={<CodeText>Build</CodeText>}
                  />
                </Panel>
              </SettingBlock>
          </Section>

          <Section id="subscription" active={activeSection} mounted={visitedSections.has("subscription")}>
            {connectionLoading && Object.keys(subscriptionStatuses).length === 0 ? (
              <CenteredLoader label="Checking subscriptions…" />
            ) : (
              <>
              <SettingBlock title="Connections & Accounts">
                <Panel>
                  {subscriptionProviderEntries.map((provider) => {
                    const status = subscriptionStatuses[provider.id];
                    return (
                      <Row
                        key={provider.id}
                        title={provider.title}
                        description={status?.detail || provider.description}
                        control={
                          provider.accounts ? (
                            <AccountControl
                              provider={provider.id}
                              title={provider.title}
                              connected={!!status?.connected}
                            />
                          ) : (
                            <StatusText tone={status?.connected ? "ok" : "idle"}>
                              {status?.connected ? "Ready" : "Not installed"}
                            </StatusText>
                          )
                        }
                        leading={<ProviderLogo id={provider.id as ProviderId} />}
                      />
                    );
                  })}
                  <Row
                    title="Ollama"
                    description={
                      ollamaAccount?.detail ??
                      "Sign in to ollama.com for cloud models and model pushes."
                    }
                    control={
                      <StatusText
                        tone={
                          ollamaAccount?.signedIn ? "ok" : ollamaAccount?.running ? "warn" : "idle"
                        }
                      >
                        {ollamaAccount?.signedIn
                          ? ollamaAccount.name ?? "Signed in"
                          : ollamaAccount?.running
                          ? "Not signed in"
                          : "Server offline"}
                      </StatusText>
                    }
                    leading={<ProviderLogo id={"ollama" as ProviderId} />}
                  />
                </Panel>
              </SettingBlock>
              <SettingBlock title="Connection Options">
                <Panel>
                  {subscriptionProviderEntries.map((provider) => {
                    const status = subscriptionStatuses[provider.id];
                    const options = status?.loginOptions.length
                      ? status.loginOptions
                      : provider.id.startsWith("cli:")
                      ? [provider.command]
                      : [`${provider.command} login`];
                    return (
                      <Row
                        key={provider.id}
                        title={provider.title}
                        description={
                          status?.commandPath
                            ? `CLI path: ${status.commandPath}`
                            : provider.description
                        }
                        control={<ModelList models={options} />}
                        leading={<ProviderLogo id={provider.id as ProviderId} />}
                      />
                    );
                  })}
                  <Row
                    title="Ollama"
                    description="Sign in opens a browser; sign out clears the local session."
                    control={<ModelList models={["ollama signin", "ollama signout"]} />}
                    leading={<ProviderLogo id={"ollama" as ProviderId} />}
                  />
                </Panel>
              </SettingBlock>
              <SettingBlock title="Model Options">
                <Panel>
                  {subscriptionProviderEntries.map((provider) => {
                    const models = subscriptionModels[provider.id] ?? [];
                    return (
                      <Row
                        key={provider.id}
                        title={provider.title}
                        description={provider.modelNote}
                        control={
                          models.length > 0 ? (
                            <ModelList models={models} max={8} />
                          ) : (
                            <StatusText tone="idle">Unavailable</StatusText>
                          )
                        }
                        leading={<ProviderLogo id={provider.id as ProviderId} />}
                      />
                    );
                  })}
                </Panel>
              </SettingBlock>
              <SettingBlock title="Custom CLI agents">
                <CustomCliAgentsBlock onChange={setCustomCliAgents} />
              </SettingBlock>
              <SettingBlock title="Mode">
                <Panel>
                  <Row
                    title="Read-only bridge"
                    description="Subscription CLIs can answer with your logged-in account without bypassing Klide diff review."
                    control={<CodeText>Plan</CodeText>}
                  />
                  <Row
                    title="Refresh status"
                    description="Re-check CLI installation, login state, and cached model options."
                    control={
                      <LinkButton onClick={() => void refreshSubscriptionConnections()}>
                        {connectionLoading ? "Checking..." : "Refresh"}
                      </LinkButton>
                    }
                  />
                </Panel>
              </SettingBlock>
              </>
            )}
          </Section>

          <Section id="editor" active={activeSection} mounted={visitedSections.has("editor")}>
            <SettingBlock title="Editor">
              <Panel>
                <Row
                  title="Font size"
                  description="Preferred code editor text size."
                  control={
                    <Stepper
                      label="Editor font size"
                      value={editorFontSize}
                      min={11}
                      max={20}
                      onChange={onEditorFontSizeChange}
                      suffix="px"
                    />
                  }
                />
                <Row
                  title="Line numbers"
                  description="Show line numbers in the editor gutter."
                  control={
                    <Toggle
                      checked={editorLineNumbers}
                      onChange={onEditorLineNumbersChange}
                      label="Line numbers"
                    />
                  }
                />
                <Row
                  title="Word wrap"
                  description="Wrap long lines instead of scrolling horizontally."
                  control={
                    <Toggle
                      checked={editorWordWrap}
                      onChange={onEditorWordWrapChange}
                      label="Word wrap"
                    />
                  }
                />
                <Row
                  title="Minimap"
                  description="Show a compact file preview on the right side of the editor."
                  control={
                    <Toggle
                      checked={editorMinimap}
                      onChange={onEditorMinimapChange}
                      label="Minimap"
                    />
                  }
                />
              </Panel>
            </SettingBlock>
          </Section>

          <Section id="terminal" active={activeSection} mounted={visitedSections.has("terminal")}>
            <SettingBlock title="Terminal">
              <Panel>
                <Row
                  title="Show terminal"
                  description="Display the built-in PTY panel at the bottom of the workbench."
                  control={
                    <Toggle
                      checked={terminalVisible}
                      onChange={onTerminalVisibleChange}
                      label="Show terminal"
                    />
                  }
                />
                <Row
                  title="Terminal height"
                  description="Height of the bottom terminal panel."
                  control={
                    <Range
                      label="Terminal height"
                      value={panelLayout.terminal?.h ?? 240}
                      min={120}
                      max={900}
                      onChange={(h) => onPanelHeightChange("terminal", h)}
                      suffix="px"
                    />
                  }
                />
              </Panel>
            </SettingBlock>
          </Section>
          {activeSection === "stats" && (
            <Section id="stats" active={activeSection}>
              <StatsSection />
            </Section>
          )}
        </div>
      </div>
    </main>
  );
}

// ── Stats ────────────────────────────────────────────────────────────
// Global usage stats across every agent source Klide knows about (its own
// runs + Claude Code, Codex, OpenCode session logs on disk). Two graphs:
// a GitHub-style activity heatmap and a provider/model breakdown, both
// switchable between conversation counts and real token usage.
