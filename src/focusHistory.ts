import type { ProviderId } from "./agent/types";

/** Remembered orders, keyed by the list they belong to. Owned by the rail for
 *  as long as it is mounted; see `keepOrder`. */
export type OrderMemory = Map<string, string[]>;

export function orderProviderHistory<T extends { provider: string; conversations: { id: string }[] }>(
  groups: T[], memory: OrderMemory, project: string,
): T[] {
  return keepOrder(groups, (group) => group.provider, memory, project);
}

/**
 * Recency ordering, decided when a list's *membership* changes rather than on
 * every tick of its timestamps.
 *
 * Provider groups within a project sort by `updatedAt`. A running conversation
 * bumps that on every message, so two live runs under two different providers
 * made their groups leapfrog each other continuously, trading first place with
 * every token. Sorting is not the problem; sorting *live* is. A list you click
 * in must not rearrange itself under the cursor.
 *
 * Provider group order is resolved once and then held: everything already on screen
 * keeps the place it had, and only genuinely new arrivals move — in at the
 * top, in the incoming recency order, which is where the thing you just
 * started belongs. Dropping the memory (the rail unmounting) re-resolves from
 * scratch, so recency still decides the order you come back to. Conversation
 * rows use their current recency order so resumed chats return to the top.
 */
export function keepOrder<T>(
  items: T[],
  idOf: (item: T) => string,
  memory: OrderMemory,
  key: string,
): T[] {
  const remembered = memory.get(key) ?? [];
  const place = new Map(remembered.map((id, index) => [id, index]));
  const arrived: T[] = [];
  const held: T[] = [];
  for (const item of items) {
    if (place.has(idOf(item))) held.push(item);
    else arrived.push(item);
  }
  held.sort((a, b) => place.get(idOf(a))! - place.get(idOf(b))!);
  const next = [...arrived, ...held];
  memory.set(key, next.map(idOf));
  return next;
}

/** Resolve a provider group's disclosure state when the user has not made an
 * explicit choice. Kept pure so secondary-panel history behavior is testable
 * without mounting the full Focus workspace. */
export function providerHistoryExpanded(
  explicit: boolean | undefined,
  groupProvider: ProviderId,
  activeProvider: ProviderId,
  newestProvider: ProviderId | undefined,
): boolean {
  return explicit ?? (
    groupProvider === activeProvider || groupProvider === newestProvider
  );
}
