import { describe, expect, it } from "vitest";
import { canConnectSshAddress, joinSshAddress, needsSshUsername, splitSshAddress } from "./machineSshAddress";

describe("explicit remote SSH accounts", () => {
  it("requires an account for discovered IPv4 and IPv6 devices", () => {
    for (const address of ["100.64.0.3", "fd7a:115c:a1e0::3", "[fd7a:115c:a1e0::3]"]) {
      expect(needsSshUsername(address)).toBe(true);
      expect(canConnectSshAddress(address)).toBe(false);
      expect(canConnectSshAddress(joinSshAddress(address, "mini-user"))).toBe(true);
    }
  });
  it("preserves configured SSH aliases and pasted user@host destinations", () => {
    expect(canConnectSshAddress("configured-mini")).toBe(true);
    expect(splitSshAddress("mini-user@100.64.0.3")).toEqual({ username: "mini-user", address: "100.64.0.3" });
    expect(joinSshAddress("100.64.0.3", "mini-user")).toBe("mini-user@100.64.0.3");
    expect(canConnectSshAddress("mini-user@")).toBe(false);
    expect(canConnectSshAddress("")).toBe(false);
  });
});
