import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { FromOtherApps } from "./settings/fromOtherApps";
import { invoke } from "@tauri-apps/api/core";
import {
  listProviderModels,
  modelReflectionLevels as queryModelReflectionLevels,
  readProviderContextWindow,
} from "../ipc/aiProviders";
import {
  contextCapOptions,
  contextSizeLabel,
  providerHasContextWindowSetting,
} from "./ai/contextWindow";
import { sortReflectionLevels } from "../reflectionLevels";
import { THEMES } from "../theme";
import { ProviderLogo } from "./ai/icons";
import { HermesSetup } from "./settings/HermesSetup";
import { PROVIDER_DOCS } from "../agent/providerResources";
import { openExternal } from "../externalLink";
import type { AgentMode, ProviderId } from "../agent/types";
import { toolCatalog, type ToolCatalogEntry } from "../agent/tools";
import { PROVIDER_GROUPS, DEFAULT_MODELS } from "../agent/providers";
import { ModelPicker } from "./ai/ModelPicker";
import { DEFAULT_ADVISOR_PROVIDER, DEFAULT_ADVISOR_MODEL } from "../agent/advisor";
import { refreshCustomCli, type CustomCli } from "../customCli";
import { SETTINGS, settingsSearchIndex, useSetting, type SettingsSectionId } from "../settingsStore";
import { SETTINGS_PAGES, defaultSettingsPage, settingsPageForSearch, settingsSearchTarget } from "../settingsPages";
import { findSettingsSearchTarget, revealSettingsSearchTarget } from "./settings/searchReveal";
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
import { WelcomeFilmCards } from "./settings/welcomeFilm";
import { API_KEY_PROVIDERS, ApiKeyIntro, ApiKeyRow, ProviderBalanceBlock } from "./settings/apiKeys";
import { notify } from "../toast";
import { playSound } from "../sound";
import { CustomCliAgentsBlock, CustomEndpointsBlock } from "./settings/customProviders";
import { ConnectorsSection } from "./settings/connectors";
import { GatewayBlock } from "./settings/gateway";
import { LocalServerRow } from "./settings/localServers";
import { AccountControl, GitHubAccountRow } from "./settings/accounts";
import { DELEGATES, type DelegateId } from "../delegates";
import { CliVersionsBlock } from "./settings/cliVersions";
import { StatsSection } from "./settings/stats";
import { StorageSection } from "./settings/storage";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  BarChartIcon,
  CloudIcon,
  ChevronRightIcon,
  CodeIcon,
  GearIcon,
  GridIcon,
  KeyIcon,
  PlugIcon,
  SearchIcon,
  ServerIcon,
  SparkIcon,
  SunIcon,
  TerminalIcon,
} from "./settings/icons";

// The section vocabulary lives in the settings store so SettingDefs can name
// their section without importing this component.
type SectionId = SettingsSectionId;

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
  explorerFloating: boolean;
  onExplorerFloatingChange: (floating: boolean) => void;
  customLayouts: LayoutPreset[];
  onCustomLayoutsChange: (next: LayoutPreset[]) => void;
  onApplyLayout: (layout: ResolvedLayout) => void;
  onProviderKeyChange?: (provider: string) => void;
  initialSection?: string | null;
  /** The open project. Connectors reads it to offer this repo's own
   *  `.mcp.json`; every other section is workspace-independent. */
  workspaceRoot: string | null;
  onBack: () => void;
};

type SubscriptionProviderId = DelegateId | `cli:${string}`;

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

type SubscriptionProviderRow = {
  id: SubscriptionProviderId;
  title: string;
  command: string;
  description: string;
  /** Klide can snapshot/switch saved logins for this CLI (accounts.rs). */
  accounts: boolean;
  /** One line under "Model Options" saying where the model list comes from. */
  modelNote: string;
};

/** The prose this page adds to each Delegate — the facts (name, binary,
 *  accounts) come from the catalog, never restated here. */
const DELEGATE_COPY: Record<DelegateId, { description: string; modelNote: string }> = {
  "claude-code": {
    description: "Subscription login, Console login, SSO, or long-lived setup token.",
    modelNote: "Loaded from Claude Code's local model usage cache.",
  },
  codex: {
    description: "ChatGPT login, device auth, API key, or access token.",
    modelNote: "Loaded from the current Codex model cache when available.",
  },
  opencode: {
    description: "Interactive OpenCode CLI, launched as a real delegate terminal.",
    modelNote: "OpenCode chooses models inside its own interactive CLI.",
  },
  omp: {
    description: "Terminal coding agent routing 40+ providers — keys come from your shell environment.",
    modelNote: "Loaded from omp's model cache (providers it could actually reach).",
  },
  amp: {
    description: "Coding agent with model routing managed by Amp. Sign in with amp login.",
    modelNote: "Amp selects its own models; Klide uses the CLI default.",
  },
  cursor: {
    description: "Cursor Agent CLI. Sign in with cursor-agent login.",
    modelNote: "Uses the CLI default model; model overrides follow Cursor's model names.",
  },
  factory: {
    description: "Factory's Droid CLI. Run droid to sign in.",
    modelNote: "Uses Droid's configured default model.",
  },
  copilot: {
    description: "GitHub Copilot CLI on your Copilot plan. Sign in with copilot login.",
    modelNote: "Uses Copilot's default model; overrides follow Copilot's model names.",
  },
  hermes: {
    description: "Nous Research's Hermes agent. Configure credentials with hermes setup.",
    modelNote: "Uses Hermes's configured provider and model.",
  },
};

