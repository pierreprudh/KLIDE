import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { THEMES, type ThemeId } from "../theme";
import { LayoutCanvas } from "./LayoutCanvas";
import { GridLayoutBuilder } from "./GridLayoutBuilder";
import {
  BUILTIN_PRESETS,
  SIZE_OPTIONS,
  emptyDraft,
  makePresetId,
  presetMatchesVisibility,
  resolvePreset,
  summarizePreset,
  type LayoutPreset,
  type RegionConfig,
  type RegionSize,
  type ResolvedLayout,
} from "../layouts";

type SectionId =
  | "general"
  | "appearance"
  | "layout"
  | "ai"
  | "api"
  | "subscription"
  | "editor"
  | "terminal";

type Props = {
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
  aiVisible: boolean;
  onAiVisibleChange: (visible: boolean) => void;
  terminalVisible: boolean;
  onTerminalVisibleChange: (visible: boolean) => void;
  leftPanelWidth: number;
  onLeftPanelWidthChange: (width: number) => void;
  aiWidth: number;
  onAiWidthChange: (width: number) => void;
  terminalHeight: number;
  onTerminalHeightChange: (height: number) => void;
  editorFontSize: number;
  onEditorFontSizeChange: (fontSize: number) => void;
  editorLineNumbers: boolean;
  onEditorLineNumbersChange: (enabled: boolean) => void;
  editorWordWrap: boolean;
  onEditorWordWrapChange: (enabled: boolean) => void;
  editorMinimap: boolean;
  onEditorMinimapChange: (enabled: boolean) => void;
  aiModel: string;
  onAiModelChange: (model: string) => void;
  availableAiModels: string[];
  requireDiffReview: boolean;
  onRequireDiffReviewChange: (enabled: boolean) => void;
  stopAfterRejection: boolean;
  onStopAfterRejectionChange: (enabled: boolean) => void;
  explorerVisible: boolean;
  customLayouts: LayoutPreset[];
  onCustomLayoutsChange: (next: LayoutPreset[]) => void;
  onApplyLayout: (layout: ResolvedLayout) => void;
  initialSection?: string | null;
  onBack: () => void;
};

type SubscriptionProviderId = "claude-code" | "codex" | "gemini-cli";

type SubscriptionStatus = {
  provider: SubscriptionProviderId;
  installed: boolean;
  connected: boolean;
  detail: string;
  commandPath?: string | null;
  loginOptions: string[];
};

const subscriptionProviders: {
  id: SubscriptionProviderId;
  title: string;
  command: string;
  description: string;
}[] = [
  {
    id: "claude-code",
    title: "Claude Code",
    command: "claude",
    description: "Subscription login, Console login, SSO, or long-lived setup token.",
  },
  {
    id: "codex",
    title: "Codex",
    command: "codex",
    description: "ChatGPT login, device auth, API key, or access token.",
  },
  {
    id: "gemini-cli",
    title: "Gemini CLI",
    command: "gemini",
    description: "Staged until the Gemini CLI is installed and its command shape is wired.",
  },
];

