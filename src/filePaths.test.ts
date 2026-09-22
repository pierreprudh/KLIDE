import { describe, expect, it } from "vitest";
import { pathFromCodeSpan, pathLabel } from "./filePaths";

describe("pathFromCodeSpan", () => {
  it("reads a rooted path — the shape that names a place on its own", () => {
    expect(pathFromCodeSpan("/Users/pierre/Documents/Onetraak")).toEqual({
      path: "/Users/pierre/Documents/Onetraak",
      line: null,
      rooted: true,
    });
    expect(pathFromCodeSpan("~/.klide/connectors.json")).toEqual({
      path: "~/.klide/connectors.json",
      line: null,
      rooted: true,
    });
    expect(pathFromCodeSpan("C:\\Users\\pierre\\Klide")).toEqual({
      path: "C:\\Users\\pierre\\Klide",
      line: null,
      rooted: true,
    });
  });

  it("offers a relative path as a candidate — the repository settles it", () => {
    expect(pathFromCodeSpan("src/App.tsx")).toEqual({
      path: "src/App.tsx",
      line: null,
      rooted: false,
    });
    expect(pathFromCodeSpan("CLAUDE.md")).toEqual({
      path: "CLAUDE.md",
      line: null,
      rooted: false,
    });
    // Shaped like a folder and unknowable from the writing alone: a branch
    // name reaches the index, which is what refuses it.
    expect(pathFromCodeSpan("m6/orchestrator")).toEqual({
      path: "m6/orchestrator",
      line: null,
      rooted: false,
    });
  });

  it("keeps a line locator out of the path", () => {
    expect(pathFromCodeSpan("/Users/pierre/KIDE/src/App.tsx:1934")).toEqual({
      path: "/Users/pierre/KIDE/src/App.tsx",
      line: 1934,
      rooted: true,
    });
    expect(pathFromCodeSpan("src/agent/mod.rs:42:7")).toEqual({
      path: "src/agent/mod.rs",
      line: 42,
      rooted: false,
    });
  });

  it("refuses what only looks like a path", () => {
    for (const span of [
      "npm run tauri dev",          // a command
      "--force",                    // a flag
      "src/**/*.ts",                // a glob
      "memory_search",              // a bare word
      "dev",                        // a branch
      "1.2.3",                      // a version
      "127.0.0.1:10100",            // an address
      "localhost:11434",            //   "
      "d28f499",                    // a commit
      ".venv",                      // a dotfile with no extension
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
  const rooted = (path: string) => ({ path, line: null, rooted: true });

  it("reads a rooted path as the word that carries the meaning", () => {
    expect(pathLabel(rooted("/Users/pierre/Documents/Onetraak"))).toBe("Onetraak");
    expect(pathLabel(rooted("~/.klide/connectors.json"))).toBe("connectors.json");
    expect(pathLabel(rooted("C:\\Users\\pierre\\Klide"))).toBe("Klide");
  });

  it("leaves a relative path whole — the folder is the information", () => {
    expect(pathLabel({ path: "src/App.tsx", line: null, rooted: false })).toBe("src/App.tsx");
  });

  it("falls back to the path when there is no last word to take", () => {
    expect(pathLabel(rooted("/"))).toBe("/");
  });
});
