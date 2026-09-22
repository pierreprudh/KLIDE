// The Stored conversation index — the durable record of AI-panel
// Conversations (CONTEXT.md: "Stored conversation"). This module owns the
// localStorage conversation index (load / save / upsert / persist), the
// change event Focus listens to, the per-panel Conversation binding
// (PanelSession), and the one title rule every surface derives from a
// message list. Live-session navigation lives in `conversationSession.ts`;
// genuinely misc helpers (token estimates, ids) stay in `utils.ts`.

import type { AgentAttachment as Attachment, ProviderId } from "../../agent/types";
import { isAutoProvider } from "../../agent/providers";
import type { Conversation, Msg } from "./types";
import { notify as notifyUser } from "../../toast";
import { canOpenSettings, openSettingsSection } from "../../settingsNavigation";

const CONVOS_KEY = "klide-conversations";
export const CONVERSATIONS_CHANGED_EVENT = "klide:conversations-changed";
export type ConversationChangedDetail = {
  conversationId: string;
  provider: ProviderId;
  cwd: string | null;
};
/** One conversation was deliberately removed from local history. Distinct from
 *  the changed event above because the two mean opposite things to a panel
 *  showing that thread: a change is metadata to refresh, a deletion is a
 *  thread to let go of before the next persist quietly brings it back. */
export const CONVERSATION_DELETED_EVENT = "klide:conversation-deleted";
export type ConversationDeletedDetail = { conversationId: string };
const MAX_CONVERSATIONS = 100;
let conversationStorageFailureNotified = false;
let conversationStoragePressureNotified = false;

/** The one title rule for a Conversation, everywhere it surfaces (history
 *  list, Mission Control row, memory note): the first user message,
 *  whitespace-collapsed, capped at 80 characters, falling back to
 *  "Untitled chat". Three surfaces used to each derive their own — 42, 80,
 *  and 120 characters with three different fallbacks — so one conversation
 *  showed three different titles. */
export function deriveTitle(msgs: Msg[]): string {
  const firstUser = msgs.find((m) => m.role === "user");
  const text = (firstUser?.content ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "Untitled chat";
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

// The snapshot to persist for a conversation. Right after a send the list is
// `[…, user, assistant("")]` — an empty placeholder waiting for tokens. We
// must not let that placeholder block persistence (a view switch in that
// window would otherwise drop the just-sent user message), so strip a
// trailing empty assistant turn but keep everything before it.
export function messagesForPersist(msgs: Msg[]): Msg[] {
  if (msgs.length === 0) return msgs;
  const last = msgs[msgs.length - 1];
  if (last.role === "assistant" && !last.content && !last.thinking && !last.toolCalls) {
    return msgs.slice(0, -1);
  }
  return msgs;
}

function isQuotaExceeded(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: unknown; code?: unknown };
  return (
    value.name === "QuotaExceededError" ||
    value.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    value.code === 22 ||
    value.code === 1014
  );
}

export function loadConversations<T>(key?: string): T[] {
  try {
    const raw = localStorage.getItem(key ?? CONVOS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    // Heal malformed records on read. Every consumer assumes `msgs` is an
    // array of message objects and dereferences `m.role` (e.g. deriveTitle's
    // `msgs.find((m) => m.role === "user")`). A partially-written record — a
    // missing `msgs`, or a `null`/non-object slot inside it — would throw at
    // the call site, and since these run during render/mount, blank the whole
    // app (white screen). So we drop entries without a `msgs` array and strip
    // any null/non-object messages from the arrays we keep.
    return parsed
      .filter((c) => c && typeof c === "object" && Array.isArray((c as { msgs?: unknown }).msgs))
      .map((c) => ({
        ...(c as object),
        msgs: ((c as { msgs: unknown[] }).msgs).filter(
          (m) => m && typeof m === "object"
        ),
      })) as T[];
  } catch {
    return [];
  }
}

export function saveConversations<T>(
  list: T[],
  key?: string,
  notify = true,
  detail?: ConversationChangedDetail,
): T[] {
  const storageKey = key ?? CONVOS_KEY;
  let candidate = list;
  while (true) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(candidate));
      const pruned = list.length - candidate.length;
      conversationStorageFailureNotified = false;
      if (pruned > 0 && storageKey === CONVOS_KEY) {
        if (!conversationStoragePressureNotified) {
          notifyUser(
            `Local conversation history was full, so Klide removed ${pruned} older snapshot${pruned === 1 ? "" : "s"}. Durable Run transcripts remain in Mission Control.`,
            {
              tone: "warn",
              // This is the moment the cache's size matters, so offer the place
              // that shows it — but only when Settings is actually reachable.
              action: canOpenSettings()
                ? { label: "Manage storage", run: () => openSettingsSection("storage") }
                : undefined,
            },
          );
        }
        conversationStoragePressureNotified = true;
      } else {
        conversationStoragePressureNotified = false;
      }
      // The native `storage` event does not fire in the window that performed
      // the write. Focus and AiPanel live in that same window, so publish one
      // lightweight navigation event when the visible conversation index
      // changes (new row, reordered row, title/model/provider/folder update).
      if ((notify || pruned > 0) && storageKey === CONVOS_KEY && typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(CONVERSATIONS_CHANGED_EVENT, { detail }));
      }
      return candidate;
    } catch (error) {
      // A Conversation snapshot is only the local reader cache; the Harness
      // Transcript remains durable on disk. Under quota pressure, keep the
      // newest contiguous history and retry by removing one oldest snapshot
      // at a time. Never discard the current/newest Conversation itself.
      if (storageKey === CONVOS_KEY && isQuotaExceeded(error) && candidate.length > 1) {
        candidate = candidate.slice(0, -1);
        continue;
      }
      if (!conversationStorageFailureNotified) {
        notifyUser(
          "Klide could not save the local conversation index. The durable Run transcript is still on disk.",
          { tone: "error" },
        );
        conversationStorageFailureNotified = true;
      }
      return loadConversations<T>(storageKey);
    }
  }
}

