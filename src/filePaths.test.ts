import { describe, expect, it } from "vitest";
import { pathFromCodeSpan, pathLabel } from "./filePaths";

describe("pathFromCodeSpan", () => {
  it("reads a rooted path — the one shape that names a single place", () => {
    expect(pathFromCodeSpan("/Users/pierre/Documents/Onetraak")).toEqual({
      path: "/Users/pierre/Documents/Onetraak",
      line: null,
    });
    expect(pathFromCodeSpan("~/.klide/connectors.json")).toEqual({
      path: "~/.klide/connectors.json",
      line: null,
    });
    expect(pathFromCodeSpan("C:\\Users\\pierre\\Klide")).toEqual({
      path: "C:\\Users\\pierre\\Klide",
      line: null,
    });
  });

  it("keeps a line locator out of the path", () => {
    expect(pathFromCodeSpan("/Users/pierre/KIDE/src/App.tsx:1934")).toEqual({
      path: "/Users/pierre/KIDE/src/App.tsx",
      line: 1934,
    });
    expect(pathFromCodeSpan("~/KIDE/agent/mod.rs:42:7")).toEqual({
      path: "~/KIDE/agent/mod.rs",
      line: 42,
    });
  });

  it("leaves a project-relative name alone — it belongs to whichever project the answer is about", () => {
    for (const span of [
      "src/App.tsx",        // this project, but Finder is not where it opens
      "CLAUDE.md",          // Onetraak's, in an answer about Onetraak
      "harness/",           //   "
      "pyproject.toml",     //   "
      "m6/orchestrator",    // a git branch, not a folder at all
    ]) {
      expect(pathFromCodeSpan(span), span).toBeNull();
    }
  });

  it("refuses what only looks like a path", () => {
    for (const span of [
      "npm run tauri dev",          // a command
      "--force",                    // a flag
      "/src/**/*.ts",               // a glob
      "memory_search",              // a bare word
      "1.2.3",                      // a version
      "127.0.0.1:10100",            // an address
      "localhost:11434",            //   "
      "d28f499",                    // a commit
      ".venv",                      // a dotfile, still project-relative
      "https://v2.tauri.app",       // the web door owns links
      "/etc/init(1)",               // a call, or a man page
      "/",                          // nowhere in particular
      "~",
      "",
    ]) {
      expect(pathFromCodeSpan(span), span).toBeNull();
    }
  });
});

describe("pathLabel", () => {
  it("reads a path as the word that carries the meaning", () => {
    expect(pathLabel("/Users/pierre/Documents/Onetraak")).toBe("Onetraak");
    expect(pathLabel("/Users/pierre/Documents/Private/KIDE")).toBe("KIDE");
    expect(pathLabel("~/.klide/connectors.json")).toBe("connectors.json");
    expect(pathLabel("C:\\Users\\pierre\\Klide")).toBe("Klide");
  });

  it("falls back to the path when there is no last word to take", () => {
    expect(pathLabel("/")).toBe("/");
  });
});
