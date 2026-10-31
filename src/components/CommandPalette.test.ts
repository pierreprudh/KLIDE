import { describe, expect, it } from "vitest";
import { groupByCategory, splitCommandLabel, splitShortcut } from "./CommandPalette";

describe("command menu rows", () => {
  it("splits a command label into its category and name", () => {
    expect(splitCommandLabel("View: Git Review")).toEqual({ category: "View", name: "Git Review" });
    expect(splitCommandLabel("Reload")).toEqual({ category: null, name: "Reload" });
  });

  it("splits a chord into one keycap per modifier, a named key whole", () => {
    expect(splitShortcut("⌘⇧F")).toEqual(["⌘", "⇧", "F"]);
    expect(splitShortcut("Esc")).toEqual(["Esc"]);
    expect(splitShortcut("?")).toEqual(["?"]);
  });

  it("groups by category in order of first appearance, stable within", () => {
    const labels = ["File: Save", "View: Close Tab", "File: Open", "Git: Push", "View: Worktrees"];
    expect(groupByCategory(labels.map((label) => ({ label }))).map((c) => c.label)).toEqual([
      "File: Save", "File: Open", "View: Close Tab", "View: Worktrees", "Git: Push",
    ]);
  });
});