/** Do these two records hold the same conversation, message for message? */
function sameMessages(a: Msg[] | undefined, b: Msg[] | undefined): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((message, index) => {
    const other = b[index];
    return message?.role === other?.role && message?.content === other?.content;
  });
}

function conversationIndexChanged(
  conversation: Conversation,
  existing: Conversation[],
): boolean {
  const previousIndex = existing.findIndex((item) => item.id === conversation.id);
  if (previousIndex !== 0) return true;
  const previous = existing[0];
  return (
    !previous ||
    previous.title !== conversation.title ||
    previous.provider !== conversation.provider ||
    previous.model !== conversation.model ||
    previous.cwd !== conversation.cwd ||
    previous.branch !== conversation.branch ||
    previous.worktree !== conversation.worktree
  );
}

/** When the conversation began, epoch ms. Prefers the stored `createdAt`, then
 *  the first message that carries its own timestamp, and finally `updatedAt` —
 *  the last of which is only right for a one-turn thread, but it is the best a
 *  record written before timestamps existed can offer. */
export function conversationStartedAt(conv: Conversation): number {
  if (typeof conv.createdAt === "number") return conv.createdAt;
  const firstStamped = conv.msgs?.find((m) => typeof (m as { ts?: number }).ts === "number");
  return (firstStamped as { ts?: number } | undefined)?.ts ?? conv.updatedAt;
}

/** How long the conversation has been running, ms — start to last activity. */
export function conversationDuration(conv: Conversation): number {
  return Math.max(0, conv.updatedAt - conversationStartedAt(conv));
}

export function upsertConversation(
  conv: Conversation,
  existing: Conversation[] = loadConversations<Conversation>(),
): Conversation[] {
  const previous = existing.find((c) => c.id === conv.id);
  // `updatedAt` is rewritten on every token, so the start has to be carried
  // forward explicitly or the thread loses it on the next save. An existing
  // record's start always wins — a resumed conversation begins when it was
  // first sent, not when it was reopened.
  const createdAt = previous
    ? conversationStartedAt(previous)
    : (conv.createdAt ?? conversationStartedAt(conv));
  // A name the person gave wins over the derived one, for the same reason:
  // every snapshot recomputes `title` from the first user message, so a
  // rename that only lived in the record would be undone by the next token.
  const named =
    previous?.renamed && !conv.renamed ? { title: previous.title, renamed: true } : {};
  // The index is ordered by recency, not by write order — a record that was
  // re-saved without gaining a turn keeps its place instead of jumping the
  // queue. Sorting rather than unshifting also means the prune below drops the
  // genuinely oldest thread. The upserted record leads among equal times, and
  // Array#sort is stable, so it keeps that lead.
  const next = [{ ...conv, createdAt, ...named }, ...existing.filter((c) => c.id !== conv.id)];
  next.sort((a, b) => b.updatedAt - a.updatedAt);
  return next.slice(0, MAX_CONVERSATIONS);
}

