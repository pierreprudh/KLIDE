import { useMemo } from "react";
import { diffLines, Change } from "diff";

export type PendingEdit = {
  path: string;
  oldContent: string;
  newContent: string;
  isCreate: boolean;
  /** Optional advisory note from the harness (e.g. a staleness warning when
   *  the file changed since the agent last read it). Shown as a banner. */
  reason?: string;
};

type Props = {
  edit: PendingEdit;
  onApply: () => void;
  onReject: () => void;
};

export function DiffModal({ edit, onApply, onReject }: Props) {
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

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onReject}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(40,40,40,0.35)",
        backdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(820px, 90vw)",
          maxHeight: "85vh",
          background: "var(--bg)",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "0 18px 60px rgba(0,0,0,0.14)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <header
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <span
              style={{
                fontSize: 10,
                color: "var(--fg-subtle)",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                fontWeight: 500,
              }}
            >
              {edit.isCreate ? "Create file" : "Edit file"}
            </span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                color: "var(--fg-strong)",
              }}
            >
              {edit.path}
            </span>
          </div>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              display: "flex",
              gap: 10,
            }}
          >
            <span style={{ color: "#1f8a3b" }}>+{stats.added}</span>
            <span style={{ color: "#b8323a" }}>−{stats.removed}</span>
          </div>
        </header>

        {edit.reason && (
          <div
            style={{
              padding: "9px 18px",
              borderBottom: "1px solid var(--border)",
              background: "rgba(184, 130, 40, 0.10)",
              color: "var(--fg-strong)",
              fontSize: 12,
              lineHeight: 1.45,
            }}
          >
            {edit.reason}
          </div>
        )}

        <div
          style={{
            flex: 1,
            overflow: "auto",
            padding: "10px 0",
            background: "var(--bg-elevated)",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.55,
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
                style={{
                  background: bg,
                  color: fg,
                  padding: "0 18px",
                  whiteSpace: "pre",
                }}
              >
                <span
                  style={{
                    color: "var(--fg-subtle)",
                    marginRight: 14,
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

        <footer
          style={{
            padding: 14,
            borderTop: "1px solid var(--border)",
            background: "var(--bg)",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <button
            onClick={onReject}
            style={{
              padding: "6px 14px",
              border: "1px solid var(--border-strong)",
              borderRadius: "var(--radius-sm)",
              color: "var(--fg)",
              background: "var(--bg)",
              fontSize: 13,
              transition: "background var(--motion-med) var(--ease-out)",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "var(--bg)")}
          >
            Reject
          </button>
          <button
            onClick={onApply}
            style={{
              padding: "6px 16px",
              border: "1px solid var(--accent)",
              borderRadius: "var(--radius-sm)",
              background: "var(--accent)",
              color: "#FFFFFF",
              fontWeight: 500,
              fontSize: 13,
              transition: "filter var(--motion-med) var(--ease-out)",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.filter = "brightness(1.08)")}
            onMouseLeave={(e) => (e.currentTarget.style.filter = "none")}
          >
            Apply
          </button>
        </footer>
      </div>
    </div>
  );
}
