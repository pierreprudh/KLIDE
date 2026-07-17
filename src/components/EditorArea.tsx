import Editor, { type OnMount } from "@monaco-editor/react";
import {
  getMonacoThemeId,
  prepareMonaco,
  type ThemeId,
} from "../theme";
import { keysFor } from "../shortcuts";
import { Kbd } from "./Kbd";

/** Actions the no-file launcher can fire; App maps them onto the same
 *  handlers its global shortcuts use, so click and chord stay one code path. */
export type EditorEmptyAction =
  | "go-to-file"
  | "command-palette"
  | "find-in-files"
  | "toggle-terminal";

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
  /** Fired by the no-file launcher rows. */
  onEmptyAction?: (action: EditorEmptyAction) => void;
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
  onEmptyAction,
}: Props) {
  const editorTheme = getMonacoThemeId(theme);

  // A folder is always open by the time we render here (App shows the
  // full-screen welcome otherwise). The "no file yet" state is a launcher,
  // not a dead end: each row is a real action with its chord as a keycap —
  // the empty screen doubles as the shortcut tutorial (the pattern Superset/
  // Orca use for their empty tabs).
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
            className="klide-enter-rise"
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
          <div style={{ display: "flex", flexDirection: "column", textAlign: "left" }}>
            {(
              [
                { action: "go-to-file", label: "Go to file" },
                { action: "command-palette", label: "Command palette" },
                { action: "find-in-files", label: "Find in files" },
                { action: "toggle-terminal", label: "Toggle terminal" },
              ] as const
            ).map(({ action, label }, i) => (
              <button
                key={action}
                type="button"
                onClick={() => onEmptyAction?.(action)}
                className="klide-enter-rise"
                style={{
                  ["--enter-delay" as string]: `${60 + i * 40}ms`,
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  height: 34,
                  padding: "0 10px",
                  borderRadius: "var(--radius-md)",
                  color: "var(--fg-subtle)",
                  fontSize: 12.5,
                  textAlign: "left",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--fg-strong)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.color = "var(--fg-subtle)";
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
                <Kbd keys={keysFor(action)} />
              </button>
            ))}
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
        beforeMount={prepareMonaco}
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
