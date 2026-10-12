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

/** The inline custom property that staggers pieces landing together. */
export const BORN_DELAY = "--born-delay";
const STAGGER_MS = 70;
const STAGGER_MAX = 8;

/**
 * The longest prefix of `source` that ends on a whole tag. A tag still being
 * written — a `<` with no closing `>` outside quotes — is cut, along with
 * everything after it. So is an element still receiving its text: a label
 * lands whole and fades in once, rather than typing itself out.
 */
export function settledMarkup(source: string): string {
  const whole = wholeTags(source);
  const lastGt = whole.lastIndexOf(">");
  if (lastGt < 0 || !whole.slice(lastGt + 1).trim()) return whole;
  // Text is still arriving after the last tag. If that tag opened the
  // element holding it, hold the element back too.
  const lastLt = whole.lastIndexOf("<", lastGt);
  const tag = whole.slice(lastLt, lastGt + 1);
  const opens = lastLt >= 0 && !tag.startsWith("</") && !tag.endsWith("/>") && !tag.startsWith("<!");
  return opens ? whole.slice(0, lastLt) : whole.slice(0, lastGt + 1);
}

function wholeTags(source: string): string {
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

// Pieces that land in the same tick do not pop in at once: each waits a beat
// longer than the one before it, so a burst reads as a cascade. The count is
// per call — the next tick starts its own cascade from zero.
function grow(oldParent: Node, newParent: Node, tally = { born: 0 }): number {
  const oldKids = Array.from(oldParent.childNodes);
  const newKids = Array.from(newParent.childNodes);
  for (let i = 0; i < newKids.length; i++) {
    const next = newKids[i];
    const have = oldKids[i];
    if (!have) {
      adopt(oldParent, next, tally);
      continue;
    }
    if (sameShape(have, next)) {
      if (have.nodeType === Node.TEXT_NODE) {
        if (have.nodeValue !== next.nodeValue) have.nodeValue = next.nodeValue;
      } else {
        grow(have, next, tally);
      }
      continue;
    }
    // A different node at this position: the stream does not rewrite what it
    // already said, so this is the parser reading an earlier auto-closed tail
    // differently now that more has arrived. Replace from here on.
    for (let k = i; k < oldKids.length; k++) oldParent.removeChild(oldKids[k]);
    for (let k = i; k < newKids.length; k++) adopt(oldParent, newKids[k], tally);
    return tally.born;
  }
  for (let k = newKids.length; k < oldKids.length; k++) oldParent.removeChild(oldKids[k]);
  return tally.born;
}

function adopt(parent: Node, node: Node, tally: { born: number }): void {
  const clone = parent.ownerDocument!.importNode(node, true);
  if (clone instanceof Element) {
    clone.classList.add(BORN_CLASS);
    const beat = Math.min(tally.born, STAGGER_MAX) * STAGGER_MS;
    if (beat && "style" in clone) (clone as HTMLElement | SVGElement).style.setProperty(BORN_DELAY, `${beat}ms`);
  }
  parent.appendChild(clone);
  tally.born++;
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
