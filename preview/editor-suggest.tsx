// Throwaway page for the editor's suggest list, without launching Tauri.
//
// A narrow EditorArea (the width of a side-by-side editor) so the suggest
// widget is wider than the editor: it must overflow, not get clipped.
//
//   npm run dev  →  http://localhost:1420/preview/editor-suggest.html
//   ?lang=markdown — prose: no suggestions while typing
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/monaspace-neon/400.css";
import "../src/styles/tokens.css";
import { EditorArea } from "../src/components/EditorArea";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = "klide-light";
const lang = params.get("lang") ?? "typescript";
const code = lang === "markdown" ? "# Notes\n\nlocalStorage TypeScript tauriEvents\n\n" : "const localStorageKey = 1;\nconst localValue = 2;\n\n";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div style={{ display: "flex", height: "100vh", background: "var(--bg)" }}>
    <div style={{ width: 380, background: "var(--bg-elevated)" }} />
    <div style={{ width: 420, display: "flex", overflow: "hidden", borderLeft: "1px solid var(--border)" }}>
      <EditorArea code={code} onChange={() => {}} language={lang} hasFile theme={"klide-light" as never} fontSize={13} lineNumbers wordWrap={false} minimap={false} />
    </div>
  </div>
);