const sections: { id: SectionId; label: string; icon: ReactNode }[] = [
  { id: "general", label: "General", icon: <GearIcon /> },
  { id: "appearance", label: "Appearance", icon: <SunIcon /> },
  { id: "layout", label: "Layout", icon: <GridIcon /> },
  { id: "ai", label: "AI Assistant", icon: <SparkIcon /> },
  { id: "api", label: "API", icon: <KeyIcon /> },
  { id: "subscription", label: "Subscription", icon: <CloudIcon /> },
  { id: "editor", label: "Editor", icon: <CodeIcon /> },
  { id: "terminal", label: "Terminal", icon: <TerminalIcon /> },
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function SettingBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 34 }}>
      <h2
        style={{
          margin: "0 0 14px",
          color: "var(--fg-strong)",
          fontSize: 16,
          lineHeight: 1.25,
          fontWeight: 700,
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function Panel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        border: "1px solid var(--border-strong)",
        borderRadius: "var(--radius-md)",
        background: "var(--bg-elevated)",
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}

function Row({
  title,
  description,
  control,
}: {
  title: string;
  description: string;
  control: ReactNode;
}) {
  return (
    <div
      style={{
        minHeight: 72,
        padding: "16px 18px",
        borderBottom: "1px solid var(--border)",
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto",
        alignItems: "center",
        gap: 18,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ color: "var(--fg-strong)", fontSize: 14, marginBottom: 5 }}>
          {title}
        </div>
        <div style={{ color: "var(--fg-subtle)", fontSize: 13, lineHeight: 1.4 }}>
          {description}
        </div>
      </div>
      {control}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      style={{
        width: 42,
        height: 24,
        borderRadius: 999,
        padding: 3,
        border: "1px solid var(--border-strong)",
        background: checked ? "var(--accent)" : "var(--bg-hover)",
        display: "flex",
        justifyContent: checked ? "flex-end" : "flex-start",
        flex: "0 0 auto",
      }}
    >
      <span
        style={{
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: checked ? "#FFFFFF" : "var(--fg-subtle)",
          display: "block",
        }}
      />
    </button>
  );
}

function Select({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  label: string;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        minWidth: 220,
        height: 34,
        borderRadius: "var(--radius-sm)",
        border: "1px solid var(--border)",
        background: "var(--bg-hover)",
        color: "var(--fg-strong)",
        font: "inherit",
        padding: "0 34px 0 12px",
      }}
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

function ChoiceCards<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; title: string; description: string; icon: ReactNode }[];
  onChange: (value: T) => void;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(2, minmax(220px, 1fr))",
        gap: 12,
      }}
    >
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            style={{
              minHeight: 88,
              padding: "16px 18px",
              borderRadius: "var(--radius-md)",
              border: `1px solid ${active ? "var(--accent)" : "var(--border-strong)"}`,
              background: active ? "var(--bg-selected)" : "var(--bg-elevated)",
              display: "grid",
              gridTemplateColumns: "28px minmax(0, 1fr) 22px",
              alignItems: "center",
              gap: 14,
              textAlign: "left",
            }}
          >
            <span style={{ color: active ? "var(--accent)" : "var(--fg-subtle)" }}>
              {option.icon}
            </span>
            <span style={{ minWidth: 0 }}>
              <span
                style={{
                  display: "block",
                  color: "var(--fg-strong)",
                  fontSize: 14,
                  marginBottom: 5,
                }}
              >
                {option.title}
              </span>
              <span
                style={{
                  display: "block",
                  color: "var(--fg-subtle)",
                  fontSize: 13,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {option.description}
              </span>
            </span>
            <span
              aria-hidden
              style={{
                width: 20,
                height: 20,
                borderRadius: "50%",
                border: `1px solid ${active ? "var(--accent)" : "var(--border-strong)"}`,
                display: "grid",
                placeItems: "center",
              }}
            >
              {active && (
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: "var(--accent)",
                  }}
                />
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ThemeSwatch({ colors }: { colors: string[] }) {
  return (
    <span
      style={{
        width: 26,
        height: 26,
        borderRadius: "var(--radius-xs)",
        border: "1px solid var(--border-strong)",
        overflow: "hidden",
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gridTemplateRows: "1fr 1fr",
      }}
    >
      {colors.map((color) => (
        <span key={color} style={{ background: color }} />
      ))}
    </span>
  );
}

function Range({
  value,
  min,
  max,
  step = 1,
  onChange,
  suffix,
  label,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  suffix: string;
  label: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <input
        className="settings-range"
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(clamp(Number(e.target.value), min, max))}
        style={{ width: 164 }}
      />
      <span style={{ minWidth: 54, color: "var(--fg-strong)", textAlign: "right" }}>
        {value}
        {suffix}
      </span>
    </div>
  );
}

function SizePicker({
  value,
  onChange,
  label,
}: {
  value: RegionSize;
  onChange: (size: RegionSize) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} style={{ display: "flex", gap: 4 }}>
      {SIZE_OPTIONS.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.id)}
            style={{
              padding: "6px 12px",
              borderRadius: "var(--radius-sm)",
              border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
              background: active ? "var(--accent-soft)" : "transparent",
              color: active ? "var(--accent)" : "var(--fg)",
              fontSize: 13,
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function GhostButton({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        height: 32,
        padding: "0 12px",
        borderRadius: "var(--radius-sm)",
        border: "1px solid var(--border)",
        background: "transparent",
        color: "var(--fg)",
        fontSize: 13,
      }}
    >
      {children}
    </button>
  );
}

function LinkButton({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        height: 32,
        padding: "0 12px",
        borderRadius: "var(--radius-sm)",
        border: "1px solid var(--border-strong)",
        background: "var(--bg-hover)",
        color: "var(--fg-strong)",
        fontSize: 13,
      }}
    >
      {children}
    </button>
  );
}

