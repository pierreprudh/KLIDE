// A shell command that is really a Python program — `python3 - <<'PY' … PY`
// or `python3 -c '…'` — read for the approval card, so the script shows as
// code and the files it writes are named before it runs. Models reach for
// this to edit files more and more; on one `$` line it reads like `ls`.
//
// Only a command that is *entirely* the script is recognised: anything
// chained before or after (`&& cargo check`) falls back to the plain shell
// line, so the card never hides part of what will run.

export type ScriptCommand = {
  /** What runs it, as typed — `python3 -`, `python -c`. */
  head: string;
  /** The program, one statement per line (`a;b` on one line is split). */
  lines: string[];
  /** Workspace paths the script names as write targets — read statically,
   *  so a best guess, never a guarantee. */
  writes: string[];
};

const INTERPRETER = String.raw`(?:\S*/)?python(?:3(?:\.\d+)?)?`;
const HEREDOC_RE = new RegExp(String.raw`^\s*(${INTERPRETER}\s+-)\s*<<-?\s*(['"]?)([A-Za-z_]\w*)\2[ \t]*\n([\s\S]*?)\n[ \t]*\3[ \t]*$`);
const DASH_C_RE = new RegExp(String.raw`^\s*(${INTERPRETER}\s+-c)\s+(?:'([^']*)'|"((?:\\.|[^"\\])*)")\s*$`);

export function parseScriptCommand(command: string): ScriptCommand | null {
  const trimmed = command.replace(/\s+$/, "");
  let head: string;
  let body: string;
  const heredoc = HEREDOC_RE.exec(trimmed);
  const dashC = heredoc ? null : DASH_C_RE.exec(trimmed);
  if (heredoc) {
    head = heredoc[1].replace(/\s+/g, " ");
    body = heredoc[4];
  } else if (dashC) {
    head = dashC[1].replace(/\s+/g, " ");
    body = dashC[2] ?? dashC[3].replace(/\\(["\\$`])/g, "$1");
  } else {
    return null;
  }
  const lines = body
    .split("\n")
    .flatMap(splitStatements)
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;
  return { head, lines, writes: writeTargets(body) };
}

/** `a=1;b=2` → two lines; a `;` inside a string literal stays put. Leading
 *  indentation of the physical line is kept on its first statement only. */
function splitStatements(line: string): string[] {
  const out: string[] = [];
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "#") {
      break;
    } else if (ch === ";") {
      out.push(line.slice(start, i));
      start = i + 1;
    }
  }
  out.push(line.slice(start));
  return out.map((part, i) => (i === 0 ? part.replace(/\s+$/, "") : part.trim()));
}

const STRING = String.raw`(?:'([^'\\\n]*)'|"([^"\\\n]*)")`;
const PATH_RE = new RegExp(String.raw`\bPath\(\s*${STRING}\s*\)`, "g");
const OPEN_WRITE_RE = new RegExp(String.raw`\bopen\(\s*${STRING}\s*,\s*(?:mode\s*=\s*)?['"][^'"]*[wax+][^'"]*['"]`, "g");

/** Paths the script names as write targets: a `Path('…')` in a script that
 *  calls `write_text` / `write_bytes`, and any `open('…', 'w'|'a'|'x')`. */
function writeTargets(body: string): string[] {
  const found = new Set<string>();
  if (/\.write_(?:text|bytes)\s*\(/.test(body)) {
    for (const m of body.matchAll(PATH_RE)) found.add(m[1] ?? m[2]);
  }
  for (const m of body.matchAll(OPEN_WRITE_RE)) found.add(m[1] ?? m[2]);
  return [...found].filter(Boolean);
}
