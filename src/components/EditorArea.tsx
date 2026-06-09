import Editor, { type OnMount } from "@monaco-editor/react";
import {
  defineKlideMonacoThemes,
  getMonacoThemeId,
  type ThemeId,
} from "../theme";

type Props = {
  code: string;
  onChange: (v: string) => void;
  language?: string;
  hasFile: boolean;
  theme: ThemeId;
  fontSize: number;
  lineNumbers: boolean;
  wordWrap: boolean;
  minimap: boolean;
  /** App keeps a ref to the Monaco editor for goto-line / reveal commands. */
  onEditorMount?: (editor: Parameters<OnMount>[0]) => void;
};

export function EditorArea({
  code,
  onChange,
  language = "plaintext",
  hasFile,
  theme,
  fontSize,
  lineNumbers,
  wordWrap,
  minimap,
  onEditorMount,
}: Props) {
  const editorTheme = getMonacoThemeId(theme);

  // A folder is always open by the time we render here (App shows the
  // full-screen welcome otherwise); this is the "no file selected yet" hint.
  if (!hasFile) {
    return (
      <div
        className="editor-empty"
        style={{
          flex: 1,
          display: "grid",
          placeItems: "center",
          minHeight: 0,
          padding: 24,
          background: "transparent",
        }}
      >
        <div
          style={{
            width: "min(360px, 72vw)",
            textAlign: "center",
            color: "var(--fg-subtle)",
            lineHeight: 1.6,
          }}
        >
          <div
            style={{
              fontSize: 13,
              color: "var(--fg-dim)",
              fontFamily: "var(--font-mono)",
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              marginBottom: 18,
            }}
          >
            No file open
          </div>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "7px 12px",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--border)",
              background: "color-mix(in srgb, var(--bg-elevated) 80%, transparent)",
              color: "var(--fg)",
              fontSize: 12.5,
            }}
          >
            <KeyCap>⌘</KeyCap>
            <span style={{ color: "var(--fg-dim)" }}>+</span>
            <KeyCap>P</KeyCap>
            <span style={{ marginLeft: 4 }}>to open a file</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="editor-host" style={{ flex: 1, minHeight: 0 }}>
      <Editor
        height="100%"
        language={language}
        theme={editorTheme}
        beforeMount={defineKlideMonacoThemes}
        onMount={(editor) => onEditorMount?.(editor)}
        value={code}
        onChange={(v) => onChange(v ?? "")}
        options={{
          automaticLayout: true,
          minimap: {
            enabled: minimap,
            side: "right",
            renderCharacters: false,
            showSlider: "always",
            maxColumn: 90,
          },
          fontSize,
          fontFamily:
            "Monaspace Neon, Monaspace Argon, Monaspace, SF Mono, JetBrains Mono, ui-monospace, monospace",
          fontLigatures: true,
          renderLineHighlight: "gutter",
          scrollBeyondLastLine: false,
          padding: { top: 12 },
          lineNumbers: lineNumbers ? "on" : "off",
          lineNumbersMinChars: lineNumbers ? 3 : 0,
          wordWrap: wordWrap ? "on" : "off",
          glyphMargin: false,
          overviewRulerLanes: minimap ? 3 : 0,
          hideCursorInOverviewRuler: !minimap,
          smoothScrolling: true,
        }}
      />
    </div>
  );
}

function KeyCap({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "inline-grid",
        placeItems: "center",
        minWidth: 18,
        height: 18,
        padding: "0 5px",
        borderRadius: 4,
        border: "1px solid color-mix(in srgb, var(--border-strong) 80%, transparent)",
        background: "color-mix(in srgb, var(--bg) 80%, var(--bg-elevated))",
        color: "var(--fg)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        lineHeight: 1,
        boxShadow: "inset 0 1px 0 var(--panel-highlight)",
      }}
    >
      {children}
    </span>
  );
}
