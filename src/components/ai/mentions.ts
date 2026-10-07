// The `@` mention — the pure half both composers share. The workbench panel
// and the Focus start stage each own a textarea; what an `@word` under the
// caret *is*, and what accepting a row does to the draft, is one rule here.
//
// `@` at the head of the message may name a subagent (`@reviewer …`); `@`
// anywhere names a workspace file. The two never clash because a subagent is
// only offered at the start — see `matchSubagents` and the menu.

export type MentionQuery = {
  /** The text typed after the `@`, up to the caret. */
  query: string;
  /** Index of the `@` in the draft. */
  start: number;
  /** The `@word` is the whole draft so far — the one place a subagent fits. */
  atStart: boolean;
};

/** The `@word` the caret stands in, or null when it stands in none. An `@`
 *  has to begin a word (so `a@b.dev` is an email, not a mention) and the
 *  word runs to the caret without a space or a second `@`. */
export function mentionQueryAt(value: string, caret: number = value.length): MentionQuery | null {
  const before = value.slice(0, caret);
  const m = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (!m) return null;
  const query = m[1];
  const start = before.length - query.length - 1;
  return { query, start, atStart: start === 0 };
}

/** Replace the `@word` at `start…caret` with `@text ` and say where the caret
 *  lands: right after the trailing space, ready for the sentence. */
export function replaceMention({
  value,
  start,
  caret,
  text,
}: {
  value: string;
  start: number;
  caret: number;
  text: string;
}): { value: string; caret: number } {
  const head = value.slice(0, start) + "@" + text + " ";
  return { value: head + value.slice(caret), caret: head.length };
}

/** Arrow keys walk the rows, Enter/Tab accept, Escape closes — the same
 *  bindings the `/` menu answers. Null for any other key. */
export function mentionKeyAction(key: string): "next" | "prev" | "accept" | "close" | null {
  if (key === "ArrowDown") return "next";
  if (key === "ArrowUp") return "prev";
  if (key === "Enter" || key === "Tab") return "accept";
  if (key === "Escape") return "close";
  return null;
}
