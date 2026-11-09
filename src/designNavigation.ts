// One seam so the command palette, a shortcut or a completion card can open
// Design mode on the conversation you are in.
//
// Design mode belongs to an AI panel — its review is sent into that panel's
// conversation — but the palette and ⌘⇧D live in App. Each panel registers
// its opener when it mounts and again when it takes focus, so the most
// recently used conversation is the one that opens; unregistering hands the
// seam back to the panel registered before it. Same best-effort contract as
// settingsNavigation: `openDesignMode` reports whether anything listened.

type DesignOpener = () => void;

let openers: DesignOpener[] = [];

/** Register (or re-promote) an opener; returns the unregister function. */
export function registerDesignOpener(open: DesignOpener): () => void {
  openers = [...openers.filter(o => o !== open), open];
  return () => { openers = openers.filter(o => o !== open); };
}

/** Promote an already registered opener — the panel was just used. */
export function promoteDesignOpener(open: DesignOpener): void {
  if (openers.includes(open) && openers[openers.length - 1] !== open) openers = [...openers.filter(o => o !== open), open];
}

/** Open Design mode on the most recently used conversation. */
export function openDesignMode(): boolean {
  const open = openers[openers.length - 1];
  if (!open) return false;
  open();
  return true;
}
