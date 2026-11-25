import { beforeEach, describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { machineSave, machineRemove, subscribeMachines, machineAuthorizeApiKey } from "./machines";

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
  it("rejects an older backend silently dropping isolation or credential choices", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeMachines(listener);
    invoke.mockResolvedValueOnce([{ id: "mini", sshHost: "mini" }]);
    await expect(machineSave({ id: "mini", sshHost: "mini", runtime: { execution: "isolated", credential: "subscription" } }, false)).rejects.toThrow("did not save your selection");
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
  it("authorizes only the chosen key ID and announces success after persistence", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeMachines(listener);
    invoke.mockResolvedValueOnce(undefined);
    await machineAuthorizeApiKey("mini", "testing-key");
    expect(invoke).toHaveBeenCalledWith("machine_authorize_api_key", { id: "mini", keyId: "testing-key" });
    expect(listener).toHaveBeenCalledOnce();
    invoke.mockRejectedValueOnce(new Error("SSH failed"));
    await expect(machineAuthorizeApiKey("mini", "other-key")).rejects.toThrow("SSH failed");
    expect(listener).toHaveBeenCalledOnce();
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
