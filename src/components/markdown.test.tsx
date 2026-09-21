import { Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

const html = (text: string, streaming?: boolean) =>
  renderToStaticMarkup(<Fragment>{renderMarkdown(text, streaming ? { streaming } : undefined)}</Fragment>);

describe("renderMarkdown streaming tail", () => {
  it("renders a finished message as plain text — no per-word spans", () => {
    expect(html("Pistachio is up 23% this month.")).not.toContain("ai-word-in");
  });

  it("wraps only the trailing plain-text run of the last block, one span per word", () => {
    const out = html("First paragraph.\n\nSales are **up** this month", true);
    const first = out.indexOf("First paragraph.");
    const spans = out.match(/class="ai-word-in"/g) ?? [];
    // "First paragraph." stays plain; " this month" → two word spans.
    expect(out.slice(0, first + 20)).not.toContain("ai-word-in");
    expect(spans).toHaveLength(2);
    expect(out).toContain('<span class="ai-word-in">this </span><span class="ai-word-in">month</span>');
  });

  it("keeps a word's key while the text grows, so the node survives the next batch", () => {
    const a = renderMarkdown("Sales are up", { streaming: true });
    const b = renderMarkdown("Sales are up this month", { streaming: true });
    const keys = (nodes: ReturnType<typeof renderMarkdown>) =>
      nodes.flatMap((n) => (typeof n === "string" ? [] : (n.props as { children: unknown[] }).children))
        .filter((c): c is { key: string } => typeof c === "object" && c !== null && "key" in c)
        .map((c) => c.key);
    expect(keys(b).slice(0, keys(a).length)).toEqual(keys(a));
  });

  it("treats a list item the model is still typing as the tail", () => {
    const out = html("- done item\n- still typing", true);
    expect(out.match(/class="ai-word-in"/g)).toHaveLength(2);
    expect(out).toContain("done item</li>");
  });

  it("never animates prose that a code fence already closed off", () => {
    const out = html("Before the fence\n\n```ts\nconst a = 1;\n```", true);
    expect(out).not.toContain("ai-word-in");
  });
});

// The parse cache is what lets a settled message cost nothing on the ~28
// renders a second the panel does while a Run streams. Its two exclusions are
// deliberate: a streaming tail changes every tick, and a `renderTool` hook
// makes the output depend on the caller rather than the text.
describe("renderMarkdown parse cache", () => {
  it("hands back the same nodes for the same settled text", () => {
    const text = "Some **bold**, some `code`, and a [link](https://example.com).\n\n- one\n- two";
    const first = renderMarkdown(text);
    expect(renderMarkdown(text)).toBe(first);
    expect(renderMarkdown(text, {})).toBe(first);
  });

  it("parses distinct text distinctly", () => {
    expect(renderMarkdown("alpha")).not.toBe(renderMarkdown("beta"));
  });

  it("does not cache a streaming tail", () => {
    const text = "words still arriving";
    expect(renderMarkdown(text, { streaming: true })).not.toBe(renderMarkdown(text, { streaming: true }));
    // Once settled, the same text caches like any other.
    expect(renderMarkdown(text)).toBe(renderMarkdown(text));
  });

  it("does not cache a tool-marker render", () => {
    const text = "[tool: read_file src/App.tsx]";
    const renderTool = () => null;
    expect(renderMarkdown(text, { renderTool })).not.toBe(renderMarkdown(text, { renderTool }));
  });
});

describe("links in an answer", () => {
  it("linkifies a URL a model wrote as prose, reading as its name", () => {
    const out = html("The docs are at https://v2.tauri.app for this.");
    expect(out).toContain('href="https://v2.tauri.app"');
    expect(out).toContain("Tauri</a>");
    // The address is the hover, not the sentence.
    expect(out).toContain('title="https://v2.tauri.app"');
    expect(out).not.toContain(">https://v2.tauri.app<");
  });

  it("names a repo link after the repo, with GitHub's mark", () => {
    const out = html("Ported from https://github.com/tauri-apps/tauri here.");
    expect(out).toContain(">tauri</a>");
    expect(out).toContain("<svg");
  });

  it("keeps the words an author chose", () => {
    const out = html("See [the plain docs](https://example.com/guide) first.");
    expect(out).toContain(">the plain docs</a>");
    // No brand behind example.com, so no glyph under words that already read.
    expect(out).not.toContain("<svg");
  });

  it("leaves the sentence's punctuation outside the link", () => {
    const out = html("Read https://v2.tauri.app.");
    expect(out).toContain('href="https://v2.tauri.app"');
    expect(out).not.toContain('href="https://v2.tauri.app."');
    expect(out).toContain("</a>.");
  });

  it("leaves a mail address as itself, with no mark", () => {
    const out = html("Mail [someone](mailto:a@b.co) about it.");
    expect(out).toContain('href="mailto:a@b.co"');
    expect(out).not.toContain("<svg");
  });

  it("still renders a markdown link as its text, not twice", () => {
    const out = html("See [the docs](https://v2.tauri.app) first.");
    expect(out).toContain('href="https://v2.tauri.app"');
    expect(out).toContain(">the docs</a>");
    expect(out.match(/<a /g) ?? []).toHaveLength(1);
  });

  it("never opens the app webview onto the link", () => {
    expect(html("Read https://v2.tauri.app now.")).not.toContain('target="_blank"');
  });

  it("leaves a URL inside a code span alone", () => {
    const out = html("Run `curl https://v2.tauri.app` to check.");
    expect(out).not.toContain("<a ");
  });

  it("refuses a scheme that would run script in the app", () => {
    const out = html("Click [here](javascript:alert(1)) now.");
    expect(out).not.toContain("<a ");
    expect(out).toContain("here");
  });
});