const subscriptionProviders: SubscriptionProviderRow[] = DELEGATES.map((d) => ({
  id: d.id,
  title: d.label,
  command: d.binary,
  accounts: d.supportsAccounts,
  ...DELEGATE_COPY[d.id],
}));

const sections: { id: SectionId; label: string; icon: ReactNode }[] = [
  { id: "general", label: "General", icon: <GearIcon /> },
  { id: "appearance", label: "Appearance", icon: <SunIcon /> },
  { id: "layout", label: "Layout", icon: <GridIcon /> },
  { id: "ai", label: "AI Assistant", icon: <SparkIcon /> },
  { id: "local-ai", label: "Local AI", icon: <ServerIcon /> },
  { id: "api", label: "API", icon: <KeyIcon /> },
  { id: "connectors", label: "Connectors", icon: <PlugIcon /> },
  { id: "subscription", label: "Subscription", icon: <CloudIcon /> },
  { id: "editor", label: "Editor", icon: <CodeIcon /> },
  { id: "terminal", label: "Terminal", icon: <TerminalIcon /> },
  { id: "stats", label: "Stats", icon: <BarChartIcon /> },
  { id: "storage", label: "Storage", icon: <ArchiveIcon /> },
];

// One orienting line per section, shown under the page title. Keeps each pane
// self-explanatory the way Linear / Vercel settings do, without a help click.
const SECTION_SUBTITLES: Record<SectionId, string> = {
  general: "Startup, files, tabs, and workbench-wide defaults.",
  appearance: "Theme, how Klide follows your system light/dark setting, and how a conversation is laid out.",
  layout: "Panel sizes and saved workbench layout presets.",
  ai: "How the assistant edits files, runs tools, and reasons.",
  "local-ai": "Run models on-device with Ollama and MLX — no key needed.",
  api: "Hosted provider keys, the opencodex gateway, and self-hosted endpoints.",
  connectors: "MCP servers Klide connects to — import the ones your other tools already use.",
  subscription: "Connect Claude Code, Codex, OpenCode, and Oh My Pi CLI logins — plus your ollama.com account.",
  editor: "Monaco editor preferences — font, gutter, and wrapping.",
  terminal: "The built-in shell's appearance and behaviour.",
  stats: "Token usage and cost across your agent runs.",
  storage: "Manage saved conversations, disk usage, the local cache and your transcript folder.",
};

// Searchable index for the "Look for a setting" box. Each entry points at the
// section that holds it; typing surfaces the matching entries so you can jump
// straight there instead of hunting through tabs.
//
// Store-backed settings derive their rows from the SETTINGS catalog
// (`search` on each SettingDef), so the index cannot drift from what the
// store actually holds. Only things that are NOT persisted settings — panel
// toggles, key managers, whole panes — stay in the hand list below.
type SettingIndexEntry = { label: string; section: SectionId; keywords: string };
const panelOnlyIndex: SettingIndexEntry[] = [
  { label: "Ask Kit from any app", section: "general", keywords: "services menu right click selection ask kit quick action raycast shortcuts deep link klide:// url scheme" },
  { label: "Panel visibility", section: "general", keywords: "explorer sidebar terminal ai panel show hide toggle" },
  { label: "Panel sizes", section: "layout", keywords: "layout width height size resize panel" },
  { label: "Layout presets", section: "layout", keywords: "layout preset bento grid workbench arrange" },
  { label: "Local servers (Ollama / MLX)", section: "local-ai", keywords: "local ollama mlx server start stop concurrency model" },
  { label: "API keys", section: "api", keywords: "api key keychain anthropic openai mistral xai deepseek openrouter token secret" },
  { label: "Provider gateway (opencodex)", section: "api", keywords: "gateway opencodex ocx proxy oauth subscription route provider bridge localhost 10100" },
  { label: "Connectors (MCP servers)", section: "connectors", keywords: "connector mcp server model context protocol tool linear notion figma playwright stdio npx import claude codex opencode" },
  { label: "CLI subscriptions", section: "subscription", keywords: "subscription claude code codex opencode omp oh my pi ollama signin login account auth cli" },
  { label: "GitHub account", section: "subscription", keywords: "github account gh avatar profile picture identity work personal switch pin push pr" },
  { label: "Terminal", section: "terminal", keywords: "terminal shell font xterm" },
  { label: "Usage & stats", section: "stats", keywords: "stats usage tokens cost transcripts runs" },
  { label: "Saved conversations & disk usage", section: "storage", keywords: "storage cache quota full history conversations size photos images delete clear folder path transcripts runs disk localstorage reveal finder" },
];
// Merged and shown in section order, so derived and hand rows interleave the
// way the section rail reads.
const sectionRank = new Map(sections.map((s, i) => [s.id, i]));
const subpageIndex: SettingIndexEntry[] = sections.flatMap((section) =>
  (SETTINGS_PAGES[section.id] ?? []).map((page) => ({
    label: page.label, section: section.id, keywords: "",
  }))
);
const settingsIndex: SettingIndexEntry[] = [...settingsSearchIndex(), ...panelOnlyIndex, ...subpageIndex]
  .filter((entry, index, entries) => entries.findIndex((other) => other.section === entry.section && other.label === entry.label) === index).sort(
  (a, b) => (sectionRank.get(a.section) ?? 99) - (sectionRank.get(b.section) ?? 99)
);

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
const TOOL_TOGGLE_MODES: AgentMode[] = ["chat", "plan", "goal"];

/** Each mode's built-in Tools, from the registry — the toggles offer exactly
 *  what a run in that mode can call. */
