import { describe, expect, it } from "vitest";
import { safeLinkHref } from "./markdown";

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
