// Real Storage section with disposable sample data; no native files are touched.
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "../src/styles/tokens.css";
import type { StoredRun } from "../src/ipc/storage";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "klide-light";
const titles = [
  "Test workers end to end. Dispatch an OpenCode implementer in the background to implement slugify.js",
  "Any ideas on how to upgrade this project?",
  "Make the project easier to understand",
  "/quiz about the project",
  "Test the workers feature end to end",
  "Refine the settings navigation",
  "Review the conversation history",
  "Explore a quieter editor layout",
];
let runs: StoredRun[] = params.get("state") === "empty" ? [] : Array.from({ length: 50 }, (_, i) => {
  const bytes = Math.round(1_100_000 / Math.pow(i + 1, 1.3));
  const transcriptBytes = Math.round(bytes * .7);
  return { id: `preview-${i}`, title: titles[i % titles.length], updatedMs: Date.now() - i * 3_600_000, bytes, transcriptBytes, supportingBytes: bytes - transcriptBytes };
});
Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (command: string, args?: Record<string, unknown>) => {
  switch (command) {
    case "app_storage_conversations":
      if (params.get("state") === "error") throw new Error("The storage folder is unavailable.");
      return runs;
    case "app_storage_dirs": return [];
    case "plugin:dialog|confirm": return true;
    case "app_storage_delete_conversation": runs = runs.filter(run => run.id !== args?.id); return;
    default: return [];
  }
} } });
if (params.has("cache")) {
  const { saveConversations } = await import("../src/components/ai/storedConversations");
  saveConversations(titles.map((title, i) => ({
    id: `cache-preview-${i}`, title, updatedAt: Date.now() - i * 3_600_000,
    msgs: [{ role: "user", content: title }, { role: "assistant", content: "Sample cached message. ".repeat(200 - i * 20) }],
  })));
}
const { StorageSection } = await import("../src/components/settings/storage");
ReactDOM.createRoot(document.getElementById("root")!).render(
  <main className="klide-settings-content" style={{ maxWidth: params.get("width") === "narrow" ? 420 : 980, margin: "0 auto", boxSizing: "border-box" }}>
    <header className="klide-settings-page-header"><div><h1>Storage</h1><p>Manage saved conversations, disk usage, the local cache and your transcript folder.</p></div></header>
    <StorageSection />
  </main>,
);
