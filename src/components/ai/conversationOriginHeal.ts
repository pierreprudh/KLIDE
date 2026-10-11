// Repair Stored conversations whose Provider metadata was overwritten.
//
// Before `originProvider` existed (conversationSession.ts), a Conversation
// recorded the panel's *current* dispatch target rather than what produced its
// turns: moving the picker rewrote the thread's provider and model on the next
// save. A panel could also restore a thread belonging to another Provider
// entirely, which made that rewrite easy to trigger without noticing — a
// Claude Code thread would surface in history, and on the Mission Control
// board, labelled OpenRouter.
//
// Both causes are fixed going forward. This heals the records already on disk.
//
// There are two kinds of evidence, and this module reads both.
//
// The stronger one is the Run's own Transcript. Rust writes a `run_started`
// line at dispatch carrying the Provider and model it is about to use, and a
// Conversation shares its id with that Transcript — so for any thread that ran
// through the Harness, the first such line IS the origin, and no guessing is
// involved. `healedConversationFromRunOrigin` uses it. (This module originally
// declared `Msg.delegateProvider` "the only surviving evidence" and left every
// API-origin record alone for want of any. That was wrong: 23 of one dogfood
// index's 44 runnable threads contradicted their own transcript, and all 23
// were recoverable from disk.)
//
// The weaker one, for a thread whose Transcript is gone, is
// `Msg.delegateProvider`: every delegate turn
// stamps the CLI's display name onto its assistant message, console or
// headless. So a thread whose FIRST assistant turn names a delegate began on
// that delegate, whatever its metadata now claims.
//
// Deliberately narrow: only the first assistant turn counts. A thread that
// started on an API provider and later moved to a CLI has a delegate name
// further down, but its origin is the API provider — and since a non-delegate
// turn stamps nothing, that origin is unrecoverable, so such a record is left
// exactly as it is. Guessing there would trade one wrong label for another.

import type { Conversation, Msg } from "./types";
import { delegateProviderByName, isDelegateProvider } from "../../agent/providers";
import { loadConversations, saveConversations } from "./storedConversations";
import { isForeignModelFor } from "./rememberedModel";
import type { RunOrigin } from "../../runs";

/** The delegate a thread demonstrably began on, or null when its first
 *  assistant turn didn't come from one (or came from a CLI this build can no
 *  longer name). */
export function originDelegateOf(msgs: Msg[]): string | null {
  const firstAssistant = msgs.find((m) => m && m.role === "assistant");
  if (!firstAssistant || firstAssistant.role !== "assistant") return null;
  const name = firstAssistant.delegateProvider;
  return name ? delegateProviderByName(name) : null;
}

/**
 * The corrected record, or null when nothing needs correcting.
 *
 * The model is dropped rather than kept: a record mislabelled OpenRouter
 * carries OpenRouter's model, which belongs to no turn in the thread and
 * cannot be recovered. An unknown model reads as "unknown" everywhere it
 * surfaces; a confidently wrong one does not.
 */
export function healedConversationOrigin(conv: Conversation): Conversation | null {
  // A record already on a delegate is either right or unrecoverable; either
  // way this heal has nothing to add.
  if (conv.provider && isDelegateProvider(conv.provider)) return null;
  const origin = originDelegateOf(conv.msgs);
  if (!origin || origin === conv.provider) return null;
  return { ...conv, provider: origin as Conversation["provider"], model: null };
}

/**
 * Heal the whole Stored conversation index in place. Runs at boot, before any
 * surface reads it.
 *
 * Idempotent and unflagged on purpose: it is a pure function of the data, so a
 * second run changes nothing, and a record whose custom CLI wasn't loaded yet
 * on this boot still gets its chance on the next one. `updatedAt` is untouched
 * — repairing a label is not activity, and Focus orders its rail by that time.
 *
 * Mission Control needs no separate pass: its store overlays the Stored
 * conversations over its own rows on first read each session, so a healed
 * thread re-derives its board row from the corrected record.
 */
