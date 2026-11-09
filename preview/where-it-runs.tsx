// Throwaway page: the real Focus start composer with "Where it runs" over its
// left edge, IPC mocked. ?state=ready|offline  ?menu=1 opens it  ?click=1 picks
// klide-box  ?pick=1 starts on it  ?theme=dark|klide-light|…
//   npx vite --port 1421  →  http://localhost:1421/preview/where-it-runs.html
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "../src/styles/tokens.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "dark";
const READY = params.get("state") !== "offline";
const PICK = params.get("pick") === "1";

(window as any).__TAURI_INTERNALS__ = {
  transformCallback: () => 0,
  invoke: async (cmd: string) => {
    if (cmd === "machines_list") return [{ id: "klide-box", sshHost: "klide-box" }];
    if (cmd === "machine_check")
      return {
        id: "klide-box", label: "klide-box", sshHost: "klide-box", ready: READY,
        caption: READY ? "Keeps going when this Mac sleeps" : "Not reached — is Tailscale on?",
        facts: READY ? [] : [{ label: "Reached", value: "timeout", tone: "bad", fix: "ssh klide-box" }],
        checkout: "~/code/pixel-art-editor",
      };
    if (cmd.endsWith("list") || cmd.includes("models") || cmd.includes("status")) return [];
    return null;
  },
};
if (PICK) localStorage.setItem("klide.startMachineByProject", JSON.stringify({ "/Users/pierre/Documents/Private/pixel-art-editor": "klide-box" }));
else localStorage.removeItem("klide.startMachineByProject");

const { FocusComposer } = await import("../src/components/FocusMode");
const { default: ToastHost } = await import("../src/components/ToastHost");

function Page() {
  return (
    <div style={{ padding: "160px 40px 40px", background: "var(--bg)", minHeight: "100vh", color: "var(--fg)", boxSizing: "border-box" }}>
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <FocusComposer
          controls={{
            workspaceRoot: "/Users/pierre/Documents/Private/pixel-art-editor",
            provider: PICK ? "claude-code" : "anthropic",
            onProviderChange: () => {},
            model: "claude-sonnet-4-6",
            onModelChange: () => {},
            effort: undefined,
            onEffortChange: () => {},
            contextWindow: undefined,
            onContextWindowChange: () => {},
            requireDiffReview: true,
            onRequireDiffReviewChange: () => {},
            autoApproveCommands: false,
            onAutoApproveCommandsChange: () => {},
            onOpenSettingsSection: () => {},
            skills: [],
          } as any}
          branch="main"
          onPingGit={() => {}}
          onSubmit={() => {}}
          autoFocus={false}
        />
      </div>
      <ToastHost />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Page />);

if (params.get("menu") === "1" || params.get("click") === "1") {
  setTimeout(() => {
    (document.querySelector('[aria-label^="Where it runs"]') as HTMLButtonElement | null)?.click();
    if (params.get("click") === "1") {
      setTimeout(() => {
        const row = [...document.querySelectorAll('[role="option"]')].find((n) => n.textContent?.includes("klide-box")) as HTMLElement | undefined;
        row?.click();
      }, 400);
    }
  }, 1200);
}

