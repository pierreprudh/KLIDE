import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MachineStatus } from "./ipc/machines";

const machineCheck = vi.fn<(id: string, root: string | null) => Promise<MachineStatus>>();
vi.mock("./ipc/machines", () => ({ machineCheck: (id: string, root: string | null) => machineCheck(id, root) }));

const status = (ready: boolean): MachineStatus => ({
  id: "klide-box", label: "klide-box", sshHost: "klide-box", ready,
  caption: ready ? "Keeps going when this Mac sleeps" : "Not reached", facts: [], checkout: null,
});

async function fresh() {
  vi.resetModules();
  return import("./machineStatus");
}

describe("machine readiness ahead of time", () => {
  beforeEach(() => machineCheck.mockReset());

  it("keeps the last answer on screen while a new one is fetched", async () => {
    const s = await fresh();
    machineCheck.mockResolvedValueOnce(status(true));
    s.refreshMachineStatus("klide-box", "/src/app");
    await vi.waitFor(() => expect(s.machineStatusCheck("klide-box", "/src/app")?.state).toBe("done"));
    let release!: (v: MachineStatus) => void;
    machineCheck.mockReturnValueOnce(new Promise((r) => { release = r; }));
    s.refreshMachineStatus("klide-box", "/src/app", { force: true });
    const during = s.machineStatusCheck("klide-box", "/src/app");
    expect(during?.state).toBe("checking");
    expect(s.lastKnownStatus(during)?.ready).toBe(true);
    release(status(false));
    await vi.waitFor(() => expect(s.lastKnownStatus(s.machineStatusCheck("klide-box", "/src/app"))?.ready).toBe(false));
  });

  it("reuses a fresh answer and never runs two checks at once", async () => {
    const s = await fresh();
    machineCheck.mockResolvedValue(status(true));
    s.refreshMachineStatus("klide-box", "/src/app");
    s.refreshMachineStatus("klide-box", "/src/app");
    await vi.waitFor(() => expect(s.machineStatusCheck("klide-box", "/src/app")?.state).toBe("done"));
    s.refreshMachineStatus("klide-box", "/src/app");
    expect(machineCheck).toHaveBeenCalledTimes(1);
  });

  it("a failed check is remembered as failed", async () => {
    const s = await fresh();
    machineCheck.mockRejectedValueOnce(new Error("No machine named klide-box"));
    s.refreshMachineStatus("klide-box", null);
    await vi.waitFor(() => expect(s.machineStatusCheck("klide-box", null)?.state).toBe("failed"));
  });
});
