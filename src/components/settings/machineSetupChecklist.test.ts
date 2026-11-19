import { describe, expect, it } from "vitest";
import type { MachineStatus } from "../../ipc/machines";
import { machineSetupChecklist } from "./machineChecklistState";
const ready: MachineStatus = { id: "mini", label: "Mini", sshHost: "mini", ready: true, facts: [], caption: "Ready", checkout: "~/code/app", setup: { connection: "connected", host: "ready", claude: "ready", github: "needsLogin", project: "ready" } };
describe("live setup checklist", () => {
  it("shows validated components and distinguishes GitHub installation from sign-in", () => {
    const rows = machineSetupChecklist(ready, true, null);
    expect(rows.find((row) => row.step === "signIn")).toMatchObject({ caption: "Validated", state: "done" });
    expect(rows.find((row) => row.step === "github")).toMatchObject({ caption: "Installed · sign in", state: "needed" });
    expect(rows.find((row) => row.step === "ready")?.state).toBe("done");
  });
  it("only checks off verified facts and keeps an active clone unfinished", () => {
    expect(machineSetupChecklist(null, true, null).some((row) => row.state === "done")).toBe(false);
    expect(machineSetupChecklist(ready, true, "clone").find((row) => row.step === "project")).toMatchObject({ state: "active", caption: "Cloning…" });
    expect(machineSetupChecklist(ready, true, "clone").find((row) => row.step === "ready")?.state).toBe("active");
  });
});
