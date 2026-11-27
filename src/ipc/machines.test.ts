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
  it("rejects older backends that silently discard the API credential choice", async () => {
    const machine = { id: "server", sshHost: "server", inference: { provider: "openrouter" as const, model: "deepseek/test-model" } };
    invoke.mockResolvedValueOnce([{ id: "server", sshHost: "server" }]);
    await expect(machineSave(machine, false)).rejects.toThrow("did not save this choice");
  });
});
