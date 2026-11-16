// The Delegate intelligence-source menu (HarnessModelPicker) on OpenCode,
// opened and hovered on a stack so a headless shot shows the side card.
//
//   http://localhost:1420/preview/harness-picker.html?theme=dark&stack=Subscription
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "../src/styles/tokens.css";
import { HarnessModelPicker } from "../src/components/ai/HarnessModelPicker";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "klide-light";
document.body.style.background = "var(--bg)";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd: string, args: any) => {
  if (cmd === "harness_source_support") return { supported: !String(args?.provider).startsWith("codex"), reason: "Needs a bridge" };
  if (cmd === "ai_provider_key_status") return { hasKey: args?.provider === "openrouter" }; if (cmd === "custom_provider_list") return [{ id: "custom:prod", label: "Prod", baseUrl: "http://x", defaultModel: "m" }];
  if (cmd === "harness_source_models") return ["moonshotai/kimi-k3", "deepseek/deepseek-v4.1-flash"];
  if (cmd.endsWith("_list") || cmd.includes("list")) return [];
  return null;
} };

window.addEventListener("error", (e) => { document.body.insertAdjacentHTML("afterbegin", `<pre style="color:red">${e.message}</pre>`); });
ReactDOM.createRoot(document.getElementById("root")!).render(
  <div style={{ position: "fixed", left: 40, bottom: 40 }}>
    <HarnessModelPicker harness="opencode" model="kimi-k3" onChange={() => {}} />
  </div>,
);
setTimeout(() => {
  document.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.click();
  setTimeout(() => {
    const stack = params.get("stack") ?? "Subscription";
    const el = document.querySelector(`[data-category="${stack}"]`) ?? document.querySelector("[data-own]");
    el?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  }, 300);
}, 300);
