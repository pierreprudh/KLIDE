import { describe, expect, it } from "vitest";
import { safeLinkHref, splitUrlTail } from "./externalLink";

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

describe("splitUrlTail", () => {
  it("gives back the punctuation that ended the sentence", () => {
    expect(splitUrlTail("https://tauri.app.")).toEqual(["https://tauri.app", "."]);
    expect(splitUrlTail("https://tauri.app,")).toEqual(["https://tauri.app", ","]);
    expect(splitUrlTail("https://tauri.app?!")).toEqual(["https://tauri.app", "?!"]);
  });

  it("keeps a parenthesis the URL opened itself", () => {
    const wiki = "https://en.wikipedia.org/wiki/Monaco_(editor)";
    expect(splitUrlTail(wiki)).toEqual([wiki, ""]);
  });

  it("drops a parenthesis the URL never opened", () => {
    expect(splitUrlTail("https://tauri.app)")).toEqual(["https://tauri.app", ")"]);
  });

  it("leaves a plain URL alone", () => {
    expect(splitUrlTail("https://tauri.app/v2/guide")).toEqual(["https://tauri.app/v2/guide", ""]);
  });
});
