import { describe, expect, it } from "vitest";
import { tailscaleEndpointUrl } from "./tailscaleEndpoint";

describe("Tailscale inference URL shortcut", () => {
  it.each(["100.64.1.2", "gpu-box", "gpu-box.tail123.ts.net"])("builds an API URL for %s", (host) => {
    expect(tailscaleEndpointUrl(` ${host} `, "8000")).toBe(`http://${host}:8000/v1`);
  });
  it.each(["", "http://gpu-box", "gpu-box/v1", "gpu-box:8000", "user@gpu-box", "gpu box"])("rejects a non-address input: %s", (host) => {
    expect(tailscaleEndpointUrl(host, "8000")).toBe("");
  });
  it.each(["", "0", "65536", "-1", "8e3", "8000/path"])("rejects an invalid port: %s", (port) => {
    expect(tailscaleEndpointUrl("gpu-box", port)).toBe("");
  });
});
