// Mission Control's icon vocabulary — source/brand marks for run rows and the
// line-glyph set its action bars use. Extracted from MissionControl.tsx so the
// board file holds board logic, not 500 lines of SVG. Provider/brand marks are
// hand-drawn on purpose (the src/icons.tsx convention); the brand *paths*
// themselves still come from ai/icons, which owns every brand mark.

import React from "react";
import { BRAND_LOGO_PATHS, BrandImage, KlideMark, ProviderLogo } from "../ai/icons";
import { ProviderModelMark, resolveModelLogo } from "../../modelIdentity";
import type { ProviderId } from "../../agent/types";
import type { RunKind, RunSource } from "../../runs";
import { isDelegateId } from "../../delegates";
import { Tooltip } from "../Tooltip";

/* ────────────────────────────── brand + source marks ─────────────────────── */

// Official brand marks served from /public, so each run wears its tool's real
// logo instead of a flat color. Used for model badges in the RunRow subtitle
// and for source avatars (Claude Code, Codex).
export function ClaudeCodeLogo({ size = 13 }: { size?: number }) {
  return <BrandImage src="/claude-code-logo.png" size={size} />;
}
// Klide's own brand mark (the app icon). Worn by Klide-harness runs that go
// through a model proxy like OpenRouter, where the model could be anything —
// the run belongs to Klide's harness, so it carries the Klide mark, not the
// underlying maker's logo.
export function KlideLogo({ size = 13 }: { size?: number }) {
  return <KlideMark size={size} />;
}
// Codex and Z.AI marks are white-on-transparent — invert them on light themes
// via the white-logo-img rule in tokens.css so they stay visible everywhere.
export function CodexLogo({ size = 13 }: { size?: number }) {
  return <BrandImage className="white-logo-img" src="/codex-logo.png" size={size} />;
}
// Oh My Pi mark — uses the same ProviderLogo(id="omp") as the AI panel
// dropdown, so the run list and the AI panel show the same mark.
export function OmpLogo({ size = 13 }: { size?: number }) {
  return <ProviderLogo id="omp" size={size} />;
}

// Anthropic company mark, hardcoded in Anthropic orange (#D97757). The
// A-shape is filled on the path directly (not via `currentColor`) so the
// brand color can never be defeated by an inherited CSS rule.

export function AnthropicMark({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <path
        d={BRAND_LOGO_PATHS.anthropic}
        fill="#D97757"
        style={{ fill: "#D97757" }}
      />
    </svg>
  );
}

export function ModelBadge({ model, size = 13 }: { model: string; size?: number }) {
  return resolveModelLogo(model, size);
}

export function providerMark(provider: string | null | undefined, size: number): React.ReactElement | null {
  return provider ? <ProviderLogo id={provider as ProviderId} size={size} /> : null;
}

// Company marks for the main run avatar: the avatar wears the company
// (Anthropic, OpenAI), while the model badge in the subtitle wears the tool
// (Claude Code, Codex). The path itself comes from `ai/icons`, which owns every
// brand mark — this file used to carry two more copies of the same 2 KB string.
const BRAND_PATH: Partial<Record<RunSource, string>> = {
  "claude-code": BRAND_LOGO_PATHS.anthropic ?? "",
};

// A small inline checkmark-in-square — used for todos. We want this to read
// at a glance as "task to do", not as any particular agent or tool.
const TASK_AVATAR_PATH =
  "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm0 2v14h14V5H5zm3.3 7.7l1.4-1.4 1.8 1.8 4.5-4.5 1.4 1.4-5.9 5.9-3.2-3.2z";

