// Pinned conversations — the rows a person chose to keep at the top of their
// provider group, whatever recency says.
//
// A separate store rather than a flag on the Conversation: the AI panel
// persists a conversation whole on every snapshot, so a flag the rail set on
// the index would be overwritten the next time the panel saved. The pin is
// the rail's fact about a thread, not the thread's, and it lives on its own —
// like `favModels.ts`, one persisted id list, read through so two mounted
// rails agree without a shared in-memory copy.

const KEY = "klide.pinnedConversations";

function read(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function write(ids: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    /* storage full / unavailable */
  }
}

const listeners = new Set<() => void>();

/** Every pinned id, in the order they were pinned (oldest first). */
export function pinnedConversationIds(): Set<string> {
  return new Set(read());
}

export function isPinnedConversation(id: string): boolean {
  return read().includes(id);
}

/** Pin or unpin one conversation. Returns the new state. */
export function togglePinnedConversation(id: string): boolean {
  const ids = read();
  const index = ids.indexOf(id);
  const pinned = index < 0;
  if (pinned) ids.push(id);
  else ids.splice(index, 1);
  write(ids);
  for (const listener of listeners) listener();
  return pinned;
}

/** A conversation that left local history takes its pin with it. */
export function forgetPinnedConversation(id: string): void {
  const ids = read();
  if (!ids.includes(id)) return;
  write(ids.filter((x) => x !== id));
  for (const listener of listeners) listener();
}

export function subscribePinnedConversations(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Pinned rows first, then the rest — each half keeping the order it came in,
 *  so a pin lifts a row without reshuffling the ones around it. */
export function orderPinnedFirst<T extends { id: string }>(
  items: readonly T[],
  pinned: ReadonlySet<string>,
): T[] {
  if (pinned.size === 0) return [...items];
  const top: T[] = [];
  const rest: T[] = [];
  for (const item of items) (pinned.has(item.id) ? top : rest).push(item);
  return [...top, ...rest];
}
