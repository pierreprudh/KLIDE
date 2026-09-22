// Klide's own AI-panel conversations, surfaced to Mission Control. AiPanel
// publishes a snapshot here whenever its messages change; the board lists them
// next to external Claude Code / Codex runs. Module-level (like tasks.ts) so a
// convo stays on the board after its panel closes or the view switches.

import type { Conversation, Msg } from "./components/ai/types";
import {
  conversationStartedAt,
  deriveTitle,
  loadConversations,
  renameStoredConversation,
} from "./components/ai/storedConversations";
import { createPersistedStore, validatedArray } from "./persistedStore";
import type { RunMessage, RunStatus } from "./runs";

export type KlideConvo = {
  id: string;
  title: string;
  status: RunStatus;
  provider?: Conversation["provider"] | null;
  model: string | null;
  cwd: string | null;
  branch: string | null;
  worktree?: string | null;
  forkedFrom?: Conversation["forkedFrom"];
  messages: RunMessage[];
  updatedMs: number;
  /** When the conversation started, epoch ms. Mission Control used to copy
   *  `updatedMs` here, which made every Klide row look instantaneous. */
  createdMs?: number;
};

const STORAGE_KEY = "klide.missionConvos";
const MAX_CONVOS = 100;

function safeStatus(status: unknown): RunStatus {
  if (status === "cancelled" || status === "error") return status;
  return "done";
}

function safeForkedFrom(value: unknown): Conversation["forkedFrom"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as NonNullable<Conversation["forkedFrom"]>;
  if (
    typeof v.conversationId !== "string" ||
    typeof v.title !== "string" ||
    typeof v.messageIndex !== "number" ||
    typeof v.createdAt !== "number" ||
    (v.mode !== "chat" && v.mode !== "worktree")
  ) {
    return null;
  }
  return {
    conversationId: v.conversationId,
    title: v.title,
    messageIndex: v.messageIndex,
    createdAt: v.createdAt,
    mode: v.mode,
  };
}

function msgToRunMessage(m: Msg): RunMessage | null {
  if (m.role !== "user" && m.role !== "assistant") return null;
  if (m.role === "assistant" && m.delegateConsole) return null;
  const text = m.content.trim();
  return text ? { role: m.role, text } : null;
}

/** One Stored conversation → one Mission Control row. The board's idle
 *  status is "done"; a live publisher (AiPanel) overrides `status` for a
 *  streaming run. Null when nothing in it is renderable on the board. */
export function conversationToConvo(c: Conversation): KlideConvo | null {
  const messages = c.msgs.map(msgToRunMessage).filter((m): m is RunMessage => !!m);
  if (messages.length === 0) return null;
  return {
    id: c.id,
    title: c.title || deriveTitle(c.msgs),
    status: "done",
    provider: c.provider ?? null,
    model: c.model ?? null,
    cwd: c.cwd ?? null,
    branch: c.branch ?? null,
    worktree: c.worktree ?? null,
    forkedFrom: c.forkedFrom ?? null,
    messages,
    updatedMs: c.updatedAt,
    createdMs: conversationStartedAt(c),
  };
}

function decodeStoredConvos(parsed: unknown): KlideConvo[] {
  return validatedArray(
    parsed,
    (c): c is KlideConvo =>
      !!c &&
      typeof c === "object" &&
      typeof (c as Partial<KlideConvo>).id === "string" &&
      typeof (c as Partial<KlideConvo>).title === "string" &&
      Array.isArray((c as Partial<KlideConvo>).messages) &&
      typeof (c as Partial<KlideConvo>).updatedMs === "number",
  ).map((c) => ({
    ...c,
    status: safeStatus(c.status),
    provider: typeof c.provider === "string" ? c.provider as Conversation["provider"] : null,
    branch: typeof c.branch === "string" ? c.branch : null,
    worktree: typeof c.worktree === "string" ? c.worktree : null,
    forkedFrom: safeForkedFrom(c.forkedFrom),
  }));
}

const store = createPersistedStore<KlideConvo[]>({
  key: STORAGE_KEY,
  // Merge-and-bound on first read: stored board snapshots, overlaid with the
  // full AI-panel conversations (the richer record wins), newest first.
  validate: (parsed) => {
    const byId = new Map<string, KlideConvo>();
    for (const c of decodeStoredConvos(parsed)) byId.set(c.id, c);
    for (const c of loadConversations<Conversation>()) {
      const convo = conversationToConvo(c);
      if (convo) byId.set(convo.id, convo);
    }
    return Array.from(byId.values())
      .sort((a, b) => b.updatedMs - a.updatedMs)
      .slice(0, MAX_CONVOS);
  },
  bound: (convos) => convos.slice(0, MAX_CONVOS),
  // A live status must not survive a restart — the durable form settles it.
  persist: (convos) => convos.map((c) => ({ ...c, status: safeStatus(c.status) })),
});

export function subscribeKlideConvos(fn: () => void): () => void {
  return store.subscribe(fn);
}

export function getKlideConvos(): KlideConvo[] {
  return store.get();
}

// Upsert a convo snapshot (newest first). Called by AiPanel on every message
// change — cheap, since snapshots are small and the board only re-renders
// when the array identity changes.
export function publishKlideConvo(convo: KlideConvo): void {
  store.mutate((convos) => {
    // Snapshots replace the whole record, so the start has to be carried across
    // or a live conversation would restart its clock on every message.
    const previous = convos.find((c) => c.id === convo.id);
    const next = {
      ...convo,
      createdMs: previous?.createdMs ?? convo.createdMs ?? convo.updatedMs,
    };
    return [next, ...convos.filter((c) => c.id !== convo.id)];
  });
}

// The panel closed or started a fresh chat — the convo is no longer live.
export function settleKlideConvo(id: string): void {
  if (!store.get().some((c) => c.id === id && c.status !== "done")) return;
  store.mutate((convos) => convos.map((c) => (c.id === id ? { ...c, status: "done" } : c)));
}

export function deleteKlideConvo(id: string): void {
  if (!store.get().some((c) => c.id === id)) return;
  store.mutate((convos) => convos.filter((c) => c.id !== id));
}

export function renameKlideConvo(id: string, title: string): void {
  const nextTitle = title.trim();
  if (!nextTitle) return;
  if (store.get().some((c) => c.id === id)) {
    store.mutate((convos) =>
      convos.map((c) => (c.id === id ? { ...c, title: nextTitle, updatedMs: Date.now() } : c))
    );
  }
  // The Stored conversation is the record every rail row reads; the title
  // travels with it (`renamed`) so the panel's next snapshot keeps it.
  renameStoredConversation(id, nextTitle);
}
