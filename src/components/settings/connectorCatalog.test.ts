import { describe, expect, it } from "vitest";
import { CONNECTOR_CATALOG, catalogConnector, catalogMatch } from "./connectorCatalog";
import type { Connector } from "../../ipc/connectors";

const byId = (id: string) => CONNECTOR_CATALOG.find((e) => e.id === id)!;

describe("connector catalog", () => {
  it("a signed-in server stores only the sign-in reference", () => {
    const c = catalogConnector(byId("linear"), {});
    expect(c.server).toEqual({ url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer ${KLIDE_OAUTH}" } });
    expect(c.enabled).toBe(true);
  });

  it("puts a pasted key in place of its reference only", () => {
    const entry = { ...byId("fetch"), server: { command: "x", args: [], env: { K: "${K}" }, cwd: null }, secrets: [{ name: "K", label: "k" }] };
    expect(catalogConnector(entry, { K: "  v1 " }).server).toMatchObject({ env: { K: "v1" } });
    // The catalog entry itself is never mutated.
    expect(entry.server.env.K).toBe("${K}");
  });

  it("ids are unique", () => {
    const ids = CONNECTOR_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("recognises the same server imported under another name", () => {
    const imported: Connector = {
      id: "pw",
      label: "pw",
      server: { command: "npx", args: ["-y", "@playwright/mcp@latest"], env: {}, cwd: null },
      enabled: false,
      origin: "claude-code",
    };
    expect(catalogMatch(byId("playwright"), [imported])?.id).toBe("pw");
    expect(catalogMatch(byId("fetch"), [imported])).toBeNull();
  });

  it("declares every variable its spec references", () => {
    for (const entry of CONNECTOR_CATALOG) {
      const text = JSON.stringify(entry.server);
      const refs = [...text.matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((m) => m[1]).filter((n) => n !== "KLIDE_OAUTH").sort();
      expect(text.includes("KLIDE_OAUTH")).toBe(entry.auth === "oauth");
      expect(entry.secrets.map((s) => s.name).sort()).toEqual(refs);
    }
  });
});