function useToolCatalogs(): Partial<Record<AgentMode, ToolCatalogEntry[]>> {
  const [catalogs, setCatalogs] = useState<Partial<Record<AgentMode, ToolCatalogEntry[]>>>({});
  useEffect(() => {
    let cancelled = false;
    void Promise.all(TOOL_TOGGLE_MODES.map(async (mode) => [mode, await toolCatalog(mode)] as const)).then(
      (entries) => {
        if (!cancelled) setCatalogs(Object.fromEntries(entries));
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return catalogs;
}

function AdvisorControl({
  provider,
  model,
  onChange,
}: {
  provider: string;
  model: string;
  onChange: (next: { advisorProvider: string; advisorModel: string }) => void;
}) {
  return (
    <ModelPairControl
      label="Advisor"
      provider={provider}
      model={model}
      groups={["Local", "API", "Subscription"]}
      onChange={(p, m) => onChange({ advisorProvider: p, advisorModel: m })}
    />
  );
}

// One provider + model pairing, as Settings rows pick them: a provider select
// over the picker's groups and the same ModelPicker the AI panel uses. With
// `automatic`, an empty provider is a real choice — "let Klide decide" — and
// the model picker steps aside.
function ModelPairControl({
  label,
  provider,
  model,
  groups: groupLabels,
  automatic,
  onChange,
}: {
  label: string;
  provider: string;
  model: string;
  groups: string[];
  /** The caption of the empty choice, when there is one. */
  automatic?: string;
  onChange: (provider: string, model: string) => void;
}) {
  const groups = PROVIDER_GROUPS.filter((g) => groupLabels.includes(g.label));
  // Real model list for the chosen provider (installed Ollama/MLX models, or a
  // hosted catalog), fetched the same way the AI panel does. Refetched whenever
  // the advisor provider changes so the model dropdown always reflects it.
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    if (!provider) {
      setModels([]);
      return;
    }
    listProviderModels(provider)
      .then((list) => alive && setModels(list))
      .catch(() => alive && setModels([]));
    return () => {
      alive = false;
    };
  }, [provider]);
  return (
    <div className="klide-settings-model-pair" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
      <select
        aria-label={`${label} provider`}
        className="klide-field klide-settings-provider-select"
        value={provider}
        onChange={(e) => {
          const p = e.target.value;
          onChange(p, p ? DEFAULT_MODELS[p as ProviderId] ?? "" : "");
        }}
      >
        {automatic && <option value="">{automatic}</option>}
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
      {provider && (
        <div className="klide-settings-model-choice">
          <span aria-hidden="true"><ProviderLogo id={provider as ProviderId} size={16} /></span>
          <ModelPicker
            provider={provider as ProviderId}
            model={model}
            availableModels={models}
            direction="down"
            fluid
            onChange={(m) => onChange(provider, m)}
          />
        </div>
      )}
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
  explorerFloating,
  onExplorerFloatingChange,
  customLayouts,
  onCustomLayoutsChange,
  onApplyLayout,
  onProviderKeyChange,
  initialSection,
  workspaceRoot,
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
  const [uiSounds, onUiSoundsChange] = useSetting(SETTINGS.uiSounds);
  const [agentSounds, onAgentSoundsChange] = useSetting(SETTINGS.agentSounds);
  const [soundVolume, onSoundVolumeChange] = useSetting(SETTINGS.soundVolume);
  const [autoSaveMode, onAutoSaveModeChange] = useSetting(SETTINGS.autoSaveMode);
  const [openFilesIn, onOpenFilesInChange] = useSetting(SETTINGS.openFilesIn);
  const [showHiddenFiles, onShowHiddenFilesChange] = useSetting(SETTINGS.showHiddenFiles);
  const [confirmCloseDirty, onConfirmCloseDirtyChange] = useSetting(SETTINGS.confirmCloseDirty);
  const [showAskerAvatar, onShowAskerAvatarChange] = useSetting(SETTINGS.showAskerAvatar);
  const [welcomeFilm, onWelcomeFilmChange] = useSetting(SETTINGS.welcomeFilm);
  const isSectionId = (value: string | null | undefined): value is SectionId =>
    sections.some((section) => section.id === value);
  const toolCatalogs = useToolCatalogs();
  const [settingsProvider, setSettingsProvider] = useState<ProviderId>(
    () => (localStorage.getItem("klide.provider") as ProviderId) || "ollama"
  );

  const [activeSection, setActiveSection] = useState<SectionId>(
    isSectionId(initialSection) ? initialSection : "general"
  );
  const [selectedPages, setSelectedPages] = useState<Partial<Record<SectionId, string>>>({});
  const activePage = selectedPages[activeSection] ?? defaultSettingsPage(activeSection);
  const [visitedPages, setVisitedPages] = useState<Set<string>>(
    () => new Set([defaultSettingsPage(isSectionId(initialSection) ? initialSection : "general")])
  );
  const contentScroller = useRef<HTMLDivElement>(null);
  const pageContent = useRef<HTMLDivElement>(null);
  // Animate the existing pane rather than remounting it: drafts, focus and
  // provider controls survive navigation. A rapid switch cancels the old fade.
  useLayoutEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
        document.documentElement.hasAttribute("data-motion-still")) return;
    const animation = pageContent.current?.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: 220, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
    );
    return () => animation?.cancel();
  }, [activeSection, activePage]);
  function goToPage(section: SectionId, page = selectedPages[section] ?? defaultSettingsPage(section)) {
    setSelectedPages((prev) => ({ ...prev, [section]: page }));
    setVisitedPages((prev) => prev.has(page) ? prev : new Set(prev).add(page));
    goToSection(section, page);
  }
  // "Look for a setting" query. While non-empty, the nav is replaced by a
  // flat list of matching settings, each labelled with its section.
  const [settingQuery, setSettingQuery] = useState("");
  const settingMatches = useMemo(() => matchSettings(settingQuery), [settingQuery]);
  const [searchReveal, setSearchReveal] = useState<{ name: string | null } | null>(null);
  function openSearchResult(entry: SettingIndexEntry) {
    goToPage(entry.section, settingsPageForSearch(entry.section, entry.label));
    setSearchReveal({ name: settingsSearchTarget(entry.section, entry.label, settingQuery) });
    setSettingQuery("");
  }
  useEffect(() => {
    if (!searchReveal) return;
    const content = pageContent.current;
    const scroller = contentScroller.current;
    if (!content || !scroller) return;
    let clearHighlight: (() => void) | undefined;
    // Subscription rows can arrive after the page's connection check.
    const reveal = () => {
      const target = findSettingsSearchTarget(content, searchReveal.name);
      if (!target) return false;
      clearHighlight = revealSettingsSearchTarget(scroller, target);
      return true;
    };
    if (reveal()) return () => clearHighlight?.();
    const observer = new MutationObserver(() => {
      if (reveal()) observer.disconnect();
    });
    observer.observe(content, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      clearHighlight?.();
    };
  }, [searchReveal]);
  // Sections that have been opened at least once. Only these mount their
  // subtree (see `Section`); the rest stay unmounted so their per-provider
  // status `invoke`s don't fire on open. The starting section is pre-seeded.
  const [visitedSections, setVisitedSections] = useState<Set<SectionId>>(
    () => new Set([isSectionId(initialSection) ? initialSection : "general"])
  );
  function goToSection(id: SectionId, page = selectedPages[id] ?? defaultSettingsPage(id)) {
    setSearchReveal(null);
    setVisitedSections((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    setVisitedPages((prev) => prev.has(page) ? prev : new Set(prev).add(page));
    setActiveSection(id);
    contentScroller.current?.scrollTo({ top: 0 });
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
  // The efforts this provider+model accepts, weakest first (empty = no dial).
  // A Codex model publishes its own set, so the rows are built from it rather
  // than from a fixed list that would offer levels the CLI rejects.
  const [reflectionLevels, setReflectionLevels] = useState<string[]>([]);
  const modelSupportsReflection = reflectionLevels.length > 0;
  // The window this model is trained to — bounds the Ollama cap picker, and
  // is the read-only fact shown for every other provider. 0 until detected.
  const [detectedWindow, setDetectedWindow] = useState(0);

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
        const levels = await queryModelReflectionLevels(settingsProvider, aiModel);
        if (!cancelled) setReflectionLevels(sortReflectionLevels(levels));
      } catch {
        if (!cancelled) setReflectionLevels([]);
      }
    }
    void checkReflectionSupport();
    setDetectedWindow(0);
    readProviderContextWindow(settingsProvider, aiModel)
      .then((window) => {
        if (!cancelled && window !== null && window > 0) setDetectedWindow(window);
      })
      .catch(() => {
        /* unreachable model: the row says so */
      });
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
    goToPage("layout", "layout-builder");
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
    goToPage("layout", "layout-presets");
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
          listProviderModels(provider.id),
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
        gridTemplateColumns: "248px minmax(0, 1fr)",
        background: "var(--bg-elevated)",
      }}
    >
      <aside
        // The sidebar runs to the window's top edge, so its surface is what the
        // traffic lights sit on — and it pays for that band in its own padding.
        data-tauri-drag-region
        style={{
          borderRight: "1px solid color-mix(in srgb, var(--border) 55%, transparent)",
          background: "var(--bg)",
          padding: "calc(16px + var(--titlebar-h)) 10px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          minHeight: 0,
          overflowY: "auto",
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
                openSearchResult(settingMatches[0]);
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
                    onClick={() => openSearchResult(entry)}
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
          className="klide-fade-swap klide-settings-nav"
          aria-label="Settings"
          style={{ position: "relative", display: "flex", flexDirection: "column", gap: 7, flexShrink: 0, paddingBottom: 2 }}
        >
          {sections.map((section) => {
            const active = activeSection === section.id;
            return (
              <div key={section.id} style={{ position: "relative" }}>
              <button
                type="button"
                className="klide-settings-nav-item"
                data-sound="tap"
                data-active={active}
                onClick={() => goToPage(section.id)}
                aria-current={active && !SETTINGS_PAGES[section.id] ? "page" : undefined}
                aria-expanded={SETTINGS_PAGES[section.id] ? active : undefined}
                aria-controls={SETTINGS_PAGES[section.id] ? `settings-subpages-${section.id}` : undefined}
                style={{
                  position: "relative",
                  zIndex: 1,
                  height: 29,
                  padding: "0 10px",
                  marginLeft: 22,
                  width: "calc(100% - 22px)",
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  color: active ? "var(--fg-strong)" : "var(--fg-subtle)",
                  background: active ? "var(--bg-hover)" : "transparent",
                  borderRadius: 9,
                  justifyContent: "flex-start",
                  fontSize: 14,
                  fontWeight: active ? 600 : 400,
                  border: "1px solid",
                  borderColor: "transparent",
                  cursor: "pointer",
                }}
              >
                <span style={{ width: 16, height: 16, display: "grid", placeItems: "center", flexShrink: 0 }}>
                  {section.icon}
                </span>
                <span style={{ flex: 1, textAlign: "left" }}>{section.label}</span>
                {SETTINGS_PAGES[section.id] && <span aria-hidden="true" className="klide-settings-chevron"><ChevronRightIcon /></span>}
              </button>
              {SETTINGS_PAGES[section.id] && (
                <div id={`settings-subpages-${section.id}`}
                  className="klide-settings-subpages-reveal" data-open={active}
                  inert={!active} aria-hidden={!active}>
                <div className="klide-settings-subpages-clip">
                <div className="klide-settings-subpages">
                  {SETTINGS_PAGES[section.id]!.map((page) => (
                    <button key={page.id} type="button"
                      className="klide-settings-subpage" data-sound="tap"
                      aria-current={activePage === page.id ? "page" : undefined}
                      onClick={() => goToPage(section.id, page.id)}>
                      <span>{page.label}</span>
                    </button>
                  ))}
                </div>
                </div>
                </div>
              )}
              </div>
            );
          })}
        </nav>
        )}
      </aside>

      <div
        // The band is reserved outside the scroller, so sections scroll under
        // nothing and the drag strip stays draggable.
        data-tauri-drag-region
        style={{
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          paddingTop: "var(--titlebar-h)",
        }}
      >
      <div
        ref={contentScroller}
        style={{
          overflow: "auto", minWidth: 0,
        }}
      >
        <div
          ref={pageContent}
          className="klide-settings-content"
          style={{
            // Center a readable column within the main pane. Stats uses the
            // available width so its charts have room to breathe.
            width: "100%",
            maxWidth: activeSection === "stats" ? "none" : 960,
            margin: "0 auto",
          }}
        >
          <header className="klide-settings-page-header">
            <div>
              {SETTINGS_PAGES[activeSection] && <div className="klide-settings-breadcrumb">{sectionTitle}</div>}
              <h1 tabIndex={-1}>
                {SETTINGS_PAGES[activeSection]?.find((page) => page.id === activePage)?.label ?? sectionTitle}
              </h1>
              <p>{SECTION_SUBTITLES[activeSection]}</p>
            </div>
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
            <SettingBlock title="Sounds">
              <Panel>
                <Row
                  title="Interaction sounds"
                  description="The familiar soft tap when you move, and a small pluck when you send a prompt."
                  control={
                    <Toggle checked={uiSounds} onChange={onUiSoundsChange} label="Interaction sounds" />
                  }
                />
                <Row
                  title="Agent notifications"
                  description="Quiet cues for approval, completion and failure when you are away from the conversation."
                  control={<Toggle checked={agentSounds} onChange={onAgentSoundsChange} label="Agent notifications" />}
                />
                <Row
                  title="Sound volume"
                  description="Applies to interaction sounds, notifications and previews."
                  control={<Range value={soundVolume} min={0} max={100} onChange={onSoundVolumeChange} suffix="%" label="Sound volume" />}
                />
                <Row title="Preview sounds" description="Listen at the current volume, even with a category switched off." control={
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    <GhostButton onClick={() => playSound("tap", true)}>Tap</GhostButton>
                    <GhostButton onClick={() => playSound("send", true)}>Send</GhostButton>
                    <GhostButton onClick={() => playSound("complete", true)}>Complete</GhostButton>
                    <GhostButton onClick={() => playSound("attention", true)}>Needs you</GhostButton>
                    <GhostButton onClick={() => playSound("failure", true)}>Failure</GhostButton>
                  </div>
                } />
              </Panel>
            </SettingBlock>
            <SettingBlock title="From other apps">
              <FromOtherApps />
            </SettingBlock>
            <SettingBlock title="Files">
              <Panel>
                <Row
                  title="Auto-save"
                  description="Save after a 1-second pause or when the window loses focus."
                  help="Files changed on disk are never overwritten silently."
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
                  title="Open files in"
                  description="Where a file opens from Git Review's diff: the classic IDE layout, or free mode's floating panels."
                  control={
                    <Segmented
                      label="Open files in"
                      value={openFilesIn}
                      options={[
                        { label: "Classic IDE", value: "anchored" },
                        { label: "Free mode", value: "free" },
                      ]}
                      onChange={(v) => onOpenFilesInChange(v === "free" ? "free" : "anchored")}
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
                  title="Floating explorer"
                  description="In the free layout, let the explorer float as a draggable panel instead of docking beside the activity bar."
                  control={
                    <Toggle
                      checked={explorerFloating}
                      onChange={onExplorerFloatingChange}
                      label="Floating explorer"
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
                        controlLayout="wide"
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
                        controlLayout="wide"
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
              <SettingBlock title="Conversation">
                <Panel>
                  <Row
                    title="Your profile picture"
                    description="Show your picture beside your own messages, so a thread reads as two participants."
                    control={
                      <Toggle
                        checked={showAskerAvatar}
                        onChange={onShowAskerAvatarChange}
                        label="Your profile picture"
                      />
                    }
                  />
                </Panel>
              </SettingBlock>
              <SettingBlock title="Welcome">
                <Panel>
                  <WelcomeFilmCards value={welcomeFilm} onChange={onWelcomeFilmChange} />
                </Panel>
              </SettingBlock>

          </Section>

          <Section id="layout" active={activeSection} mounted={visitedSections.has("layout")}>
              <Section id="layout-presets" active={activePage} mounted={visitedPages.has("layout-presets")}>
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

              </Section>
              <Section id="layout-builder" active={activePage} mounted={visitedPages.has("layout-builder")}>
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

              </Section>
              <Section id="layout-grid" active={activePage} mounted={visitedPages.has("layout-grid")}>
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
              <Section id="layout-sizes" active={activePage} mounted={visitedPages.has("layout-sizes")}>
              <SettingBlock title="Panel sizes">
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
          </Section>

          <Section id="ai" active={activeSection} mounted={visitedSections.has("ai")}>
              <Section id="ai-model" active={activePage} mounted={visitedPages.has("ai-model")}>
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
                              <ProviderLogo id={p.id} size={24} />
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
                      <div className="klide-settings-model-choice">
                      <span aria-hidden="true"><ProviderLogo id={settingsProvider} size={16} /></span>
                      <Select
                        value={aiModel}
                        onChange={onAiModelChange}
                        options={availableAiModels.length > 0 ? availableAiModels : [aiModel]}
                        label="AI model"
                      />
                      </div>
                    }
                  />
                </Panel>
              </SettingBlock>
              </Section>
              <Section id="ai-inference" active={activePage} mounted={visitedPages.has("ai-inference")}>
              <SettingBlock title="Inference">
                <Panel>
                  {providerHasContextWindowSetting(settingsProvider) ? (
                    <Row
                      title="Context window"
                      description="Conversation capacity. Auto grows as needed; a cap limits memory use."
                      help={
                        detectedWindow > 0
                          ? `${aiModel} is trained to ${contextSizeLabel(detectedWindow)}. Auto starts at a ${contextSizeLabel(Math.min(32_768, detectedWindow))} working window and grows with the conversation up to that; a cap holds it lower when memory matters. Sent to Ollama as num_ctx.`
                          : `How much room ${aiModel} gets for a conversation. Auto starts at a 32K working window and grows with the conversation up to the model's trained limit; a cap holds it lower when memory matters.`
                      }
                      control={
                        <Segmented
                          label="Context window"
                          value={harnessSettings?.contextWindows?.[aiModel]}
                          options={contextCapOptions(detectedWindow).map(({ label, value }) => ({ label, value }))}
                          onChange={(v) => {
                            const next = { ...(harnessSettings?.contextWindows ?? {}) };
                            if (v === undefined) delete next[aiModel];
                            else next[aiModel] = Number(v);
                            onHarnessSettingsChange?.({ ...harnessSettings, contextWindows: next });
                          }}
                        />
                      }
                    />
                  ) : (
                    <Row
                      title="Context window"
                      description="Set by the provider. Klide tracks usage against the model’s limit."
                      help={
                        detectedWindow > 0
                          ? `${aiModel}'s window is a property of the model, not a setting: the provider serves ${contextSizeLabel(detectedWindow)} and no request can ask for less. Klide tracks usage against it.`
                          : `A hosted or self-hosted model's window is set by the provider, not by Klide. Klide tracks usage against the advertised size once the model is reachable.`
                      }
                      control={
                        <span
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontSize: 12,
                            color: "var(--fg-subtle)",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {detectedWindow > 0 ? contextSizeLabel(detectedWindow) : "—"}
                        </span>
                      }
                    />
                  )}
                  <Row
                    title="Effort"
                    description="Reply budget per turn. Higher effort is slower and uses more context. Ollama only."
                    help={`Controls how many tokens ${aiModel} can use to reason and answer. Auto keeps the default budget.`}
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
                          ...reflectionLevels.map((level) => ({ label: level, value: level })),
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
                </Panel>
              </SettingBlock>
              </Section>
              <Section id="ai-execution" active={activePage} mounted={visitedPages.has("ai-execution")}>
              <SettingBlock title="Tool execution">
                <Panel>
                  <Row
                    title="Parallel tool calls"
                    description="Run read-only tools in parallel. File edits stay sequential for review."
                    help="Applies when the assistant requests several read-only tools in the same step."
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
                    description="Tool rounds before the assistant pauses. Default: 50."
                    help="Raise the limit for larger tasks. This guards against runaway loops; send another message to continue after the limit."
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
                    description="Time allowed for each shell command. Default: 180 seconds."
                    help="Commands still running after the limit are stopped. Increase it for slow builds; commands that wait for input or run continuously may reach the limit."
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
                    description="Optional test command to run after an accepted file change."
                    help="Leave empty to use only the built-in Rust and JSON syntax checks."
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
                    description="Simultaneous Ollama requests. Restart the local server to apply."
                    help="Increase this to use several AI panels at once. Applies to Ollama servers launched by Klide."
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
              </Section>
              <Section id="ai-harness" active={activePage} mounted={visitedPages.has("ai-harness")}>
              <SettingBlock title="Tools per mode">
                <Panel>
                  {/* Tools per mode — one toggle chip per tool. Enabled chips
                      carry the accent tint + check; disabled ones are quiet and
                      hidden from the model entirely. */}
                  <div style={{ padding: "16px 18px", borderBottom: "1px solid var(--border)" }}>
                    <div className="klide-row-title" style={{ marginBottom: 3 }}>Tools per mode</div>
                    <p style={{ margin: "0 0 14px", color: "var(--fg-subtle)", fontSize: 12.5, lineHeight: 1.45 }}>
                      Choose which tools each run mode can call. Disabled tools are hidden from the model entirely.
                    </p>
                    {TOOL_TOGGLE_MODES.map((mode, idx) => (
                      <div key={mode} style={{ marginBottom: idx < TOOL_TOGGLE_MODES.length - 1 ? 16 : 0 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0, color: "var(--fg-dim)", marginBottom: 8 }}>
                          {mode.charAt(0).toUpperCase() + mode.slice(1)} mode
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                          {(toolCatalogs[mode] ?? []).map(({ name: tool }) => {
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

                </Panel>
              </SettingBlock>
              </Section>
              <Section id="ai-automation" active={activePage} mounted={visitedPages.has("ai-automation")}>
              <SettingBlock title="Assistant models & memory">
                <Panel>
                  {/* Advisor pairing — which model a consult_advisor call escalates to */}
                  <Row
                    title="Advisor model"
                    description="Model consulted for difficult decisions in Plan and Goal modes."
                    help="The assistant continues to run the task. The advisor answers consult_advisor calls with guidance."
                    control={
                      <AdvisorControl
                        provider={harnessSettings?.advisorProvider ?? DEFAULT_ADVISOR_PROVIDER}
                        model={harnessSettings?.advisorModel ?? DEFAULT_ADVISOR_MODEL}
                        onChange={(next) => onHarnessSettingsChange?.({ ...harnessSettings, ...next })}
                      />
                    }
                  />

                  {/* Eyes — who describes a photo for a model that cannot see one */}
                  <Row
                    title="Eyes model (OCR)"
                    description="Reads images for models without vision. Automatic tries a local model first."
                    help="Automatic falls back to a hosted model you have a key for. Local processing keeps the image on this machine. Images are described once per turn before sending, and the conversation identifies the model used. Subscription CLIs are not supported."
                    control={
                      <ModelPairControl
                        label="Eyes"
                        provider={harnessSettings?.eyesProvider ?? ""}
                        model={harnessSettings?.eyesModel ?? ""}
                        groups={["Local", "API"]}
                        automatic="Automatic — local first, then hosted"
                        onChange={(p, m) => onHarnessSettingsChange?.({ ...harnessSettings, eyesProvider: p || undefined, eyesModel: m || undefined })}
                      />
                    }
                  />

                  {/* Conversation names — the rail row takes a name beside the first turn */}
                  <Row
                    title="Name conversations"
                    description="Automatically name new conversations. Names you type are kept."
                    help="Uses one short model request after the first turn. The name appears in the sidebar when ready."
                    control={
                      <Toggle
                        checked={harnessSettings?.nameConversations !== false}
                        onChange={(v) => onHarnessSettingsChange?.({ ...harnessSettings, nameConversations: v ? undefined : false })}
                        label="Name conversations"
                      />
                    }
                  />
                  <Row
                    title="Naming model"
                    description="Model used for conversation names. Local conversations are named locally."
                    help="Automatic uses a low-cost model from the conversation’s provider when a key is available, then another provider with a saved key. Subscription CLIs use their routed provider, another saved key, or the local default."
                    control={
                      <ModelPairControl
                        label="Naming"
                        provider={harnessSettings?.namingProvider ?? ""}
                        model={harnessSettings?.namingModel ?? ""}
                        groups={["Local", "API"]}
                        automatic="Automatic — the thread's own provider, light"
                        onChange={(p, m) => onHarnessSettingsChange?.({ ...harnessSettings, namingProvider: p || undefined, namingModel: m || undefined })}
                      />
                    }
                  />

                  {/* Memory drafting */}
                  <Row
                    title="Auto-draft memory on run done"
                    description="Draft a memory note after a successful run. Review it before saving."
                    help="Accept, edit, or skip the draft in Project Memory. The Summarize action in the header still saves directly."
                    control={
                      <Toggle
                        checked={harnessSettings?.autoMemoryOnRunDone !== false}
                        onChange={(v) => onHarnessSettingsChange?.({ ...harnessSettings, autoMemoryOnRunDone: v ? undefined : false })}
                        label="Auto-draft memory on run done"
                      />
                    }
                  />

                </Panel>
              </SettingBlock>
              </Section>
              <Section id="ai-prompts" active={activePage} mounted={visitedPages.has("ai-prompts")}>
              <SettingBlock title="System prompts">
                <Panel>
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
              </Section>
              <Section id="ai-sessions" active={activePage} mounted={visitedPages.has("ai-sessions")}>
              <SettingBlock title="Delegate sessions">
                <Panel>
                  <DelegateDaemonRow />
                </Panel>
              </SettingBlock>
              <SettingBlock title="Connections">
                <Panel>
                  <Row
                    title="API providers"
                    description="OpenAI, Mistral, xAI, and DeepSeek keys are read by the Tauri backend."
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
          </Section>

          <Section id="local-ai" active={activeSection} mounted={visitedSections.has("local-ai")}>
              <SettingBlock title="Local Servers">
                <Panel>
                  <LocalServerRow provider="ollama" />
                  <LocalServerRow provider="mlx" />
                  <LocalServerRow provider="llamacpp" />
                </Panel>
              </SettingBlock>
              <SettingBlock title="Notes">
                <Panel>
                  <Row
                    title="Managed by Klide"
                    description="Start and stop local servers from Klide."
                    help="Servers already running outside Klide are detected and left running."
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
              <Section id="api-keys" active={activePage} mounted={visitedPages.has("api-keys")}>
              <section className="klide-settings-section">
                <ApiKeyIntro />
                <Panel>
                  {API_KEY_PROVIDERS.map((provider) => (
                    <ApiKeyRow
                      key={provider.id}
                      id={provider.id}
                      title={provider.title}
                      envVar={provider.envVar}
                      placeholder={provider.placeholder}
                      workspaceRoot={workspaceRoot}
                      onChange={onProviderKeyChange}
                    />
                  ))}
                </Panel>
              </section>
              <SettingBlock title="Documentation">
                <Panel>
                  <Row title="DeepSeek" description="Official API setup and reference."
                    leading={<ProviderLogo id="deepseek" size={28} />}
                    control={<LinkButton onClick={() => void openExternal(PROVIDER_DOCS.deepseek)}>Open docs</LinkButton>}
                  />
                </Panel>
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
              <Section id="api-balance" active={activePage} mounted={visitedPages.has("api-balance")}>
              <SettingBlock title="Balance">
                <ProviderBalanceBlock />
              </SettingBlock>
              </Section>
              <Section id="api-gateway" active={activePage} mounted={visitedPages.has("api-gateway")}>
              <SettingBlock title="Provider gateway">
                <GatewayBlock />
              </SettingBlock>
              </Section>
              <Section id="api-endpoints" active={activePage} mounted={visitedPages.has("api-endpoints")}>
              <SettingBlock title="Self-hosted endpoints">
                <CustomEndpointsBlock onProviderKeyChange={onProviderKeyChange} />
              </SettingBlock>

              </Section>
          </Section>

          <Section
            id="connectors"
            active={activeSection}
            mounted={visitedSections.has("connectors")}
          >
            <ConnectorsSection workspaceRoot={workspaceRoot} />
          </Section>

          <Section id="subscription" active={activeSection} mounted={visitedSections.has("subscription")}>
            {connectionLoading && Object.keys(subscriptionStatuses).length === 0 ? (
              <CenteredLoader label="Checking subscriptions…" />
            ) : (
              <>
              <Section id="subscription-accounts" active={activePage} mounted={visitedPages.has("subscription-accounts")}>
              <SettingBlock title="Connections & Accounts">
                <Panel>
                  {/* GitHub first: it's the identity the whole app wears —
                      avatar, PR author, push credentials. */}
                  <GitHubAccountRow />
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
                        leading={<ProviderLogo id={provider.id as ProviderId} size={28} />}
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
                    leading={<ProviderLogo id={"ollama" as ProviderId} size={28} />}
                  />
                </Panel>
              </SettingBlock>
              </Section>
              <Section id="subscription-setup" active={activePage} mounted={visitedPages.has("subscription-setup")}>
              <SettingBlock title="Documentation">
                <Panel>
                  {subscriptionProviderEntries.filter((provider) => PROVIDER_DOCS[provider.id]).map((provider) => (
                    <Row key={provider.id} title={provider.title}
                      description="Official installation and CLI documentation."
                      leading={<ProviderLogo id={provider.id as ProviderId} size={28} />}
                      control={<LinkButton onClick={() => void openExternal(PROVIDER_DOCS[provider.id])}>Open docs</LinkButton>}
                    />
                  ))}
                </Panel>
              </SettingBlock>
              <HermesSetup />
              <CliVersionsBlock />
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
                        leading={<ProviderLogo id={provider.id as ProviderId} size={28} />}
                      />
                    );
                  })}
                  <Row
                    title="Ollama"
                    description="Sign in opens a browser; sign out clears the local session."
                    control={<ModelList models={["ollama signin", "ollama signout"]} />}
                    leading={<ProviderLogo id={"ollama" as ProviderId} size={28} />}
                  />
                </Panel>
              </SettingBlock>
              </Section>
              <Section id="subscription-models" active={activePage} mounted={visitedPages.has("subscription-models")}>
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
                        leading={<ProviderLogo id={provider.id as ProviderId} size={28} />}
                      />
                    );
                  })}
                </Panel>
              </SettingBlock>
              </Section>
              <Section id="subscription-custom" active={activePage} mounted={visitedPages.has("subscription-custom")}>
              <SettingBlock title="Custom CLI agents">
                <CustomCliAgentsBlock onChange={setCustomCliAgents} />
              </SettingBlock>
              </Section>
              <Section id="subscription-mode" active={activePage} mounted={visitedPages.has("subscription-mode")}>
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
              </Section>
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
          {activeSection === "storage" && (
            <Section id="storage" active={activeSection}>
              <StorageSection />
            </Section>
          )}
        </div>
      </div>
      </div>
    </main>
  );
}

