import { describe, expect, it } from "vitest";
import { presentProjects, projectMatchesFilter } from "./runLedger";

describe("projectMatchesFilter", () => {
  it("matches the current workspace by cwd even when the parsed project is missing", () => {
    const run = {
      project: null,
      cwd: "/Users/pierre/Documents/Private/KIDE",
    };

    expect(projectMatchesFilter(run, "KIDE", "/Users/pierre/Documents/Private/KIDE")).toBe(true);
  });

  it("matches by cwd basename as a fallback for stale project strings", () => {
    const run = {
      project: "Private",
      cwd: "/Users/pierre/Documents/Private/KIDE",
    };

    expect(projectMatchesFilter(run, "KIDE", "/Users/pierre/Documents/Private/KIDE")).toBe(true);
  });
});

describe("presentProjects", () => {
  it("includes projects recoverable from cwd", () => {
    expect(presentProjects([{ project: null, cwd: "/Users/pierre/Documents/Private/KIDE" }])).toEqual(["KIDE"]);
  });
});
