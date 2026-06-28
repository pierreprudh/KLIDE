// Klide's own AI-panel conversations, surfaced to Mission Control. AiPanel
// publishes a snapshot here whenever its messages change; the board lists them
// next to external Claude Code / Codex runs. Module-level (like tasks.ts) so a
// convo stays on the board after its panel closes or the view switches.

import type { Conversation, Msg } from "./components/ai/types";
import { deriveTitle, loadConversations, persistConversation } from "./components/ai/utils";
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

function conversationToConvo(c: Conversation): KlideConvo | null {
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
  };
}

function readStoredConvos(): KlideConvo[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((c): c is KlideConvo =>
        c &&
        typeof c.id === "string" &&
        typeof c.title === "string" &&
        Array.isArray(c.messages) &&
        typeof c.updatedMs === "number"
      )
      .map((c) => ({
        ...c,
        status: safeStatus(c.status),
        provider: typeof c.provider === "string" ? c.provider as Conversation["provider"] : null,
        branch: typeof c.branch === "string" ? c.branch : null,
        worktree: typeof c.worktree === "string" ? c.worktree : null,
        forkedFrom: safeForkedFrom(c.forkedFrom),
      }));
  } catch {
    return [];
  }
}

function initialConvos(): KlideConvo[] {
  const byId = new Map<string, KlideConvo>();
  for (const c of readStoredConvos()) byId.set(c.id, c);
  for (const c of loadConversations<Conversation>()) {
    const convo = conversationToConvo(c);
    if (convo) byId.set(convo.id, convo);
  }
  return Array.from(byId.values())
    .sort((a, b) => b.updatedMs - a.updatedMs)
    .slice(0, MAX_CONVOS);
}

function persistConvos() {
  try {
    const durable = convos
      .map((c) => ({ ...c, status: safeStatus(c.status) }))
      .slice(0, MAX_CONVOS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(durable));
  } catch {
    /* storage full or unavailable */
  }
}

let convos: KlideConvo[] = initialConvos();
const subscribers = new Set<() => void>();

function emitChange() {
  for (const fn of subscribers) fn();
}

export function subscribeKlideConvos(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

export function getKlideConvos(): KlideConvo[] {
  return convos;
}

// Upsert a convo snapshot (newest first). Called by AiPanel on every message
// change — cheap, since snapshots are small and the board only re-renders
// when the array identity changes.
export function publishKlideConvo(convo: KlideConvo): void {
  convos = [convo, ...convos.filter((c) => c.id !== convo.id)].slice(0, MAX_CONVOS);
  persistConvos();
  emitChange();
}

// The panel closed or started a fresh chat — the convo is no longer live.
export function settleKlideConvo(id: string): void {
  if (!convos.some((c) => c.id === id && c.status !== "done")) return;
  convos = convos.map((c) => (c.id === id ? { ...c, status: "done" } : c));
  persistConvos();
  emitChange();
}

export function deleteKlideConvo(id: string): void {
  if (!convos.some((c) => c.id === id)) return;
  convos = convos.filter((c) => c.id !== id);
  persistConvos();
  emitChange();
}

export function renameKlideConvo(id: string, title: string): void {
  const nextTitle = title.trim();
  if (!nextTitle) return;
  const current = convos.find((c) => c.id === id);
  if (current) {
    convos = convos.map((c) =>
      c.id === id ? { ...c, title: nextTitle, updatedMs: Date.now() } : c
    );
    persistConvos();
    emitChange();
  }
  const conversation = loadConversations<Conversation>().find((c) => c.id === id);
  if (conversation) {
    persistConversation({
      ...conversation,
      title: nextTitle,
      updatedAt: Date.now(),
    });
  }
}
