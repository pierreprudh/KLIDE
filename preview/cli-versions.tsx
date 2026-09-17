// Throwaway page for looking at Settings › Subscription › CLI versions without
// launching Tauri — and without actually updating anything on this machine.
//
// It renders the real CliVersionsBlock against the real tokens; only the IPC is
// faked. The version fixtures are what the four CLIs on this machine actually
// answered on 2026-09-17, and the update output is a real-shaped installer
// stream: colours, a progress line redrawn with \r, and a final version.
//
//   npx vite --port 1421   →  http://localhost:1421/preview/cli-versions.html
//   ?theme=dark | klide-light | sage-garden | cursor-dark | …
//   ?state=missing   →  Codex not on PATH, and an update that fails
//   ?state=current   →  every update finds the CLI already up to date
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "@fontsource/monaspace-neon/700.css";
import "../src/styles/tokens.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "klide-light";
const STATE = params.get("state") ?? "default";

const ESC = "";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Row = {
  provider: string;
  binary: string;
  installed: boolean;
  version: string | null;
  raw: string | null;
  commandPath: string | null;
  updateCommand: string | null;
  detail: string | null;
};

// What the four CLIs on this machine really said.
let rows: Row[] = [
  {
    provider: "claude-code",
    binary: "claude",
    installed: true,
    version: "2.1.274",
    raw: "2.1.274 (Claude Code)",
    commandPath: "/Users/pierre/.local/bin/claude",
    updateCommand: "claude update",
    detail: null,
  },
  {
    provider: "codex",
    binary: "codex",
    installed: true,
    version: "0.154.0",
    raw: "codex-cli 0.154.0",
    commandPath: "/Users/pierre/.local/bin/codex",
    updateCommand: "codex update",
    detail: null,
  },
  {
    provider: "opencode",
    binary: "opencode",
    installed: true,
    version: "1.18.31",
    raw: "1.18.31",
    commandPath: "/Users/pierre/.opencode/bin/opencode",
    updateCommand: "opencode upgrade",
    detail: null,
  },
  {
    provider: "omp",
    binary: "omp",
    installed: true,
    version: "15.13.3",
    raw: "omp/15.13.3",
    commandPath: "/Users/pierre/.nvm/versions/node/v24.16.0/bin/omp",
    updateCommand: "omp update",
    detail: null,
  },
];

if (STATE === "missing") {
  // The uninstalled row: no version, no Update — there is no install to replace.
  rows = rows.map((row) =>
    row.provider === "codex"
      ? {
          ...row,
          installed: false,
          version: null,
          raw: null,
          commandPath: null,
          updateCommand: null,
          detail: "codex CLI is not installed or not on PATH",
        }
      : row,
  );
}

/** One installer's output, in the shape a real one arrives in. */
function script(row: Row): string[] {
  if (STATE === "current") {
    return [`Checking for updates…\n`, `${row.binary} is already up to date (${row.version}).\n`];
  }
  return [
    `Current version: ${row.version}\n`,
    `Checking for updates…\n`,
    `${ESC}[2mFound 0.155.0${ESC}[0m\n`,
    "downloading   0%\r",
    "downloading  38%\r",
    "downloading  91%\r",
    "downloading 100%\n",
    `${ESC}[32m✓ Updated to 0.155.0${ESC}[0m\n`,
  ];
}

type RawChannel = { id: (raw: { index: number; message: unknown }) => void };

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  // The preview's transformCallback is the identity, so `channel.id` IS the
  // raw handler and the stub can drive the stream by calling it.
  transformCallback: (cb: unknown) => cb,
  unregisterCallback: () => {},
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "cli_versions":
        await wait(240);
        return rows;
      case "cli_version":
        return rows.find((r) => r.provider === args.provider);
      case "cli_update": {
        const row = rows.find((r) => r.provider === args.provider)!;
        const channel = args.onEvent as RawChannel;
        let index = 0;
        for (const chunk of script(row)) {
          await wait(420);
          channel.id({ index: index++, message: { kind: "output", chunk } });
        }
        await wait(300);
        if (STATE === "missing") throw "codex update exited with 1";
        const next =
          STATE === "current" ? row : { ...row, version: "0.155.0", raw: `${row.binary} 0.155.0` };
        rows = rows.map((r) => (r.provider === next.provider ? next : r));
        return next;
      }
      default:
        throw `preview: no stub for ${cmd}`;
    }
  },
};

const { CliVersionsBlock } = await import("../src/components/settings/cliVersions");
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
    {/* The settings pane's own measure, so the rows are judged at their real width. */}
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "0 32px" }}>
      <h1 style={{ margin: "0 0 6px", fontSize: 24, color: "var(--fg-strong)", fontWeight: 600 }}>
        CLI versions
      </h1>
      <p style={{ margin: "0 0 28px", fontSize: 13.5, color: "var(--fg-subtle)", lineHeight: 1.5 }}>
        Which build of each delegate CLI Klide launches, and the CLI's own updater.
      </p>
      <CliVersionsBlock />
    </div>
    <ToastHost />
  </div>,
);