function CodePill({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        minHeight: 28,
        padding: "0 10px",
        borderRadius: "var(--radius-sm)",
        border: "1px solid var(--border)",
        background: "var(--bg-hover)",
        color: "var(--fg-strong)",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function StatusPill({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "idle";
  children: ReactNode;
}) {
  const color =
    tone === "ok" ? "var(--accent)" : tone === "warn" ? "#A15C00" : "var(--fg-subtle)";
  const background =
    tone === "ok"
      ? "var(--accent-soft)"
      : tone === "warn"
      ? "color-mix(in srgb, #A15C00 12%, var(--bg-hover))"
      : "var(--bg-hover)";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        minHeight: 28,
        padding: "0 10px",
        borderRadius: "var(--radius-sm)",
        border: "1px solid var(--border)",
        background,
        color,
        fontSize: 12,
        fontWeight: 500,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function ModelChips({ models }: { models: string[] }) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "flex-end",
        gap: 6,
        maxWidth: 420,
      }}
    >
      {models.map((model) => (
        <CodePill key={model}>{model}</CodePill>
      ))}
    </div>
  );
}

// API providers whose keys live in the OS keychain (managed from the API tab).
const API_KEY_PROVIDERS: {
  id: string;
  title: string;
  envVar: string;
  placeholder: string;
}[] = [
  { id: "openai", title: "OpenAI", envVar: "OPENAI_API_KEY", placeholder: "sk-..." },
  { id: "mistral", title: "Mistral", envVar: "MISTRAL_API_KEY", placeholder: "..." },
  { id: "xai", title: "xAI Grok", envVar: "XAI_API_KEY", placeholder: "xai-..." },
];

type KeyStatus = { hasKey: boolean; source: "keychain" | "env" | "none" };

// One provider's key control: shows where the key comes from (keychain / env /
// none), lets you paste a new one (saved into the keychain via Rust), and clear
// it. The key value never lives in React state once saved — only its status.
function ApiKeyRow({
  id,
  title,
  envVar,
  placeholder,
}: {
  id: string;
  title: string;
  envVar: string;
  placeholder: string;
}) {
  const [status, setStatus] = useState<KeyStatus>({ hasKey: false, source: "none" });
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await invoke<KeyStatus>("ai_provider_key_status", {
        provider: id,
      });
      setStatus(next);
    } catch {
      setStatus({ hasKey: false, source: "none" });
    }
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save() {
    if (!value.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("ai_set_provider_key", { provider: id, key: value });
      setValue("");
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("ai_clear_provider_key", { provider: id });
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const pill =
    status.source === "keychain" ? (
      <StatusPill tone="ok">Saved</StatusPill>
    ) : status.source === "env" ? (
      <StatusPill tone="warn">From env</StatusPill>
    ) : (
      <StatusPill tone="idle">Not set</StatusPill>
    );

  const description = error
    ? error
    : status.source === "keychain"
    ? "Stored securely in your macOS Keychain."
    : status.source === "env"
    ? `Using ${envVar} from the environment. Save here to move it into the Keychain (survives a packaged build).`
    : `Paste a key to store it in your macOS Keychain, or export ${envVar}.`;

  return (
    <Row
      title={title}
      description={description}
      control={
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {pill}
          <input
            type="password"
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
            }}
            aria-label={`${title} API key`}
            autoComplete="off"
            style={{
              width: 190,
              height: 34,
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border)",
              background: "var(--bg-hover)",
              color: "var(--fg-strong)",
              font: "inherit",
              padding: "0 12px",
            }}
          />
          <LinkButton onClick={() => void save()}>
            {busy ? "..." : "Save"}
          </LinkButton>
          {status.source === "keychain" && (
            <GhostButton onClick={() => void clear()}>Clear</GhostButton>
          )}
        </div>
      }
    />
  );
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

