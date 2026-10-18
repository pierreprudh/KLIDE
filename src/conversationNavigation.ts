// One seam so a background module can send you to a conversation.
//
// The toasts that matter most — an agent needs you, finished its turn, a
// background observer updated a thread — are raised by modules with no access
// to the app's view state, and the one thing you want from them is to go
// there. App registers the opener it already has (the rail's: raised if open,
// resumed if not, its project brought along) and anyone may ask for it — the
// same shape as settingsNavigation.ts.
//
// Best-effort: `openConversation` reports whether the conversation was found,
// so a caller can fall back to another door (a live Delegate PTY that never
// became a stored conversation).

type ConversationOpener = (conversationId: string) => boolean;

let opener: ConversationOpener | null = null;

/** App calls this on mount, and with `null` on unmount. */
export function registerConversationOpener(next: ConversationOpener | null): void {
  opener = next;
}

/** True when a conversation can be opened — i.e. an Open action is worth offering. */
export function canOpenConversation(): boolean {
  return opener !== null;
}

/** Open one stored conversation where the user is. False when nothing is
 *  listening or no stored conversation has that id. */
export function openConversation(conversationId: string): boolean {
  return opener ? opener(conversationId) : false;
}

// A live Delegate PTY session (`{convoId}:{provider}`) that has no stored
// conversation yet is reached through Mission Control's Reattach door instead.
type SessionReattacher = (conversationId: string, provider: string) => void;

let reattacher: SessionReattacher | null = null;

export function registerSessionReattacher(next: SessionReattacher | null): void {
  reattacher = next;
}

/** Open the conversation a Delegate session belongs to: the stored thread if
 *  there is one, else a panel reattached to the live PTY. */
export function openDelegateSession(sessionId: string): void {
  const cut = sessionId.lastIndexOf(":");
  if (cut <= 0) return;
  const conversationId = sessionId.slice(0, cut);
  if (openConversation(conversationId)) return;
  reattacher?.(conversationId, sessionId.slice(cut + 1));
}
