// A CSS tokenizer, faithful to CSS Syntax Level 3 §4 — the same token stream
// the webview's own parser will see. The visual sanitizer (`visualHtml.ts`)
// decides what a model's stylesheet is allowed to do, and a decision made on
// a different reading of the text than the browser's is no decision at all: a
// quote inside a comment, a newline inside a string, or `fi\78 ed` spelling
// `fixed` each read one way to a regex and another way to WebKit.
//
// So the sanitizer never looks at CSS text. It tokenizes, reasons about
// tokens, and writes back canonical text from them — comments gone, escapes
// decoded and re-escaped, every string re-quoted — so what it approved is
// exactly what gets parsed.
//
// Pure string work, no DOM, like the rest of the visual pipeline.

export type CssToken =
  | { type: "ws"; raw: string }
  | { type: "comment" }
  | { type: "ident"; value: string }
  | { type: "function"; value: string }
  | { type: "at-keyword"; value: string }
  | { type: "hash"; value: string }
  /** `unterminated` — the string ran into the end of the input. */
  | { type: "string"; value: string; unterminated?: boolean }
  /** A newline ended the string early: the browser drops what it was in. */
  | { type: "bad-string" }
  | { type: "url"; value: string; unterminated?: boolean }
  | { type: "bad-url" }
  | { type: "delim"; value: string }
  | { type: "number"; repr: string }
  | { type: "percentage"; repr: string }
  | { type: "dimension"; repr: string; unit: string }
  | { type: "cdo" }
  | { type: "cdc" }
  | { type: ":" | ";" | "," | "(" | ")" | "[" | "]" | "{" | "}" };

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isHex = (c: string | undefined) => c !== undefined && /^[0-9a-fA-F]$/.test(c);
const isWs = (c: string | undefined) => c === " " || c === "\t" || c === "\n";
const isNameStart = (c: string | undefined) =>
  c !== undefined && (/^[A-Za-z_]$/.test(c) || c.charCodeAt(0) >= 0x80);
const isName = (c: string | undefined) => isNameStart(c) || isDigit(c) || c === "-";
const validEscape = (a: string | undefined, b: string | undefined) => a === "\\" && b !== undefined && b !== "\n";

function startsIdent(a: string | undefined, b: string | undefined, c: string | undefined): boolean {
  if (a === "-") return isNameStart(b) || b === "-" || validEscape(b, c);
  if (isNameStart(a)) return true;
  return validEscape(a, b);
}

function startsNumber(a: string | undefined, b: string | undefined, c: string | undefined): boolean {
  if (a === "+" || a === "-") return isDigit(b) || (b === "." && isDigit(c));
  if (a === ".") return isDigit(b);
  return isDigit(a);
}

