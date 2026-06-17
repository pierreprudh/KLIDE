import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { THEMES, type ThemeId } from "../theme";
import { ChevronDown, ProviderLogo } from "./ai/icons";
import type { ProviderId } from "../agent/types";
import { PROVIDER_GROUPS } from "../agent/providers";
import {
  customIdFromLabel,
  refreshCustomProviders,
  removeCustomProvider,
  upsertCustomProvider,
  type CustomProvider,
} from "../customProviders";
import { LayoutCanvas } from "./LayoutCanvas";
import { GridLayoutBuilder } from "./GridLayoutBuilder";
import {
  ActivityHeatmap,
  formatCompact,
  mondayOfWeek,
  msToKey,
  startOfDay,
} from "./ActivityHeatmap";
import {
  SOURCE_LABEL,
  fetchAgentRunsCached,
  peekAgentRunsCache,
  type Run,
  type RunSource,
} from "../runs";
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
  | "local-ai"
  | "api"
  | "subscription"
  | "editor"
  | "terminal"
  | "stats";

type Props = {
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
  autoTheme: boolean;
  onAutoThemeChange: (enabled: boolean) => void;
  lightTheme: ThemeId;
  onLightThemeChange: (theme: ThemeId) => void;
  darkTheme: ThemeId;
  onDarkThemeChange: (theme: ThemeId) => void;
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
  harnessSettings?: { chatPrompt?: string; planPrompt?: string; goalPrompt?: string; toolOverrides?: Record<string, boolean>; contextWindows?: Record<string, number>; effortBudgets?: Record<string, number>; reflectionLevels?: Record<string, string>; maxParallelTools?: number; maxTurns?: number; serverConcurrency?: number; autoMemoryOnRunDone?: boolean };
  onHarnessSettingsChange?: (settings: { chatPrompt?: string; planPrompt?: string; goalPrompt?: string; toolOverrides?: Record<string, boolean>; contextWindows?: Record<string, number>; effortBudgets?: Record<string, number>; reflectionLevels?: Record<string, string>; maxParallelTools?: number; maxTurns?: number; serverConcurrency?: number; autoMemoryOnRunDone?: boolean }) => void;
  explorerVisible: boolean;
  customLayouts: LayoutPreset[];
  onCustomLayoutsChange: (next: LayoutPreset[]) => void;
  onApplyLayout: (layout: ResolvedLayout) => void;
  onProviderKeyChange?: (provider: string) => void;
  initialSection?: string | null;
  onBack: () => void;
};

type SubscriptionProviderId = "claude-code" | "codex" | "opencode";

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
    id: "opencode",
    title: "OpenCode",
    command: "opencode",
    description: "Interactive OpenCode CLI, launched as a real delegate terminal.",
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

// A section's subtree only mounts once its tab has been visited (`mounted`),
// then stays mounted (hidden via display) so re-selecting it is instant and
// in-progress edits survive a tab switch. Deferring the mount is what keeps
// Settings opening fast: the API / Local-AI sections fire per-provider status
// `invoke`s on mount, so we don't pay for them until the user goes there.
function Section({
  id,
  active,
  mounted = true,
  children,
}: {
  id: SectionId;
  active: SectionId;
  mounted?: boolean;
  children: ReactNode;
}) {
  return (
    <div style={{ display: id === active ? "block" : "none" }}>
      {mounted ? children : null}
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function SettingBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="klide-settings-section">
      <h2 className="klide-settings-heading">{title}</h2>
      {children}
    </section>
  );
}

function Panel({ children }: { children: ReactNode }) {
  return <div className="klide-surface">{children}</div>;
}

function Row({
  title,
  description,
  control,
  leading,
}: {
  title: string;
  description: string;
  control: ReactNode;
  leading?: ReactNode;
}) {
  return (
    <div
      className="klide-settings-row"
    >
      <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 10 }}>
        {leading && (
          <div style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
            {leading}
          </div>
        )}
        <div style={{ minWidth: 0 }}>
          <div className="klide-row-title">{title}</div>
          <div className="klide-row-description">{description}</div>
        </div>
      </div>
      {control}
    </div>
  );
}

