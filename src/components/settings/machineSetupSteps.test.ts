import { describe, expect, it } from "vitest";
import { canVisitMachineSetupStep, machineSetupStep } from "./machineSetupSteps";
import type { MachineStatus } from "../../ipc/machines";
const ready: MachineStatus = { id: "dev", label: "Dev", sshHost: "dev", ready: true, caption: "Ready", checkout: "~/code/app", facts: [], setup: { connection: "connected", host: "ready", claude: "ready", project: "ready" } };
function status(changes: Partial<MachineStatus["setup"]>): MachineStatus { return { ...ready, ready: false, setup: { ...ready.setup, ...changes } }; }
describe("guided SSH setup", () => {
  it("lets ready machines revisit setup while gating unverified prerequisites", () => {
    for (const step of ["connection", "software", "signIn", "project", "ready"] as const) expect(canVisitMachineSetupStep(step, ready, true)).toBe(true);
    expect(canVisitMachineSetupStep("software", status({ connection: "offline" }), true)).toBe(false);
    expect(canVisitMachineSetupStep("signIn", status({ host: "missing" }), true)).toBe(true);
    expect(canVisitMachineSetupStep("signIn", status({ connection: "offline" }), true)).toBe(false);
    expect(canVisitMachineSetupStep("connection", null, true)).toBe(true);
    expect(canVisitMachineSetupStep("project", ready, false)).toBe(false);
  });
  it("never advances while disconnected, even with stale ready facts", () => {
    expect(machineSetupStep(null, true)).toBe("connection");
    for (const connection of ["offline", "needsTrust", "needsAuthentication"] as const) expect(machineSetupStep(status({ connection }), true)).toBe("connection");
  });
  it("handles a missing helper, an upgrade and a missing provider before login", () => {
    for (const host of ["missing", "outdated", "unknown"] as const) expect(machineSetupStep(status({ host }), true)).toBe("software");
    expect(machineSetupStep(status({ claude: "missing" }), true)).toBe("software");
    expect(machineSetupStep(status({ claude: "needsLogin" }), true)).toBe("signIn");
  });
  it("requires this project's checkout and final backend readiness", () => {
    expect(machineSetupStep(status({ project: "missing" }), true)).toBe("project");
    expect(machineSetupStep(ready, true)).toBe("ready");
    expect(machineSetupStep({ ...ready, setup: { ...ready.setup, project: "notSelected" } }, false)).toBe("ready");
    expect(machineSetupStep({ ...ready, ready: false }, true)).not.toBe("ready");
  });
  it("works on an authorized API key without a Claude login, or Claude Code installed", () => {
    const api: MachineStatus = { ...ready, setup: { ...ready.setup, claude: "missing", apiKeys: ["openrouter"], credentials: "ready" } };
    expect(machineSetupStep(api, true)).toBe("ready");
    expect(machineSetupStep({ ...api, ready: false, setup: { ...api.setup, project: "missing" } }, true)).toBe("project");
    expect(machineSetupStep({ ...api, setup: { ...api.setup, apiKeys: [], credentials: "needsLogin" } }, true)).toBe("software");
  });
});