export function healStoredConversationOrigins(): number {
  let healed = 0;
  const conversations = loadConversations<Conversation>();
  const next = conversations.map((conv) => {
    const fixed = healedConversationOrigin(conv);
    if (!fixed) return conv;
    healed += 1;
    return fixed;
  });
  // Don't rewrite (or notify) an index that was already correct.
  if (healed > 0) saveConversations(next, undefined, false);
  return healed;
}

/* ─────────────── a model that belongs to another Provider ────────────── */

/**
 * The record with its model dropped, when that model plainly belongs to
 * another Provider — or null when it is fine. A thread carried onto a CLI
 * from an API chat used to keep the chat's model (a Claude Code session
 * showing `deepseek/deepseek-v4.1-flash`); `conversationSession` no longer
 * lets that happen, and this clears what was saved before. Dropping, not
 * replacing: with no model the thread opens on the CLI's own default, which
 * is where a resumed session belongs anyway.
 */
export function healedConversationModel(conv: Conversation): Conversation | null {
  if (!conv.provider || !conv.model || !isForeignModelFor(conv.provider, conv.model)) return null;
  return { ...conv, model: null };
}

/** Repair every stored thread whose model is another Provider's. Returns how
 *  many changed; the index is rewritten only when one did. */
export function healStoredConversationModels(): number {
  let healed = 0;
  const conversations = loadConversations<Conversation>();
  const next = conversations.map((conv) => {
    const fixed = healedConversationModel(conv);
    if (!fixed) return conv;
    healed += 1;
    return fixed;
  });
  if (healed > 0) saveConversations(next, undefined, false);
  return healed;
}

/* ─────────────── the strong evidence: the Run's own Transcript ────────────── */

/**
 * The record corrected against what its Run actually dispatched with, or null
 * when nothing needs correcting.
 *
 * Unlike the delegate heal above, this replaces the model too rather than
 * dropping it — the transcript names it, so there is nothing to be unsure
 * about. And unlike that heal, it is not restricted to non-delegate records: a
 * thread mislabelled *as* a delegate is exactly as wrong as one mislabelled as
 * OpenRouter, and the transcript settles both.
 */
export function healedConversationFromRunOrigin(
  conv: Conversation,
  origin: RunOrigin | undefined,
): Conversation | null {
  if (!origin || !origin.provider) return null;
  const sameProvider = conv.provider === origin.provider;
  const sameModel = (conv.model ?? "") === origin.model;
  if (sameProvider && sameModel) return null;
  return {
    ...conv,
    provider: origin.provider as Conversation["provider"],
    model: origin.model,
  };
}

/**
 * Heal the Stored conversation index against the Transcripts on disk.
 *
 * Async, so unlike its sibling it cannot run before the first render — it runs
 * just after, and the index it corrects is republished through the ordinary
 * change event so every mounted surface re-reads it.
 *
 * Same discipline as the sync heal: idempotent, unflagged, a pure function of
 * data + disk, and `updatedAt` untouched, because repairing a label is not
 * activity. A thread whose Transcript has been deleted keeps whatever label it
 * has — absent evidence is not evidence of absence.
 */
export async function healStoredConversationsFromTranscripts(
  fetchOrigins: (runIds: string[]) => Promise<RunOrigin[]>,
): Promise<number> {
  const conversations = loadConversations<Conversation>();
  if (conversations.length === 0) return 0;
  const origins = await fetchOrigins(conversations.map((conv) => conv.id));
  const byId = new Map(origins.map((origin) => [origin.runId, origin]));
  let healed = 0;
  const next = conversations.map((conv) => {
    const fixed = healedConversationFromRunOrigin(conv, byId.get(conv.id));
    if (!fixed) return conv;
    healed += 1;
    return fixed;
  });
  // Notify on this one: surfaces have already rendered from the stale index by
  // the time it resolves, so a corrected row has to be published to be seen.
  if (healed > 0) saveConversations(next, undefined, true);
  return healed;
}