/** Tokenize a stylesheet or a declaration list. Never throws. */
export function tokenizeCss(input: string): CssToken[] {
  // §3.3 preprocessing: one newline, no NUL.
  const s = input.replace(/\r\n?|\f/g, "\n").replace(/\0/g, "�");
  const out: CssToken[] = [];
  let i = 0;

  // An escape, with the `\` already consumed: 1–6 hex digits and one optional
  // whitespace, or the next character itself.
  const escape = (): string => {
    if (i >= s.length) return "�";
    if (isHex(s[i])) {
      let hex = "";
      while (hex.length < 6 && isHex(s[i])) hex += s[i++];
      if (isWs(s[i])) i++;
      const cp = parseInt(hex, 16);
      return cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? "�" : String.fromCodePoint(cp);
    }
    return s[i++];
  };

  const name = (): string => {
    let out = "";
    for (;;) {
      if (isName(s[i])) out += s[i++];
      else if (validEscape(s[i], s[i + 1])) { i++; out += escape(); }
      else return out;
    }
  };

  const numeric = (): CssToken => {
    const start = i;
    if (s[i] === "+" || s[i] === "-") i++;
    while (isDigit(s[i])) i++;
    if (s[i] === "." && isDigit(s[i + 1])) { i++; while (isDigit(s[i])) i++; }
    if ((s[i] === "e" || s[i] === "E") && (isDigit(s[i + 1]) || ((s[i + 1] === "+" || s[i + 1] === "-") && isDigit(s[i + 2])))) {
      i += 2;
      while (isDigit(s[i])) i++;
    }
    const repr = s.slice(start, i);
    if (startsIdent(s[i], s[i + 1], s[i + 2])) return { type: "dimension", repr, unit: name() };
    if (s[i] === "%") { i++; return { type: "percentage", repr }; }
    return { type: "number", repr };
  };

  const string = (q: string): CssToken => {
    let value = "";
    for (;;) {
      const c = s[i];
      if (c === undefined) return { type: "string", value, unterminated: true };
      if (c === q) { i++; return { type: "string", value }; }
      // A newline ends a string badly and is left for the next token.
      if (c === "\n") return { type: "bad-string" };
      i++;
      if (c === "\\") {
        if (i >= s.length) continue;
        if (s[i] === "\n") { i++; continue; }
        value += escape();
      } else value += c;
    }
  };

  const badUrlRemnants = (): CssToken => {
    for (;;) {
      const c = s[i];
      if (c === undefined) return { type: "bad-url" };
      i++;
      if (c === ")") return { type: "bad-url" };
      if (validEscape(c, s[i])) escape();
    }
  };

  const url = (): CssToken => {
    let value = "";
    while (isWs(s[i])) i++;
    for (;;) {
      const c = s[i];
      if (c === undefined) return { type: "url", value, unterminated: true };
      i++;
      if (c === ")") return { type: "url", value };
      if (isWs(c)) {
        while (isWs(s[i])) i++;
        if (s[i] === ")") { i++; return { type: "url", value }; }
        if (s[i] === undefined) return { type: "url", value, unterminated: true };
        return badUrlRemnants();
      }
      const code = c.charCodeAt(0);
      if (c === '"' || c === "'" || c === "(" || code <= 8 || code === 0x0b || (code >= 0x0e && code <= 0x1f) || code === 0x7f) {
        return badUrlRemnants();
      }
      if (c === "\\") {
        if (validEscape(c, s[i])) { value += escape(); continue; }
        return badUrlRemnants();
      }
      value += c;
    }
  };

  const identLike = (): CssToken => {
    const value = name();
    if (value.toLowerCase() === "url" && s[i] === "(") {
      i++;
      while (isWs(s[i]) && isWs(s[i + 1])) i++;
      const next = isWs(s[i]) ? s[i + 1] : s[i];
      if (next === '"' || next === "'") return { type: "function", value };
      return url();
    }
    if (s[i] === "(") { i++; return { type: "function", value }; }
    return { type: "ident", value };
  };

  while (i < s.length) {
    const c = s[i];
    if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      i = end < 0 ? s.length : end + 2;
      out.push({ type: "comment" });
      continue;
    }
    if (isWs(c)) {
      const start = i;
      while (isWs(s[i])) i++;
      out.push({ type: "ws", raw: s.slice(start, i) });
      continue;
    }
    if (c === '"' || c === "'") { i++; out.push(string(c)); continue; }
    if (c === "#") {
      if (isName(s[i + 1]) || validEscape(s[i + 1], s[i + 2])) { i++; out.push({ type: "hash", value: name() }); }
      else { i++; out.push({ type: "delim", value: c }); }
      continue;
    }
    if (c === "(" || c === ")" || c === "[" || c === "]" || c === "{" || c === "}" || c === "," || c === ":" || c === ";") {
      i++;
      out.push({ type: c });
      continue;
    }
    if (c === "+" || c === ".") {
      if (startsNumber(c, s[i + 1], s[i + 2])) out.push(numeric());
      else { i++; out.push({ type: "delim", value: c }); }
      continue;
    }
    if (c === "-") {
      if (startsNumber(c, s[i + 1], s[i + 2])) out.push(numeric());
      else if (s[i + 1] === "-" && s[i + 2] === ">") { i += 3; out.push({ type: "cdc" }); }
      else if (startsIdent(c, s[i + 1], s[i + 2])) out.push(identLike());
      else { i++; out.push({ type: "delim", value: c }); }
      continue;
    }
    if (c === "<") {
      if (s.startsWith("<!--", i)) { i += 4; out.push({ type: "cdo" }); }
      else { i++; out.push({ type: "delim", value: c }); }
      continue;
    }
    if (c === "@") {
      i++;
      if (startsIdent(s[i], s[i + 1], s[i + 2])) out.push({ type: "at-keyword", value: name() });
      else out.push({ type: "delim", value: c });
      continue;
    }
    if (c === "\\") {
      if (validEscape(c, s[i + 1])) out.push(identLike());
      else { i++; out.push({ type: "delim", value: c }); }
      continue;
    }
    if (isDigit(c)) { out.push(numeric()); continue; }
    if (isNameStart(c)) { out.push(identLike()); continue; }
    i++;
    out.push({ type: "delim", value: c });
  }
  return out;
}

// ── Serialization ───────────────────────────────────────────────────────────
//
// Written back from decoded values, never from the input: an escape the model
// used to hide a word is gone, and one this writer adds is the only kind left.

const hexEscape = (ch: string) => `\\${ch.codePointAt(0)!.toString(16)} `;

/**
 * An identifier, escaped so it reads back as the same single identifier. A
 * `<` is hex-escaped rather than written `\<`, which would still spell `</`.
 */
export function serializeIdent(value: string): string {
  if (value === "-") return "\\-";
  let out = "";
  [...value].forEach((ch, index) => {
    const code = ch.codePointAt(0)!;
    if (ch === "<" || code < 0x20 || code === 0x7f) out += hexEscape(ch);
    else if (isDigit(ch) && (index === 0 || (index === 1 && value[0] === "-"))) out += hexEscape(ch);
    else if (code >= 0x80 || /^[A-Za-z0-9_-]$/.test(ch)) out += ch;
    else out += `\\${ch}`;
  });
  return out;
}