export function SettingsPanel({
  theme,
  onThemeChange,
  aiVisible,
  onAiVisibleChange,
  terminalVisible,
  onTerminalVisibleChange,
  leftPanelWidth,
  onLeftPanelWidthChange,
  aiWidth,
  onAiWidthChange,
  terminalHeight,
  onTerminalHeightChange,
  editorFontSize,
  onEditorFontSizeChange,
  editorLineNumbers,
  onEditorLineNumbersChange,
  editorWordWrap,
  onEditorWordWrapChange,
  editorMinimap,
  onEditorMinimapChange,
  aiModel,
  onAiModelChange,
  availableAiModels,
  requireDiffReview,
  onRequireDiffReviewChange,
  stopAfterRejection,
  onStopAfterRejectionChange,
  explorerVisible,
  customLayouts,
  onCustomLayoutsChange,
  onApplyLayout,
  initialSection,
  onBack,
}: Props) {
  const isSectionId = (value: string | null | undefined): value is SectionId =>
    sections.some((section) => section.id === value);
  const [activeSection, setActiveSection] = useState<SectionId>(
    isSectionId(initialSection) ? initialSection : "general"
  );
  const [draft, setDraft] = useState(() => emptyDraft());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [subscriptionStatuses, setSubscriptionStatuses] = useState<
    Partial<Record<SubscriptionProviderId, SubscriptionStatus>>
  >({});
  const [subscriptionModels, setSubscriptionModels] = useState<
    Partial<Record<SubscriptionProviderId, string[]>>
  >({});
  const [connectionLoading, setConnectionLoading] = useState(false);

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
    const entries = await Promise.all(
      subscriptionProviders.map(async (provider) => {
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
    setConnectionLoading(false);
  }

  useEffect(() => {
    void refreshSubscriptionConnections();
  }, []);

  return (
    <main
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "grid",
        gridTemplateColumns: "284px minmax(0, 1fr)",
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

        <nav style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {sections.map((section) => {
            const active = activeSection === section.id;
            return (
              <button
                key={section.id}
                type="button"
                onClick={() => setActiveSection(section.id)}
                style={{
                  height: 36,
                  padding: "0 12px",
                  display: "flex",
                  alignItems: "center",
                  gap: 11,
                  color: active ? "var(--fg-strong)" : "var(--fg)",
                  background: active ? "var(--bg-hover)" : "transparent",
                  borderRadius: "var(--radius-sm)",
                  justifyContent: "flex-start",
                  fontSize: 14,
                }}
              >
                <span style={{ width: 18, height: 18, display: "grid", placeItems: "center" }}>
                  {section.icon}
                </span>
                {section.label}
              </button>
            );
          })}
        </nav>
      </aside>

      <div style={{ overflow: "auto", minWidth: 0 }}>
        <div
          style={{
            width: "min(930px, calc(100vw - 360px))",
            margin: "0 auto",
            padding: "44px 34px 72px",
          }}
        >
          <h1
            style={{
              margin: "0 0 54px",
              color: "var(--fg-strong)",
              fontSize: 24,
              lineHeight: 1.15,
              fontWeight: 700,
            }}
          >
            {sectionTitle}
          </h1>

          {activeSection === "general" && (
            <>
              <SettingBlock title="Panels">
                <Panel>
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
            </>
          )}

          {activeSection === "appearance" && (
            <>
              <SettingBlock title="Theme">
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
              </SettingBlock>
              <SettingBlock title="Layout">
                <Panel>
                  <Row
                    title="Left panel width"
                    description="Controls the explorer and Git panel width."
                    control={
                      <Range
                        label="Left panel width"
                        value={leftPanelWidth}
                        min={220}
                        max={520}
                        onChange={onLeftPanelWidthChange}
                        suffix="px"
                      />
                    }
                  />
                  <Row
                    title="AI panel width"
                    description="Controls the assistant panel width."
                    control={
                      <Range
                        label="AI panel width"
                        value={aiWidth}
                        min={300}
                        max={620}
                        onChange={onAiWidthChange}
                        suffix="px"
                      />
                    }
                  />
                </Panel>
              </SettingBlock>
            </>
          )}

          {activeSection === "layout" && (
            <>
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
                            style={{
                              height: 32,
                              padding: "0 14px",
                              borderRadius: "var(--radius-sm)",
                              border: "1px solid var(--border-strong)",
                              background: "var(--bg-hover)",
                              color: "var(--fg-strong)",
                              fontSize: 13,
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
                        style={{
                          minWidth: 220,
                          height: 34,
                          borderRadius: "var(--radius-sm)",
                          border: "1px solid var(--border)",
                          background: "var(--bg-hover)",
                          color: "var(--fg-strong)",
                          font: "inherit",
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
                      style={{
                        height: 34,
                        padding: "0 16px",
                        borderRadius: "var(--radius-sm)",
                        border: "1px solid var(--accent)",
                        background: "var(--accent)",
                        color: "#FFFFFF",
                        fontSize: 13,
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
            </>
          )}

          {activeSection === "ai" && (
            <>
              <SettingBlock title="Assistant">
                <Panel>
                  <Row
                    title="Show assistant panel"
                    description="Display the AI chat on the right side of the workbench."
                    control={
                      <Toggle
                        checked={aiVisible}
                        onChange={onAiVisibleChange}
                        label="Show assistant panel"
                      />
                    }
                  />
                  <Row
                    title="Ollama model"
                    description="Use this model for the AI panel immediately."
                    control={
                      <Select
                        label="Ollama model"
                        value={aiModel}
                        onChange={onAiModelChange}
                        options={
                          availableAiModels.includes(aiModel)
                            ? availableAiModels
                            : [aiModel, ...availableAiModels]
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
              <SettingBlock title="Connections">
                <Panel>
                  <Row
                    title="API providers"
                    description="OpenAI, Mistral, and xAI keys are read by the Tauri backend."
                    control={
                      <LinkButton onClick={() => setActiveSection("api")}>
                        Open API
                      </LinkButton>
                    }
                  />
                  <Row
                    title="Subscription providers"
                    description="Claude Code and Codex use your local CLI login."
                    control={
                      <LinkButton onClick={() => setActiveSection("subscription")}>
                        Open Subscription
                      </LinkButton>
                    }
                  />
                </Panel>
              </SettingBlock>
            </>
          )}

          {activeSection === "api" && (
            <>
              <SettingBlock title="API Keys">
                <Panel>
                  {API_KEY_PROVIDERS.map((provider) => (
                    <ApiKeyRow
                      key={provider.id}
                      id={provider.id}
                      title={provider.title}
                      envVar={provider.envVar}
                      placeholder={provider.placeholder}
                    />
                  ))}
                </Panel>
              </SettingBlock>
              <SettingBlock title="Notes">
                <Panel>
                  <Row
                    title="Secret boundary"
                    description="Keys are stored in the OS keychain and read only by Rust — they never enter the React webview."
                    control={<CodePill>src-tauri</CodePill>}
                  />
                  <Row
                    title="Tool support"
                    description="These providers use the OpenAI-compatible chat and function-calling adapter."
                    control={<CodePill>Build</CodePill>}
                  />
                </Panel>
              </SettingBlock>
            </>
          )}

          {activeSection === "subscription" && (
            <>
              <SettingBlock title="Subscription Connections">
                <Panel>
                  {subscriptionProviders.map((provider) => {
                    const status = subscriptionStatuses[provider.id];
                    const tone = status?.connected
                      ? "ok"
                      : status?.installed
                      ? "warn"
                      : "idle";
                    const label = status?.connected
                      ? "Connected"
                      : status?.installed
                      ? "Installed"
                      : "Missing";
                    return (
                      <Row
                        key={provider.id}
                        title={provider.title}
                        description={status?.detail || provider.description}
                        control={<StatusPill tone={tone}>{label}</StatusPill>}
                      />
                    );
                  })}
                </Panel>
              </SettingBlock>
              <SettingBlock title="Connection Options">
                <Panel>
                  {subscriptionProviders.map((provider) => {
                    const status = subscriptionStatuses[provider.id];
                    const options = status?.loginOptions.length
                      ? status.loginOptions
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
                        control={<ModelChips models={options} />}
                      />
                    );
                  })}
                </Panel>
              </SettingBlock>
              <SettingBlock title="Model Options">
                <Panel>
                  {subscriptionProviders.map((provider) => {
                    const models = subscriptionModels[provider.id] ?? [];
                    return (
                      <Row
                        key={provider.id}
                        title={provider.title}
                        description={
                          provider.id === "claude-code"
                            ? "Loaded from Claude Code's local model usage cache."
                            : provider.id === "codex"
                            ? "Loaded from the current Codex model cache when available."
                            : "Shown for when Gemini CLI support is enabled."
                        }
                        control={
                          models.length > 0 ? (
                            <ModelChips models={models} />
                          ) : (
                            <StatusPill tone="idle">Unavailable</StatusPill>
                          )
                        }
                      />
                    );
                  })}
                </Panel>
              </SettingBlock>
              <SettingBlock title="Mode">
                <Panel>
                  <Row
                    title="Read-only bridge"
                    description="Subscription CLIs can answer with your logged-in account without bypassing Klide diff review."
                    control={<CodePill>Plan</CodePill>}
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

          {activeSection === "editor" && (
            <SettingBlock title="Editor">
              <Panel>
                <Row
                  title="Font size"
                  description="Preferred code editor text size."
                  control={
                    <Range
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
          )}

          {activeSection === "terminal" && (
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
                  description="Controls the default height of the bottom terminal panel."
                  control={
                    <Range
                      label="Terminal height"
                      value={terminalHeight}
                      min={140}
                      max={460}
                      onChange={onTerminalHeightChange}
                      suffix="px"
                    />
                  }
                />
              </Panel>
            </SettingBlock>
          )}
        </div>
      </div>
    </main>
  );
}

function IconBase({ children }: { children: ReactNode }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

function ArrowLeftIcon() {
  return (
    <IconBase>
      <path d="M19 12H5" />
      <path d="M12 19l-7-7 7-7" />
    </IconBase>
  );
}

function GearIcon() {
  return (
    <IconBase>
      <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z" />
      <path d="M19.4 15a1.8 1.8 0 0 0 .4 2l.1.1-2 3.4-.2-.1a1.8 1.8 0 0 0-2 .4l-.2.2-3.5-2-.1-.3a1.8 1.8 0 0 0-1.8-1.1 1.8 1.8 0 0 0-1.7 1.2l-.1.2-3.6-2 .1-.2a1.8 1.8 0 0 0-.4-2l-.2-.2 2-3.4.3.1a1.8 1.8 0 0 0 2-.5l.1-.1 3.5 2" />
    </IconBase>
  );
}

function SunIcon() {
  return (
    <IconBase>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 2.5v2.2" />
      <path d="M12 19.3v2.2" />
      <path d="M4.6 4.6l1.6 1.6" />
      <path d="M17.8 17.8l1.6 1.6" />
      <path d="M2.5 12h2.2" />
      <path d="M19.3 12h2.2" />
      <path d="M4.6 19.4l1.6-1.6" />
      <path d="M17.8 6.2l1.6-1.6" />
    </IconBase>
  );
}

function SparkIcon() {
  return (
    <IconBase>
      <path d="M12 3.5l1.6 4.4L18 9.5l-4.4 1.6L12 15.5l-1.6-4.4L6 9.5l4.4-1.6L12 3.5z" />
      <path d="M18 16l.7 1.8 1.8.7-1.8.7L18 21l-.7-1.8-1.8-.7 1.8-.7L18 16z" />
    </IconBase>
  );
}

function KeyIcon() {
  return (
    <IconBase>
      <circle cx="8" cy="12" r="3.5" />
      <path d="M11.5 12H21" />
      <path d="M17 12v3" />
      <path d="M14 12v2" />
    </IconBase>
  );
}

function CloudIcon() {
  return (
    <IconBase>
      <path d="M7.5 18h9.2a4 4 0 0 0 .5-7.9 5.5 5.5 0 0 0-10.5 1.4A3.3 3.3 0 0 0 7.5 18z" />
    </IconBase>
  );
}

function GridIcon() {
  return (
    <IconBase>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.2" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.2" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.2" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.2" />
    </IconBase>
  );
}

function CodeIcon() {
  return (
    <IconBase>
      <path d="M8 9l-3 3 3 3" />
      <path d="M16 9l3 3-3 3" />
      <path d="M14 5l-4 14" />
    </IconBase>
  );
}

function TerminalIcon() {
  return (
    <IconBase>
      <path d="M4 6.5h16v11H4z" />
      <path d="M7 10l2 2-2 2" />
      <path d="M12 14h4" />
    </IconBase>
  );
}
