import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

type Props = {
  filePath: string | null;
  workspaceRoot: string | null;
  onClose: () => void;
};

export function FileViewerPanel({ filePath, workspaceRoot, onClose }: Props) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!filePath || !workspaceRoot) { setContent(null); setError(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    invoke<string>("read_text_file", { workspaceRoot, path: filePath })
      .then((text) => { if (!cancelled) setContent(text); })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filePath, workspaceRoot]);

  const fileName = filePath ? filePath.split("/").pop() ?? filePath : "";

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "6px 10px",
          borderBottom: "1px solid var(--border)",
          fontSize: 12,
          fontFamily: "var(--font-mono)",
          color: "var(--fg-strong)",
          gap: 8,
        }}
      >
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {fileName || "File Viewer"}
        </span>
        <button
          onClick={onClose}
          aria-label="Close viewer"
          style={{
            background: "none",
            border: "none",
            color: "var(--fg-subtle)",
            cursor: "pointer",
            padding: "2px 6px",
            borderRadius: "var(--radius-xs)",
            fontSize: 14,
            lineHeight: 1,
          }}
        >
          ✕
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "10px 14px" }}>
        {!filePath ? (
          <div style={{ color: "var(--fg-subtle)", fontSize: 12, padding: 20, textAlign: "center" }}>
            Right-click a file in the explorer and select <strong>Quick View</strong> to preview it here.
          </div>
        ) : loading ? (
          <div style={{ color: "var(--fg-subtle)", fontSize: 12, padding: 20 }}>Loading…</div>
        ) : error ? (
          <div style={{ color: "#D64545", fontSize: 12, padding: 20 }}>{error}</div>
        ) : (
          <pre
            style={{
              margin: 0,
              fontSize: 11.5,
              fontFamily: "var(--font-mono)",
              color: "var(--fg)",
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            <code>{content}</code>
          </pre>
        )}
      </div>
    </div>
  );
}
