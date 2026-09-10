import { describe, expect, it } from "vitest";
import {
  currentModeText,
  filterSlashCommands,
  slashKeyAction,
  slashQueryOf,
  stepSlashIndex,
} from "./slashCommands";

describe("slashQueryOf", () => {
  it("opens on a lone slash and tracks the typed word", () => {
    expect(slashQueryOf("/")).toBe("");
    expect(slashQueryOf("/pl")).toBe("pl");
  });

  it("keeps the menu open across a hyphen so /auto-mode can be typed out", () => {
    expect(slashQueryOf("/auto-")).toBe("auto-");
    expect(slashQueryOf("/auto-mode")).toBe("auto-mode");
  });

  it("treats a slash inside prose or a path as text", () => {
    expect(slashQueryOf("look at src/App.tsx")).toBeNull();
    expect(slashQueryOf("/plan the release")).toBeNull();
    expect(slashQueryOf("")).toBeNull();
  });
});

describe("filterSlashCommands", () => {
  const cmds = [{ name: "plan" }, { name: "auto-mode" }, { name: "chat" }];
  it("prefix-matches case-insensitively and keeps catalog order", () => {
    expect(filterSlashCommands(cmds, "").map((c) => c.name)).toEqual(["plan", "auto-mode", "chat"]);
    expect(filterSlashCommands(cmds, "A").map((c) => c.name)).toEqual(["auto-mode"]);
    expect(filterSlashCommands(cmds, "x")).toEqual([]);
  });
});

describe("stepSlashIndex", () => {
  it("wraps in both directions and survives an empty list", () => {
    expect(stepSlashIndex(2, 1, 3)).toBe(0);
    expect(stepSlashIndex(0, -1, 3)).toBe(2);
    expect(stepSlashIndex(0, 1, 0)).toBe(0);
  });
});

describe("slashKeyAction", () => {
  it("maps the four menu keys and leaves everything else to the composer", () => {
    expect(slashKeyAction("ArrowDown")).toBe("next");
    expect(slashKeyAction("ArrowUp")).toBe("prev");
    expect(slashKeyAction("Enter")).toBe("accept");
    expect(slashKeyAction("Tab")).toBe("accept");
    expect(slashKeyAction("Escape")).toBe("dismiss");
    expect(slashKeyAction("a")).toBeNull();
  });
});

describe("currentModeText", () => {
  it("reads the Goal policy only when the mode is goal", () => {
    expect(currentModeText({ effectiveMode: "chat", requireDiffReview: false, autoApproveCommands: true })).toBe("chat mode · no tools");
    expect(currentModeText({ effectiveMode: "plan", requireDiffReview: false, autoApproveCommands: false })).toBe("plan mode · read-only");
    expect(currentModeText({ effectiveMode: "goal", requireDiffReview: true, autoApproveCommands: false })).toBe("reviewing every edit");
    expect(currentModeText({ effectiveMode: "goal", requireDiffReview: false, autoApproveCommands: false })).toBe("auto-accept edits on");
    expect(currentModeText({ effectiveMode: "goal", requireDiffReview: false, autoApproveCommands: true })).toBe("full auto · commands run without asking");
  });
});
