// Throwaway page for looking at Settings › Connectors without launching Tauri.
//
// It renders the real ConnectorsSection against the real tokens; only the IPC
// is faked, by standing in for Tauri's internals before the module that calls
// them is imported. The fixture is this machine's actual MCP config — pencil
// from Claude Code, node_repl and computer-use from Codex — so the page is
// seen with the data it will really have.
//
//   npx vite --port 1421   →  http://localhost:1421/preview/connectors.html
//   ?theme=dark | klide-light | sage-garden | sage-garden-dark | cursor-dark | …
//   ?state=empty            →  the first-visit page, nothing imported yet
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "@fontsource/monaspace-neon/700.css";
import "../src/styles/tokens.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "klide-light";
const EMPTY = params.get("state") === "empty";

const pencil = {
  command: "/Applications/Pencil.app/Contents/Resources/app.asar.unpacked/out/mcp-server-darwin-arm64",
  args: ["--app", "desktop"],
  env: {},
  cwd: null,
};
const nodeRepl = {
  command: "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl",
  args: [],
  env: { NODE_REPL_NODE_PATH: "/Applications/ChatGPT.app/…/bin/node", CODEX_HOME: "/Users/pierre/.codex" },
  cwd: null,
};
const linear = { command: "npx", args: ["-y", "linear-mcp"], env: { LINEAR_API_KEY: "lin_api_…" }, cwd: null };

let store = EMPTY
  ? []
  : [
      { id: "pencil", label: "Pencil", server: pencil, enabled: true, origin: "claude-code" },
      { id: "linear", label: "Linear", server: linear, enabled: true, origin: "manual" },
      { id: "node-repl", label: "node_repl", server: nodeRepl, enabled: false, origin: "codex" },
    ];

const OFFERS = [
  {
    id: "computer-use",
    label: "computer-use",
    origin: "codex",
    sourcePath: "/Users/pierre/.codex/config.toml",
    server: { command: "/Applications/…/SkyComputerUseClient", args: ["mcp"], env: {}, cwd: null },
    alreadyAdded: false,
  },
  {
    id: "obsidian-mcp-tools",
    label: "obsidian-mcp-tools",
    origin: "claude-code",
    sourcePath: "/Users/pierre/.claude.json",
    server: { command: "npx", args: ["-y", "obsidian-mcp-tools"], env: {}, cwd: null },
    alreadyAdded: false,
  },
];

/** Tools with real-looking names and prose, so the grid is judged at the width
 *  it will actually wrap at. */
const TOOLS = [
  { name: "list_issues", description: "List issues in a team, filtered by state, assignee or label.", readOnly: true },
  { name: "get_issue", description: "Read one issue by its identifier, with comments.", readOnly: true },
  { name: "create_issue", description: "Open a new issue in a team, with title, description and assignee." },
  { name: "update_issue", description: "Change an issue's state, assignee, estimate or labels." },
  { name: "search", description: "Full-text search across issues, projects and documents.", readOnly: true },
  { name: "list_teams", description: "Every team in the workspace.", readOnly: true },
];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Tauri v2's invoke() routes through this object; standing it up is all a
// browser tab needs to run components that talk over IPC.
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  transformCallback: (cb: unknown) => cb,
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "connectors_list":
        return store;
      case "connectors_discover":
        return OFFERS.map((o) => ({ ...o, alreadyAdded: store.some((c) => c.id === o.id) }));
      case "connectors_upsert": {
        const next = args.connector as (typeof store)[number];
        store = [...store.filter((c) => c.id !== next.id), next].sort((a, b) =>
          a.label.toLowerCase().localeCompare(b.label.toLowerCase())
        );
        return store;
      }
      case "connectors_remove":
        store = store.filter((c) => c.id !== args.id);
        return store;
      case "connectors_probe": {
        // Long enough to see the "Checking…" state; node_repl fails on purpose
        // so the brick-red failure path is visible beside the good one.
        await wait(900);
        const server = args.server as { command: string };
        if (server.command.includes("node_repl")) {
          throw "The server stopped: NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS is not set";
        }
        const many = server.command === "npx";
        return {
          serverName: many ? "linear-mcp" : "pencil",
          serverVersion: many ? "0.4.1" : "1.2.0",
          protocolVersion: "2025-06-18",
          instructions: null,
          tools: many ? TOOLS : TOOLS.slice(0, 3),
          elapsedMs: many ? 4200 : 760,
        };
      }
      default:
        throw `preview: no stub for ${cmd}`;
    }
  },
};

const { ConnectorsSection } = await import("../src/components/settings/connectors");
const { default: ToastHost } = await import("../src/components/ToastHost");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div
    style={{
      minHeight: "100vh",
      background: "var(--bg)",
      color: "var(--fg)",
      fontFamily: "var(--font-ui)",
      padding: "48px 0",
    }}
  >
    {/* The settings pane's own measure, so the ledger is judged at its real width. */}
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "0 32px" }}>
      <h1
        style={{
          margin: "0 0 6px",
          fontSize: 24,
          color: "var(--fg-strong)",
          letterSpacing: "-0.01em",
        }}
      >
        Connectors
      </h1>
      <p style={{ margin: "0 0 28px", fontSize: 13, color: "var(--fg-subtle)" }}>
        MCP servers Klide connects to — import the ones your other tools already use.
      </p>
      <ConnectorsSection workspaceRoot="/Users/pierre/Documents/Private/KIDE" />
    </div>
    <ToastHost />
  </div>
);
