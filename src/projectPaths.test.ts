import { describe, expect, it } from "vitest";
import {
  canonicalWorkspaceRoot,
  legacyAutoRunWorkspace,
  linkedFolderLabel,
  parentDirectory,
  linkedProjectForPath,
  normalizeProjectPath,
  pathBelongsToProject,
} from "./projectPaths";

const KIDE = "/Users/pierre/Documents/Private/KIDE";

describe("project path ownership", () => {
  it("normalizes trailing separators and Windows separators", () => {
    expect(normalizeProjectPath(`${KIDE}///`)).toBe(KIDE);
    expect(normalizeProjectPath("C:\\code\\KIDE\\")).toBe("C:/code/KIDE");
  });

  it("matches exact, nested, and linked-worktree folders", () => {
    expect(pathBelongsToProject(KIDE, KIDE)).toBe(true);
    expect(pathBelongsToProject(`${KIDE}/packages/ui`, KIDE)).toBe(true);
    expect(pathBelongsToProject(`${KIDE}-worktrees/race-one`, KIDE)).toBe(true);
  });

  it("maps a managed worktree back to its owning workspace", () => {
    expect(canonicalWorkspaceRoot(`${KIDE}-worktrees/klide-run-fix-tests-c0ffee12`)).toBe(KIDE);
    expect(canonicalWorkspaceRoot(KIDE)).toBe(KIDE);
  });

  it("recognizes conversations created by the removed automatic run isolation", () => {
    expect(legacyAutoRunWorkspace({
      cwd: `${KIDE}-worktrees/klide-run-how-to-report-a-bug-a9dc5e94`,
      branch: "klide/run-how-to-report-a-bug-a9dc5e94",
      worktree: "klide-run-how-to-report-a-bug-a9dc5e94",
    })).toBe(KIDE);
  });

  it("preserves deliberately created worktree conversations", () => {
    expect(legacyAutoRunWorkspace({
      cwd: `${KIDE}-worktrees/klide-turn-migrate-auth`,
      branch: "klide/turn-migrate-auth",
      worktree: "klide-turn-migrate-auth",
    })).toBeNull();
  });

  it("uses path boundaries instead of matching lookalike folders", () => {
    expect(pathBelongsToProject(`${KIDE}-archive`, KIDE)).toBe(false);
    expect(pathBelongsToProject("/Users/pierre/Documents/Private/Other-worktrees/race", KIDE)).toBe(false);
  });

  it("chooses the deepest visible project for nested repositories", () => {
    expect(
      linkedProjectForPath(`${KIDE}/packages/ui/src`, [KIDE, `${KIDE}/packages/ui`]),
    ).toBe(`${KIDE}/packages/ui`);
  });

  it("describes nested folders and worktrees relative to their project", () => {
    expect(linkedFolderLabel(`${KIDE}/packages/ui`, KIDE)).toBe("packages/ui");
    expect(linkedFolderLabel(`${KIDE}-worktrees/race-one`, KIDE)).toBe("Worktree · race-one");
    expect(linkedFolderLabel(KIDE, KIDE)).toBeNull();
  });

  it("names the folder a project sits in, so a picker opens beside its siblings", () => {
    expect(parentDirectory(KIDE)).toBe("/Users/pierre/Documents/Private");
    expect(parentDirectory(`${KIDE}/`)).toBe("/Users/pierre/Documents/Private");
    expect(parentDirectory("/Users")).toBe("/");
    expect(parentDirectory("/")).toBeNull();
    expect(parentDirectory(null)).toBeNull();
  });
});
