import { useMemo } from "react";
import { diffLines, Change } from "diff";

export type InlineDiffEdit = {
  path: string;
  oldContent: string;
  newContent: string;
  isCreate: boolean;
  /** Optional advisory note from the harness (e.g. a staleness warning when
   *  the file changed since the agent last read it). Shown as a banner. */
  reason?: string;
};

type Props = {
  edit: InlineDiffEdit;
  onApply: () => void;
  onReject: () => void;
};

/** Compact, in-panel accept/reject card for a proposed file edit or creation.
 *  Lives in the AI panel's footer alongside the run-command and question cards
 *  — same `ai-qa-card` look, no full-screen overlay. The diff body scrolls
 *  on its own so a large change can't push the composer off-screen. */
export function InlineDiffCard({ edit, onApply, onReject }: Props) {
  const changes: Change[] = useMemo(
    () => diffLines(edit.oldContent, edit.newContent),
    [edit.oldContent, edit.newContent]
  );

  const stats = changes.reduce(
    (acc, c) => {
      const lines = c.value.split("\n").length - (c.value.endsWith("\n") ? 1 : 0);
      if (c.added) acc.added += lines;
      else if (c.removed) acc.removed += lines;
      return acc;
    },
    { added: 0, removed: 0 }
  );

  const fileName = edit.path.split("/").pop() || edit.path;

  return (
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
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            color: "var(--fg-strong)",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
          }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ color: "var(--accent)" }}
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            {edit.isCreate ? (
              <>
                <line x1="12" y1="13" x2="12" y2="17" />
                <line x1="10" y1="15" x2="14" y2="15" />
              </>
            ) : (
              <line x1="9" y1="15" x2="15" y2="15" />
            )}
          </svg>
          {edit.isCreate ? "Create file?" : "Edit file?"}
        </span>
        <span
          title={edit.path}
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: "var(--font-mono)",
            fontSize: 11.5,
            color: "var(--fg)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            direction: "rtl",
            textAlign: "left",
          }}
        >
          {fileName}
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, display: "flex", gap: 8, flexShrink: 0 }}>
          <span style={{ color: "#1f8a3b" }}>+{stats.added}</span>
          <span style={{ color: "#b8323a" }}>−{stats.removed}</span>
        </span>
      </div>

      {edit.reason && (
        <div
          style={{
            padding: "7px 9px",
            borderRadius: "var(--radius-sm)",
            background: "rgba(184, 130, 40, 0.12)",
            color: "var(--fg-strong)",
            fontSize: 11.5,
            lineHeight: 1.4,
          }}
        >
          {edit.reason}
        </div>
      )}

      <div
        style={{
          maxHeight: 200,
          overflow: "auto",
          padding: "6px 0",
          borderRadius: "var(--radius-sm)",
          border: "1px solid var(--border-strong)",
          background: "var(--bg)",
          fontFamily: "var(--font-mono)",
          fontSize: 11.5,
          lineHeight: 1.5,
        }}
      >
        {changes.map((c, ci) => {
          const sign = c.added ? "+" : c.removed ? "−" : " ";
          const bg = c.added
            ? "rgba(31, 138, 59, 0.10)"
            : c.removed
            ? "rgba(184, 50, 58, 0.10)"
            : "transparent";
          const fg = c.added ? "#1f8a3b" : c.removed ? "#b8323a" : "var(--fg-strong)";
          const lines = c.value.split("\n");
          if (lines[lines.length - 1] === "") lines.pop();
          return lines.map((line, li) => (
            <div
              key={`${ci}-${li}`}
              style={{ background: bg, color: fg, padding: "0 10px", whiteSpace: "pre" }}
            >
              <span
                style={{
                  color: "var(--fg-subtle)",
                  marginRight: 10,
                  userSelect: "none",
                  display: "inline-block",
                  width: 8,
                }}
              >
                {sign}
              </span>
              {line || " "}
            </div>
          ));
        })}
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
        <button
          type="button"
          onClick={onReject}
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
          Reject
        </button>
        <button
          type="button"
          onClick={onApply}
          style={{
            height: 26,
            padding: "0 12px",
            fontSize: 11.5,
            fontWeight: 600,
            color: "#fff",
            background: "var(--accent)",
            border: "1px solid var(--accent)",
            borderRadius: "var(--radius-sm)",
            cursor: "pointer",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.filter = "brightness(1.08)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.filter = "none"; }}
        >
          {edit.isCreate ? "Create" : "Apply"}
        </button>
      </div>
    </div>
  );
}