export function SourceLogo({
  source,
  kind,
  model,
  provider,
  size = 14,
}: {
  source: RunSource;
  kind?: RunKind;
  model?: string | null;
  provider?: string | null;
  size?: number;
}) {
  // Tasks always wear the task mark — even after dispatch — so a row reads
  // as "this todo is being worked on by Claude Code", not "this is a Claude
  // Code session".
  if (kind === "task") {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
        style={{ color: "var(--fg-subtle)" }}
      >
        <path d={TASK_AVATAR_PATH} />
      </svg>
    );
  }
  // Klide AI-panel conversations still have a concrete provider/harness
  // (Claude Code, Codex, Ollama, OpenAI, OpenRouter, custom:*). Preserve that
  // identity in Mission Control instead of collapsing every convo to the
  // generic Klide spark.
  if (source === "klide") {
    const mark = providerMark(provider, size);
    if (mark) {
      return (
        <span style={{ width: size, height: size, display: "grid", placeItems: "center", flexShrink: 0 }}>
          {mark}
        </span>
      );
    }
  }
  if (source === "codex") {
    return <CodexLogo size={size} />;
  }
  // Claude Code's harness mark is the main logo on the run row; the
  // Anthropic company A lives in the subtitle badge (orange).
  if (source === "claude-code") {
    return <ClaudeCodeLogo size={size} />;
  }
  // Oh My Pi's own mark — bold wordmark in omp purple.
  if (source === "omp") {
    return <OmpLogo size={size} />;
  }
  // Every other Delegate (Amp, Cursor, Factory, Copilot, Hermes) wears its own
  // mark — they route to several makers' models, but the row is still the
  // CLI's. Without this they fell through to the anonymous spark.
  if (source !== "opencode" && isDelegateId(source)) {
    return <ProviderLogo id={source} size={size} />;
  }
  const path = BRAND_PATH[source];
  const color = "var(--fg-strong)";
  if (path) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
        style={{ color }}
      >
        <path d={path} />
      </svg>
    );
  }
  // OpenCode wears its own two-tone logo (ProviderLogo owns the light/dark
  // variants and the tokens.css theme-swap), paired with the model's maker:
  // every model in its catalogue comes from someone else, so the CLI mark on
  // its own leaves the useful half of the row unsaid. `ProviderModelMark`
  // falls back to the bare CLI mark when the model names no maker, and at
  // sizes too small for a satellite.
  if (source === "opencode") {
    return <ProviderModelMark provider="opencode" model={model} size={size} />;
  }
  // Other Klide runs wear the logo of the model they used — Ollama for local
  // lfm2.5/llama, OpenAI for gpt, Anthropic for claude, etc. — so the board
  // reads as "which model ran this". Falls back to the quiet spark when the
  // model is unknown or absent.
  if (model) {
    const logo = resolveModelLogo(model, size);
    if (logo) {
      return (
        <span style={{ width: size, height: size, display: "grid", placeItems: "center", flexShrink: 0 }}>
          {logo}
        </span>
      );
    }
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ color }}
    >
      <path d="M12 3.5l1.6 4.4L18 9.5l-4.4 1.6L12 15.5l-1.6-4.4L6 9.5l4.4-1.6L12 3.5z" />
    </svg>
  );
}

export function RunAvatar({
  source,
  kind,
  model,
  provider,
  size = 22,
}: {
  source: RunSource;
  kind?: RunKind;
  model?: string | null;
  provider?: string | null;
  size?: number;
}) {
  return (
    <SourceLogo source={source} kind={kind} model={model} provider={provider} size={size} />
  );
}

// Source filter mark. Delegates (claude-code/codex/opencode/omp) are real
// ProviderIds with logos; the native "klide" source is NOT a ProviderId, so it
// would hit ProviderLogo's fallback circle — render the Klide mark instead.
export function SourceMark({ source, size = 16 }: { source: RunSource; size?: number }) {
  if (source === "klide") {
    return <KlideMark className="provider-logo-img" size={size} />;
  }
  return <ProviderLogo id={source as ProviderId} size={size} />;
}

/* ────────────────────────────── action atoms ─────────────────────────────── */

export function ActionButton({
  label,
  primary,
  disabled,
  onClick,
}: {
  label: string;
  primary?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      title={disabled && !onClick ? "Not wired yet" : undefined}
      style={{
        fontSize: 12,
        fontWeight: primary ? 560 : 400,
        padding: "5px 12px",
        borderRadius: "var(--radius-sm)",
        border: `1px solid ${primary && !disabled ? "var(--accent)" : "var(--border)"}`,
        color: disabled ? "var(--fg-subtle)" : primary ? "var(--control-primary-fg)" : "var(--fg)",
        background: primary && !disabled ? "var(--accent)" : "transparent",
        opacity: disabled ? 0.55 : 1,
        cursor: disabled ? "default" : "pointer",
        transition: "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), filter var(--motion-fast) var(--ease-out)",
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        if (primary) e.currentTarget.style.filter = "brightness(1.08)";
        else { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.borderColor = "var(--border-strong)"; }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.filter = "none";
        if (!primary) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderColor = "var(--border)"; }
      }}
    >
      {label}
    </button>
  );
}

// How much an action icon grows under the pointer.
const HOVER_ZOOM = 1.45;

