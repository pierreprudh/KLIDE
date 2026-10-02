import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { delegateCatalog } from "./delegates";
import { DELEGATES } from "../delegates";

describe("Delegate catalog IPC adapter", () => {
  beforeEach(() => invokeMock.mockReset());

  it("owns the catalog wire contract and returns the adapters' facts as is", async () => {
    invokeMock.mockResolvedValue([...DELEGATES]);

    await expect(delegateCatalog()).resolves.toEqual([...DELEGATES]);
    expect(invokeMock).toHaveBeenCalledWith("delegate_catalog");
  });
});
