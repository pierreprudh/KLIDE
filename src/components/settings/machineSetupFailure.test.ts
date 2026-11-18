import { describe, expect, it } from "vitest";
import { machineSetupFailure } from "./machineSetupFailure";

describe("SSH setup recovery", () => {
  it("explains a server-side disconnect without reporting the machine as powered off", () => {
    const message = machineSetupFailure("connect", "Connection closed by 100.64.0.3 port 22\r\n");
    expect(message).toContain("Remote Login");
    expect(message).toContain("username");
    expect(message).not.toContain("Turn on");
  });
  it("distinguishes rejected authentication, host trust, disabled SSH and network failure", () => {
    expect(machineSetupFailure("connect", "Permission denied (publickey,password,keyboard-interactive).")).toContain("sign-in was rejected");
    expect(machineSetupFailure("connect", "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!")).toContain("fingerprint");
    expect(machineSetupFailure("connect", "connect to host mini port 22: Connection refused")).toContain("enable Remote Login");
    expect(machineSetupFailure("connect", "Connection timed out")).toContain("network or VPN");
  });
  it("keeps installer failures separate from SSH authentication", () => {
    expect(machineSetupFailure("prepare", "Permission denied writing executable")).not.toContain("SSH sign-in");
  });
});
