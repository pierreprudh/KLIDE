// One seam so a toast or the Scheduled page can start "Look into it" on a
// klide-bot mention. App registers the opener (it owns Focus and the panel
// fleet) — the same shape as ciFixNavigation.ts.

import type { KlideBotMention } from "./ipc/klideBot";

type Opener = (mention: KlideBotMention) => void;

let opener: Opener | null = null;

export function registerKlideBotOpener(next: Opener | null): void {
  opener = next;
}

export function canLookIntoMention(): boolean {
  return opener !== null;
}

export function lookIntoMention(mention: KlideBotMention): void {
  opener?.(mention);
}