export function persistConversation(
  conv: Conversation,
  _stalePanelSnapshot?: Conversation[],
): Conversation[] {
  // Every mounted panel has its own React history state. That state is useful
  // for rendering but is not a safe write base: two panels can mount from the
  // same snapshot, then the second writer would erase the first. Re-read the
  // one durable browser store synchronously for every merge. The optional
  // argument remains only so older callers cannot reintroduce last-writer-wins
  // while they migrate; it is intentionally ignored.
  const current = loadConversations<Conversation>();
  // Loading a conversation re-snapshots it verbatim, and the snapshot always
  // carries a fresh `updatedAt`. Letting that land would make reading a thread
  // count as working on it: it would climb to the top of its provider group,
  // drag the group's own sort position with it, and read "just now" though
  // nothing was said. Activity is what changes the messages — so when they are
  // identical to the stored record, keep the time that record already had.
  // Metadata edits (model, branch) still save; they just don't count as use.
  const previous = current.find((item) => item.id === conv.id);
  const stamped =
    previous && sameMessages(previous.msgs, conv.msgs)
      ? { ...conv, updatedAt: previous.updatedAt }
      : conv;
  // The cache may not carry an unbounded photo (see SNAPSHOT_IMAGE_BUDGET).
  // Applied here, at the one write boundary, so no caller can bypass it — and
  // applied to the *snapshot only*: the mounted panel keeps the full image it
  // is rendering, and the transcript on disk keeps it for good.
  const next = upsertConversation(cacheableConversation(stamped), current);
  // Streaming persists on every token. Avoid making Focus rebuild its rail on
  // every text delta; the first snapshot already contains the selected model,
  // so notify only when navigation-visible metadata or ordering changes.
  const navigationChanged = conversationIndexChanged(stamped, current);
  return saveConversations(
    next,
    undefined,
    navigationChanged,
    navigationChanged
      ? {
          conversationId: conv.id,
          provider: conv.provider ?? "ollama",
          cwd: conv.cwd ?? null,
        }
      : undefined,
  );
}

/** Whether reopening this conversation would show anything.
 *
 *  The one predicate for "resumable", replacing a provider blocklist that stood
 *  in for it. A delegate conversation used to be unresumable by definition —
 *  its transcript lived in the CLI's PTY, not in Klide — but a delegate run
 *  through the headless Focus path stores ordinary messages. What disqualifies a
 *  conversation is having nothing to restore: only a console placeholder, or an
 *  empty first turn. */
export function conversationIsRestorable(conv: Conversation): boolean {
  return hasRestorableMessages(conv);
}

function hasRestorableMessages(conv: Conversation): boolean {
  if (!conv || !Array.isArray(conv.msgs)) return false;
  return conv.msgs.some((m) => {
    if (!m || typeof m.content !== "string") return false;
    if (m.role === "user") return m.content.trim().length > 0;
    if (m.role === "assistant") return !m.delegateConsole && m.content.trim().length > 0;
    return false;
  });
}

export function latestRestorableConversationId(
  workspaceRoot: string | null,
  provider?: string | null,
): string | null {
  const conversations = loadConversations<Conversation>()
    // No provider blocklist: a delegate conversation with restorable messages
    // came from the headless path and reopens correctly, while a PTY-session one
    // holds only console rows and is excluded by the predicate above.
    .filter((conv) => hasRestorableMessages(conv))
    .filter((conv) => !workspaceRoot || !conv.cwd || conv.cwd === workspaceRoot)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  // A panel only restores a Conversation that ran on its own Provider. The
  // fallback used to be "otherwise the most recent thread of any Provider",
  // which is how an OpenRouter panel silently adopted a Claude Code thread —
  // and, once the picker moved, relabelled it (see `originProvider` in
  // conversationSession.ts). With no thread for this Provider the panel opens
  // a fresh one; history is one click away and keeps its own identity.
  // An Auto panel owns no Provider: its threads record whatever the router
  // landed each on, and continuing one re-locks to that origin in Rust. So it
  // restores the most recent thread of any Provider — the one case where the
  // rule above would otherwise leave a panel with nothing to reopen.
  if (provider && !isAutoProvider(provider)) {
    return conversations.find((conv) => conv.provider === provider)?.id ?? null;
  }
  return conversations[0]?.id ?? null;
}

