import Editor from "@monaco-editor/react";

type Props = {
  code: string;
  onChange: (v: string) => void;
  language?: string;
  hasFile: boolean;
};

export function EditorArea({ code, onChange, language = "plaintext", hasFile }: Props) {
  if (!hasFile) {
    return (
      <div
        style={{
          flex: 1,
          display: "grid",
          placeItems: "center",
          color: "var(--fg-subtle)",
          fontSize: 13,
          background: "var(--bg)",
        }}
      >
        Open a file to begin
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, background: "var(--bg)" }}>
      <Editor
        height="100%"
        language={language}
        theme="vs"
        value={code}
        onChange={(v) => onChange(v ?? "")}
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          fontFamily: "SF Mono, JetBrains Mono, ui-monospace, monospace",
          fontLigatures: true,
          renderLineHighlight: "gutter",
          scrollBeyondLastLine: false,
          padding: { top: 12 },
          lineNumbersMinChars: 3,
          glyphMargin: false,
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          smoothScrolling: true,
        }}
      />
    </div>
  );
}
