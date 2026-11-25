// Throwaway page for Settings › Trusted folders without Tauri. The real row,
// the real tokens; only the IPC is faked.
//
//   npx vite --port 1421   →  http://localhost:1421/preview/trusted-folders.html
//   ?theme=dark | klide-light | …     ?state=empty
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "../src/styles/tokens.css";
import { Panel } from "../src/components/settings/controls";
import { TrustedFoldersRow } from "../src/components/settings/trustedFolders";
import ToastHost from "../src/components/ToastHost";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "klide-light";

let folders =
  params.get("state") === "empty"
    ? []
    : [
        "/Users/me/Code/klide",
        "/Users/me/Code/website",
        "/Users/me/Code/clients/acme/data-platform-with-a-rather-long-folder-name",
      ];

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  transformCallback: (cb: unknown) => cb,
  unregisterCallback: () => {},
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    await new Promise((r) => setTimeout(r, 200));
    if (cmd === "workspace_trust_list") return folders;
    if (cmd === "workspace_trust_revoke") {
      folders = folders.filter((f) => f !== args.root);
      return null;
    }
    throw new Error(`preview: ${cmd}`);
  },
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--fg)", fontFamily: "var(--font-ui)", padding: "48px 0" }}>
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "0 32px" }}>
      <h1 style={{ margin: "0 0 28px", fontSize: 24, color: "var(--fg-strong)", fontWeight: 600 }}>Execution</h1>
      <Panel>
        <TrustedFoldersRow />
      </Panel>
    </div>
    <ToastHost />
  </div>,
);