// A panel's *conversation* identity is separate from its *panel* identity
// (provider/model prefs, keyed by panelId). We persist a tiny per-panel
// record so a transient unmount (view switch) can re-attach to the Conversation
// the panel was showing. Workspace + Provider prevent a durable Delegate
// binding from leaking into another Workspace. Run activity belongs to
// Conversation Session; it was previously written here as `active` but never
// read, so older records may contain that harmless extra field.
const PANEL_SESSION_PREFIX = "klide.panelSession.";

export interface PanelSession {
  convoId: string;
  workspaceRoot?: string | null;
  provider?: ProviderId;
}

export function loadPanelSession(panelId: string): PanelSession | null {
  try {
    const raw = localStorage.getItem(PANEL_SESSION_PREFIX + panelId);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p && typeof p.convoId === "string") {
      return {
        convoId: p.convoId,
        workspaceRoot:
          p.workspaceRoot === null || typeof p.workspaceRoot === "string"
            ? p.workspaceRoot
            : undefined,
        provider: typeof p.provider === "string" ? p.provider as ProviderId : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Fired in this window when a panel↔conversation binding is written. The
 *  native `storage` event never fires in the writing window, and the rail's
 *  selected/open marks are derived from these bindings — without a signal they
 *  only refresh when the conversation *index* happens to change, which a
 *  resume into a panel does not do. Bindings are written on identity
 *  transitions only (fresh/resume/branch/provider/run start), so this is a
 *  rare event, not a per-message one. */
export const PANEL_BINDINGS_CHANGED_EVENT = "klide:panel-bindings-changed";

export function savePanelSession(panelId: string, session: PanelSession) {
  try {
    localStorage.setItem(
      PANEL_SESSION_PREFIX + panelId,
      JSON.stringify(session)
    );
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(PANEL_BINDINGS_CHANGED_EVENT));
    }
  } catch {
    /* storage full or unavailable */
  }
}

// ── The cache's size, and what it may hold ────────────────────────────────
//
// A Stored conversation is a *reader cache*; the durable record is the Run
// transcript on disk. localStorage gives the whole app about 5 MB, and one
// pasted screenshot is base64 — a 2 MB photo becomes ~2.7 MB of string, over
// half the quota inside a single message. When that write failed, the quota
// loop below did what it was told: it evicted 33 older threads to fit one
// photo, and stopped at the newest record because it may never drop that.
// Losing a month of history to one screenshot is the wrong trade, so a
// snapshot now carries images only while they are small.

/** How much base64 image one conversation snapshot may keep. Beyond this the
 *  `dataUri` is dropped (the `path`/`mime` stay, so the bubble can still say a
 *  photo was there) and the full image is read back from the Run transcript. */
export const SNAPSHOT_IMAGE_BUDGET = 150_000;

/** Attachments ride the user variant of `Msg`, so reading them off any message
 *  needs one narrow accessor rather than a role check at every call site. */
type MaybeAttached = { attachments?: Attachment[] };

function attachmentsOf(msg: Msg): Attachment[] {
  return (msg as MaybeAttached).attachments ?? [];
}

function imageBytesOf(msg: Msg): number {
  return attachmentsOf(msg).reduce((sum, a) => sum + (a.dataUri?.length ?? 0), 0);
}

/** Total base64 image bytes a message list is carrying. */
export function conversationImageBytes(msgs: Msg[] | undefined): number {
  return Array.isArray(msgs) ? msgs.reduce((sum, m) => sum + imageBytesOf(m), 0) : 0;
}

/** What a conversation costs in the cache, in bytes of serialized JSON. */
export function conversationBytes(conv: unknown): number {
  try {
    return JSON.stringify(conv).length;
  } catch {
    return 0;
  }
}

/**
 * The snapshot as it may be cached: newest messages keep their images while the
 * running total fits `budget`; older ones are stripped to `path` + `mime`.
 *
 * Newest-first because the photo you are looking at is the one worth caching.
 * Returns the input untouched when nothing needs dropping, so the common path
 * allocates nothing and `sameMessages` comparisons stay stable.
 */
export function cacheableMessages(msgs: Msg[], budget = SNAPSHOT_IMAGE_BUDGET): Msg[] {
  if (!Array.isArray(msgs) || conversationImageBytes(msgs) <= budget) return msgs;
  let spent = 0;
  const kept: Msg[] = new Array(msgs.length);
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i];
    const bytes = imageBytesOf(msg);
    if (bytes === 0) {
      kept[i] = msg;
      continue;
    }
    if (spent + bytes <= budget) {
      spent += bytes;
      kept[i] = msg;
      continue;
    }
    // Keep `path` and `mime`: the bubble still says a photo was here, and the
    // full image is read back from the Run transcript.
    kept[i] = {
      ...msg,
      attachments: attachmentsOf(msg).map(({ dataUri: _dropped, ...rest }) => rest),
    } as Msg;
  }
  return kept;
}

