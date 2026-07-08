// Settings design primitives — the shared vocabulary every settings
// section is built from: the Section visibility wrapper, SettingBlock/
// Panel/Row scaffolding, input controls (Toggle, Segmented, Select, choice
// cards, theme chips, steppers, ranges) and small text/icon helpers.
// Extracted from SettingsPanel.tsx; purely presentational.

import { type ReactNode } from "react";
import type { ThemeId } from "../../theme";
import { SIZE_OPTIONS, type RegionSize } from "../../layouts";

// A section's subtree only mounts once its tab has been visited (`mounted`),
// then stays mounted (hidden via display) so re-selecting it is instant and
// in-progress edits survive a tab switch. Deferring the mount is what keeps
// Settings opening fast: the API / Local-AI sections fire per-provider status
// `invoke`s on mount, so we don't pay for them until the user goes there.
export function Section({
  id,
  active,
  mounted = true,
  children,
}: {
  id: string;
  active: string;
  mounted?: boolean;
  children: ReactNode;
}) {
  return (
    <div style={{ display: id === active ? "block" : "none" }}>
      {mounted ? children : null}
    </div>
  );
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function SettingBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="klide-settings-section">
      <h2 className="klide-settings-heading">{title}</h2>
      {children}
    </section>
  );
}

export function Panel({ children }: { children: ReactNode }) {
  return <div className="klide-surface">{children}</div>;
}

export function Row({
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

// A flat text-tab row — one-click choice across a small ladder of options,
// the premium alternative to a free-text number field. The first option is
// the "off / auto / default" sentinel (value `undefined`); the active option
// carries a 2px accent underline.
export function Segmented({
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
              padding: "0 9px",
              borderRadius: "var(--radius-sm)",
              border: "none",
              borderBottom: `2px solid ${active ? "var(--accent)" : "transparent"}`,
              cursor: disabled ? "not-allowed" : "pointer",
              fontSize: 11.5,
              fontWeight: active ? 600 : 500,
              letterSpacing: "0.01em",
              color: disabled ? "var(--fg-dim)" : active ? "var(--fg-strong)" : "var(--fg-subtle)",
              background: "transparent",
              transition:
                "color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
            }}
            onMouseEnter={(e) => {
              if (!active && !disabled) {
                e.currentTarget.style.color = "var(--fg-strong)";
                e.currentTarget.style.background = "var(--bg-hover)";
              }
            }}
            onMouseLeave={(e) => {
              if (!active && !disabled) {
                e.currentTarget.style.color = "var(--fg-subtle)";
                e.currentTarget.style.background = "transparent";
              }
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export function Toggle({
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

export function Select({
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

export function ChoiceCards<T extends string>({
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

export function ThemeSwatch({ colors, size = 26 }: { colors: string[]; size?: number }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: "var(--radius-xs)",
        border: "1px solid var(--border-strong)",
        overflow: "hidden",
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gridTemplateRows: "1fr 1fr",
        flexShrink: 0,
      }}
    >
      {colors.map((color) => (
        <span key={color} style={{ background: color }} />
      ))}
    </span>
  );
}

// A horizontal set of selectable theme options — swatch + name in a flat
// hairline row. The premium replacement for a native <select>: you see each
// theme's palette at a glance and pick in one click. The active option carries
// a stronger border + text.
export function ThemeChips({
  value,
  options,
  onChange,
  label,
}: {
  value: ThemeId;
  options: { id: ThemeId; name: string; swatches: string[] }[];
  onChange: (value: ThemeId) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      style={{ display: "flex", flexWrap: "wrap", gap: 7, justifyContent: "flex-end" }}
    >
      {options.map((opt) => {
        const active = opt.id === value;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.id)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              height: 34,
              padding: "0 12px 0 7px",
              borderRadius: "var(--radius-sm)",
              cursor: "pointer",
              border: `1px solid ${active ? "var(--border-strong)" : "var(--border)"}`,
              background: "var(--bg-elevated)",
              color: active ? "var(--fg-strong)" : "var(--fg-subtle)",
              fontSize: 12.5,
              fontWeight: active ? 600 : 500,
              transition: "background 0.12s ease, border-color 0.12s ease, color 0.12s ease",
            }}
          >
            <ThemeSwatch colors={opt.swatches} size={18} />
            {opt.name}
          </button>
        );
      })}
    </div>
  );
}

// A precise − value + stepper for small numeric ranges (font size, etc.) where
// a slider is fiddly. Quieter and more exact than dragging; the value reads as
// tabular so the control doesn't reflow as digits change.
export function Stepper({
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
  suffix?: string;
  label: string;
}) {
  const set = (next: number) => onChange(clamp(next, min, max));
  const btn = (dir: -1 | 1, glyph: string, aria: string, atEdge: boolean) => (
    <button
      type="button"
      aria-label={aria}
      disabled={atEdge}
      onClick={() => set(value + dir * step)}
      style={{
        width: 30,
        height: 30,
        display: "grid",
        placeItems: "center",
        border: "none",
        background: "transparent",
        borderRadius: 999,
        color: atEdge ? "var(--fg-dim)" : "var(--fg-strong)",
        cursor: atEdge ? "not-allowed" : "pointer",
        fontSize: 16,
        lineHeight: 1,
      }}
      onMouseEnter={(e) => {
        if (!atEdge) e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {glyph}
    </button>
  );
  return (
    <div
      role="group"
      aria-label={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 2,
        padding: 2,
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--border-strong)",
        background: "color-mix(in srgb, var(--bg-elevated) 88%, transparent)",
      }}
    >
      {btn(-1, "−", `Decrease ${label}`, value <= min)}
      <span
        style={{
          minWidth: 58,
          textAlign: "center",
          color: "var(--fg-strong)",
          fontSize: 13,
          fontWeight: 600,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
        {suffix}
      </span>
      {btn(1, "+", `Increase ${label}`, value >= max)}
    </div>
  );
}

export function Range({
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

export function SizePicker({
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

export function GhostButton({
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

export function LinkButton({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="klide-button klide-button-secondary"
      style={{
        height: 32,
        ...(disabled ? { opacity: 0.5, cursor: "not-allowed" } : null),
      }}
    >
      {children}
    </button>
  );
}

export function CodeText({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        color: "var(--fg-subtle)",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

export function CenteredLoader({ label }: { label?: string }) {
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

export function StatusText({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "idle";
  children: ReactNode;
}) {
  const color =
    tone === "ok" ? "var(--success)" : tone === "warn" ? "var(--warning)" : "var(--fg-subtle)";
  return (
    <span
      style={{
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

export function ModelList({ models, max }: { models: string[]; max?: number }) {
  const shown = max ? models.slice(0, max) : models;
  const hidden = models.length - shown.length;
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "flex-end",
        alignItems: "baseline",
        columnGap: 6,
        rowGap: 2,
        maxWidth: 420,
      }}
    >
      {shown.map((model, i) => (
        <span key={model} style={{ display: "inline-flex", alignItems: "baseline", gap: 6 }}>
          {i > 0 && (
            <span aria-hidden style={{ color: "var(--fg-dim)" }}>
              ·
            </span>
          )}
          <CodeText>{model}</CodeText>
        </span>
      ))}
      {hidden > 0 && (
        <span style={{ fontSize: 11, color: "var(--fg-dim)", whiteSpace: "nowrap" }}>
          + {hidden} more
        </span>
      )}
    </div>
  );
}

export function PencilIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

export function TrashIcon({ size = 14 }: { size?: number }) {
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
export function IconButton({
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
        e.currentTarget.style.color = danger ? "var(--danger)" : "var(--fg-strong)";
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

