import { describe, expect, it } from "vitest";
import { matchingClose, serializeCss, splitTopLevel, tokenizeCss } from "./cssTokens";

const types = (css: string) => tokenizeCss(css).map((t) => t.type);

describe("tokenizeCss", () => {
  it("reads a comment as one token, whatever quotes it holds", () => {
    expect(types("a/* ' \" */b")).toEqual(["ident", "comment", "ident"]);
  });

  it("ends a string at a newline, badly, the way the browser does", () => {
    expect(types('"a\n}')).toEqual(["bad-string", "ws", "}"]);
    expect(tokenizeCss('"a\\\nb"')).toEqual([{ type: "string", value: "ab" }]);
  });

  it("decodes an escaped identifier to the word it spells", () => {
    expect(tokenizeCss("fi\\78 ed")).toEqual([{ type: "ident", value: "fixed" }]);
    expect(tokenizeCss("\\66ixed")).toEqual([{ type: "ident", value: "fixed" }]);
  });

  it("tells an unquoted url from a quoted one and from a broken one", () => {
    expect(tokenizeCss("url( https://x/a.png )")).toEqual([{ type: "url", value: "https://x/a.png" }]);
    expect(types('url("x")')).toEqual(["function", "string", ")"]);
    expect(types("url(a b)")).toEqual(["bad-url"]);
  });

  it("reads numbers, units and percentages", () => {
    expect(tokenizeCss("-1.5e2px 50% .5")).toEqual([
      { type: "dimension", repr: "-1.5e2", unit: "px" },
      { type: "ws", raw: " " },
      { type: "percentage", repr: "50" },
      { type: "ws", raw: " " },
      { type: "number", repr: ".5" },
    ]);
  });
});

describe("serializeCss", () => {
  it("writes back canonical text: comments gone, escapes redone, strings requoted", () => {
    expect(serializeCss(tokenizeCss("position:/**/fi\\78 ed"))).toBe("position:fixed");
    expect(serializeCss(tokenizeCss("content:'a\"<b'"))).toBe('content:"a\\"\\3c b"');
    // A comment that kept two tokens apart keeps them apart.
    expect(serializeCss(tokenizeCss("a/**/b"))).toBe("a/**/b");
  });

  it("round-trips what it writes", () => {
    const once = serializeCss(tokenizeCss(".a\\:b { content: '\\'' ; width: calc(1px + 2%) }"));
    expect(serializeCss(tokenizeCss(once))).toBe(once);
  });
});

describe("blocks", () => {
  it("matches nesting of every kind and reports an unclosed one", () => {
    const tokens = tokenizeCss("{ a: f( [ ] ) } x");
    expect(tokens[matchingClose(tokens, 0)].type).toBe("}");
    expect(matchingClose(tokenizeCss("{ a: f( }"), 0)).toBe(-1);
  });

  it("splits at the top level only", () => {
    const { parts, unbalanced } = splitTopLevel(tokenizeCss("a:f(1;2);b:c"), ";");
    expect(parts.map(serializeCss)).toEqual(["a:f(1;2)", "b:c"]);
    expect(unbalanced).toBe(false);
  });
});
