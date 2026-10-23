// One seam so a conversation can open the PDF someone dropped on it.
//
// The attachment card lives deep in a composer or a sent message; the
// document viewer is App's. Same shape as `settingsNavigation.ts`: App
// registers the opener it already has, anyone may ask for it, and the answer
// says whether anything was listening — so a card offers a click only when
// the click would do something.

type AttachmentOpener = (stored: string) => void;

let opener: AttachmentOpener | null = null;

/** App calls this on mount, and with `null` on unmount. */
export function registerAttachmentOpener(next: AttachmentOpener | null): void {
  opener = next;
}

/** True when a kept attachment can be opened — i.e. a click is worth offering. */
export function canOpenStoredAttachment(): boolean {
  return opener !== null;
}

/** Open a kept attachment (`AgentAttachment.stored`) in the document viewer.
 *  Returns false when nothing is listening. */
export function openStoredAttachment(stored: string): boolean {
  if (!opener) return false;
  opener(stored);
  return true;
}
