// Production Accounts page with synthetic identities; no native calls.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/monaspace-neon/400.css";
import "../src/styles/tokens.css";
import { SubscriptionAccounts } from "../src/components/settings/subscriptionAccounts";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "klide-light";
const providers = [
  { id: "claude-code", title: "Claude Code", description: "Subscription login, Console login, or SSO.", accounts: true },
  { id: "codex", title: "Codex", description: "ChatGPT login, device auth, or API key.", accounts: true },
  { id: "opencode", title: "OpenCode", description: "Interactive coding agent.", accounts: true },
  { id: "omp", title: "Oh My Pi", description: "Provider keys come from your shell environment.", accounts: false },
  { id: "amp", title: "Amp", description: "Sign in with amp login.", accounts: false },
];
const active: Record<string, string> = {};
const commands: string[] = [];
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (command: string, args: Record<string, string>) => {
    commands.push(command);
    switch (command) {
      case "accounts_list": return { present: args.provider !== "opencode", accounts: args.provider === "opencode" ? [] : [
        { name: "Personal", savedMs: 0, active: (active[args.provider] ?? "Personal") === "Personal", identity: { email: "alex@example.com", detail: "Plus" } },
        { name: "Work", savedMs: 0, active: active[args.provider] === "Work", identity: { email: "alex@company.example" } },
      ] };
      case "account_activate": active[args.provider] = args.name; return null;
      case "app_user_info": return { username: "Alex", hostname: "MacBook" };
      case "github_current_user": return { login: "alex-dev", avatarUrl: "" };
      default: throw new Error(`Unexpected preview command: ${command}`);
    }
  },
};
Object.assign(window, { __accountsPreview: { commands } });
function Page() {
  const [refreshing, setRefreshing] = useState(false);
  return <main className="klide-settings-content" style={{ maxWidth: 920, margin: "0 auto", color: "var(--fg)", fontFamily: "var(--font-ui)" }}>
    <header className="klide-settings-page-header"><div>
      <div className="klide-settings-breadcrumb">Settings / Subscription</div><h1>Accounts</h1>
      <p>Manage the accounts Klide uses for GitHub, coding agents, and cloud models.</p>
    </div></header>
    <SubscriptionAccounts providers={providers} statuses={{
      "claude-code": { installed: true, connected: true, detail: "Subscription login · alex@example.com" },
      codex: { installed: true, connected: true, detail: "ChatGPT Plus · alex@example.com" },
      opencode: { installed: true, connected: false, detail: "Installed. Sign in with opencode auth login." },
      omp: { installed: true, connected: true, detail: "Provider keys loaded from your shell environment." },
      amp: { installed: false, connected: false, detail: "Install Amp to connect your account." },
    }} ollamaAccount={{ running: true, signedIn: false, detail: "Sign in with ollama signin in a terminal." }} refreshing={refreshing}
      onRefresh={() => { setRefreshing(true); setTimeout(() => setRefreshing(false), 300); }} />
  </main>;
}
document.body.style.background = "var(--bg)";
createRoot(document.getElementById("root")!).render(<Page />);
