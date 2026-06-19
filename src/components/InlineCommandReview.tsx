import { type ReactNode } from "react";

type Props = {
  command: string;
  onReject: () => void;
  onApproveOnce: () => void;
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
 *  three bare icon actions (cancel ✗, approve-for-run 📌, approve-once ✓). No
 *  heavy framing, no icon containers. Lives inline under the requesting turn. */
export function InlineCommandReview({ command, onReject, onApproveOnce }: Props) {
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
        <BareAction label="Approve" tone="accent" onClick={onApproveOnce}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </BareAction>
      </span>
    </div>
  );
}
