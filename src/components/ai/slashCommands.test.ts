import { describe, expect, it } from "vitest";
import {
  currentModeText,
  filterSlashCommands,
  replaceSlashWord,
  skillSlashCommands,
  skillSlashName,
  skillSlashPrefix,
  slashKeyAction,
  slashQueryAt,
  stepSlashIndex,
} from "./slashCommands";

describe("slashQueryAt", () => {
  it("opens on a lone slash and tracks the typed word", () => {
    expect(slashQueryAt("/")).toEqual({ query: "", start: 0, head: true });
    expect(slashQueryAt("/pl")).toEqual({ query: "pl", start: 0, head: true });
  });

  it("keeps the menu open across a hyphen so /auto-mode can be typed out", () => {
    expect(slashQueryAt("/auto-")?.query).toBe("auto-");
    expect(slashQueryAt("/auto-mode")?.query).toBe("auto-mode");
  });

  it("opens mid-sentence, where only the Skills are on offer", () => {
    expect(slashQueryAt("draw the flow /")).toEqual({ query: "", start: 14, head: false });
    expect(slashQueryAt("draw the flow /vis")).toEqual({ query: "vis", start: 14, head: false });
  });

  it("reads the word up to the caret and judges the whole of it", () => {
    // `/vis|ualise` — filtering follows the caret, the shape does not.
    expect(slashQueryAt("/visualise", 4)).toEqual({ query: "vis", start: 0, head: true });
    // A command with prose after it is no longer the whole draft.
    expect(slashQueryAt("/plan the release", 5)).toEqual({ query: "plan", start: 0, head: false });
  });

  it("refuses a path, typed out or half typed", () => {
    expect(slashQueryAt("look at src/App.tsx")).toBeNull();
    expect(slashQueryAt("open /Users/pierre/notes.md")).toBeNull();
    // Half typed: the caret sits inside the first segment, the rest gives it away.
    expect(slashQueryAt("open /Users/pierre", 8)).toBeNull();
    expect(slashQueryAt("see /README.md", 8)).toBeNull();
  });

  it("treats a slash that starts nothing as text", () => {
    expect(slashQueryAt("2 / 3")).toBeNull();
    expect(slashQueryAt("")).toBeNull();
    expect(slashQueryAt("/plan the release")).toBeNull();
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
    expect(inserted[0]).toBe("/code-review ");
  });

  it("keeps the first of two skills that slug to the same name", () => {
    const cmds = skillSlashCommands([skill("Zoom Out", true), skill("zoom-out", true)], [], () => {});
    expect(cmds.map((c) => c.name)).toEqual(["zoom-out"]);
  });
});

describe("replaceSlashWord", () => {
  const accept = (value: string, start: number, caret: number) =>
    replaceSlashWord({ value, start, caret, prefix: "/visualise " });

  it("completes a command that is the whole draft", () => {
    expect(accept("/visu", 0, 5)).toEqual({ value: "/visualise ", caret: 11 });
  });

  it("leaves the sentence where it stands and lands the command in it", () => {
    expect(accept("draw the auth flow /vis", 19, 23)).toEqual({
      value: "draw the auth flow /visualise ",
      caret: 30,
    });
  });

  it("takes the whole word when the caret sits inside it", () => {
    expect(accept("draw the flow /vis", 14, 17)).toEqual({
      value: "draw the flow /visualise ",
      caret: 25,
    });
  });

  it("keeps one space when prose already follows", () => {
    expect(accept("draw /vis the auth flow", 5, 9)).toEqual({
      value: "draw /visualise the auth flow",
      caret: 15,
    });
  });
});
