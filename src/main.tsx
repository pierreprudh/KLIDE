import React from "react";
import ReactDOM from "react-dom/client";
// Bundle the design-system fonts locally (offline-first). The family names
// these register ("Atkinson Hyperlegible", "Monaspace Neon") match tokens.css.
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "@fontsource/monaspace-neon/700.css";
// Point Monaco at the bundled package (offline, no CDN) before <App> mounts.
import "./monaco-setup";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
