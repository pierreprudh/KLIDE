import Editor from "@monaco-editor/react";
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
        }}
      >
        <div
          style={{
            width: "min(420px, 72vw)",
            textAlign: "center",
            color: "var(--fg-subtle)",
            lineHeight: 1.65,
          }}
        >
          <div
            style={{
              fontSize: 24,
              color: "var(--fg-strong)",
              fontWeight: 500,
              marginBottom: 8,
            }}
          >
            Klide
          </div>
          <div style={{ fontSize: 14, color: "var(--fg)" }}>
            Choose a file from the explorer to start editing.
          </div>
          <div style={{ marginTop: 14, fontSize: 12, color: "var(--fg-subtle)" }}>
            Files on the left · AI on the right · Terminal below
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
