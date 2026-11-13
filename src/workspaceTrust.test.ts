import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmWorkspaceTrust, workspaceNeedsTrust } from "./workspaceTrust";

describe("workspace activation trust", () => {
  const values = new Map<string, string>();
  const confirm = vi.fn();
  beforeEach(() => {
    values.clear(); confirm.mockReset();
    vi.stubGlobal("window", { confirm });
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  it("does not inherit a parent or similarly named folder's approval", () => {
    expect(workspaceNeedsTrust("/repo", ["/repo"])).toBe(false);
    expect(workspaceNeedsTrust("/repo/clone", ["/repo"])).toBe(true);
    expect(workspaceNeedsTrust("/repo-other", ["/repo"])).toBe(true);
  });
  it("a declined activation grants no remembered permission", () => {
    confirm.mockReturnValue(false);
    expect(confirmWorkspaceTrust("/download")).toBe(false);
    expect(confirmWorkspaceTrust("/download")).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(values.size).toBe(0);
  });
  it("remembers an explicit approval only for that exact workspace", () => {
    confirm.mockReturnValue(true);
    expect(confirmWorkspaceTrust("/repo")).toBe(true);
    expect(confirmWorkspaceTrust("/repo")).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    confirm.mockReturnValue(false);
    expect(confirmWorkspaceTrust("/repo/subproject")).toBe(false);
  });
  it("damaged stored approvals never silently open a workspace", () => {
    values.set("klide.trustedWorkspaces.v1", '{"/download":true}');
    confirm.mockReturnValue(false);
    expect(confirmWorkspaceTrust("/download")).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
  });
});
