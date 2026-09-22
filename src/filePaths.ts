// Which backticked words in an answer are places you can open.
//
// Two shapes reach that bar, and they are read differently. A *rooted* path —
// `/Users/pierre/Documents/Onetraak`, `~/.klide/connectors.json` — names one
// place on this machine and needs nothing else to be understood. A *relative*
// one — `src/App.tsx`, `harness/`, `CLAUDE.md` — belongs to whichever project
// the answer is about, which is very often not the one Klide has open, so the
// writing alone can never settle it: the open repository has to recognise the
// path before it becomes anything (`workspaceIndex.ts`).
//
// That second gate is what keeps a paragraph describing *another* repository
// from reading as a link farm. An answer names a dozen of a project's files in
// one breath; none of them is here, so none of them lights up — and a branch
// like `m6/orchestrator`, a slash and no extension, shaped exactly like a
// folder, is refused for the same reason rather than by guesswork.
//
// Nothing here touches the filesystem. It reads the writing, not the disk.

/**
 * A path as a model wrote it, plus the line it pointed at (`file.rs:42`).
 *
 * `rooted` says whether the path stands on its own. A relative one is only a
 * *candidate* until the open repository recognises it.
 */
export type WrittenPath = { path: string; line: number | null; rooted: boolean };

// A locator suffix — `:42` or `:42:7` — is how every editor and every agent
// cites a line. It is not part of the path, so it comes off before the path is
// judged and is handed back separately.
const LOCATOR_RE = /:(\d+)(?::\d+)?$/u;

// Characters that mean the span is code, a command, or a pattern, not a place:
// shell punctuation, globs, and the brackets of a function call.
const NOT_A_PATH = /[\s()[\]{}<>=;,|&$"'`*?!]/u;

// Absolute, home-relative, or a Windows drive — the shapes that name one place
// without a project to resolve them against.
function isRooted(path: string): boolean {
  return path.startsWith("/") || path.startsWith("~/") || /^[A-Za-z]:[\\/]/u.test(path);
}

// A relative candidate has to look like a path at all: a folder step, or a
// filename whose extension starts with a letter — which is what keeps a
// version (`1.2.3`), an address (`127.0.0.1`) and a bare word (`dev`) out
// before the repository is ever asked.
const RELATIVE_SHAPE = /^(?:[\w.@-]+[\\/])|^[\w.@-]+\.[A-Za-z][A-Za-z0-9]{0,8}$/u;

/**
 * Read one inline-code span as a place, or decide it isn't one.
 *
 * Accepts a rooted path outright, and a relative one as a candidate, each with
 * an optional `:line` locator. Refuses anything holding whitespace or shell
 * punctuation (`npm run tauri dev`), a glob (`src/**` + `/*.ts`), a flag
 * (`--force`), a bare word (`dev`, `d28f499`) and a URL (the web door already
 * owns those).
 */
export function pathFromCodeSpan(raw: string): WrittenPath | null {
  const span = raw.trim();
  if (!span || span.includes("://")) return null;

  const locator = LOCATOR_RE.exec(span);
  // `C:` is a drive, not a line number — a locator needs a path in front of it.
  const path = locator && locator.index > 1 ? span.slice(0, locator.index) : span;
  const line = locator && locator.index > 1 ? Number(locator[1]) : null;

  if (!path || path === "/" || path === "~") return null;
  if (NOT_A_PATH.test(path)) return null;

  const rooted = isRooted(path);
  if (!rooted && !RELATIVE_SHAPE.test(path)) return null;

  return { path, line, rooted };
}

/**
 * How a path reads in a sentence.
 *
 * Nobody reads `/Users/pierre/Documents/Onetraak` mid-prose; the word that
 * carries the meaning is the last one — the same bargain a bare URL already
 * makes, with the full address on hover. A path already written relative to
 * the project is short, and its folder is the point (`src/App.tsx` is not
 * `App.tsx`), so that one stands exactly as written.
 */
export function pathLabel(written: WrittenPath | string): string {
  const path = typeof written === "string" ? written : written.path;
  if (typeof written !== "string" && !written.rooted) return path;
  const segments = path.split(/[\\/]+/u).filter(Boolean);
  const last = segments[segments.length - 1];
  return last && last !== "~" ? last : path;
}
