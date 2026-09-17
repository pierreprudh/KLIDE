import { describe, expect, it } from "vitest";
import {
  currentModeText,
  filterSlashCommands,
  skillSlashCommands,
  skillSlashName,
  skillSlashPrefix,
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

describe("skill slash commands", () => {
  const skill = (name: string, enabled: boolean, description = "") => ({
    id: name, name, description, instructions: "do it", tools: [], enabled,
  });

  it("names a skill in kebab-case so the menu grammar can type it", () => {
    expect(skillSlashName("Code Review")).toBe("code-review");
    expect(skillSlashName("visualise")).toBe("visualise");
    expect(skillSlashName("  Matt's  Zoom_Out! ")).toBe("matts-zoom-out");
  });

  it("lists only enabled skills, after the built-ins, and yields a taken name", () => {
    const inserted: string[] = [];
    const cmds = skillSlashCommands(
      [skill("Code Review", true, "Review code."), skill("handoff", true), skill("Visualise", false)],
      [{ name: "handoff" }],
      (p) => inserted.push(p),
    );
    expect(cmds.map((c) => c.name)).toEqual(["code-review"]);
    expect(cmds[0].desc).toBe("Review code.");
    void cmds[0].run();
    expect(inserted).toEqual([skillSlashPrefix({ name: "Code Review" })]);
  });

  it("keeps the first of two skills that slug to the same name", () => {
    const cmds = skillSlashCommands([skill("Zoom Out", true), skill("zoom-out", true)], [], () => {});
    expect(cmds.map((c) => c.name)).toEqual(["zoom-out"]);
  });
});
