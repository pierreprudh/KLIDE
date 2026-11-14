import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmLinkedFolder, migrateTrustOnce, resetTrustMigrationForTests } from "./workspaceTrust";

describe("restricted folders", () => {
  const values = new Map<string, string>();
  const confirm = vi.fn();
  beforeEach(() => {
    values.clear();
    confirm.mockReset();
    resetTrustMigrationForTests();
    vi.stubGlobal("window", { confirm });
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("trusts recents and the older consent's folders once, then never again", async () => {
    values.set("klide.trustedWorkspaces.v1", JSON.stringify(["/approved", "/repo"]));
    const grant = vi.fn().mockResolvedValue(undefined);
    await migrateTrustOnce(["/repo", "/work"], grant);
    expect(grant).toHaveBeenCalledWith(["/repo", "/work", "/approved"]);
    resetTrustMigrationForTests();
    await migrateTrustOnce(["/later"], grant);
    expect(grant).toHaveBeenCalledOnce();
  });

  it("a failed grant is retried on the next launch", async () => {
    const grant = vi.fn().mockRejectedValueOnce(new Error("disk")).mockResolvedValue(undefined);
    await migrateTrustOnce(["/repo"], grant);
    resetTrustMigrationForTests();
    await migrateTrustOnce(["/repo"], grant);
    expect(grant).toHaveBeenCalledTimes(2);
    expect(values.get("klide.trust.migrated.v1")).toBe("1");
  });

  it("a link to a trusted folder opens without asking", async () => {
    expect(await confirmLinkedFolder("/repo", async () => ({ trusted: true, gitPaused: false }))).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("a link to any other folder asks, and a no opens nothing", async () => {
    confirm.mockReturnValue(false);
    expect(await confirmLinkedFolder("/download", async () => ({ trusted: false, gitPaused: true }))).toBe(false);
    expect(await confirmLinkedFolder("/download", async () => { throw new Error("ipc"); })).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});