// ── Delegate session daemon ──────────────────────────────────────────
// Toggle for the detached `klide ptyd` host (docs/delegate-session-replay.md
// Slice 3): with it on, delegate CLIs run outside the app process and survive
// an app restart — quit Klide mid-run, reopen, and the session is still in
// the Live strip. Self-contained: reads/writes the Rust-side config directly
// rather than threading through harness settings, because the flag must be
// known before the frontend loads.

type DaemonStatus = {
  enabled: boolean;
  reachable: boolean;
  version: string | null;
  liveSessions: number;
};

function DelegateDaemonRow() {
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    invoke<DaemonStatus>("delegate_daemon_status")
      .then(setStatus)
      .catch(() => setStatus(null));
  };
  useEffect(refresh, []);

  const detail = !status
    ? ""
    : !status.enabled
      ? ""
      : !status.reachable
        ? "Daemon not running — it starts with the next delegate session."
        : status.liveSessions > 0
          ? `Daemon running · ${status.liveSessions} live session${status.liveSessions === 1 ? "" : "s"}`
          : "Daemon running";

  return (
    <Row
      title="Persistent delegate sessions"
      help="Claude Code, Codex, OpenCode, and Oh My Pi run in a background process. Reopen Klide to return to their sessions."
      description={
        "Keep delegate agents running when Klide quits. Experimental." +
        (detail ? ` ${detail}` : "")
      }
      control={
        <Toggle
          checked={status?.enabled ?? false}
          onChange={(next: boolean) => {
            if (busy) return;
            setBusy(true);
            invoke("delegate_daemon_set_enabled", { enabled: next })
              .then(() => {
                notify(next ? "Persistent sessions on — new delegate runs survive app restarts." : "Persistent sessions off for new delegate runs.");
              })
              .catch((e) => notify(`Persistent sessions: ${e}`, { tone: "error", duration: 0 }))
              .finally(() => {
                setBusy(false);
                refresh();
              });
          }}
          label="Persistent delegate sessions"
        />
      }
    />
  );
}

// ── Stats ────────────────────────────────────────────────────────────
// Global usage stats across every agent source Klide knows about (its own
// runs + Claude Code, Codex, OpenCode session logs on disk). Two graphs:
// a GitHub-style activity heatmap and a provider/model breakdown, both
// switchable between conversation counts and real token usage.
