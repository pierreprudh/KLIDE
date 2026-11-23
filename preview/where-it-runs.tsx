// Throwaway page: the real Focus start composer with "Where it runs" over its
// left edge, IPC mocked. ?state=ready|offline  ?menu=1 opens it  ?click=1 picks
// klide-box  ?pick=1 starts on it  ?theme=dark|klide-light|…
//   npx vite --port 1421  →  http://localhost:1421/preview/where-it-runs.html
import { useState } from "react";
import { MachinesSection } from "../src/components/settings/machines";
import type { Machine } from "../src/ipc/machines";
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "../src/styles/tokens.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "dark";
const READY = params.get("state") !== "offline" && !params.has("offline");
const PICK = params.get("pick") === "1";

let machines: Machine[] = params.get("state") === "empty" ? [] : [{ id: "klide-box", sshHost: "klide-box", checkouts: {} }];
let nextCallback = 1;
const callbacks = new Map<number, (event: unknown) => void>();
const eventListeners = new Map<number, { event: string; handler: number }>();
let connected = false;
let signedIn = false;
let componentsInstalled = false;
let promptSession: string | null = null;
let githubPromptStage = 0;
let githubSignedIn = false;
let personalAccounts = params.has("personalGithub") ? ["example-user"] : [];
const remoteFolders: Record<string, string[]> = { "/Users/remote": ["Documents", "Projects"], "/Users/remote/Documents": [], "/Users/remote/Projects": ["Existing project"], "/Users/remote/Projects/Existing project": [] };
function emit(event: string, payload: unknown) {
  for (const [id, listener] of eventListeners) if (listener.event === event) callbacks.get(listener.handler)?.({ event, id, payload });
}
(window as any).__TAURI_INTERNALS__ = {
  transformCallback: (callback: (event: unknown) => void) => { const id = nextCallback++; callbacks.set(id, callback); return id; },
  unregisterCallback: (id: number) => { callbacks.delete(id); },
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    if (cmd === "machine_remote_directories" || cmd === "machine_remote_create_directory") {
      if (params.has("failBrowse")) throw new Error("Permission denied while reading this remote folder");
      let path = args.path === "~" ? "/Users/remote" : args.path as string;
      if (cmd === "machine_remote_create_directory") {
        path = `${args.parent}/${args.name}`;
        remoteFolders[path] = [];
        remoteFolders[args.parent as string].push(args.name as string);
        (window as any).__MACHINE_FOLDER_CREATED__ = path;
      }
      if (!(path in remoteFolders)) throw new Error("Folder not found");
      return { path, parent: path === "/Users/remote" ? "/Users" : path.slice(0, path.lastIndexOf("/")), entries: remoteFolders[path].map((name) => ({ name, path: `${path}/${name}` })), truncated: false };
    }
    if (cmd === "machine_repository_context") return { repository: "example/project", authorName: "Example Dev", authorEmail: "dev@example.test" };
    if (cmd === "machine_github_accounts") return [...personalAccounts];
    if (cmd === "machine_github_logout") { (window as any).__MACHINE_GITHUB_LOGOUT__ = args.login; personalAccounts = personalAccounts.filter((login) => login !== args.login); return; }
    if (cmd === "machine_repository_connect") { (window as any).__MACHINE_REPOSITORY_CONNECT__ = args; githubSignedIn = true; return "Repository-only access verified."; }
    if (cmd === "machine_repository_configure") { (window as any).__MACHINE_REPOSITORY_CONFIGURE__ = args; return; }
    if (cmd === "plugin:opener|open_url") { (window as any).__MACHINE_OPENED_URL__ = args.url; return; }
    if (cmd === "pty_write") {
      (window as any).__MACHINE_INPUTS__ = [...((window as any).__MACHINE_INPUTS__ ?? []), args.data];
      if (params.get("prompt") === "github" && args.id === promptSession) {
        if (githubPromptStage === 1 && args.data === "y\r") {
          githubPromptStage = 2;
          // Survey asks for the terminal size after confirmation. A form-only
          // client that writes the answer but never replies to DSR stalls here.
          setTimeout(() => emit("pty:data", { id: args.id, chunk: "\x1b7\x1b[?25l\x1b[999;999f\x1b[" }), 100);
          setTimeout(() => emit("pty:data", { id: args.id, chunk: "6n" }), 150);
        } else if (githubPromptStage === 2 && args.data === "\x1b[24;80R") {
          githubPromptStage = 3;
          const code = params.get("codeStyle") === "clipboard" ? "! One-time code (ABCD-1234) copied to clipboard" : "! First copy your one-time code: ABCD-1234";
          setTimeout(() => emit("pty:data", { id: args.id, chunk: `\r\n${code}\r\n` }), 100);
          setTimeout(() => emit("pty:data", { id: args.id, chunk: "Press Enter to open https://github.com/login/device in your browser... \x1b7" }), 250);
        } else if (githubPromptStage === 3 && args.data === "\r") {
          githubPromptStage = 4;
          const finish = () => {
            githubSignedIn = !params.has("failGithub");
            emit("pty:data", { id: args.id, chunk: params.has("failGithub") ? "\r\nGitHub authentication failed.\r\n" : "\r\nAuthentication complete.\r\n" });
            emit("machine-setup:exit", { id: args.id, success: !params.has("failGithub") });
          };
          if (params.has("holdGithub")) (window as any).__MACHINE_GITHUB_COMPLETE__ = finish;
          else setTimeout(finish, 100);
        }
        return;
      }
      if (args.id === promptSession) setTimeout(() => {
        connected = true; signedIn = true;
        emit("pty:data", { id: args.id, chunk: "\r\nSetup complete\r\n" });
        emit("machine-setup:exit", { id: args.id, success: true });
      }, 100);
      return;
    }
    if (cmd === "plugin:event|listen") { const id = nextCallback++; eventListeners.set(id, args as { event: string; handler: number }); return id; }
    if (cmd === "plugin:event|unlisten") { eventListeners.delete(args.eventId as number); return; }
    if (cmd === "machine_setup_close") { (window as any).__MACHINE_SETUP_CLOSES__ = [...((window as any).__MACHINE_SETUP_CLOSES__ ?? []), args.id]; return; }
    if (cmd === "machine_setup_spawn") {
      if (args.action === "clone") (window as any).__MACHINE_CLONE_CHECKOUT__ = machines.find((machine) => machine.id === args.id)?.checkouts?.[args.workspaceRoot as string];
      (window as any).__MACHINE_SETUP_HOST__ = machines.find((machine) => machine.id === args.id)?.sshHost;
      (window as any).__MACHINE_SETUP_ACTIONS__ = [...((window as any).__MACHINE_SETUP_ACTIONS__ ?? []), args.action];
      if (params.has("liveChecklist") && args.action === "prepare") {
        setTimeout(() => { componentsInstalled = true; }, 200);
        (window as any).__MACHINE_FINISH_SETUP__ = () => emit("machine-setup:exit", { id: args.terminalId, success: true });
        return;
      }
      if (params.has("prompt")) {
        promptSession = args.terminalId as string;
        const prompts: Record<string, string> = {
          password: "mini-user@100.64.0.3's password: ",
          trust: "ED25519 key fingerprint is SHA256:abcdefghijklmnopqrstuvwxyz1234567890abcdefg.\r\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ",
          oauth: "Open https://claude.ai/oauth/authorize?state=example\r\nPaste code here if prompted > ",
          interactive: "Choose an account\r\nUse arrow keys to choose an account, then press Enter",
          github: "! Read more at https://gh.io/gh-expiring-tokens\r\n? Authenticate Git with your GitHub credentials? (Y/n) \x1b7",
        };
        if (params.get("prompt") === "github") githubPromptStage = 1;
        setTimeout(() => emit("pty:data", { id: args.terminalId, chunk: prompts[params.get("prompt")!] ?? "" }), 100);
        return;
      }
      if (params.has("authorizeSuccess") && args.action === "authorize") {
        setTimeout(() => { emit("machine-setup:exit", { id: args.terminalId, success: true }); }, 200);
        return;
      }
      if (params.has("failConnect")) setTimeout(() => {
        emit("pty:data", { id: args.terminalId, chunk: "Connection closed by 100.64.0.3 port 22\r\n" });
        emit("machine-setup:exit", { id: args.terminalId, success: false });
      }, 300);
      if (params.has("connectSuccess") || params.has("authorizeSuccess") && args.action === "connect") setTimeout(() => {
        connected = true;
        emit("pty:data", { id: args.terminalId, chunk: "SSH connected\r\n" });
        emit("machine-setup:exit", { id: args.terminalId, success: true });
      }, 300);
      return;
    }
    if (cmd === "machines_list") return structuredClone(machines);
    if (cmd === "machine_remove") {
      if (params.has("failRemove")) throw new Error("Could not remove the saved machine");
      machines = machines.filter((machine) => machine.id !== args.id);
      return structuredClone(machines);
    }
    if (cmd === "machine_discover") {
      if (params.has("discoveryDelay")) await new Promise((resolve) => setTimeout(resolve, 500));
      if (args.method === "tailscale") return params.has("noTailscale") ? { machines: [], message: "Install Tailscale and connect this Mac to your network, then refresh." } : {
        machines: [
          { label: "Linux dev", sshHost: "100.64.0.2", source: "tailscale", online: true, supported: true, detail: "Tailscale · SSH check required", machine: null },
          { label: "Build server", sshHost: "100.64.0.4", source: "tailscale", online: false, supported: true, detail: "Tailscale · SSH check required", machine: null },
          { label: "Mac mini", sshHost: "100.64.0.3", source: "tailscale", online: true, supported: true, detail: "Tailscale · SSH check required", machine: null },
          { label: "Windows PC", sshHost: "100.64.0.5", source: "tailscale", online: true, supported: true, detail: "Tailscale · SSH check required", machine: null },
          { label: "Phone", sshHost: "100.64.0.6", source: "tailscale", online: true, supported: false, detail: "No native SSH helper for this operating system", machine: null },
        ], message: "Choose a device on your Tailscale network. The remote machine still needs SSH and a supported OS and architecture.",
      };
      return { machines: machines.map((machine) => ({ label: machine.label ?? machine.id, sshHost: machine.sshHost, source: "saved", online: null, supported: true, detail: "Saved in Klide", machine })), message: args.method === "vpn" ? "Connect your VPN first, then choose or add an SSH address." : "Choose a saved machine or add an SSH address." };
    }
    if (cmd === "machine_save") {
      (window as any).__MACHINE_SAVED__ = args.machine;
      if (params.has("failSave")) throw new Error("Could not save machine settings");
      const machine = args.machine as Machine;
      machines = [...machines.filter((m) => m.id !== machine.id), machine];
      return machines;
    }
    if (cmd === "machine_prepare_host") { (window as any).__MACHINE_PREPARED_TARGET__ = args.target; return null; }
    if (cmd === "machine_check") {
      if (params.has("pendingCheck")) return new Promise(() => {});
      if (params.has("delay")) await new Promise((resolve) => setTimeout(resolve, 1500));
      const machine = machines.find((m) => m.id === args.id)!;
      const reachable = (READY || connected) && !(window as any).__MACHINE_FORCE_OFFLINE__;
      const needsInstall = params.has("needsInstall") && !componentsInstalled;
      return {
        id: machine.id, label: machine.label ?? machine.id, sshHost: machine.sshHost, ready: reachable && !needsInstall && (!params.has("needsLogin") || signedIn) && !params.has("needsProject") && !params.has("unsupported"),
        target: reachable ? { os: params.get("system") ?? "linux", arch: params.get("system") === "macos" ? "aarch64" : "x86_64" } : null,
        caption: params.has("unsupported") ? "This remote architecture does not have a published helper yet" : reachable ? "Keeps going when this Mac sleeps" : "Not reached — is Tailscale on?",
        facts: reachable ? [] : [{ label: "Reached", value: "timeout", tone: "bad", fix: "ssh klide-box" }],
        checkout: "~/code/pixel-art-editor",
        setup: { connection: params.has("unsupported") ? "unsupported" : reachable ? "connected" : "offline", host: needsInstall && !params.has("hostReady") ? "missing" : "ready", claude: needsInstall ? "missing" : params.has("needsLogin") && !signedIn ? "needsLogin" : "ready", githubScope: params.has("oldBackend") ? undefined : params.has("repoAccess") ? "repository" : "account", github: params.has("missingGh") && !componentsInstalled ? "missing" : (params.has("needsGhLogin") || params.has("missingGh")) && !githubSignedIn ? "needsLogin" : "ready", project: params.has("needsProject") ? "missing" : "ready" },
      };
    }
    if (cmd.endsWith("list") || cmd.includes("models") || cmd.includes("status")) return [];
    return null;
  },
};
if (PICK) localStorage.setItem("klide.startMachineByProject", JSON.stringify({ "/Users/pierre/Documents/Private/pixel-art-editor": "klide-box" }));
else localStorage.removeItem("klide.startMachineByProject");

const { FocusComposer } = await import("../src/components/FocusMode");
const { default: ToastHost } = await import("../src/components/ToastHost");

function Page() {
  const [section, setSection] = useState<string | null>(params.has("settings") ? "machines" : null);
  if (section === "machines") return <main style={{ maxWidth: 900, padding: 24, margin: "0 auto" }}><button onClick={() => setSection(null)}>Back to Focus</button><MachinesSection workspaceRoot="/Users/pierre/Documents/Private/pixel-art-editor" /></main>;
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
            onOpenSettingsSection: setSection,
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


