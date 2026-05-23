import { useMemo } from "react";
import { diffLines, Change } from "diff";

export type PendingEdit = {
  path: string;
  oldContent: string;
  newContent: string;
  isCreate: boolean;
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
        background: "rgba(0,0,0,0.6)",
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
          background: "var(--bg-elevated)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <header
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span
              style={{
                fontSize: 10,
                color: "var(--fg-muted)",
                letterSpacing: "0.08em",
              }}
            >
              {edit.isCreate ? "CREATE FILE" : "EDIT FILE"}
            </span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}>
              {edit.path}
            </span>
          </div>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              display: "flex",
              gap: 8,
            }}
          >
            <span style={{ color: "#7dd87d" }}>+{stats.added}</span>
            <span style={{ color: "#e07b7b" }}>-{stats.removed}</span>
          </div>
        </header>

        <div
          style={{
            flex: 1,
            overflow: "auto",
            padding: "8px 0",
            background: "var(--bg)",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          {changes.map((c, ci) => {
            const sign = c.added ? "+" : c.removed ? "-" : " ";
            const bg = c.added
              ? "rgba(80, 200, 120, 0.10)"
              : c.removed
              ? "rgba(220, 100, 100, 0.10)"
              : "transparent";
            const fg = c.added ? "#a8e6b8" : c.removed ? "#f0a8a8" : "var(--fg)";
            const lines = c.value.split("\n");
            if (lines[lines.length - 1] === "") lines.pop();
            return lines.map((line, li) => (
              <div
                key={`${ci}-${li}`}
                style={{
                  background: bg,
                  color: fg,
                  padding: "0 16px",
                  whiteSpace: "pre",
                }}
              >
                <span
                  style={{ color: "var(--fg-dim)", marginRight: 12, userSelect: "none" }}
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
            padding: 12,
            borderTop: "1px solid var(--border)",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <button
            onClick={onReject}
            style={{
              padding: "6px 14px",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--fg-muted)",
            }}
          >
            Reject
          </button>
          <button
            onClick={onApply}
            style={{
              padding: "6px 14px",
              border: "1px solid var(--accent)",
              borderRadius: 4,
              background: "var(--accent)",
              color: "#0f0f0f",
              fontWeight: 500,
            }}
          >
            Apply
          </button>
        </footer>
      </div>
    </div>
  );
}
