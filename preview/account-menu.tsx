// Throwaway page for looking at the rail's account menu without launching
// Tauri. Real ProfileModal, real tokens; only IPC is faked, with this machine's
// actual readings on 2026-09-30 (Claude Team at 95% of its session).
//
//   npx vite --port 1421  →  http://localhost:1421/preview/account-menu.html
//   ?theme=dark | klide-light | …     ?state=signed-out
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "../src/styles/tokens.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "klide-light";
const SIGNED_OUT = params.get("state") === "signed-out";
const now = Date.now();

const USAGE = [
  SIGNED_OUT
    ? { provider: "claude-code", plan: null, windows: [], spend: null, error: "Sign in with Claude Code." }
    : {
        provider: "claude-code",
        plan: "Team",
        windows: [
          { label: "Session", percent: 95, resetsAtMs: now + 2.4 * 3600e3, seenAtMs: null },
          { label: "Weekly", percent: 43, resetsAtMs: now + 3.6 * 86400e3, seenAtMs: null },
        ],
        spend: null,
        error: null,
      },
  {
    provider: "codex",
    plan: "Plus",
    windows: [
      { label: "Session", percent: 0, resetsAtMs: null, seenAtMs: now - 5 * 3600e3 },
      { label: "Weekly", percent: 72, resetsAtMs: now + 4 * 86400e3, seenAtMs: now - 5 * 3600e3 },
    ],
    spend: null,
    error: null,
  },
  { provider: "opencode", plan: null, windows: [], spend: { costUsd: 0.2961, tokens: 4044730, sinceMs: now - 7 * 86400e3 }, error: null },
];

const account = (name: string, active: boolean) => ({ name, active, identity: { email: `${name}@example.com` } });

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  transformCallback: (cb: unknown) => cb,
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "usage_snapshot":
        await new Promise((r) => setTimeout(r, 400));
        return USAGE;
      case "accounts_list":
        return args.provider === "claude-code"
          ? { accounts: [account("work", true), account("private", false)], currentUnsaved: null }
          : args.provider === "codex"
            ? { accounts: [account("private", true)], currentUnsaved: null }
            : { accounts: [], currentUnsaved: null };
      case "delegate_logout":
        await new Promise((r) => setTimeout(r, 600));
        return null;
      case "github_accounts":
        return { logins: ["pierreprudh", "Pierre-OTK"], active: "pierreprudh", pinned: "pierreprudh" };
      default:
        return null;
    }
  },
};

const { ProfileModal } = await import("../src/components/ProfileModal");
const { default: ToastHost } = await import("../src/components/ToastHost");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
    <ProfileModal open workspaceRoot="/Users/pierre/Documents/Private/KIDE" onClose={() => {}} />
    <ToastHost />
  </div>
);
