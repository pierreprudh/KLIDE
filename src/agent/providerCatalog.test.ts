import { describe, expect, it } from "vitest";
import {
  PROVIDER_CATALOG_ROWS,
  hostedProviderRows,
  isBuiltinProviderId,
  isLocalServerProvider,
  providerBrand,
  providerCaps,
  providerDefaultModel,
  providerGroup,
  providerHasCredits,
  providerHasNumCtx,
  providerKeyEnv,
  providerLabel,
  providerPresets,
  providerRow,
  providerRowsIn,
  verifyProviderCatalog,
} from "./providerCatalog";

describe("Provider catalog — the one TS door onto the Rust registry", () => {
  it("holds every row the mirror carries, in registry order, with a whole row each", () => {
    expect(PROVIDER_CATALOG_ROWS.length).toBeGreaterThan(0);
    expect(new Set(PROVIDER_CATALOG_ROWS.map((r) => r.id)).size).toBe(PROVIDER_CATALOG_ROWS.length);
    for (const row of PROVIDER_CATALOG_ROWS) {
      expect(row.label.trim(), row.id).not.toBe("");
      expect(row.brand.trim(), row.id).not.toBe("");
      expect(["local", "hosted", "subscription"]).toContain(row.group);
      expect(["ollama", "anthropic", "openai", "delegate"]).toContain(row.wire);
      expect(row.wire === "delegate").toBe(row.group === "subscription");
    }
  });

  it("answers for a builtin id from its row", () => {
    expect(providerLabel("mlx")).toBe("MLX (Apple Silicon)");
    expect(providerGroup("mlx")).toBe("local");
    expect(providerDefaultModel("ollama")).toBe("llama3.1:8b");
    expect(providerPresets("ollama")).toEqual(["pierreprudh/klide-8b"]);
    expect(providerPresets("mlx")[0]).toBe(providerDefaultModel("mlx"));
    expect(providerKeyEnv("xai")).toBe("XAI_API_KEY");
    expect(providerBrand("claude-code")).toBe("claude-code");
    expect(providerHasNumCtx("ollama")).toBe(true);
    expect(providerHasNumCtx("mlx")).toBe(false);
    expect(isLocalServerProvider("ollama")).toBe(true);
    expect(isLocalServerProvider("lmstudio")).toBe(false);
    expect(providerHasCredits("openrouter")).toBe(true);
    expect(providerHasCredits("anthropic")).toBe(false);
    expect(isBuiltinProviderId("codex")).toBe(true);
  });

  it("carries the run-loop quirks the Rust row declares", () => {
    expect(providerCaps("ollama")).toEqual({
      structuredReplay: false,
      minimalChatContext: true,
      appendTodoUpdates: false,
    });
    expect(providerCaps("mlx")).toMatchObject({ minimalChatContext: true, appendTodoUpdates: true });
    expect(providerCaps("anthropic")).toEqual({
      structuredReplay: true,
      minimalChatContext: false,
      appendTodoUpdates: false,
    });
  });

  it("answers explicitly for `auto` and `custom:*`, never with a builtin's value", () => {
    for (const id of ["auto", "custom:my-box", "cli:cursor-agent", "retired-provider"]) {
      expect(providerRow(id), id).toBeUndefined();
      expect(isBuiltinProviderId(id), id).toBe(false);
      expect(providerLabel(id), id).toBeUndefined();
      expect(providerGroup(id), id).toBeNull();
      expect(providerDefaultModel(id), id).toBeNull();
      expect(providerPresets(id), id).toEqual([]);
      expect(providerKeyEnv(id), id).toBeNull();
      expect(providerBrand(id), id).toBe(id);
      expect(providerHasNumCtx(id), id).toBe(false);
      expect(isLocalServerProvider(id), id).toBe(false);
      expect(providerHasCredits(id), id).toBe(false);
      // The hosted posture — the same fallback Rust `ProviderCaps::for_provider` uses.
      expect(providerCaps(id), id).toEqual({
        structuredReplay: true,
        minimalChatContext: false,
        appendTodoUpdates: false,
      });
    }
  });

  it("groups rows without re-deriving the group from the wire or the key", () => {
    expect(providerRowsIn("local").map((r) => r.id)).toEqual(["ollama", "mlx", "lmstudio"]);
    expect(providerRowsIn("subscription").every((r) => r.keyEnv === null)).toBe(true);
    const hosted = hostedProviderRows();
    expect(hosted.map((r) => r.id)).toEqual(providerRowsIn("hosted").map((r) => r.id));
    for (const row of hosted) {
      expect(row.keyEnv, row.id).toMatch(/_API_KEY$/);
      expect(row.keyPlaceholder, row.id).not.toBeNull();
    }
  });

  it("ignores IPC object-key order, including nested capabilities", async () => {
    const reordered: typeof PROVIDER_CATALOG_ROWS = JSON.parse(JSON.stringify(PROVIDER_CATALOG_ROWS.map((row) => ({
      ...Object.fromEntries(Object.entries(row).reverse()),
      caps: Object.fromEntries(Object.entries(row.caps).reverse()),
    }))));
    expect(await verifyProviderCatalog(async () => [...reordered])).toEqual([]);
  });

  it("verifies the mirror against what Rust serves live", async () => {
    const same = await verifyProviderCatalog(async () => [...PROVIDER_CATALOG_ROWS]);
    expect(same).toEqual([]);
    const [first, ...rest] = PROVIDER_CATALOG_ROWS;
    const drifted = await verifyProviderCatalog(async () => [
      { ...first, label: "Renamed" },
      ...rest,
      { ...first, id: "brand-new" },
    ]);
    expect(drifted).toEqual([first.id, "brand-new"]);
  });
});
