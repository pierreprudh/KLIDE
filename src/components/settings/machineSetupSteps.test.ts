import { describe, expect, it } from "vitest";
import { machineSetupStep } from "./machineSetupSteps";
import type { MachineStatus } from "../../ipc/machines";
const ready: MachineStatus = { id: "dev", label: "Dev", sshHost: "dev", ready: true, caption: "Ready", checkout: "~/code/app", facts: [], setup: { connection: "connected", host: "ready", claude: "ready", project: "ready" } };
function status(changes: Partial<MachineStatus["setup"]>): MachineStatus { return { ...ready, ready: false, setup: { ...ready.setup, ...changes } }; }
describe("guided SSH setup", () => {
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
});
