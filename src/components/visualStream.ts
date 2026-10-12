// A drawing coming to life piece by piece.
//
// While an `svg` fence is still arriving, the block does not wait for the
// closing fence to show anything. It shows what has landed so far — every
// whole element — and each new one fades in where the model put it. Two
// pieces make that honest:
//
// - `settledMarkup` trims the partial source back to its last complete tag,
//   so a half-written `<rect x="1` is never handed to a parser. Text after a
//   complete tag stays: a label growing a letter at a time is the point.
// - `growVisual` updates the live DOM in place instead of replacing it. The
//   source only ever grows, so the old tree is always a prefix of the new
//   one: nodes already on the page are kept (their fade is not restarted),
//   a text node that grew is updated, the last open container is descended
//   into, and only what is genuinely new is appended with `.kv-born`.
//
// Nothing here parses markup itself — the markup has already been through
// `prepareVisual`, and the browser's own parser (which auto-closes whatever
// is still open) builds the tree.

/** The class a newly landed node wears for its entrance (tokens.css). */
export const BORN_CLASS = "kv-born";

/**
 * The longest prefix of `source` that ends on a whole tag (or on text after
 * one). A tag still being written — a `<` with no closing `>` outside quotes —
 * is cut, along with everything after it.
 */
export function settledMarkup(source: string): string {
  let i = 0;
  let cut = source.length;
  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt < 0) break;
    const rest = source.slice(lt, lt + 4);
    if (rest === "<!--") {
      const end = source.indexOf("-->", lt + 4);
      if (end < 0) { cut = lt; break; }
      i = end + 3;
      continue;
    }
    let j = lt + 1;
    let quote = "";
    let closed = false;
    while (j < source.length) {
      const c = source[j];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        closed = true;
        break;
      }
      j++;
    }
    if (!closed) { cut = lt; break; }
    i = j + 1;
  }
  return source.slice(0, cut);
}

/**
 * Whether the partial source has enough to draw: the root `<svg>` open tag
 * has fully arrived. Before that there is no canvas to put pieces on.
 */
export function hasDrawingRoot(settled: string): boolean {
  return /<svg[\s>]/i.test(settled);
}

/**
 * Bring `host`'s children up to `html`, keeping every node that is already
 * there. Returns how many nodes were newly added.
 */
export function growVisual(host: Element, html: string): number {
  const template = host.ownerDocument.createElement("template");
  template.innerHTML = html;
  return grow(host, template.content);
}

function grow(oldParent: Node, newParent: Node): number {
  let born = 0;
  const oldKids = Array.from(oldParent.childNodes);
  const newKids = Array.from(newParent.childNodes);
  for (let i = 0; i < newKids.length; i++) {
    const next = newKids[i];
    const have = oldKids[i];
    if (!have) {
      born += adopt(oldParent, next, null);
      continue;
    }
    if (sameShape(have, next)) {
      if (have.nodeType === Node.TEXT_NODE) {
        if (have.nodeValue !== next.nodeValue) have.nodeValue = next.nodeValue;
      } else {
        born += grow(have, next);
      }
      continue;
    }
    // A different node at this position: the stream does not rewrite what it
    // already said, so this is the parser reading an earlier auto-closed tail
    // differently now that more has arrived. Replace from here on.
    for (let k = i; k < oldKids.length; k++) oldParent.removeChild(oldKids[k]);
    for (let k = i; k < newKids.length; k++) born += adopt(oldParent, newKids[k], null);
    return born;
  }
  for (let k = newKids.length; k < oldKids.length; k++) oldParent.removeChild(oldKids[k]);
  return born;
}

function adopt(parent: Node, node: Node, before: Node | null): number {
  const clone = parent.ownerDocument!.importNode(node, true);
  if (clone instanceof Element) clone.classList.add(BORN_CLASS);
  parent.insertBefore(clone, before);
  return 1;
}

// Same kind of node, and — for an element — the same tag and attributes. An
// element's open tag is whole before it is ever shown (`settledMarkup`), so
// its attributes never change afterwards; only its children can grow.
function sameShape(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType !== Node.ELEMENT_NODE) return true;
  const x = a as Element;
  const y = b as Element;
  if (x.tagName !== y.tagName) return false;
  const names = x.getAttributeNames().filter(n => n !== "class");
  const theirs = y.getAttributeNames().filter(n => n !== "class");
  if (names.length !== theirs.length) return false;
  for (const name of names) if (x.getAttribute(name) !== y.getAttribute(name)) return false;
  return stripBorn(x.getAttribute("class")) === stripBorn(y.getAttribute("class"));
}

function stripBorn(value: string | null): string {
  return (value ?? "").split(/\s+/).filter(c => c && c !== BORN_CLASS).sort().join(" ");
}