// A segmented pill control — one-click choice across a small ladder of
// options, the premium alternative to a free-text number field. The first
// option is the "off / auto / default" sentinel (value `undefined`); the
// active pill is lifted with the accent tint.
function Segmented({
  options,
  value,
  onChange,
  label,
  disabled = false,
}: {
  options: { label: string; value: number | string | undefined }[];
  value: number | string | undefined;
  onChange: (value: number | string | undefined) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      style={{
        display: "inline-flex",
        gap: 2,
        padding: 2,
        borderRadius: 999,
        border: "1px solid var(--border-strong)",
        background: "color-mix(in srgb, var(--panel) 88%, transparent)",
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.label}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            style={{
              height: 26,
              minWidth: 38,
              padding: "0 11px",
              borderRadius: 999,
              border: "none",
              cursor: disabled ? "not-allowed" : "pointer",
              fontSize: 11.5,
              fontWeight: active ? 600 : 500,
              letterSpacing: "0.01em",
              color: disabled ? "var(--fg-dim)" : active ? "var(--accent)" : "var(--fg-subtle)",
              background: active
                ? "color-mix(in srgb, var(--accent-soft) 60%, transparent)"
                : "transparent",
              boxShadow: active
                ? "inset 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent)"
                : "none",
              transition:
                "color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
            }}
            onMouseEnter={(e) => {
              if (!active && !disabled) e.currentTarget.style.color = "var(--fg-strong)";
            }}
            onMouseLeave={(e) => {
              if (!active && !disabled) e.currentTarget.style.color = "var(--fg-subtle)";
            }}
          >
            {opt.label}
          </button>
        );
      })}
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
      className="klide-switch"
      data-checked={checked}
    >
      <span className="klide-switch-knob" />
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
      className="klide-field"
      style={{
        minWidth: 180,
        height: 30,
        padding: "0 30px 0 10px",
        cursor: "pointer",
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
            className={active ? "klide-surface" : ""}
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
      className="klide-button klide-button-ghost"
      style={{
        height: 32,
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
      className="klide-button klide-button-secondary"
      style={{
        height: 32,
      }}
    >
      {children}
    </button>
  );
}

function CodePill({ children }: { children: ReactNode }) {
  return (
    <span
      className="klide-code-chip"
    >
      {children}
    </span>
  );
}

function CenteredLoader({ label }: { label?: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        padding: "96px 20px",
        color: "var(--fg-subtle)",
      }}
    >
      <svg
        width="36"
        height="10"
        viewBox="0 0 36 10"
        fill="currentColor"
        aria-hidden
      >
        <circle cx="5" cy="5" r="4">
          <animate
            attributeName="opacity"
            values="0.25;1;0.25"
            dur="1.2s"
            begin="0s"
            repeatCount="indefinite"
          />
        </circle>
        <circle cx="18" cy="5" r="4">
          <animate
            attributeName="opacity"
            values="0.25;1;0.25"
            dur="1.2s"
            begin="0.4s"
            repeatCount="indefinite"
          />
        </circle>
        <circle cx="31" cy="5" r="4">
          <animate
            attributeName="opacity"
            values="0.25;1;0.25"
            dur="1.2s"
            begin="0.8s"
            repeatCount="indefinite"
          />
        </circle>
      </svg>
      {label && (
        <span style={{ fontSize: 12.5, letterSpacing: "0.02em" }}>{label}</span>
      )}
    </div>
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
      className="klide-status-chip"
      style={{
        background,
        color,
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
  { id: "anthropic", title: "Anthropic", envVar: "ANTHROPIC_API_KEY", placeholder: "sk-ant-..." },
  { id: "openai", title: "OpenAI", envVar: "OPENAI_API_KEY", placeholder: "sk-..." },
  { id: "mistral", title: "Mistral", envVar: "MISTRAL_API_KEY", placeholder: "..." },
  { id: "xai", title: "xAI Grok", envVar: "XAI_API_KEY", placeholder: "xai-..." },
];

type KeyStatus = { hasKey: boolean; source: "keychain" | "env" | "reference" | "none" };

// One provider's key control: shows where the key comes from (keychain / env /
// none), lets you paste a new one (saved into the keychain via Rust), and clear
// it. The key value never lives in React state once saved — only its status.
function ApiKeyRow({
  id,
  title,
  envVar,
  placeholder,
  onChange,
}: {
  id: string;
  title: string;
  envVar: string;
  placeholder: string;
  onChange?: (provider: string) => void;
}) {
  const [status, setStatus] = useState<KeyStatus>({ hasKey: false, source: "none" });
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Two ways to supply the key: "paste" → macOS Keychain (classic), or "ref"
  // → a `${VAR}` reference resolved from .env (same as self-hosted endpoints).
  const [method, setMethod] = useState<"paste" | "ref">("paste");

  const refresh = useCallback(async () => {
    try {
      const next = await invoke<KeyStatus>("ai_provider_key_status", {
        provider: id,
      });
      setStatus(next);
      // Reflect the saved method so reopening Settings shows how it's wired.
      if (next.source === "reference") setMethod("ref");
      else if (next.source === "keychain") setMethod("paste");
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
      if (method === "ref") {
        await invoke("ai_set_provider_key_reference", { provider: id, reference: value });
      } else {
        await invoke("ai_set_provider_key", { provider: id, key: value });
      }
      setValue("");
      await refresh();
      onChange?.(id);
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
      // Clear whichever method is currently providing the key.
      const cmd =
        status.source === "reference"
          ? "ai_clear_provider_key_reference"
          : "ai_clear_provider_key";
      await invoke(cmd, { provider: id });
      await refresh();
      onChange?.(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const pill =
    status.source === "keychain" ? (
      <StatusPill tone="ok">Saved</StatusPill>
    ) : status.source === "reference" ? (
      status.hasKey ? (
        <StatusPill tone="ok">Linked</StatusPill>
      ) : (
        <StatusPill tone="warn">Unresolved</StatusPill>
      )
    ) : status.source === "env" ? (
      <StatusPill tone="warn">From env</StatusPill>
    ) : (
      <StatusPill tone="idle">Not set</StatusPill>
    );

  const description = error
    ? error
    : status.source === "keychain"
    ? "Stored securely in your macOS Keychain."
    : status.source === "reference"
    ? status.hasKey
      ? "Resolved from a ${VAR} reference in your .env — no key stored in the app."
      : "Reference set, but it doesn't resolve. Add the variable to your project .env or ~/.klide/.env."
    : status.source === "env"
    ? `Using ${envVar} from the environment. Save here to move it into the Keychain (survives a packaged build).`
    : method === "ref"
    ? `Reference an env var (e.g. \${${envVar}}); the value stays in your .env, never in the app.`
    : `Paste a key to store it in your macOS Keychain, or export ${envVar}.`;

  return (
    <Row
      title={title}
      description={description}
      control={
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {pill}
          <MethodToggle method={method} onChange={setMethod} />
          <input
            type={method === "ref" ? "text" : "password"}
            value={value}
            placeholder={method === "ref" ? `\${${envVar}}` : placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
            }}
            aria-label={method === "ref" ? `${title} env reference` : `${title} API key`}
            autoComplete="off"
            spellCheck={false}
            className="klide-field"
            style={{
              width: 190,
              height: 34,
              padding: "0 12px",
            }}
          />
          <LinkButton onClick={() => void save()}>
            {busy ? "..." : "Save"}
          </LinkButton>
          {(status.source === "keychain" || status.source === "reference") && (
            <GhostButton onClick={() => void clear()}>Clear</GhostButton>
          )}
        </div>
      }
    />
  );
}

// Compact two-segment switch between the pasted-key (Keychain) and the
// env-reference (.env) methods. Quiet at rest; the active segment carries the
// accent tint, matching the picker chips elsewhere.
function MethodToggle({
  method,
  onChange,
}: {
  method: "paste" | "ref";
  onChange: (m: "paste" | "ref") => void;
}) {
  const seg = (m: "paste" | "ref", label: string) => {
    const active = method === m;
    return (
      <button
        type="button"
        onClick={() => onChange(m)}
        aria-pressed={active}
        style={{
          height: 26,
          padding: "0 9px",
          border: "none",
          borderRadius: 6,
          background: active ? "var(--bg-elevated)" : "transparent",
          boxShadow: active ? "0 1px 2px rgba(38,38,32,0.12)" : "none",
          color: active ? "var(--fg-strong)" : "var(--fg-subtle)",
          fontSize: 11.5,
          fontWeight: active ? 560 : 500,
          cursor: "pointer",
          transition: "background 120ms ease, color 120ms ease",
        }}
      >
        {label}
      </button>
    );
  };
  return (
    <div
      role="group"
      aria-label="Key method"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: 2,
        borderRadius: 8,
        background: "var(--bg-hover)",
        border: "1px solid var(--border)",
      }}
    >
      {seg("paste", "Paste")}
      {seg("ref", "Env ref")}
    </div>
  );
}

// Self-hosted (custom) OpenAI-compatible endpoints. Config (label, base URL,
// default model) persists to the Rust store; the bearer token rides the same
// keychain path as the built-in keys. Adding one here makes it appear in the
// AI panel's provider dropdown under "Self-hosted".
function PencilIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function TrashIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  );
}

// A square, ghost-styled icon button. Stops propagation so it can sit
// inside a clickable (expandable) row without toggling it.
function IconButton({
  title,
  onClick,
  danger,
  children,
}: {
  title: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{
        display: "grid",
        placeItems: "center",
        width: 28,
        height: 28,
        borderRadius: "var(--radius-sm)",
        border: "1px solid transparent",
        background: "transparent",
        color: "var(--fg-subtle)",
        cursor: "pointer",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--bg-hover)";
        e.currentTarget.style.color = danger ? "var(--danger, #c0392b)" : "var(--fg-strong)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = "var(--fg-subtle)";
      }}
    >
      {children}
    </button>
  );
}

