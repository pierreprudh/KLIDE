/** Tailscale is a connection shortcut; the saved provider is still an ordinary API URL. */
export function isTailscaleEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, "");
    if (host.endsWith(".ts.net")) return true;
    if (host.startsWith("[fd7a:115c:a1e0:")) return true;
    const parts = host.split(".").map(Number);
    return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
  } catch {
    return false;
  }
}

export function tailscaleEndpointUrl(host: string, port: string): string {
  const address = host.trim();
  if (!address || !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(address)) return "";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return "";
  return `http://${address}:${Number(port)}/v1`;
}