/** The same rule applied to a whole conversation record. */
export function cacheableConversation<C extends { msgs: Msg[] }>(
  conv: C,
  budget = SNAPSHOT_IMAGE_BUDGET,
): C {
  const msgs = cacheableMessages(conv.msgs, budget);
  return msgs === conv.msgs ? conv : { ...conv, msgs };
}

/** One row per cached conversation, biggest first — what Settings shows. */
export type CachedConversationSize = {
  id: string;
  title: string;
  updatedAt: number;
  bytes: number;
  imageBytes: number;
  messages: number;
};

export function cachedConversationSizes(): CachedConversationSize[] {
  return loadConversations<Conversation>()
    .map((conv) => ({
      id: conv.id,
      title: conv.title || deriveTitle(conv.msgs ?? []),
      updatedAt: conv.updatedAt,
      bytes: conversationBytes(conv),
      imageBytes: conversationImageBytes(conv.msgs),
      messages: conv.msgs?.length ?? 0,
    }))
    .sort((a, b) => b.bytes - a.bytes);
}

/** What Klide is holding in this browser store, key by key. Every key counts:
 *  the quota is shared, so a big skills or mission cache squeezes history too. */
export function localCacheUsage(): { bytes: number; keys: { key: string; bytes: number }[] } {
  const keys: { key: string; bytes: number }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key === null) continue;
      keys.push({ key, bytes: (key.length + (localStorage.getItem(key)?.length ?? 0)) });
    }
  } catch {
    return { bytes: 0, keys: [] };
  }
  keys.sort((a, b) => b.bytes - a.bytes);
  return { bytes: keys.reduce((sum, k) => sum + k.bytes, 0), keys };
}

/** Drop every cached image from the whole index, retroactively. Returns the
 *  bytes freed. The photos remain in the Run transcripts on disk. */
export function dropCachedImages(): number {
  const current = loadConversations<Conversation>();
  const before = conversationBytes(current);
  const next = current.map((conv) => cacheableConversation(conv, 0));
  saveConversations(next);
  return Math.max(0, before - conversationBytes(next));
}

/** Forget one cached conversation. The Run transcript stays on disk. Every
 *  surface still showing the thread hears about it — the rail, Settings
 *  storage and a panel's own history list all delete through here, so a panel
 *  drops to a fresh chat instead of re-persisting the snapshot you removed. */
/** Give a conversation the name the person typed. Whitespace-collapsed like a
 *  derived title; an empty name is a no-op, not an erasure. The record is
 *  marked `renamed` so later snapshots keep it (see `upsertConversation`),
 *  and its place in the list is unchanged — naming a thread is not using it. */
export function renameStoredConversation(id: string, title: string): Conversation[] {
  const nextTitle = title.replace(/\s+/g, " ").trim();
  const current = loadConversations<Conversation>();
  const previous = current.find((c) => c.id === id);
  if (!nextTitle || !previous || (previous.renamed && previous.title === nextTitle)) return current;
  const next = current.map((c) => (c.id === id ? { ...c, title: nextTitle, renamed: true } : c));
  return saveConversations(next, undefined, true, {
    conversationId: id,
    provider: previous.provider ?? "ollama",
    cwd: previous.cwd ?? null,
  });
}

export function forgetStoredConversation(id: string): Conversation[] {
  const next = saveConversations(
    loadConversations<Conversation>().filter((conv) => conv.id !== id),
  );
  if (typeof window !== "undefined") {
    const detail: ConversationDeletedDetail = { conversationId: id };
    window.dispatchEvent(new CustomEvent(CONVERSATION_DELETED_EVENT, { detail }));
  }
  return next;
}

/** Forget the whole local index. */
export function clearStoredConversations(): Conversation[] {
  return saveConversations<Conversation>([]);
}
