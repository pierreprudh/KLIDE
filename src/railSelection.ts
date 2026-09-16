// Which conversation row the rail lights as "you are here".
//
// The truth is the panel bindings: the focused panel's conversation, falling
// back to the primary slot. But a binding is written only after the AI panel
// has *finished* resuming — and the moment that matters to the person is the
// click. Between the two the old binding still stands, so the row they left
// stayed lit and the row they chose did not, until the panel caught up (or,
// when a resume went sideways, never). The row a person just picked therefore
// wins until the bindings know about it; from then on the bindings rule, so
// focusing the other half of a Focus split still moves the highlight.
//
// Focus has two more states the bindings cannot see: the start stage (nothing
// on the canvas, whatever the panels still hold) and the apology row for a
// conversation that is no longer in local history. Both show the picked row
// and only that.

export type RailSelectionInput = {
  /** The Focus shell (true) or the workbench (false). */
  focus: boolean;
  /** Focus only: a conversation is up on the canvas, not the start stage. */
  chatActive: boolean;
  /** Focus only: the canvas is showing the apology for a missing thread. */
  convoError: boolean;
  /** The conversation the person last picked in the rail, if any. */
  picked: string | null;
  /** The focused panel's bound conversation, falling back to the primary. */
  boundActive: string | null;
  /** Every conversation some panel is bound to. */
  boundIds: readonly string[];
};

export function railSelectedConversation(input: RailSelectionInput): string | null {
  const { focus, chatActive, convoError, picked, boundActive, boundIds } = input;
  const pending = picked && !boundIds.includes(picked) ? picked : null;
  if (!focus) return pending ?? boundActive;
  if (!chatActive || convoError) return picked;
  return pending ?? boundActive ?? picked;
}
