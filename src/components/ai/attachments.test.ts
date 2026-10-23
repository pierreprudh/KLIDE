import { describe, expect, it } from "vitest";
import {
  ATTACH_ACCEPT,
  attachmentSize,
  MAX_DOC_CHARS,
  MAX_IMAGE_BYTES,
  MAX_STAGED,
  MAX_TOTAL_IMAGE_BYTES,
  classifyFile,
  isPhotoAttachment,
  markupPreviewUri,
  stageFiles,
  type StageableFile,
} from "./attachments";

function fake(name: string, type: string, body: string, size?: number): StageableFile {
  const bytes = new TextEncoder().encode(body);
  return {
    name,
    type,
    size: size ?? bytes.byteLength,
    text: async () => body,
    arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer,
  };
}

describe("classifyFile", () => {
  it("reads a photo from its MIME type", () => {
    expect(classifyFile({ name: "shot.png", type: "image/png" })).toBe("photo");
  });

  it("treats SVG as a document — it is markup a blind model can read", () => {
    expect(classifyFile({ name: "mark.svg", type: "image/svg+xml" })).toBe("document");
  });

  it("falls back to the extension when the browser gives no MIME", () => {
    expect(classifyFile({ name: "notes.md", type: "" })).toBe("document");
    expect(classifyFile({ name: "main.rs", type: "" })).toBe("document");
    expect(classifyFile({ name: ".gitignore", type: "" })).toBe("document");
  });

  it("refuses an image format no provider wire accepts", () => {
    // A photo dropped from Finder on a Mac is routinely HEIC.
    expect(classifyFile({ name: "IMG_4210.heic", type: "image/heic" })).toBe("other");
    expect(classifyFile({ name: "scan.tiff", type: "image/tiff" })).toBe("other");
    expect(classifyFile({ name: "icon.avif", type: "image/avif" })).toBe("other");
    expect(classifyFile({ name: "shot.webp", type: "image/webp" })).toBe("photo");
  });

  it("refuses what Klide has no wire for", () => {
    expect(classifyFile({ name: "spec.pdf", type: "application/pdf" })).toBe("other");
    expect(classifyFile({ name: "bundle.zip", type: "application/zip" })).toBe("other");
  });
});

describe("ATTACH_ACCEPT", () => {
  it("offers the picker exactly what staging accepts", () => {
    const accept = ATTACH_ACCEPT.split(",");
    expect(accept).toContain("image/png");
    expect(accept).toContain("image/webp");
    expect(accept).toContain(".md");
    expect(accept).toContain(".rs");
    // The formats no wire forwards must not be offered in the first place.
    expect(ATTACH_ACCEPT).not.toContain("image/heic");
    expect(ATTACH_ACCEPT).not.toContain("application/pdf");
  });
});

