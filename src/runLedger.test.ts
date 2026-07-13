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

  it("matches runs executing in a linked worktree of the filtered project", () => {
    // Races and worktree forks run in `<repo>-worktrees/<name>` — they must
    // stay visible under the default current-project filter.
    const run = {
      project: null,
      cwd: "/Users/pierre/Documents/Private/KIDE-worktrees/race-m3abc-1",
    };

    expect(projectMatchesFilter(run, "KIDE", "/Users/pierre/Documents/Private/KIDE")).toBe(true);
  });

  it("does not leak another project's worktree runs into the filter", () => {
    const run = {
      project: null,
      cwd: "/Users/pierre/Documents/Other-worktrees/race-m3abc-1",
    };

    expect(projectMatchesFilter(run, "KIDE", "/Users/pierre/Documents/Private/KIDE")).toBe(false);
  });
});

describe("presentProjects", () => {
  it("includes projects recoverable from cwd", () => {
    expect(presentProjects([{ project: null, cwd: "/Users/pierre/Documents/Private/KIDE" }])).toEqual(["KIDE"]);
  });
});
