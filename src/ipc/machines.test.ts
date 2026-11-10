import { beforeEach, describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { machineSave, machineRemove, subscribeMachines } from "./machines";

describe("machine configuration updates", () => {
  beforeEach(() => invoke.mockReset());
  it("refreshes subscribers after a durable save or removal", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeMachines(listener);
    const machine = { id: "server", sshHost: "user@server", checkouts: { "/src/app": "~/code/app" } };
    invoke.mockResolvedValueOnce([machine]).mockResolvedValueOnce([]);
    expect(await machineSave(machine, true)).toEqual([machine]);
    expect(invoke).toHaveBeenCalledWith("machine_save", { machine, creating: true });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(await machineRemove("server")).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
  it("keeps the picker unchanged when persistence fails", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeMachines(listener);
    invoke.mockRejectedValueOnce(new Error("Invalid machine store"));
    await expect(machineSave({ id: "server", sshHost: "server" }, true)).rejects.toThrow("Invalid machine store");
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
