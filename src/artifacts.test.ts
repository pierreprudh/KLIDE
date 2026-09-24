import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  artifactActionLabel,
  artifactOpensIn,
  artifactPreview,
  loadArtifactPreview,
  openArtifactInApp,
} from "./artifacts";

beforeEach(() => invokeMock.mockReset());

describe("where a produced document opens", () => {
  it.each(["notes.md", "report.MD", "data.csv", "index.html", "src/gen/types.ts"])(
    "reads %s in the inspector",
    (path) => expect(artifactOpensIn(path)).toBe("inspector"),
  );

  it.each(["decks/Q3.pptx", "brief.docx", "report.pdf", "chart.png", "bundle.zip"])(
    "hands %s to the app that owns it",
    (path) => expect(artifactOpensIn(path)).toBe("system"),
  );

  it.each(["budget.xlsx", "budget.XLSX", "report.sheet.json"])("opens %s in the built-in spreadsheet", path => {
    expect(artifactOpensIn(path)).toBe("spreadsheet");
    expect(artifactActionLabel(path)).toContain("in spreadsheet");
  });

  it("treats an unknown or missing extension as a binary", () => {
    // Monaco showing a binary is the failure this list exists to prevent, so
    // the unknown case leaves the app rather than guessing.
    expect(artifactOpensIn("build/output")).toBe("system");
    expect(artifactOpensIn("archive.tar.zst")).toBe("system");
  });

  it("does not read a dotfile's name as its extension", () => {
    expect(artifactOpensIn(".env")).toBe("system");
    expect(artifactOpensIn("config/.gitignore")).toBe("system");
  });

  it("says which of the things the row will do", () => {
    expect(artifactActionLabel("decks/Q3 review.pptx")).toBe("Open Q3 review.pptx in its app");
    expect(artifactActionLabel("notes/summary.md")).toBe("Read summary.md");
  });

  it("promises Finder, not an app, for a file with no extension", () => {
    // Rust reveals what names no app; an extensionless +x file is never run.
    expect(artifactActionLabel("build/deploy")).toBe("Show deploy in Finder");
    expect(artifactActionLabel("config/.envrc")).toBe("Show .envrc in Finder");
  });

  it.each(["decks/Q3.pptx", "brief.docx", "report.pdf", "budget.xlsx"])(
    "asks Quick Look to picture %s",
    (path) => expect(artifactPreview(path)).toBe("quicklook"),
  );
  it("draws a picture itself when the document is one", () => {
    expect(artifactPreview("chart.png")).toBe("image");
  });
  it("never asks Quick Look to render a page; its source reads in the inspector", () => {
    expect(artifactPreview("site/index.html")).toBe("none");
    expect(artifactPreview("site/INDEX.HTM")).toBe("none");
    expect(artifactOpensIn("site/index.html")).toBe("inspector");
    expect(artifactPreview("notes.md")).toBe("none");
  });
  it("does not picture what the inspector will show as text", () => {
    expect(artifactPreview("notes.md")).toBe("none");
    expect(artifactPreview("data.csv")).toBe("none");
  });
});

describe("reaching the file", () => {
  // The regression: Rust canonicalizes the path it is handed and never joins
  // the workspace root, so a relative path resolved against the app's own
  // working directory and every preview came back "No such file or directory".
  it("hands Rust an absolute path for a preview", async () => {
    invokeMock.mockResolvedValue("data:image/png;base64,x");
    await loadArtifactPreview("/Users/p/KIDE", "q3-demo/deck.pptx", 1800);
    expect(invokeMock).toHaveBeenCalledWith("preview_file", {
      workspaceRoot: "/Users/p/KIDE",
      path: "/Users/p/KIDE/q3-demo/deck.pptx",
      size: 1800,
    });
  });

  it("hands Rust an absolute path to open one, and reports what Rust did", async () => {
    invokeMock.mockResolvedValue("reveal");
    await expect(openArtifactInApp("/Users/p/KIDE/", "q3-demo/deck.pptx")).resolves.toBe("reveal");
    expect(invokeMock).toHaveBeenCalledWith("open_entry", {
      workspaceRoot: "/Users/p/KIDE/",
      path: "/Users/p/KIDE/q3-demo/deck.pptx",
    });
  });

  it("reads an image off disk rather than asking Quick Look to draw one", async () => {
    invokeMock.mockResolvedValue("data:image/png;base64,x");
    await loadArtifactPreview("/Users/p/KIDE", "shots/chart.png");
    expect(invokeMock).toHaveBeenCalledWith("read_file_data_uri", expect.objectContaining({
      path: "/Users/p/KIDE/shots/chart.png",
    }));
  });
});
