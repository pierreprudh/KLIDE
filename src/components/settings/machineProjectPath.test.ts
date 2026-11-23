import { describe, expect, it } from "vitest";
import { machineProjectClonePath } from "./machineProjectPath";

describe("remote clone destination", () => {
  it("creates a named project folder inside a selected parent", () => {
    expect(machineProjectClonePath("/Users/ontraak/Documents/", "KLIDE", false)).toBe("/Users/ontraak/Documents/KLIDE");
    expect(machineProjectClonePath("/", "KLIDE", false)).toBe("/KLIDE");
    expect(machineProjectClonePath("~/code", "KLIDE", false)).toBe("~/code/KLIDE");
  });
  it("does not nest another project folder when retrying the saved checkout", () => {
    expect(machineProjectClonePath("/Users/ontraak/Documents/KLIDE", "KLIDE", false)).toBe("/Users/ontraak/Documents/KLIDE");
    expect(machineProjectClonePath("/projects/klide", "KLIDE", false)).toBe("/projects/klide/KLIDE");
  });
  it("handles Windows separators, drive roots and case-insensitive folder names", () => {
    expect(machineProjectClonePath("C:\\Users\\shared\\Documents", "KLIDE", true)).toBe("C:\\Users\\shared\\Documents\\KLIDE");
    expect(machineProjectClonePath("C:\\", "KLIDE", true)).toBe("C:\\KLIDE");
    expect(machineProjectClonePath("C:/Projects/klide/", "KLIDE", true)).toBe("C:/Projects/klide");
  });
});