describe("stageFiles", () => {
  it("stages a photo as a data URI the chat can render", async () => {
    const { attachments, notices } = await stageFiles([fake("shot.png", "image/png", "PNGDATA")], {
      allowPhotos: true,
    });
    expect(notices).toEqual([]);
    expect(attachments).toHaveLength(1);
    expect(isPhotoAttachment(attachments[0])).toBe(true);
    expect(attachments[0].dataUri?.startsWith("data:image/png;base64,")).toBe(true);
    expect(attachments[0].mime).toBe("image/png");
  });

  it("stages a document as text, the same shape an @mention produces", async () => {
    const { attachments } = await stageFiles([fake("readme.md", "text/markdown", "# Hi")], {
      allowPhotos: true,
    });
    expect(isPhotoAttachment(attachments[0])).toBe(false);
    expect(attachments[0]).toMatchObject({ path: "readme.md", content: "# Hi" });
  });

  it("truncates an oversized document instead of dropping it", async () => {
    const long = "x".repeat(MAX_DOC_CHARS + 500);
    const { attachments } = await stageFiles([fake("log.txt", "text/plain", long)], {
      allowPhotos: true,
    });
    expect(attachments[0].content.length).toBeLessThan(long.length);
    expect(attachments[0].content.endsWith("…(truncated)")).toBe(true);
  });

  it("refuses a photo by name when the model is blind, and keeps the document", async () => {
    const { attachments, notices } = await stageFiles(
      [fake("shot.png", "image/png", "PNGDATA"), fake("notes.md", "text/markdown", "hi")],
      { allowPhotos: false },
    );
    expect(attachments.map((a) => a.path)).toEqual(["notes.md"]);
    expect(notices[0].text).toContain("shot.png");
    expect(notices[0].tone).toBe("warn");
  });

  it("refuses an unreadable kind by name", async () => {
    const { attachments, notices } = await stageFiles([fake("spec.pdf", "application/pdf", "%PDF")], {
      allowPhotos: true,
    });
    expect(attachments).toEqual([]);
    expect(notices[0].text).toContain("spec.pdf");
  });

  it("refuses an over-limit photo rather than sending a truncated one", async () => {
    const { attachments, notices } = await stageFiles(
      [fake("huge.png", "image/png", "PNGDATA", MAX_IMAGE_BYTES + 1)],
      { allowPhotos: true },
    );
    expect(attachments).toEqual([]);
    expect(notices[0].text).toContain("too large");
  });

  it("names the format when an image is the wrong kind of image", async () => {
    const { attachments, notices } = await stageFiles(
      [fake("IMG_4210.heic", "image/heic", "HEICDATA")],
      { allowPhotos: true },
    );
    expect(attachments).toEqual([]);
    expect(notices[0].text).toContain("PNG, JPEG, GIF or WebP");
  });

  it("caps the total image bytes one turn may carry", async () => {
    // Each one clears the per-image cap; the third is what breaks the turn's
    // total, so the cap has to be more than a per-file check.
    const each = 5_000_000;
    const { attachments, notices } = await stageFiles(
      [
        fake("a.png", "image/png", "A", each),
        fake("b.png", "image/png", "B", each),
        fake("c.png", "image/png", "C", each),
      ],
      { allowPhotos: true },
    );
    expect(attachments.map((a) => a.path)).toEqual(["a.png", "b.png"]);
    expect(notices[0].text).toContain("of images");
  });

  it("counts images the composer already holds against that cap", async () => {
    const { attachments, notices } = await stageFiles(
      [fake("late.png", "image/png", "L", 1_000_000)],
      { allowPhotos: true, alreadyImageBytes: MAX_TOTAL_IMAGE_BYTES },
    );
    expect(attachments).toEqual([]);
    expect(notices[0].text).toContain("late.png");
  });

  it("stops at the staged ceiling, counting what the composer already holds", async () => {
    const { attachments, notices } = await stageFiles(
      [fake("a.md", "text/markdown", "a"), fake("b.md", "text/markdown", "b")],
      { allowPhotos: true, alreadyStaged: MAX_STAGED - 1 },
    );
    expect(attachments).toHaveLength(1);
    expect(notices.some((n) => n.text.includes("1 more attachment"))).toBe(true);
  });

  it("says so when a drop is already full", async () => {
    const { attachments, notices } = await stageFiles([fake("a.md", "text/markdown", "a")], {
      allowPhotos: true,
      alreadyStaged: MAX_STAGED,
    });
    expect(attachments).toEqual([]);
    expect(notices[0].text).toContain(`${MAX_STAGED} attachments`);
  });
});

describe("markupPreviewUri", () => {
  it("previews a staged SVG from its whole markup, even when the text is truncated", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">${"<path d=\"m0 0\"/>".repeat(2000)}</svg>`;
    const { attachments } = await stageFiles([fake("steve.svg", "image/svg+xml", svg)], { allowPhotos: false });
    expect(attachments[0].content.endsWith("…(truncated)")).toBe(true);
    expect(markupPreviewUri(attachments[0])).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  });
  it("leaves other documents and non-markup .svg files alone", async () => {
    const { attachments } = await stageFiles(
      [fake("notes.md", "text/markdown", "<svg></svg>"), fake("broken.svg", "image/svg+xml", "not a drawing")],
      { allowPhotos: false },
    );
    expect(attachments.map(markupPreviewUri)).toEqual([null, null]);
  });
});

describe("attachmentSize", () => {
  it("weighs a photo by its decoded bytes and a document by its UTF-8 text", () => {
    const photo = { path: "a.png", content: "", dataUri: `data:image/png;base64,${"A".repeat(4000)}` };
    expect(attachmentSize(photo)).toBe("3 KB");
    expect(attachmentSize({ path: "n.txt", content: "two\nlines" })).toBe("9 B");
    expect(attachmentSize({ path: "é.txt", content: "é".repeat(600) })).toBe("1 KB");
    expect(attachmentSize({ path: "big.csv", content: "x".repeat(2_400_000) })).toBe("2.4 MB");
  });
});
