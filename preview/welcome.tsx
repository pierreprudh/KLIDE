// Throwaway page for the Welcome screen, without launching Tauri.
//
// It renders the real WelcomeScreen inside the same full-height wrapper
// App.tsx gives it, with stub handlers — what this page proves is the visual
// half: the pixel film filling its card, the narrow-window stack, and the
// reduced-motion still.
//
//   npx vite --port 1421   →  http://localhost:1421/preview/welcome.html
//   ?theme=dark | klide-light | sage-garden | …
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "../src/styles/tokens.css";
import { WelcomeScreen } from "../src/components/WelcomeScreen";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "klide-light";

const noop = () => {};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
    <WelcomeScreen
      recentFolders={["/Users/you/Documents/klide", "/Users/you/code/notes", "/Users/you/code/site"]}
      onOpenFolder={noop}
      onNewProject={noop}
      onCloneRepo={noop}
      onOpenRecent={noop}
      onRemoveRecent={noop}
      onOpenSettings={noop}
    />
  </div>,
);
