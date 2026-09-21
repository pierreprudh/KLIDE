// Which backticked words in an answer are places you can open.
//
// Only a *rooted* path qualifies — `/Users/pierre/Documents/Onetraak`,
// `~/.klide/connectors.json`, `C:\…`. That is the one shape that names exactly
// one place on this machine, and it is also the shape worth having: a path
// written relative to a project ("`harness/`", "`CLAUDE.md`") belongs to
// whichever project the answer is *about*, which is very often not the one
// Klide has open. Resolving those against the open workspace sends you to the
// wrong folder, or to nothing.
//
// Leaving them alone fixes the other half of the problem too. An answer
// describing a repository names a dozen of its files in one breath; if every
// one turned accent the paragraph would read as a link farm, and a branch like
// `m6/orchestrator` — a slash, no extension, indistinguishable from a folder —
// would turn blue as well.
//
// Nothing here touches the filesystem. It reads the writing, not the disk —
// whether the path exists is the opener's question to answer, out loud, when
// someone actually clicks.

/** A path as a model wrote it, plus the line it pointed at (`file.rs:42`). */
export type WrittenPath = { path: string; line: number | null };

// A locator suffix — `:42` or `:42:7` — is how every editor and every agent
// cites a line. It is not part of the path, so it comes off before the path is
// judged and is handed back separately.
const LOCATOR_RE = /:(\d+)(?::\d+)?$/u;

// Characters that mean the span is code, a command, or a pattern, not a place:
// shell punctuation, globs, and the brackets of a function call.
const NOT_A_PATH = /[\s()[\]{}<>=;,|&$"'`*?!]/u;

// Absolute, home-relative, or a Windows drive — the only shapes that name one
// place without a project to resolve them against.
function isRooted(path: string): boolean {
  return path.startsWith("/") || path.startsWith("~/") || /^[A-Za-z]:[\\/]/u.test(path);
}

/**
 * Read one inline-code span as a place, or decide it isn't one.
 *
 * Accepts an absolute or `~`-relative path, with an optional `:line` locator.
 * Refuses anything project-relative (`src/App.tsx`, `CLAUDE.md`, the branch
 * `m6/orchestrator`), anything holding whitespace or shell punctuation (`npm
 * run tauri dev`), a glob (`src/**` + `/*.ts`), a flag (`--force`), and a URL
 * (the web door already owns those).
 */
export function pathFromCodeSpan(raw: string): WrittenPath | null {
  const span = raw.trim();
  if (!span || span.includes("://")) return null;

  const locator = LOCATOR_RE.exec(span);
  // `C:` is a drive, not a line number — a locator needs a path in front of it.
  const path = locator && locator.index > 1 ? span.slice(0, locator.index) : span;
  const line = locator && locator.index > 1 ? Number(locator[1]) : null;

  if (!path || path === "/" || path === "~" || !isRooted(path)) return null;
  if (NOT_A_PATH.test(path)) return null;

  return { path, line };
}

/**
 * How a path reads in a sentence.
 *
 * Nobody reads `/Users/pierre/Documents/Onetraak` mid-prose; the word that
 * carries the meaning is the last one — the same bargain a bare URL already
 * makes, with the full address on hover.
 */
export function pathLabel(path: string): string {
  const segments = path.split(/[\\/]+/u).filter(Boolean);
  const last = segments[segments.length - 1];
  return last && last !== "~" ? last : path;
}
