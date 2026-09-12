import { beforeEach, describe, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { decodeBytes, encodeBytes, readWorkbookFile, saveWorkbookFile } from "./files";

beforeEach(() => invoke.mockReset());
describe("workbook file boundary", () => {
  it("round trips arbitrary bytes without corrupting Unicode or binary workbooks", () => {
    const bytes = new TextEncoder().encode("Dépenses · 日本語");
    expect(decodeBytes(encodeBytes(bytes))).toEqual(bytes);
  });
  it("loads bytes and a version from an absolute workspace path", async () => {
    invoke.mockResolvedValueOnce("12:1234").mockResolvedValueOnce("data:application/octet-stream;base64,e30=");
    expect(await readWorkbookFile("/workspace", "budget.sheet.json")).toEqual({ bytes: new TextEncoder().encode("{}"), base64: "e30=", version: "12:1234" });
    expect(invoke).toHaveBeenCalledWith("read_file_data_uri", { workspaceRoot: "/workspace", path: "/workspace/budget.sheet.json" });
  });
  it("sends the original bytes for conflict checking, or null for create-only export", async () => {
    invoke.mockResolvedValue(undefined);
    await saveWorkbookFile("/workspace", "budget.sheet.json", new Uint8Array([1, 2]), "old");
    expect(invoke).toHaveBeenLastCalledWith("save_spreadsheet", { workspaceRoot: "/workspace", path: "/workspace/budget.sheet.json", content: "AQI=", expected: "old" });
    await saveWorkbookFile("/workspace", "budget.xlsx", new Uint8Array([1, 2]), null);
    expect(invoke).toHaveBeenLastCalledWith("save_spreadsheet", expect.objectContaining({ expected: null }));
  });
});
