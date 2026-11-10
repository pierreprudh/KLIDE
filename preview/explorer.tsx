// Throwaway page: the real Explorer tree with list_dir/git_status mocked.
// ?theme=dark|klide-light|…
//   npx vite --port 1437  →  http://localhost:1437/preview/explorer.html
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "../src/styles/tokens.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "dark";
const ROOT = "/Users/pierre/Documents/Private/pixel-art-editor";
const d = (name: string) => ({ name, isDirectory: true });
const f = (name: string) => ({ name, isDirectory: false });
const TREE: Record<string, unknown[]> = {
  [ROOT]: [d("public"), d("docs"), d("src"), f(".gitignore"), f("index.html"), f("package.json"), f("README.md"), f("tsconfig.json"), f("vite.config.ts")],
  [`${ROOT}/src`]: [d("components"), f("App.tsx"), f("canvas.ts"), f("main.tsx"), f("palette.ts"), f("styles.css")],
  [`${ROOT}/docs`]: [f("notes.md")],
  [`${ROOT}/src/components`]: [f("Canvas.tsx"), f("Palette.tsx"), f("Toolbar.tsx")],
};
localStorage.setItem(`klide-expanded-folders:${ROOT}`, JSON.stringify([`${ROOT}/docs`, `${ROOT}/src`, `${ROOT}/src/components`]));

(window as any).__TAURI_INTERNALS__ = {
  transformCallback: () => 0,
  invoke: async (cmd: string, args: any) => {
    if (cmd === "list_dir") return TREE[args.path] ?? [];
    if (cmd === "git_status")
      return { branch: "main", files: [{ path: "src/canvas.ts", status: "M", staged: false }, { path: "src/palette.ts", status: "??", staged: false }] };
    return null;
  },
};

const { Sidebar } = await import("../src/components/Sidebar");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div style={{ display: "flex", height: "100vh", background: "var(--bg-chrome, var(--bg))", color: "var(--fg)" }}>
    <div style={{ width: 260, display: "flex", flexDirection: "column" }}>
      <Sidebar
        fill
        visible
        width={260}
        workspaceRoot={ROOT}
        onOpen={() => {}}
        onRootChange={() => {}}
        activePath={`${ROOT}/src/components/Canvas.tsx`}
      />
    </div>
  </div>,
);