// One self-hosted endpoint: a click-to-expand row. Expanding fetches the
// live model list (which doubles as a connection + auth test) and the key
// status. Clicking a model pins it as the endpoint's default.
function CustomEndpointRow({
  endpoint,
  busy,
  onEdit,
  onRemove,
  onSetDefault,
}: {
  endpoint: CustomProvider;
  busy: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onSetDefault: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyStatus, setKeyStatus] = useState<KeyStatus>({ hasKey: false, source: "none" });
  const [hoveredModel, setHoveredModel] = useState<string | null>(null);

  const loadDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const ks = await invoke<KeyStatus>("ai_provider_key_status", {
        provider: endpoint.id,
      }).catch(() => ({ hasKey: false, source: "none" }) as KeyStatus);
      setKeyStatus(ks);
      const m = await invoke<string[]>("ai_provider_models", { provider: endpoint.id });
      setModels(m);
    } catch (e) {
      setError(String(e));
      setModels([]);
    } finally {
      setLoading(false);
    }
  }, [endpoint.id]);

  function toggle() {
    const next = !open;
    setOpen(next);
    // Lazy-load the detail the first time it opens.
    if (next && models === null && !loading) void loadDetail();
  }

  // Show just the host in the collapsed subtitle; full URL in the detail.
  let host = endpoint.baseUrl;
  try {
    host = new URL(endpoint.baseUrl).host;
  } catch {
    /* keep raw */
  }
  const count = models?.length ?? 0;

  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      <div
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
        className="klide-settings-row"
        style={{ cursor: "pointer" }}
      >
        <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              display: "grid",
              placeItems: "center",
              color: "var(--fg-dim)",
              transform: open ? "rotate(0deg)" : "rotate(-90deg)",
              transition: "transform 120ms ease",
              flexShrink: 0,
            }}
          >
            <ChevronDown />
          </span>
          <span style={{ display: "grid", placeItems: "center", color: "var(--fg-subtle)", flexShrink: 0 }}>
            <ProviderLogo id={endpoint.id as ProviderId} size={15} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="klide-row-title">{endpoint.label}</div>
            <div className="klide-row-description">
              {host}
              {endpoint.defaultModel ? ` · ${endpoint.defaultModel}` : ""}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <IconButton title="Edit endpoint" onClick={onEdit}>
            <PencilIcon />
          </IconButton>
          <IconButton title="Remove endpoint" danger onClick={onRemove}>
            <TrashIcon />
          </IconButton>
        </div>
      </div>

      {open && (
        <div style={{ padding: "0 18px 14px 40px", display: "grid", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {loading ? (
              <StatusPill tone="idle">Checking…</StatusPill>
            ) : error ? (
              <StatusPill tone="warn">Unreachable</StatusPill>
            ) : (
              <StatusPill tone="ok">{`${count} ${count === 1 ? "model" : "models"}`}</StatusPill>
            )}
            {keyStatus.source === "keychain" ? (
              <StatusPill tone="ok">Token saved</StatusPill>
            ) : keyStatus.source === "env" ? (
              <StatusPill tone="ok">Token from env</StatusPill>
            ) : keyStatus.source === "reference" ? (
              keyStatus.hasKey ? (
                <StatusPill tone="ok">Token from .env</StatusPill>
              ) : (
                <StatusPill tone="warn">Reference unresolved</StatusPill>
              )
            ) : (
              <StatusPill tone="idle">No token</StatusPill>
            )}
          </div>
          <div style={{ fontSize: 12, color: "var(--fg-subtle)", wordBreak: "break-all" }}>
            {endpoint.baseUrl}
          </div>
          {error && (
            <div style={{ fontSize: 12, color: "var(--danger, #c0392b)", wordBreak: "break-word" }}>
              {error}
            </div>
          )}
          {models && models.length > 0 && (
            <div style={{ display: "grid", gap: 7 }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: "var(--fg-dim)", letterSpacing: "0.02em" }}>
                  Models{" "}
                  <span style={{ fontWeight: 400, color: "var(--fg-subtle)" }}>{count}</span>
                </span>
                <span style={{ fontSize: 10.5, color: "var(--fg-subtle)" }}>click to set default</span>
              </div>
              <div style={{ display: "grid", gap: 2 }}>
                {models.map((m) => {
                  const isDefault = m === endpoint.defaultModel;
                  const hovered = hoveredModel === m;
                  const colon = m.indexOf(":");
                  const name = colon >= 0 ? m.slice(0, colon) : m;
                  const tag = colon >= 0 ? m.slice(colon + 1) : null;
                  return (
                    <button
                      key={m}
                      disabled={busy}
                      onClick={() => onSetDefault(m)}
                      onMouseEnter={() => setHoveredModel(m)}
                      onMouseLeave={() => setHoveredModel((cur) => (cur === m ? null : cur))}
                      title={isDefault ? "Default model" : "Set as default"}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        width: "100%",
                        textAlign: "left",
                        padding: "7px 10px",
                        borderRadius: "var(--radius-sm)",
                        cursor: busy ? "default" : "pointer",
                        border: `1px solid ${isDefault ? "color-mix(in srgb, var(--accent) 38%, var(--border))" : "transparent"}`,
                        background: isDefault ? "var(--accent-soft)" : hovered ? "var(--bg-hover)" : "transparent",
                        transition: "background 0.12s ease, border-color 0.12s ease",
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 15,
                          height: 15,
                          flexShrink: 0,
                          borderRadius: "50%",
                          display: "grid",
                          placeItems: "center",
                          border: `1px solid ${isDefault ? "var(--accent)" : "var(--border)"}`,
                          background: isDefault ? "var(--accent)" : "transparent",
                        }}
                      >
                        {isDefault && (
                          <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                            <path d="M2.5 6.2l2.3 2.3 4.7-5" stroke="var(--bg)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </span>
                      <span style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 7, flex: 1 }}>
                        <span
                          style={{
                            fontFamily: "var(--font-mono, monospace)",
                            fontSize: 12,
                            color: isDefault ? "var(--accent)" : "var(--fg-strong)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {name}
                        </span>
                        {tag && (
                          <span
                            style={{
                              flexShrink: 0,
                              fontSize: 10,
                              fontWeight: 600,
                              letterSpacing: "0.03em",
                              textTransform: "uppercase",
                              color: "var(--fg-subtle)",
                              background: "var(--bg-hover)",
                              border: "1px solid var(--border)",
                              padding: "1px 6px",
                              borderRadius: 999,
                              fontFamily: "var(--font-mono, monospace)",
                            }}
                          >
                            {tag}
                          </span>
                        )}
                      </span>
                      {isDefault ? (
                        <span style={{ flexShrink: 0, fontSize: 10.5, fontWeight: 600, color: "var(--accent)", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                          Default
                        </span>
                      ) : hovered ? (
                        <span style={{ flexShrink: 0, fontSize: 10.5, color: "var(--fg-subtle)" }}>
                          Set default
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div>
            <LinkButton onClick={() => void loadDetail()}>Refresh</LinkButton>
          </div>
        </div>
      )}
    </div>
  );
}

function CustomEndpointsBlock({
  onProviderKeyChange,
}: {
  onProviderKeyChange?: (id: string) => void;
}) {
  const [endpoints, setEndpoints] = useState<CustomProvider[]>([]);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setEndpoints(await refreshCustomProviders());
    } catch {
      /* store unreadable → treat as empty */
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  function resetForm() {
    setAdding(false);
    setEditingId(null);
    setLabel("");
    setBaseUrl("");
    setDefaultModel("");
    setToken("");
    setError(null);
  }

  const formOpen = adding || editingId !== null;

  // Escape closes the add/edit modal, matching the app's other dialogs.
  useEffect(() => {
    if (!formOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") resetForm();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [formOpen]);

  async function save() {
    if (busy || !label.trim() || !baseUrl.trim()) return;
    setBusy(true);
    setError(null);
    try {
      // Keep an existing id stable on edit; mint one from the label on add.
      const id = editingId ?? customIdFromLabel(label);
      const trimmedToken = token.trim();
      // Self-hosted endpoints don't use the keychain: the token field holds a
      // `${VAR}` reference resolved from the project's .env (or env var). A
      // raw token has nowhere to go, so reject it with a hint. Blank means
      // "leave whatever's saved alone" — preserve the existing reference.
      if (trimmedToken && !trimmedToken.startsWith("$")) {
        setError("Use a ${VAR} reference (e.g. ${DEV_TOKEN}) and put the value in your .env.");
        setBusy(false);
        return;
      }
      const existing = editingId ? endpoints.find((e) => e.id === editingId) : undefined;
      const tokenRef = trimmedToken || existing?.tokenRef;
      await upsertCustomProvider({
        id,
        label: label.trim(),
        baseUrl: baseUrl.trim(),
        defaultModel: defaultModel.trim(),
        tokenRef,
      });
      onProviderKeyChange?.(id);
      resetForm();
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await removeCustomProvider(id);
      if (editingId === id) resetForm();
      await load();
      onProviderKeyChange?.(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // Pin a model from the live list as this endpoint's default (used when
  // the provider is first selected in the AI panel).
  async function setDefault(ep: CustomProvider, model: string) {
    if (busy || ep.defaultModel === model) return;
    setBusy(true);
    try {
      await upsertCustomProvider({ ...ep, defaultModel: model });
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function startEdit(ep: CustomProvider) {
    resetForm();
    setEditingId(ep.id);
    setLabel(ep.label);
    setBaseUrl(ep.baseUrl);
    setDefaultModel(ep.defaultModel);
    // A `${VAR}` reference is safe to show; a keychain token is not, so it
    // stays blank ("leave alone"). This lets the user see/edit the reference.
    setToken(ep.tokenRef ?? "");
  }

  return (
    <>
      {endpoints.length > 0 && (
        <Panel>
          {endpoints.map((ep) => (
            <CustomEndpointRow
              key={ep.id}
              endpoint={ep}
              busy={busy}
              onEdit={() => startEdit(ep)}
              onRemove={() => void remove(ep.id)}
              onSetDefault={(model) => void setDefault(ep, model)}
            />
          ))}
        </Panel>
      )}

      {/* Add lives below the container as its own button, not nested in the
          endpoint list — the list is the container, adding is a separate act. */}
      <button
        onClick={() => { resetForm(); setAdding(true); }}
        className="klide-button"
        style={{
          width: "100%",
          marginTop: endpoints.length > 0 ? 10 : 0,
          justifyContent: "center",
          minHeight: 40,
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-md)",
          background: "var(--bg-hover)",
          color: "var(--fg-strong)",
          fontSize: 12.5,
        }}
      >
        + Add self-hosted endpoint
      </button>

      {/* The add/edit form is a centered modal, not an inline panel row —
          a focused surface for entering URL + token, dimming the list. */}
      {formOpen &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label={editingId ? "Edit endpoint" : "Add self-hosted endpoint"}
            onClick={resetForm}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 5200,
              display: "grid",
              placeItems: "center",
              background: "rgba(0,0,0,0.30)",
              backdropFilter: "blur(3px)",
            }}
          >
            <div
              className="floating-panel"
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "min(440px, calc(100vw - 80px))",
                borderRadius: "var(--radius-lg)",
                display: "grid",
                gap: 10,
                padding: "20px 22px",
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg-strong)" }}>
                {editingId ? "Edit endpoint" : "Add self-hosted endpoint"}
              </div>
              <input
                value={label}
                placeholder="Name (e.g. My Gateway)"
                onChange={(e) => setLabel(e.target.value)}
                aria-label="Endpoint name"
                className="klide-field"
                disabled={editingId !== null}
                autoFocus
                style={{ height: 34, padding: "0 12px" }}
              />
              <input
                value={baseUrl}
                placeholder="Base URL (https://llm.example.com/v1)"
                onChange={(e) => setBaseUrl(e.target.value)}
                aria-label="Base URL"
                className="klide-field"
                autoComplete="off"
                style={{ height: 34, padding: "0 12px" }}
              />
              <input
                value={defaultModel}
                placeholder="Default model (optional, e.g. devstral-small-2:24b)"
                onChange={(e) => setDefaultModel(e.target.value)}
                aria-label="Default model"
                className="klide-field"
                autoComplete="off"
                style={{ height: 34, padding: "0 12px" }}
              />
              <input
                // A `${VAR}` reference is non-secret config, so it's shown
                // plainly — there's no token to mask (self-hosted endpoints
                // never store a literal token in the app).
                type="text"
                value={token}
                placeholder={editingId ? "Token reference ${VAR} (blank = keep current)" : "Token reference, e.g. ${DEV_TOKEN} (optional)"}
                onChange={(e) => setToken(e.target.value)}
                aria-label="Bearer token reference"
                className="klide-field"
                autoComplete="off"
                spellCheck={false}
                style={{ height: 34, padding: "0 12px" }}
              />
              <div style={{ fontSize: 11, lineHeight: 1.5, color: "var(--fg-subtle)" }}>
                The bearer token is a reference like <code>{"${DEV_TOKEN}"}</code> —
                put the value in your project's <code>.env</code>{" "}
                (<code>DEV_TOKEN=…</code>), or in <code>~/.klide/.env</code> as a global
                fallback. Klide stores only the reference, never the token, so there's
                no keychain prompt; keep the <code>.env</code> gitignored.
                <br />
                Requests use the OpenAI wire format. The per-model context window in
                Inference settings does not apply here — for a self-hosted Ollama
                endpoint, set the context length server-side (e.g. <code>num_ctx</code>{" "}
                in a Modelfile), or the model's default is used.
              </div>
              {error && (
                <div style={{ fontSize: 12, color: "var(--danger, #c0392b)" }}>{error}</div>
              )}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <GhostButton onClick={resetForm}>Cancel</GhostButton>
                <LinkButton onClick={() => void save()}>
                  {busy ? "…" : editingId ? "Update" : "Add endpoint"}
                </LinkButton>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}

function LocalServerRow({
  provider,
  title,
  defaultModel,
}: {
  provider: string;
  title: string;
  defaultModel: string;
}) {
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval>;
    async function check() {
      try {
        const ok = await invoke<boolean>("ai_local_server_status", { provider });
        setRunning(ok);
      } catch {
        setRunning(false);
      }
    }
    check();
    timer = setInterval(check, 4000);
    return () => clearInterval(timer);
  }, [provider]);

  async function toggle() {
    if (starting) return;
    setError(null);
    setStarting(true);
    try {
      if (running) {
        await invoke("ai_local_server_stop", { provider });
        setRunning(false);
      } else {
        const started = await invoke<boolean>("ai_local_server_start", { provider, model: defaultModel });
        setRunning(started);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setStarting(false);
    }
  }

  const pill = running ? (
    <StatusPill tone="ok">Running</StatusPill>
  ) : (
    <StatusPill tone="idle">Stopped</StatusPill>
  );

  return (
    <Row
      title={title}
      description={error ? error : running ? "Server is reachable on localhost." : "Server is not running. Start it to enable chat."}
      control={
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {pill}
          <button
            onClick={() => void toggle()}
            disabled={starting}
            style={{
              height: 28,
              padding: "0 12px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border-strong)",
              background: running ? "var(--bg-hover)" : "var(--accent)",
              color: running ? "var(--fg-strong)" : "#FFFFFF",
              fontSize: 12,
              fontWeight: 600,
              cursor: starting ? "default" : "pointer",
              opacity: starting ? 0.6 : 1,
              transition: "opacity var(--motion-fast) var(--ease-out)",
            }}
          >
            {starting ? "..." : running ? "Stop" : "Start"}
          </button>
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
  autoTheme,
  onAutoThemeChange,
  lightTheme,
  onLightThemeChange,
  darkTheme,
  onDarkThemeChange,
  aiVisible,
  onAiVisibleChange,
  terminalVisible,
  onTerminalVisibleChange,
  panelLayout,
  onPanelWidthChange,
  onPanelHeightChange,
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
  harnessSettings,
  onHarnessSettingsChange,
  explorerVisible,
  customLayouts,
  onCustomLayoutsChange,
  onApplyLayout,
  onProviderKeyChange,
  initialSection,
  onBack,
}: Props) {
  const isSectionId = (value: string | null | undefined): value is SectionId =>
    sections.some((section) => section.id === value);
  const [settingsProvider, setSettingsProvider] = useState<ProviderId>(
    () => (localStorage.getItem("klide.provider") as ProviderId) || "ollama"
  );

  const [activeSection, setActiveSection] = useState<SectionId>(
    isSectionId(initialSection) ? initialSection : "general"
  );
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
  const [connectionLoading, setConnectionLoading] = useState(false);
  const [modelSupportsReflection, setModelSupportsReflection] = useState(false);

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
    if (activeSection === "subscription") void refreshSubscriptionConnections();
  }, [activeSection]);

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

        <nav style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {sections.map((section) => {
            const active = activeSection === section.id;
            return (
              <button
                key={section.id}
                type="button"
                onClick={() => goToSection(section.id)}
                onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
                style={{
                  height: 32,
                  padding: "0 10px",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  color: active ? "var(--fg-strong)" : "var(--fg-subtle)",
                  background: active ? "var(--bg-hover)" : "transparent",
                  borderRadius: "var(--radius-sm)",
                  justifyContent: "flex-start",
                  fontSize: 13,
                  fontWeight: active ? 500 : 400,
                  border: "none",
                  cursor: "pointer",
                  transition: "background 0.08s ease, color 0.08s ease",
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
      </aside>

      <div
        style={{
          overflow: "auto", minWidth: 0,
        }}
      >
        <div
          style={{
            width: "min(930px, calc(100vw - 360px))",
            margin: "0 auto",
            padding: "32px 28px 64px",
          }}
        >
          <h1
            style={{
              margin: "0 0 32px",
              color: "var(--fg-strong)",
              fontSize: 20,
              lineHeight: 1.2,
              fontWeight: 600,
            }}
          >
            {sectionTitle}
          </h1>

          <Section id="general" active={activeSection} mounted={visitedSections.has("general")}>
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
                          <select
                            value={lightTheme}
                            onChange={(e) => onLightThemeChange(e.target.value as ThemeId)}
                            className="klide-field"
                            style={{
                              padding: "4px 8px",
                              fontSize: 12,
                            }}
                          >
                            {THEMES.filter((t) => !t.isDark).map((t) => (
                              <option key={t.id} value={t.id}>{t.name}</option>
                            ))}
                          </select>
                        }
                      />
                      <Row
                        title="Dark theme"
                        description="Theme used when your system is in dark mode."
                        control={
                          <select
                            value={darkTheme}
                            onChange={(e) => onDarkThemeChange(e.target.value as ThemeId)}
                            className="klide-field"
                            style={{
                              padding: "4px 8px",
                              fontSize: 12,
                            }}
                          >
                            {THEMES.filter((t) => t.isDark).map((t) => (
                              <option key={t.id} value={t.id}>{t.name}</option>
                            ))}
                          </select>
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
                              {isActive && (
                                <span style={{ marginLeft: "auto", width: 7, height: 7, borderRadius: "50%", background: "var(--accent)", flexShrink: 0 }} />
                              )}
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
                  <p style={{ margin: "0 0 10px", color: "var(--fg-subtle)", fontSize: 12, lineHeight: 1.45 }}>
                    Toggle which tools each run mode can call. Disabled tools are hidden from the model entirely.
                  </p>
                  {(["plan", "goal"] as const).map((mode) => (
                    <div key={mode} style={{ marginBottom: 14 }}>
                      <label style={{ display: "block", color: "var(--fg-strong)", fontSize: 12, fontWeight: 600, marginBottom: 5 }}>
                        {mode.charAt(0).toUpperCase() + mode.slice(1)} mode tools
                      </label>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {(["read_file","list_dir","glob","grep","get_git_status","get_git_diff","clean_context","web_search","web_fetch","write_file","create_file","create_skill"] as const).map((tool) => {
                          const key = `${mode}.${tool}`;
                          const overrides = harnessSettings?.toolOverrides ?? {};
                          const enabled = overrides[key] !== false;
                          return (
                            <label
                              key={tool}
                              style={{
                                display: "flex", alignItems: "center", gap: 4,
                                fontSize: 11, color: "var(--fg-subtle)", cursor: "pointer",
                                padding: "3px 7px", borderRadius: "var(--radius-sm)",
                                background: enabled ? "var(--bg-hover)" : "transparent",
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={enabled}
                                onChange={(e) => {
                                  const next = { ...(harnessSettings?.toolOverrides ?? {}), [key]: e.target.checked ? true : false };
                                  onHarnessSettingsChange?.({ ...harnessSettings, toolOverrides: next });
                                }}
                                style={{ accentColor: "var(--accent)" }}
                              />
                              {tool}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                  <p style={{ margin: "10px 0", color: "var(--fg-subtle)", fontSize: 12, lineHeight: 1.45 }}>
                    Override the system prompt per mode. Leave blank to use the built-in defaults.
                  </p>
                  <div style={{ margin: "10px 0 14px" }}>
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
                  </div>
                  {(["chat", "plan", "goal"] as const).map((mode) => (
                    <div key={mode} style={{ marginBottom: 14 }}>
                      <label style={{ display: "block", color: "var(--fg-strong)", fontSize: 12, fontWeight: 600, marginBottom: 5 }}>
                        {mode.charAt(0).toUpperCase() + mode.slice(1)} mode prompt
                      </label>
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
                    control={<CodePill>Process</CodePill>}
                  />
                  <Row
                    title="MLX default model"
                    description="The Start button uses the default model. Change the active model in the AI panel dropdown after the server is running."
                    control={<CodePill>Model</CodePill>}
                  />
                </Panel>
              </SettingBlock>
          </Section>

          <Section id="api" active={activeSection} mounted={visitedSections.has("api")}>
              <SettingBlock title="API Keys">
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
              <SettingBlock title="Self-hosted endpoints">
                <CustomEndpointsBlock onProviderKeyChange={onProviderKeyChange} />
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
                    description="These providers support chat and tool calls over the OpenAI-compatible API."
                    control={<CodePill>Build</CodePill>}
                  />
                </Panel>
              </SettingBlock>
          </Section>

          <Section id="subscription" active={activeSection} mounted={visitedSections.has("subscription")}>
            {connectionLoading && Object.keys(subscriptionStatuses).length === 0 ? (
              <CenteredLoader label="Checking subscriptions…" />
            ) : (
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
                        leading={<ProviderLogo id={provider.id as ProviderId} />}
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
                        leading={<ProviderLogo id={provider.id as ProviderId} />}
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
                            : "OpenCode chooses models inside its own interactive CLI."
                        }
                        control={
                          models.length > 0 ? (
                            <ModelChips models={models} />
                          ) : (
                            <StatusPill tone="idle">Unavailable</StatusPill>
                          )
                        }
                        leading={<ProviderLogo id={provider.id as ProviderId} />}
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
          </Section>

          <Section id="editor" active={activeSection} mounted={visitedSections.has("editor")}>
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

type StatsMetric = "conversations" | "tokens";

// Per-source brand tints for the breakdown bars. Flat hexes (not CSS vars)
// so color-mix can fade them against the panel background.
const STATS_SOURCE_COLOR: Record<RunSource, string> = {
  "claude-code": "#D97757",
  codex: "#7A7A7A",
  opencode: "#3A3A3A",
  omp: "#7C6BAE",
  klide: "var(--accent)",
};

// Opacity steps for model segments within one provider's bar — first model
// wears the full tint, later ones fade toward the background.
const SEGMENT_MIX = [100, 70, 48, 32, 20, 12];

function runTokens(r: Run): number {
  return (r.inputTokens ?? 0) + (r.outputTokens ?? 0);
}

function prettyProvider(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * A number that reads compact ("1.2M") and flips to the exact amount
 * ("1,234,567") on click. Hover shows the exact value either way.
 */
function PreciseNumber({ value, suffix }: { value: number; suffix?: string }) {
  const [precise, setPrecise] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setPrecise((p) => !p)}
      title={`${value.toLocaleString("en-US")}${suffix ? ` ${suffix}` : ""}`}
      style={{
        background: "none",
        border: "none",
        padding: 0,
        margin: 0,
        cursor: "pointer",
        font: "inherit",
        color: "inherit",
      }}
    >
      {precise ? value.toLocaleString("en-US") : formatCompact(value)}
      {suffix ? ` ${suffix}` : ""}
    </button>
  );
}

type ProviderGroup = {
  key: string;
  label: string;
  color: string;
  source: RunSource;
  provider: string | null;
  conversations: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  models: { name: string; conversations: number; tokens: number }[];
};

// The breakdown rows wear real brand marks: external CLIs use their tool's
// logo id directly; Klide groups use the AI provider's (ollama, anthropic…).
function GroupLogo({ group, size = 16 }: { group: ProviderGroup; size?: number }) {
  const id = group.source === "klide" ? group.provider ?? "ollama" : group.source;
  return <ProviderLogo id={id as ProviderId} size={size} />;
}

function MetricToggle({
  value,
  onChange,
}: {
  value: StatsMetric;
  onChange: (m: StatsMetric) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Stats metric"
      style={{
        display: "inline-flex",
        border: "1px solid var(--border-strong)",
        borderRadius: 6,
        overflow: "hidden",
      }}
    >
      {(["conversations", "tokens"] as const).map((m) => (
        <button
          key={m}
          type="button"
          role="tab"
          aria-selected={value === m}
          onClick={() => onChange(m)}
          style={{
            padding: "4px 10px",
            fontSize: 11,
            fontWeight: 500,
            border: "none",
            cursor: "pointer",
            background: value === m ? "var(--bg-hover)" : "transparent",
            color: value === m ? "var(--fg-strong)" : "var(--fg-subtle)",
          }}
        >
          {m === "conversations" ? "Conversations" : "Tokens"}
        </button>
      ))}
    </div>
  );
}

// Weekly histogram of the last 26 weeks. In tokens mode each bar stacks
// input (faded) under output (full accent); in conversations mode it's a
// plain count. Clicking a bar pins its exact numbers below the chart.
function UsageHistogram({ runs, metric }: { runs: Run[]; metric: StatsMetric }) {
  const WEEKS = 26;
  const WEEK_MS = 7 * 86_400_000;
  const [selected, setSelected] = useState<number | null>(null);

  const buckets = useMemo(() => {
    const startMonday = mondayOfWeek(startOfDay(Date.now())) - (WEEKS - 1) * WEEK_MS;
    const buckets = Array.from({ length: WEEKS }, (_, i) => ({
      startMs: startMonday + i * WEEK_MS,
      conversations: 0,
      inputTokens: 0,
      outputTokens: 0,
    }));
    for (const r of runs) {
      const idx = Math.floor((mondayOfWeek(r.createdMs) - startMonday) / WEEK_MS);
      if (idx < 0 || idx >= WEEKS) continue;
      buckets[idx].conversations += 1;
      buckets[idx].inputTokens += r.inputTokens ?? 0;
      buckets[idx].outputTokens += r.outputTokens ?? 0;
    }
    return buckets;
  }, [runs]);

  const valueOf = (b: (typeof buckets)[number]) =>
    metric === "tokens" ? b.inputTokens + b.outputTokens : b.conversations;
  const max = Math.max(1, ...buckets.map(valueOf));
  const sel = selected != null ? buckets[selected] : null;

  // One label at each month change, positioned by week index.
  const monthLabels = useMemo(() => {
    const labels: { i: number; name: string }[] = [];
    let last = -1;
    buckets.forEach((b, i) => {
      const month = new Date(b.startMs).getMonth();
      if (month !== last) {
        labels.push({ i, name: new Date(b.startMs).toLocaleDateString("en-US", { month: "short" }) });
        last = month;
      }
    });
    return labels;
  }, [buckets]);

  const weekLabel = (startMs: number) =>
    `Week of ${new Date(startMs).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

  const chartHeight = 110;

  return (
    <div>
      {/* Bars */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 3,
          height: chartHeight,
        }}
      >
        {buckets.map((b, i) => {
          const total = valueOf(b);
          const isSel = i === selected;
          return (
            <div
              key={b.startMs}
              title={`${weekLabel(b.startMs)}: ${b.conversations} conversations · ${formatCompact(
                b.inputTokens + b.outputTokens,
              )} tokens`}
              onClick={() => setSelected(isSel ? null : i)}
              style={{
                flex: 1,
                minWidth: 0,
                height: "100%",
                display: "flex",
                flexDirection: "column",
                justifyContent: "flex-end",
                cursor: "pointer",
                borderRadius: 3,
                background: isSel ? "var(--bg-hover)" : "transparent",
              }}
            >
              {total > 0 && metric === "tokens" ? (
                <>
                  {/* input above output — output (the model's work) anchors the bar */}
                  <div
                    style={{
                      height: `${(b.inputTokens / max) * 100}%`,
                      background: "color-mix(in srgb, var(--accent) 30%, var(--bg-elevated))",
                      borderRadius: "2px 2px 0 0",
                    }}
                  />
                  <div
                    style={{
                      height: `${(b.outputTokens / max) * 100}%`,
                      minHeight: 2,
                      background: "var(--accent)",
                    }}
                  />
                </>
              ) : total > 0 ? (
                <div
                  style={{
                    height: `${(total / max) * 100}%`,
                    minHeight: 2,
                    background: "var(--accent)",
                    borderRadius: "2px 2px 0 0",
                  }}
                />
              ) : (
                // Empty weeks still get a hairline so the axis reads continuously.
                <div style={{ height: 2, background: "var(--bg)", borderRadius: 1 }} />
              )}
            </div>
          );
        })}
      </div>

      {/* Month labels */}
      <div style={{ position: "relative", height: 16, marginTop: 4 }}>
        {monthLabels.map(({ i, name }) => (
          <span
            key={`${i}-${name}`}
            style={{
              position: "absolute",
              left: `${(i / WEEKS) * 100}%`,
              color: "var(--fg-subtle)",
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              whiteSpace: "nowrap",
            }}
          >
            {name}
          </span>
        ))}
      </div>

      {/* Legend (tokens mode) */}
      {metric === "tokens" && (
        <div
          style={{
            display: "flex",
            gap: 14,
            marginTop: 6,
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: "var(--fg-subtle)",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span
              aria-hidden
              style={{ width: 8, height: 8, borderRadius: 2, background: "var(--accent)" }}
            />
            output
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span
              aria-hidden
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: "color-mix(in srgb, var(--accent) 30%, var(--bg-elevated))",
              }}
            />
            input
          </span>
        </div>
      )}

      {/* Exact numbers for the clicked week */}
      {sel && (
        <div
          style={{
            marginTop: 10,
            paddingTop: 10,
            borderTop: "1px solid var(--border)",
            display: "flex",
            alignItems: "baseline",
            gap: 14,
            fontSize: 11.5,
            fontFamily: "var(--font-mono)",
          }}
        >
          <span style={{ color: "var(--fg-strong)", fontWeight: 600 }}>
            {weekLabel(sel.startMs)}
          </span>
          <span style={{ color: "var(--fg)" }}>
            {sel.conversations.toLocaleString("en-US")} conversations
          </span>
          <span style={{ color: "var(--fg)" }}>
            {sel.inputTokens.toLocaleString("en-US")} tokens in
          </span>
          <span style={{ color: "var(--fg)" }}>
            {sel.outputTokens.toLocaleString("en-US")} tokens out
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => setSelected(null)}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
              color: "var(--fg-subtle)",
              fontSize: 11,
            }}
          >
            clear
          </button>
        </div>
      )}
    </div>
  );
}

// Pre-fetch / loading state for the stats panel. Mirrors the real layout
// (heatmap, histogram, provider rows) as placeholders, with a "Load stats"
// button over it — so the user triggers the (slow) log parse themselves and
// the wait reads as intentional. Placeholders shimmer only while loading.
function StatsSkeleton({
  loading,
  onFetch,
}: {
  loading: boolean;
  onFetch: () => void;
}) {
  const bar = (width: number | string, height: number, extra?: CSSProperties) => (
    <div
      className={loading ? "klide-skeleton" : undefined}
      style={{
        width,
        height,
        borderRadius: 4,
        ...(loading
          ? {}
          : { background: "color-mix(in srgb, var(--fg-dim) 13%, transparent)" }),
        ...extra,
      }}
    />
  );
  // Deterministic, calm-looking histogram bar heights (percent of track).
  const histHeights = [
    30, 44, 38, 52, 60, 48, 66, 72, 58, 80, 70, 90, 84, 76, 64, 88, 78, 92, 70,
    60, 74, 82, 56, 68, 50, 62,
  ];
  return (
    <div style={{ position: "relative" }}>
      {/* The placeholder layout, dimmed and inert until the user loads it. */}
      <div
        aria-hidden
        style={{
          opacity: loading ? 1 : 0.55,
          pointerEvents: "none",
          transition: "opacity var(--motion-med) var(--ease-out)",
        }}
      >
      <SettingBlock title="Activity">
        <Panel>
          <div style={{ padding: "14px 18px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 16,
                marginBottom: 14,
              }}
            >
              {bar("min(60%, 360px)", 12)}
              {bar(108, 22, { borderRadius: 9999 })}
            </div>
            {bar("100%", 96, { borderRadius: 6 })}
          </div>
        </Panel>
      </SettingBlock>

      <SettingBlock title="Usage over time">
        <Panel>
          <div style={{ padding: "14px 18px" }}>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 96 }}>
              {histHeights.map((h, i) => (
                <div
                  key={i}
                  className={loading ? "klide-skeleton klide-rise" : undefined}
                  style={{
                    flex: 1,
                    height: `${h}%`,
                    borderRadius: 2,
                    // Stagger the rise so the bars cascade up on click.
                    ...(loading
                      ? { animationDelay: `${i * 26}ms` }
                      : {
                          background:
                            "color-mix(in srgb, var(--fg-dim) 13%, transparent)",
                        }),
                  }}
                />
              ))}
            </div>
          </div>
        </Panel>
      </SettingBlock>

      <SettingBlock title="Providers & models">
        <Panel>
          {[0, 1, 2].map((gi) => (
            <div
              key={gi}
              style={{
                padding: "14px 18px",
                borderBottom: gi < 2 ? "1px solid var(--border)" : "none",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 16,
                  marginBottom: 8,
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {bar(18, 18, { borderRadius: 4 })}
                  {bar(120, 13)}
                </span>
                {bar(150, 11)}
              </div>
              {bar(`${[88, 64, 40][gi]}%`, 6, { borderRadius: 3, marginBottom: 10 })}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {bar("70%", 11)}
                {bar("52%", 11)}
              </div>
            </div>
          ))}
        </Panel>
      </SettingBlock>
      </div>

      {/* Call-to-action layer: load button (idle) or progress (loading). */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "center",
          paddingTop: 96,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 12,
            textAlign: "center",
            padding: "20px 24px",
            maxWidth: 320,
          }}
        >
          {loading ? (
            <div
              className="ai-msg-in"
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 12,
              }}
            >
              <span className="ai-loader-orbit" aria-hidden>
                <span />
                <span />
                <span />
                <span />
              </span>
              <div style={{ color: "var(--fg-subtle)", fontSize: 12.5 }}>
                Reading session logs…
              </div>
            </div>
          ) : (
            <>
              <div style={{ color: "var(--fg-strong)", fontSize: 14, fontWeight: 600 }}>
                Session stats
              </div>
              <div style={{ color: "var(--fg-subtle)", fontSize: 12.5, lineHeight: 1.45 }}>
                Reading your agent logs takes a moment. Load them when you're ready.
              </div>
              <button
                type="button"
                onClick={onFetch}
                style={{
                  marginTop: 4,
                  background: "var(--control-primary-bg)",
                  color: "var(--control-primary-fg)",
                  border: "none",
                  borderRadius: "var(--radius-md)",
                  padding: "8px 18px",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Load stats
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function StatsSection() {
  // Render instantly from the session cache when it's warm — the parse of all
  // session logs is expensive, so we only pay it on a genuine cold open.
  // Don't auto-fetch on open — parsing every session log is slow, and an
  // unprompted wait reads as lag. Show the skeleton with a "Load stats" button
  // so the wait is the user's own action. A warm cache renders instantly.
  const cached = peekAgentRunsCache(1000, 0);
  const [runs, setRuns] = useState<Run[]>(cached ?? []);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(cached !== null);
  const [metric, setMetric] = useState<StatsMetric>("conversations");
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const all = await fetchAgentRunsCached(1000, 0);
      setRuns(all);
    } catch {
      // Outside Tauri (plain Vite) — leave the section empty.
    } finally {
      setLoading(false);
      setFetched(true);
    }
  }, []);

  // Stable weight fn so the heatmap's useMemo doesn't recompute every render.
  const tokenWeight = useCallback((r: Run) => runTokens(r), []);

  const groups = useMemo<ProviderGroup[]>(() => {
    const map = new Map<string, ProviderGroup & { byModel: Map<string, { conversations: number; tokens: number }> }>();
    for (const r of runs) {
      // Klide runs split by their AI provider (Ollama, Anthropic…);
      // external CLIs are one group each.
      const isKlide = r.source === "klide";
      const key = isKlide ? `klide:${r.provider ?? ""}` : r.source;
      let g = map.get(key);
      if (!g) {
        g = {
          key,
          label: isKlide
            ? r.provider
              ? `Klide · ${prettyProvider(r.provider)}`
              : "Klide"
            : SOURCE_LABEL[r.source],
          color: STATS_SOURCE_COLOR[r.source],
          source: r.source,
          provider: r.provider ?? null,
          conversations: 0,
          tokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          models: [],
          byModel: new Map(),
        };
        map.set(key, g);
      }
      const tokens = runTokens(r);
      g.conversations += 1;
      g.tokens += tokens;
      g.inputTokens += r.inputTokens ?? 0;
      g.outputTokens += r.outputTokens ?? 0;
      const model = r.model?.trim() || "unknown";
      const m = g.byModel.get(model) ?? { conversations: 0, tokens: 0 };
      m.conversations += 1;
      m.tokens += tokens;
      g.byModel.set(model, m);
    }
    const valueOf = (x: { conversations: number; tokens: number }) =>
      metric === "tokens" ? x.tokens : x.conversations;
    return [...map.values()]
      .map(({ byModel, ...g }) => ({
        ...g,
        models: [...byModel.entries()]
          .map(([name, v]) => ({ name, ...v }))
          .sort((a, b) => valueOf(b) - valueOf(a)),
      }))
      .sort((a, b) => valueOf(b) - valueOf(a));
  }, [runs, metric]);

  const valueOf = (x: { conversations: number; tokens: number }) =>
    metric === "tokens" ? x.tokens : x.conversations;
  const maxGroupValue = Math.max(1, ...groups.map(valueOf));

  // Exact numbers for the clicked heatmap day.
  const dayDetail = useMemo(() => {
    if (!selectedDay) return null;
    let conversations = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    for (const r of runs) {
      if (msToKey(r.createdMs) !== selectedDay) continue;
      conversations += 1;
      inputTokens += r.inputTokens ?? 0;
      outputTokens += r.outputTokens ?? 0;
    }
    return { conversations, inputTokens, outputTokens };
  }, [runs, selectedDay]);

  if (!fetched) {
    return <StatsSkeleton loading={loading} onFetch={load} />;
  }

  return (
    <>
      <SettingBlock title="Activity">
        <Panel>
          <div style={{ padding: "14px 18px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 16,
                marginBottom: 14,
              }}
            >
              <div style={{ color: "var(--fg-subtle)", fontSize: 12.5, lineHeight: 1.4 }}>
                Agent sessions across Klide, Claude Code, Codex and OpenCode over the last year.
              </div>
              <MetricToggle value={metric} onChange={setMetric} />
            </div>
            <div style={{ overflowX: "auto", paddingBottom: 4 }}>
              <ActivityHeatmap
                runs={runs}
                weeks={52}
                weight={metric === "tokens" ? tokenWeight : undefined}
                unit={metric}
                selectedDay={selectedDay}
                onSelectDay={setSelectedDay}
              />
            </div>
            {selectedDay && dayDetail && (
              <div
                style={{
                  marginTop: 10,
                  paddingTop: 10,
                  borderTop: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "baseline",
                  gap: 14,
                  fontSize: 11.5,
                  fontFamily: "var(--font-mono)",
                }}
              >
                <span style={{ color: "var(--fg-strong)", fontWeight: 600 }}>
                  {new Date(selectedDay + "T00:00:00").toLocaleDateString("en-US", {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </span>
                <span style={{ color: "var(--fg)" }}>
                  {dayDetail.conversations.toLocaleString("en-US")} conversations
                </span>
                <span style={{ color: "var(--fg)" }}>
                  {dayDetail.inputTokens.toLocaleString("en-US")} tokens in
                </span>
                <span style={{ color: "var(--fg)" }}>
                  {dayDetail.outputTokens.toLocaleString("en-US")} tokens out
                </span>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  onClick={() => setSelectedDay(null)}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    color: "var(--fg-subtle)",
                    fontSize: 11,
                  }}
                >
                  clear
                </button>
              </div>
            )}
          </div>
        </Panel>
      </SettingBlock>

      <SettingBlock title="Usage over time">
        <Panel>
          <div style={{ padding: "14px 18px" }}>
            <UsageHistogram runs={runs} metric={metric} />
          </div>
        </Panel>
      </SettingBlock>

      <SettingBlock title="Providers & models">
        <Panel>
          {!loading && groups.length === 0 && (
            <div style={{ padding: "14px 18px", color: "var(--fg-subtle)", fontSize: 12 }}>
              No agent sessions found yet. Run a conversation and come back.
            </div>
          )}
          {groups.map((g, gi) => {
            const groupValue = valueOf(g);
            return (
              <div
                key={g.key}
                style={{
                  padding: "14px 18px",
                  borderBottom: gi < groups.length - 1 ? "1px solid var(--border)" : "none",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 16,
                    marginBottom: 8,
                  }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <GroupLogo group={g} />
                    <span style={{ color: "var(--fg-strong)", fontSize: 13, fontWeight: 500 }}>
                      {g.label}
                    </span>
                  </span>
                  <span
                    style={{
                      color: "var(--fg-subtle)",
                      fontSize: 11.5,
                      fontFamily: "var(--font-mono)",
                      whiteSpace: "nowrap",
                      display: "inline-flex",
                      gap: 10,
                    }}
                  >
                    <PreciseNumber value={g.conversations} suffix="conversations" />
                    {g.tokens > 0 && (
                      <>
                        <span aria-hidden>·</span>
                        <PreciseNumber value={g.inputTokens} suffix="in" />
                        <span aria-hidden>·</span>
                        <PreciseNumber value={g.outputTokens} suffix="out" />
                      </>
                    )}
                  </span>
                </div>

                {/* Length = this provider's share of the top provider; segments = models. */}
                <div
                  style={{
                    height: 6,
                    borderRadius: 3,
                    background: "var(--bg)",
                    overflow: "hidden",
                    marginBottom: 10,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      height: "100%",
                      width: `${Math.max(1.5, (groupValue / maxGroupValue) * 100)}%`,
                      borderRadius: 3,
                      overflow: "hidden",
                    }}
                  >
                    {g.models.slice(0, SEGMENT_MIX.length).map((m, i) => (
                      <div
                        key={m.name}
                        style={{
                          width: `${(valueOf(m) / Math.max(1, groupValue)) * 100}%`,
                          background: `color-mix(in srgb, ${g.color} ${SEGMENT_MIX[i]}%, var(--bg-elevated))`,
                        }}
                      />
                    ))}
                  </div>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {g.models.slice(0, SEGMENT_MIX.length).map((m, i) => (
                    <div
                      key={m.name}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        fontSize: 11.5,
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 2,
                          flexShrink: 0,
                          background: `color-mix(in srgb, ${g.color} ${SEGMENT_MIX[i]}%, var(--bg-elevated))`,
                        }}
                      />
                      <span
                        style={{
                          color: "var(--fg)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {m.name}
                      </span>
                      <span style={{ flex: 1 }} />
                      <span style={{ color: "var(--fg-subtle)", whiteSpace: "nowrap" }}>
                        {metric === "tokens" ? (
                          <PreciseNumber value={m.tokens} suffix="tokens" />
                        ) : (
                          <PreciseNumber value={m.conversations} suffix="conv" />
                        )}
                      </span>
                    </div>
                  ))}
                  {g.models.length > SEGMENT_MIX.length && (
                    <div style={{ color: "var(--fg-subtle)", fontSize: 11, paddingLeft: 16 }}>
                      +{g.models.length - SEGMENT_MIX.length} more models
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </Panel>
      </SettingBlock>
    </>
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

function BarChartIcon() {
  return (
    <IconBase>
      <rect x="3.5" y="13" width="3" height="8" rx="0.8" />
      <rect x="8.5" y="9" width="3" height="12" rx="0.8" />
      <rect x="13.5" y="5" width="3" height="16" rx="0.8" />
      <rect x="18.5" y="8" width="3" height="13" rx="0.8" />
    </IconBase>
  );
}

function ServerIcon() {
  return (
    <IconBase>
      <rect x="3.5" y="4.5" width="17" height="5" rx="1.2" />
      <rect x="3.5" y="14.5" width="17" height="5" rx="1.2" />
      <circle cx="7" cy="7" r="1" />
      <circle cx="7" cy="17" r="1" />
    </IconBase>
  );
}
