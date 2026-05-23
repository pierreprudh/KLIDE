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
          color: "var(--fg-dim)",
          fontSize: 13,
        }}
      >
        Open a folder to begin
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0 }}>
      <Editor
        height="100%"
        language={language}
        theme="vs-dark"
        value={code}
        onChange={(v) => onChange(v ?? "")}
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          fontFamily: "JetBrains Mono, ui-monospace, monospace",
          fontLigatures: true,
          renderLineHighlight: "gutter",
          scrollBeyondLastLine: false,
          padding: { top: 12 },
        }}
      />
    </div>
  );
}
