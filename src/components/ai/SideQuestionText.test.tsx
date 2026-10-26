import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SideQuestionText } from "./SideQuestionText";

describe("transcript side-question shortcuts", () => {
  it("links standalone /btw mentions while preserving surrounding message text", () => {
    const html = renderToStaticMarkup(<SideQuestionText text="Live /btw acceptance. Also (/btw)." onOpen={() => {}} />);
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).toContain("Live ");
    expect(html).toContain("acceptance. Also (");
  });

  it("leaves paths, URLs, longer command names and escaped markup as text", () => {
    const html = renderToStaticMarkup(<SideQuestionText text={'/btwhatever https://example.com/btw /tmp/btw <script>'} onOpen={() => {}} />);
    expect(html).not.toContain("<button");
    expect(html).toContain("&lt;script&gt;");
  });
});