/** The part after a `#`, or a unit: name characters, escaped otherwise. */
function serializeName(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === "<" || code < 0x20 || code === 0x7f) out += hexEscape(ch);
    else if (code >= 0x80 || /^[A-Za-z0-9_-]$/.test(ch)) out += ch;
    else out += `\\${ch}`;
  }
  return out;
}

/**
 * A string, always double-quoted. `<` is escaped so no stylesheet this writes
 * can hold the text `</style`, whatever the string said.
 */
export function serializeString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '"' || ch === "\\") out += `\\${ch}`;
    else if (ch === "<" || code < 0x20 || code === 0x7f) out += hexEscape(ch);
    else out += ch;
  }
  return `${out}"`;
}

/** A URL: bare when every character is inert there, a quoted string otherwise. */
export function serializeUrl(value: string): string {
  return /^[A-Za-z0-9_#:;,.+/=%?&~-]*$/.test(value) ? `url(${value})` : `url(${serializeString(value)})`;
}

// Tokens that would fuse into one if written side by side with nothing
// between them. A comment that separated two of these becomes an empty one.
const FUSIBLE = new Set(["ident", "function", "at-keyword", "hash", "number", "percentage", "dimension", "url", "delim"]);

function serializeOne(token: CssToken): string {
  switch (token.type) {
    case "ws": return token.raw;
    case "comment": return "";
    case "ident": return serializeIdent(token.value);
    case "function": return `${serializeIdent(token.value)}(`;
    case "at-keyword": return `@${serializeIdent(token.value)}`;
    case "hash": return `#${serializeName(token.value)}`;
    case "string": return serializeString(token.value);
    case "url": return serializeUrl(token.value);
    case "delim": return token.value === "\\" ? "" : token.value;
    case "number": return token.repr;
    case "percentage": return `${token.repr}%`;
    case "dimension": {
      // `1e3` is a number, so a unit that starts with `e` must not read as
      // an exponent: escape its first letter when it could.
      const unit = serializeName(token.unit);
      return token.repr + (/^[eE]/.test(unit) && !/[eE]/.test(token.repr) ? `\\${unit}` : unit);
    }
    // Refused by every caller before it gets here; never emitted.
    case "bad-string": case "bad-url": case "cdo": case "cdc": return "";
    default: return token.type;
  }
}

/** Canonical text for a token run: comments gone, escapes decoded and redone. */
export function serializeCss(tokens: readonly CssToken[]): string {
  let out = "";
  let prev: CssToken | null = null;
  tokens.forEach((token, index) => {
    if (token.type === "comment") {
      const next = tokens.slice(index + 1).find((t) => t.type !== "comment");
      if (prev && next && FUSIBLE.has(prev.type) && FUSIBLE.has(next.type)) out += "/**/";
      return;
    }
    // `<` then `/` is the only way left to spell `</style` outside a string.
    if (token.type === "delim" && token.value === "/" && prev?.type === "delim" && prev.value === "<") out += " ";
    out += serializeOne(token);
    prev = token;
  });
  return out;
}

// ── Blocks ──────────────────────────────────────────────────────────────────

const CLOSER: Partial<Record<CssToken["type"], CssToken["type"]>> = { "{": "}", "[": "]", "(": ")", function: ")" };

/**
 * The index of the token that closes the block opened at `open` (a `{`, `[`,
 * `(` or function token), or -1 when the input ends first. Nesting of every
 * kind counts, the way the browser counts it.
 */
export function matchingClose(tokens: readonly CssToken[], open: number): number {
  const stack: CssToken["type"][] = [];
  for (let i = open; i < tokens.length; i++) {
    const t = tokens[i].type;
    const closer = CLOSER[t];
    if (closer) stack.push(closer);
    else if (t === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/**
 * Split at every top-level `sep` token, blocks skipped whole. A block the
 * input never closed leaves `unbalanced` set: nothing after it can be trusted
 * to mean what it seems to.
 */
export function splitTopLevel(tokens: readonly CssToken[], sep: CssToken["type"]): { parts: CssToken[][]; unbalanced: boolean } {
  const parts: CssToken[][] = [[]];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === sep) { parts.push([]); continue; }
    if (CLOSER[t.type]) {
      const close = matchingClose(tokens, i);
      if (close < 0) {
        parts[parts.length - 1].push(...tokens.slice(i));
        return { parts, unbalanced: true };
      }
      parts[parts.length - 1].push(...tokens.slice(i, close + 1));
      i = close;
      continue;
    }
    parts[parts.length - 1].push(t);
  }
  return { parts, unbalanced: false };
}

/** Tokens the browser recovers from by dropping whatever holds them. */
export function hasBrokenToken(tokens: readonly CssToken[]): boolean {
  return tokens.some(
    (t) =>
      t.type === "bad-string" || t.type === "bad-url" || t.type === "cdo" || t.type === "cdc" ||
      (t.type === "delim" && t.value === "\\") ||
      ((t.type === "string" || t.type === "url") && t.unterminated === true),
  );
}
