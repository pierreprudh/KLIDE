/** Human-readable message from an unknown thrown value (Error, string, or a
 *  Tauri command rejection, which is usually already a string). */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A send gave up waiting for its conversation's previous Run to let go.
 *  Nothing is wrong with the provider, so the message stands on its own. */
export class RunBusyError extends Error {
  constructor() {
    super("This conversation's Run is still busy — stop it or wait, then send again.");
    this.name = "RunBusyError";
  }
}

/** What a failed turn should tell the user: the provider's own message, then the
 *  one thing to do about it.
 *
 *  The panel used to append "Check <provider> connection and credentials." to
 *  every failure. That is the right advice for an auth or network error and
 *  wrong for everything else — a stale Codex CLI reports "the model requires a
 *  newer version of Codex", which sent the reader to look at credentials that
 *  were never the problem. So a message that already says what is wrong gets
 *  the matching instruction, and the credentials line stays the fallback for
 *  failures that say nothing about themselves.
 *
 *  `providerLabel` is the provider's display name, passed in so this module
 *  stays free of the provider registry. */
export function providerFailureMessage(err: unknown, providerLabel: string): string {
  if (err instanceof RunBusyError) return err.message;
  const message = errMessage(err).trim().replace(/[.\s]+$/, "");
  return `${message}. ${providerFailureHint(message, providerLabel)}`;
}

function providerFailureHint(message: string, providerLabel: string): string {
  // Every Codex model gates on a minimum CLI version server-side, so this
  // arrives as a plain HTTP 400 from a CLI that is merely out of date. Only
  // Codex's updater is named because it is the only one verified here; the
  // others get the same instruction without a command to paste.
  if (/requires a newer version/i.test(message)) {
    return providerLabel === "Codex"
      ? "Your Codex CLI is out of date — run `codex update`, then retry."
      : `Your ${providerLabel} CLI is out of date — update it, then retry.`;
  }
  return `Check ${providerLabel} connection and credentials.`;
}
