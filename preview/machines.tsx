// Production settings with synthetic SSH responses for interaction/layout checks.
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "../src/styles/tokens.css";
import { MachinesSection } from "../src/components/settings/machines";
import type { Machine } from "../src/ipc/machines";

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") ?? "klide-light";
document.body.style.background = "var(--bg-panel)";
let machines: Machine[] = [{ id: "cloud-dev", label: "Cloud development", sshHost: "cloud-dev", checkouts: { "/Users/me/app": "~/code/app" } }, { id: "home-server", label: "Home server", sshHost: "dev@home-server" }];
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (command: string, args: Record<string, unknown>) => {
    if (command === "machines_list") return machines;
    if (command === "machine_save") {
      const machine = args.machine as Machine;
      if (args.creating && machines.some((m) => m.id === machine.id)) throw new Error("A machine with this ID already exists");
      machines = [...machines.filter((m) => m.id !== machine.id), machine];
      return machines;
    }
    if (command === "machine_remove") { machines = machines.filter((m) => m.id !== args.id); return machines; }
    if (command === "machine_check") {
      const machine = machines.find((m) => m.id === args.id)!;
      const ready = machine.id !== "home-server";
      return { ...machine, label: machine.label ?? machine.id, ready, caption: ready ? "Ready to run Claude Code" : "Claude Code needs login", checkout: "~/code/app", facts: [
        { label: "SSH", value: "Connected", tone: "ok" },
        { label: "Claude Code", value: ready ? "Logged in" : "Not logged in", tone: ready ? "ok" : "warn", ...(!ready ? { fix: "ssh -t dev@home-server claude" } : {}) },
      ] };
    }
    throw new Error(`Unexpected preview command: ${command}`);
  },
};
ReactDOM.createRoot(document.getElementById("root")!).render(<main className="klide-settings-content" style={{ maxWidth: 1000, margin: "40px auto", padding: "0 24px" }}><MachinesSection workspaceRoot="/Users/me/app" /></main>);