// Icon-only action button — the detail-pane action bar reads as a tidy row of
// glyphs (and provider logos) rather than a wall of text buttons. The label is
// surfaced via tooltip + aria-label so it stays accessible.
//   tone="primary"  → accent ring + soft fill (the headline action: Resume)
//   tone="success"  → accent border, used for transient "done" feedback
export function IconActionButton({
  icon,
  label,
  description,
  tone = "default",
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  /** A muted second tooltip line — what the action does, when its name alone
   *  doesn't say (an agent's own mark names the agent, not the verb). */
  description?: React.ReactNode;
  tone?: "default" | "primary" | "success";
  disabled?: boolean;
  onClick?: () => void;
}) {
  const accent = tone === "primary" || tone === "success";
  // These buttons are icon-only: the label is the only thing that says which
  // agent a mark belongs to, or whether a glyph forks, merges, or archives.
  // A themed tooltip carries it — the native `title=` waited half a second,
  // ignored the design system, and floated wherever the OS put it.
  return (
    <Tooltip label={label} description={description}>
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        aria-label={label}
        style={{
          width: 28,
          height: 28,
          flexShrink: 0,
          display: "grid",
          placeItems: "center",
          border: "none",
          padding: 0,
          color: accent ? "var(--accent)" : "var(--fg-subtle)",
          background: "transparent",
          opacity: disabled ? 0.45 : 1,
          cursor: disabled ? "default" : "pointer",
          transition: "color 160ms var(--ease-out)",
        }}
        onMouseEnter={(e) => {
          if (disabled) return;
          const art = e.currentTarget.firstElementChild as HTMLElement | null;
          if (art) art.style.transform = "scale(1)";
          if (!accent) e.currentTarget.style.color = "var(--fg)";
        }}
        onMouseLeave={(e) => {
          const art = e.currentTarget.firstElementChild as HTMLElement | null;
          if (art) art.style.transform = `scale(${1 / HOVER_ZOOM})`;
          if (!accent) e.currentTarget.style.color = "var(--fg-subtle)";
        }}
      >
        {/* Drawn at hover size and shrunk at rest: a transform scales the
            bitmap WebKit already painted, so growing a 16px logo on hover
            blurred it. Shrinking a large paint stays sharp, and the hover
            state is the icon at its native resolution. */}
        <span
          style={{
            display: "grid",
            placeItems: "center",
            zoom: HOVER_ZOOM,
            transform: `scale(${1 / HOVER_ZOOM})`,
            transformOrigin: "center bottom",
            transition: "transform 220ms cubic-bezier(0.22, 1, 0.36, 1)",
          }}
        >
          {icon}
        </span>
      </button>
    </Tooltip>
  );
}

// Shared svg frame for the action-bar glyphs — line icons at 24-grid, 14px.
export function Glyph({
  children,
  size = 14,
  fill = false,
  sw = 1.7,
}: {
  children: React.ReactNode;
  size?: number;
  fill?: boolean;
  sw?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? "currentColor" : "none"}
      stroke={fill ? "none" : "currentColor"}
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const PencilGlyph = <Glyph><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></Glyph>;
export const CheckGlyph = <Glyph sw={2}><path d="m20 6-11 11-5-5" /></Glyph>;
export const ArchiveGlyph = <Glyph><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" /><path d="M10 12h4" /></Glyph>;
export const ExportGlyph = <Glyph><path d="M12 15V3" /><path d="m8 7 4-4 4 4" /><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></Glyph>;
export const ForkGlyph = <Glyph><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="12" cy="18" r="2.5" /><path d="M6 8.5v1a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-1" /><path d="M12 11.5v4" /></Glyph>;
export const WorktreeGlyph = <Glyph><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><path d="M6 8.5v7" /><circle cx="18" cy="9" r="2.5" /><path d="M18 11.5a6 6 0 0 1-6 6" /></Glyph>;
export const MergeGlyph = <Glyph><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="9" r="2.5" /><path d="M6 8.5v7" /><path d="M6 12a6 6 0 0 0 6-6h3.5" /></Glyph>;
export const CompareGlyph = <Glyph><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M13 6h3a2 2 0 0 1 2 2v7" /><path d="m16 9-3-3 3-3" /><path d="M11 18H8a2 2 0 0 1-2-2V9" /><path d="m8 15 3 3-3 3" /></Glyph>;
export const DiffGlyph = <Glyph><path d="M12 4v8" /><path d="M8 8h8" /><path d="M6 20h12" /></Glyph>;
export const MemoryGlyph = <Glyph><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z" /></Glyph>;
export const CopyGlyph = <Glyph><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></Glyph>;
export const FolderGlyph = <Glyph><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z" /></Glyph>;
// A document bearing a check — the run's proof, not just its words.
export const EvidenceGlyph = <Glyph><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /><path d="m9 15 2 2 4-4" /></Glyph>;

// Micro glyphs for the review bar — 11px so they sit flush with the 10px mono
// counts they annotate.
export const TurnsGlyph = (
  <Glyph size={11}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
  </Glyph>
);
export const ToolRunGlyph = (
  <Glyph size={11}>
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </Glyph>
);
export const NotesGlyph = (
  <Glyph size={11}>
    <path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11l5-5V5a2 2 0 0 0-2-2Z" />
    <path d="M15 21v-4a2 2 0 0 1 2-2h4" />
  </Glyph>
);

export function SendIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}

export function DismissIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

export function RefreshIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 4v5h-5" />
    </svg>
  );
}

export function SearchIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}
