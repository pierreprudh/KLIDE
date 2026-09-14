import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

// The whole path a message takes: fence → renderer → DOM. What a model writes
// in an `html` fence has to reach the conversation as a picture, and what it
// writes in a `ts` fence has to stay source.
function render(markdown: string): string {
  return renderToStaticMarkup(<>{renderMarkdown(markdown)}</>);
}

describe("the inline visualizer", () => {
  it("draws a closed html fence instead of quoting it", () => {
    const html = render("```html\n<div class=\"card\">hi</div>\n```");
    expect(html).toContain('<div class="card">hi</div>');
    expect(html).toContain(">Code<");
  });

  it("leaves an ordinary language as source", () => {
    const html = render("```ts\nconst a = 1;\n```");
    expect(html).toContain("const");
    expect(html).not.toContain(">Preview<");
  });

  it("holds an unclosed fence as source while it streams", () => {
    const html = render("```html\n<div>half");
    expect(html).toContain(">Preview<");
    expect(html).toContain("&lt;div&gt;half");
  });

  it("renders nothing a hostile block asked for", () => {
    const html = render(
      "```html\n" +
        '<style>body { background: red; padding: 40px } .note { background: red }</style>\n' +
        '<script>window.x = 1</script>\n' +
        '<img src="https://tracker.example/b.gif" onerror="window.y = 1">\n' +
        '<a href="javascript:void(0)">link</a>\n' +
        '<iframe src="https://example.com"></iframe>\n' +
        "<p>kept</p>\n```",
    );
    expect(html).toContain("<p>kept</p>");
    expect(html).toContain("<a>link</a>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("tracker.example");
    expect(html).toContain("iframe, script not rendered");
    // The model's `body` rule is re-anchored to the block, never left global.
    // Its gutters survive; its ground does not — a page's background is a
    // whole-window decision, and the block's own ground is the themed one.
    expect(html).toMatch(/\.kv[A-Za-z0-9]+\{padding: 40px\}/);
    expect(html).not.toContain("background: red");
    // A rule that is not the page itself still lands on the block's palette.
    expect(html).toMatch(
      /\.kv[A-Za-z0-9]+ \.note\{background: color-mix\(in srgb, var\(--viz-danger\) 16%, var\(--viz-surface\)\);color:var\(--viz-ink\)\}/,
    );
  });

  it("gives two visuals in one message their own ids", () => {
    const html = render(
      "```svg\n<svg><marker id=\"arrow\"/><path marker-end=\"url(#arrow)\"/></svg>\n```\n\n" +
        "```svg\n<svg><marker id=\"arrow\"/><path marker-end=\"url(#arrow)\"/></svg>\n```",
    );
    const ids = [...html.matchAll(/id="arrow-([A-Za-z0-9]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });
});
