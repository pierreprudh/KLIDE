// One seam so a toast or the Scheduled page can start "Fix it" on a CI watch
// firing. App registers the opener (it owns Focus and the panel fleet) — the
// same shape as conversationNavigation.ts.

import type { CiWatchFired } from "./ipc/ciWatch";

type CiFixOpener = (fired: CiWatchFired) => void;

let opener: CiFixOpener | null = null;

export function registerCiFixOpener(next: CiFixOpener | null): void {
  opener = next;
}

export function canStartCiFix(): boolean {
  return opener !== null;
}

export function startCiFix(fired: CiWatchFired): void {
  opener?.(fired);
}
