import { useCallback, useSyncExternalStore, type SetStateAction } from "react";
import type { AgentAttachment } from "../../agent/types";
import { notify } from "../../toast";

export type ComposerDraft = { text: string; attachments: AgentAttachment[] };
const EMPTY: ComposerDraft = { text: "", attachments: [] };
const PREFIX = "klide.composer-draft.v1:";
const drafts = new Map<string, ComposerDraft>();
const listeners = new Set<() => void>();
let warned = false;

export function composerDraftKey(workspace: string | null, conversationId: string): string {
  return PREFIX + JSON.stringify([workspace, conversationId]);
}

export function readComposerDraft(key: string): ComposerDraft {
  const cached = drafts.get(key);
  if (cached) return cached;
  let draft = EMPTY;
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null");
    if (saved && typeof saved.text === "string" && Array.isArray(saved.attachments)) {
      draft = { text: saved.text, attachments: saved.attachments.filter((a: AgentAttachment | null) =>
        a && typeof a.path === "string" && typeof a.content === "string") };
    }
  } catch { /* A damaged entry must not break the composer. */ }
  drafts.set(key, draft);
  return draft;
}

export function updateComposerDraft(key: string, update: (draft: ComposerDraft) => ComposerDraft): void {
  const next = update(readComposerDraft(key));
  drafts.set(key, next);
  try {
    if (!next.text && !next.attachments.length) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // A large screenshot may exceed WebKit's storage quota. Still save the
    // typed message; the full attachment stays in the session cache.
    try { localStorage.setItem(key, JSON.stringify({ text: next.text, attachments: [] })); } catch { /* Session cache remains available. */ }
    if (!warned) {
      warned = true;
      notify("Draft kept for this app session. Local storage is full, so it may not survive a restart.", { tone: "warn" });
    }
  }
  listeners.forEach(listener => listener());
}

export function forgetComposerDrafts(conversationId: string): void {
  const keys = new Set(drafts.keys());
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(PREFIX)) keys.add(key);
  }
  for (const key of keys) {
    try {
      if (JSON.parse(key.slice(PREFIX.length))[1] !== conversationId) continue;
      drafts.delete(key);
      localStorage.removeItem(key);
    } catch { /* Ignore unrelated or damaged keys. */ }
  }
  listeners.forEach(listener => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** Setters capture the conversation key: an async paste finishing after
 * navigation still belongs to the conversation where it began. */
export function useComposerDraft(key: string) {
  const getSnapshot = useCallback(() => readComposerDraft(key), [key]);
  const draft = useSyncExternalStore(subscribe, getSnapshot);
  const setText = useCallback((action: SetStateAction<string>) => {
    updateComposerDraft(key, current => ({ ...current, text: typeof action === "function" ? action(current.text) : action }));
  }, [key]);
  const setAttachments = useCallback((action: SetStateAction<AgentAttachment[]>) => {
    updateComposerDraft(key, current => ({ ...current, attachments: typeof action === "function" ? action(current.attachments) : action }));
  }, [key]);
  return { ...draft, setText, setAttachments };
}
