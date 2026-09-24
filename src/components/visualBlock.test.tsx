import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

// The whole path a message takes: fence → renderer → DOM. What a model writes
// in an `html` fence has to reach the conversation as a picture, and what it
// writes in a `ts` fence has to stay source.
function render(markdown: string): string {
  return renderToStaticMarkup(<>{renderMarkdown(markdown, { visuals: true })}</>);
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

  // A model that skips the fence (DeepSeek did, 2026-09-16) still meant a
  // picture. Block-level markup is drawn; markup quoted mid-sentence or
  // inside a source fence is not.
  it("draws a bare <svg> block the model wrote without a fence", () => {
    const html = render("Here it is.\n\n<svg viewBox=\"0 0 10 10\"><circle r=\"4\"/></svg>\n\nDone.");
    expect(html).toContain("<circle");
    expect(html).toContain(">Code<");
    expect(html).not.toContain("&lt;svg");
    expect(html).toContain("Done.");
  });

  it("keeps a nested <svg> inside one bare drawing", () => {
    const html = render("<svg viewBox=\"0 0 10 10\"><svg x=\"1\"><rect/></svg><circle/></svg>\n\nafter");
    expect(html).toContain("<rect");
    expect(html).toContain("<circle");
    expect(html).not.toContain("&lt;/svg");
  });

  it("holds a bare <svg> as source while it is still streaming", () => {
    const html = renderToStaticMarkup(<>{renderMarkdown("<svg viewBox=\"0 0 10 10\"><circle", { streaming: true, visuals: true })}</>);
    expect(html).toContain(">Preview<");
    expect(html).toContain("&lt;svg");
  });

  it("leaves an <svg> quoted mid-sentence, or in a source fence, as text", () => {
    expect(render("Use an <svg> element here.")).toContain("&lt;svg&gt;");
    const fenced = render("```ts\nconst s = `<svg viewBox=\"0 0 1 1\"></svg>`;\n```");
    expect(fenced).toContain("&lt;svg");
    expect(fenced).not.toContain(">Code<");
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

// A visual is markup joining the app's document. Only the assistant's own
// answer opts in; a PR body, a commit message or a delegate transcript was
// written by someone else and is shown as what it is — source.
describe("where a visual may draw", () => {
  const plain = (markdown: string) => renderToStaticMarkup(<>{renderMarkdown(markdown)}</>);

  it("keeps an html fence and a bare <svg> line as source by default", () => {
    const fenced = plain("```html\n<div class=\"card\">hi</div>\n```");
    expect(fenced).toContain("&lt;div");
    expect(fenced).not.toContain(">Code<");
    const bare = plain("Look:\n\n<svg viewBox=\"0 0 10 10\"><circle r=\"4\"/></svg>\n\nDone.");
    expect(bare).not.toContain("<circle");
    expect(bare).toContain("&lt;svg");
  });

  it("does not share a parse between the two readings of one text", () => {
    const text = "```svg\n<svg viewBox=\"0 0 1 1\"><rect/></svg>\n```";
    expect(plain(text)).not.toContain("<rect");
    expect(render(text)).toContain("<rect");
    expect(plain(text)).not.toContain("<rect");
  });
});
