// The composer "+" menu's Connectors row, opened, against the real tokens.
//   ?theme=dark   ?state=empty (no connectors: the row leads to Settings)
//   ?state=many (twenty connectors: the card scrolls, a filter leads)
import { createRoot } from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "../src/styles/tokens.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "klide-light";
let store = params.get("state") === "empty" ? [] : [
  { id: "github", label: "GitHub", server: { url: "https://api.githubcopilot.com/mcp/", headers: {} }, enabled: true, origin: "preset" },
  { id: "linear", label: "Linear", server: { url: "https://mcp.linear.app/mcp", headers: {} }, enabled: true, origin: "catalog" },
  { id: "notion", label: "Notion", server: { url: "https://mcp.notion.com/mcp", headers: {} }, enabled: false, origin: "catalog" },
  { id: "playwright", label: "Playwright", server: { command: "npx", args: ["-y", "@playwright/mcp@latest"], env: {}, cwd: null }, enabled: true, origin: "catalog" },
];
if (params.get("state") === "many") {
  const more = ["Sentry", "Supabase", "Stripe", "PostHog", "Hugging Face", "Canva", "Intercom", "Granola", "Airtable", "ClickUp", "Miro", "Dropbox", "Todoist", "Neon", "Netlify", "Cloudflare"];
  store = [...store, ...more.map((label, i) => ({ id: label.toLowerCase().replace(/ /g, "-"), label, server: { url: `https://mcp.${label.toLowerCase().replace(/ /g, "")}.com/mcp`, headers: {} }, enabled: i % 3 === 0, origin: "catalog" }))];
}
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: { connector?: (typeof store)[number] }) => {
    if (cmd === "connectors_list") return store;
    if (cmd === "connectors_upsert") { store = store.map((c) => (c.id === args.connector!.id ? args.connector! : c)); return store; }
    return null;
  },
};
const { ConnectorsMenu } = await import("../src/components/ai/ConnectorsMenu");
document.body.style.background = "var(--bg)";
// ?still: animations off, so a headless screenshot shows the settled card.
if (params.has("still")) document.head.insertAdjacentHTML("beforeend", "<style>*{animation:none!important}</style>");
createRoot(document.getElementById("root")!).render(
  <div style={{ padding: "40px 40px 40px 40px", marginTop: Number(params.get("top") ?? 0), fontFamily: "var(--font-ui)" }}>
    <div role="menu" className="menu-glass" style={{ width: 238, padding: 5, borderRadius: "var(--radius-md)", border: "1px solid var(--border)", background: "var(--bg-elevated)" }}>
      <div style={{ height: 32, display: "flex", alignItems: "center", padding: "0 10px", fontSize: 13, color: "var(--fg)" }}>Add file</div>
      <ConnectorsMenu onNavigate={() => {}} />
      <div style={{ height: 1, background: "var(--border)", margin: "4px 8px" }} />
      <div style={{ height: 32, display: "flex", alignItems: "center", padding: "0 10px", fontSize: 13, color: "var(--fg-subtle)" }}>Plan</div>
    </div>
  </div>,
);
setTimeout(() => (document.querySelector(".klide-menu-connectors-row") as HTMLElement | null)?.click(), 500);
