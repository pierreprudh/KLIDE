// Production settings with synthetic SSH responses for interaction/layout checks.
import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "../src/styles/tokens.css";
import { MachinesSection } from "../src/components/settings/machines";
import type { Machine } from "../src/ipc/machines";

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") ?? "klide-light";
document.body.style.background = "var(--bg-panel)";
let machines: Machine[] = [{ id: "cloud-dev", label: "Cloud development", sshHost: "cloud-dev", checkouts: { "/Users/me/app": "~/code/app" } }, { id: "home-server", label: "Home server", sshHost: "dev@home-server" }];
let installed = false;
let signedIn = false;
let cloned = false;
const setupActions: string[] = [];
Object.assign(window, { __machineSetupActions: setupActions });
const options = new URLSearchParams(location.search);
mockIPC(async (command, args = {}) => {
    const payload = args as Record<string, unknown>;
    if (command === "machine_prepare_host" || command === "pty_resize" || command === "pty_write" || command === "machine_setup_close") return null;
    if (command === "machine_setup_spawn") {
      const id = payload.terminalId;
      const action = payload.action;
      setupActions.push(String(action));
      setTimeout(async () => {
        if (action === "signIn") signedIn = true;
        if (action === "clone") cloned = true;
        await emit("pty:data", { id, chunk: `Synthetic ${action} output\r\n` });
        await emit("machine-setup:exit", { id, success: true });
      }, 80);
      return null;
    }
    if (command === "machine_install_host") {
      if (new URLSearchParams(location.search).has("active")) throw new Error("Finish the remote host's active sessions before updating");
      installed = true;
      return null;
    }
    if (command === "machine_discover") return { machines: [], message: "Choose a saved machine or add an SSH address." };
    if (command === "machines_list") return machines;
    if (command === "machine_save") {
      const machine = payload.machine as Machine;
      if (payload.creating && machines.some((m) => m.id === machine.id)) throw new Error("A machine with this ID already exists");
      machines = [...machines.filter((m) => m.id !== machine.id), machine];
      return machines;
    }
    if (command === "machine_remove") { machines = machines.filter((m) => m.id !== payload.id); return machines; }
    if (command === "machine_check") {
      const machine = machines.find((m) => m.id === payload.id)!;
      const offline = options.has("offline");
      const needsSoftware = options.has("install") && !installed;
      const loggedIn = signedIn || machine.id !== "home-server";
      const projectReady = !options.has("project") || cloned;
      const ready = !offline && !needsSoftware && loggedIn && projectReady;
      return { ...machine, label: machine.label ?? machine.id, ready, caption: offline ? "Offline" : ready ? "Ready to run Claude Code" : "Continue setup", checkout: machine.checkouts?.["/Users/me/app"] ?? "~/code/app",
        setup: { connection: offline ? "offline" : "connected", host: needsSoftware ? "missing" : "ready", claude: loggedIn ? "ready" : "needsLogin", project: projectReady ? "ready" : "missing" }, facts: [
        { label: "SSH", value: "Connected", tone: "ok" },
        { label: "Claude Code", value: ready ? "Logged in" : "Not logged in", tone: ready ? "ok" : "warn", ...(!ready ? { fix: "ssh -t dev@home-server claude" } : {}) },
      ] };
    }
    throw new Error(`Unexpected preview command: ${command}`);
}, { shouldMockEvents: true });
ReactDOM.createRoot(document.getElementById("root")!).render(<main className="klide-settings-content" style={{ maxWidth: 1000, margin: "40px auto", padding: "0 24px" }}><MachinesSection workspaceRoot="/Users/me/app" /></main>);
