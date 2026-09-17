import { describe, expect, it } from "vitest";
import { safeLinkHref, visualBlocksOf } from "./markdown";

describe("safeLinkHref", () => {
  it("allows http, https, and mailto links", () => {
    expect(safeLinkHref("https://example.com/docs")).toBe("https://example.com/docs");
    expect(safeLinkHref("http://localhost:3000")).toBe("http://localhost:3000");
    expect(safeLinkHref("mailto:a@b.c")).toBe("mailto:a@b.c");
  });

  it("blocks script-capable schemes", () => {
    expect(safeLinkHref("javascript:alert(1)")).toBeNull();
    expect(safeLinkHref("JavaScript:alert(1)")).toBeNull();
    expect(safeLinkHref("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeLinkHref("vbscript:msgbox(1)")).toBeNull();
  });

  it("blocks other non-navigable schemes and relative URLs", () => {
    expect(safeLinkHref("file:///etc/passwd")).toBeNull();
    expect(safeLinkHref("ftp://example.com/x")).toBeNull();
    expect(safeLinkHref("./relative/path")).toBeNull();
    expect(safeLinkHref("/absolute/path")).toBeNull();
    expect(safeLinkHref("not a url")).toBeNull();
  });
});

describe("visualBlocksOf", () => {
  it("finds closed visual fences with renderable markup, in order", () => {
    const text = "Here.\n\n```svg\n<svg viewBox=\"0 0 10 10\"><rect width=\"4\" height=\"4\"/></svg>\n```\n\nAnd code:\n\n```ts\nconst a = 1;\n```\n\n```html\n<div>hi</div>\n```\n";
    const out = visualBlocksOf(text);
    expect(out.map((v) => [v.key, v.lang, v.kind])).toEqual([["visual-1", "svg", "drawing"], ["visual-5", "html", "drawing"]]);
    expect(out[1].code).toBe("<div>hi</div>");
  });

  it("leaves a fence that is still streaming, and one that holds only prose", () => {
    expect(visualBlocksOf("```svg\n<svg viewBox=\"0 0 1 1\"></svg>")).toEqual([]);
    expect(visualBlocksOf("```html\njust words\n```")).toEqual([]);
  });
});
