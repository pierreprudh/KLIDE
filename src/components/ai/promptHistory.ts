// Recalling what you already asked. The composer's ↑ / ↓ walk this
// conversation's own user turns the way a shell walks its history: the draft
// you were writing is stashed on the way back and restored when you come
// forward past the newest entry.
//
// Two rules keep it out of the way of ordinary editing:
//   - ↑ only recalls when the caret sits on the first line (↓ on the last),
//     so arrows still move through a multi-line draft.
//   - while browsing, an untouched recalled entry keeps arrow control, so the
//     caret can rest at the end for editing and ↑ still steps further back.
//     The first keystroke that changes the text ends the browse.

import type { Msg } from "./types";

/** The conversation's user prompts, oldest first — what ↑ walks back through.
 *  Wake turns (the panel speaking for agent mail) and empty/attachment-only
 *  turns were never typed, so they are not history; an immediately repeated
 *  prompt collapses to one entry the way a shell collapses duplicates. */
export function promptHistoryEntries(msgs: readonly Msg[]): string[] {
  const entries: string[] = [];
  for (const m of msgs) {
    if (m.role !== "user" || m.wake) continue;
    const text = m.content;
    if (!text.trim()) continue;
    if (entries[entries.length - 1] === text) continue;
    entries.push(text);
  }
  return entries;
}

export type PromptHistoryMove = {
  /** What the composer should now contain. */
  text: string;
  /** Position in `entries`, or null when the stashed draft is back. */
  index: number | null;
  /** This move opened a browse: the composer stashes the value it had as the
   *  draft to come back to, so an edited recall isn't lost by walking on. */
  stash?: true;
};

export type PromptHistoryInput = {
  direction: "older" | "newer";
  /** Oldest first, from `promptHistoryEntries`. */
  entries: readonly string[];
  /** Where the browse currently stands; null when composing a fresh draft. */
  index: number | null;
  value: string;
  selectionStart: number;
  selectionEnd: number;
  /** The draft stashed when the browse began. */
  draft: string;
};

const caretOnFirstLine = (value: string, caret: number) =>
  value.lastIndexOf("\n", caret - 1) === -1;

/** What ↑ / ↓ mean right now, or null when the key is ordinary caret movement
 *  and the composer should let the textarea have it. */
export function navigatePromptHistory(input: PromptHistoryInput): PromptHistoryMove | null {
  const { direction, entries, index, value, selectionStart, selectionEnd, draft } = input;
  // A selection means the user is working on the text, not browsing.
  if (selectionStart !== selectionEnd) return null;
  // An entry recalled and left untouched keeps the arrows; editing hands them
  // back to the textarea, wherever the caret happens to be.
  const browsing = index !== null && index < entries.length && value === entries[index];

  if (direction === "newer") {
    // ↓ is only ever a way back out of a browse.
    if (!browsing || index === null) return null;
    const next = index + 1;
    if (next >= entries.length) return { text: draft, index: null };
    return { text: entries[next], index: next };
  }

  if (entries.length === 0) return null;
  if (!browsing && !caretOnFirstLine(value, selectionStart)) return null;
  if (!browsing) return { text: entries[entries.length - 1], index: entries.length - 1, stash: true };
  if (index === null) return null;
  // Already at the oldest prompt: absorb the key rather than jumping the caret.
  if (index === 0) return { text: entries[0], index: 0 };
  return { text: entries[index - 1], index: index - 1 };
}
