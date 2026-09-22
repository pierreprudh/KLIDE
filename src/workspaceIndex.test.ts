import { beforeEach, describe, expect, it } from "vitest";
import {
  foldersOf,
  primeWorkspaceIndex,
  repoHasPath,
  setIndexedProject,
} from "./workspaceIndex";

describe("foldersOf", () => {
  it("names every folder on the way to a file", () => {
    expect([...foldersOf(["src/components/ai/types.ts", "README.md"])]).toEqual([
      "src",
      "src/components",
      "src/components/ai",
    ]);
  });
});

describe("repoHasPath", () => {
  beforeEach(() => setIndexedProject(null));

  it("is false with no project open — nothing can be inside nothing", () => {
    expect(repoHasPath("src/App.tsx")).toBe(false);
  });

  it("waits rather than saying no while the walk is out", () => {
    setIndexedProject("/tmp/project");
    expect(repoHasPath("src/App.tsx")).toBeNull();
  });

  it("recognises a walked file, and the folders above it", () => {
    primeWorkspaceIndex("/tmp/project", ["src/App.tsx", "docs/MODEL_ROUTING.md"]);
    expect(repoHasPath("src/App.tsx")).toBe(true);
    expect(repoHasPath("docs")).toBe(true);
    expect(repoHasPath("docs/")).toBe(true);
    expect(repoHasPath("./src/App.tsx")).toBe(true);
  });

  it("does not recognise another project's names", () => {
    primeWorkspaceIndex("/tmp/project", ["src/App.tsx"]);
    for (const path of ["harness/", "CLAUDE.md", "pyproject.toml", "m6/orchestrator"]) {
      expect(repoHasPath(path), path).toBe(false);
    }
  });

  it("forgets the old repository the moment the project changes", () => {
    primeWorkspaceIndex("/tmp/project", ["src/App.tsx"]);
    setIndexedProject("/tmp/other");
    expect(repoHasPath("src/App.tsx")).toBeNull();
  });
});
