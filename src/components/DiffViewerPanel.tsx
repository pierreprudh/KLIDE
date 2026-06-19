import { DiffEditor } from "@monaco-editor/react";
import { defineKlideMonacoThemes, getMonacoThemeId, type ThemeId } from "../theme";

type Props = {
  path: string;
  original: string;
  modified: string;
  language?: string;
  isCreate?: boolean;
  theme: ThemeId;
  onClose: () => void;
};

/** Read-only side-by-side diff of a proposed (or applied) edit, rendered with
 *  Monaco's DiffEditor so it gets real syntax highlighting and the same theme
 *  as the editor. Opened from the inline review pill's "open changes" action. */
export function DiffViewerPanel({ path, original, modified, language = "plaintext", isCreate, theme, onClose }: Props) {
  const fileName = path.split("/").pop() ?? path;
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "6px 10px",
          borderBottom: "1px solid var(--border)",
          gap: 8,
        }}
      >
        <span style={{ display: "flex", alignItems: "baseline", gap: 7, minWidth: 0 }}>
          <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--accent)", flexShrink: 0 }}>
            {isCreate ? "Create" : "Changes"}
          </span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={path}>
            {fileName}
          </span>
        </span>
        <button
          onClick={onClose}
          aria-label="Close diff"
          style={{ background: "none", border: "none", color: "var(--fg-subtle)", cursor: "pointer", padding: "2px 6px", borderRadius: "var(--radius-xs)", fontSize: 14, lineHeight: 1 }}
        >
          ✕
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <DiffEditor
          original={original}
          modified={modified}
          language={language}
          theme={getMonacoThemeId(theme)}
          beforeMount={defineKlideMonacoThemes}
          options={{
            readOnly: true,
            renderSideBySide: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 12,
            automaticLayout: true,
            renderOverviewRuler: false,
            scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
          }}
        />
      </div>
    </div>
  );
}
