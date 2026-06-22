import { type ReactNode } from "react";

type Props = {
  command: string;
  onReject: () => void;
  onApproveOnce: () => void;
  /** Approve this exact command for the rest of the run (allowlist, session). */
  onApproveForRun?: () => void;
  /** Approve this exact command for future runs in this workspace (project
   *  allowlist, persisted). */
  onApproveForProject?: () => void;
};

/** A bare icon action — no container, just the glyph, coloring on hover. Keeps
 *  the command card minimal per the design direction. */
function BareAction({
  label,
  tone,
  onClick,
  children,
}: {
  label: string;
  tone: "danger" | "accent" | "neutral";
  onClick: () => void;
  children: ReactNode;
}) {
  const hoverFg = tone === "danger" ? "#b8323a" : tone === "accent" ? "var(--accent)" : "var(--fg-strong)";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{
        flexShrink: 0,
        width: 20,
        height: 20,
        display: "grid",
        placeItems: "center",
        padding: 0,
        border: "none",
        background: "transparent",
        color: "var(--fg-subtle)",
        cursor: "pointer",
        transition: "color var(--motion-fast) var(--ease-out)",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.color = hoverFg)}
      onMouseLeave={(e) => (e.currentTarget.style.color = "var(--fg-subtle)")}
    >
      {children}
    </button>
  );
}

/** Shell-command approval — minimal: the command in mono with a `$` prompt and
 *  bare icon actions (cancel ✗, optional approve-for-run 📌, optional
 *  approve-for-project 🗂, approve-once ✓). No heavy framing, no icon
 *  containers. Lives inline under the requesting turn. */
export function InlineCommandReview({
  command,
  onReject,
  onApproveOnce,
  onApproveForRun,
  onApproveForProject,
}: Props) {
  return (
    <div
      className="ai-qa-card"
      style={{
        // A touch narrower than the composer below it, centered.
        margin: "0 16px 8px",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 10px",
        borderRadius: 10,
        border: "1px solid var(--border)",
        background: "color-mix(in srgb, var(--bg-elevated) 90%, transparent)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          lineHeight: 1.5,
          color: "var(--fg-strong)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={command}
      >
        <span style={{ color: "var(--fg-dim)", userSelect: "none" }}>$ </span>
        {command}
      </span>
      <span style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>
        <BareAction label="Cancel" tone="danger" onClick={onReject}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </BareAction>
        {onApproveForRun && (
          <BareAction label="Approve for this run" tone="neutral" onClick={onApproveForRun}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="17" x2="12" y2="22" />
              <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
            </svg>
          </BareAction>
        )}
        {onApproveForProject && (
          <BareAction label="Approve for this project" tone="neutral" onClick={onApproveForProject}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
            </svg>
          </BareAction>
        )}
        <BareAction label="Approve" tone="accent" onClick={onApproveOnce}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </BareAction>
      </span>
    </div>
  );
}
