import type { Msg } from "./types";
import { estimateProjectContextTokens } from "../../contextTray";

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
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

export function deriveTitle(msgs: Msg[]): string {
  const firstUser = msgs.find((m) => m.role === "user");
  const text = firstUser?.content.trim() ?? "";
  if (!text) return "New chat";
  return text.length > 42 ? `${text.slice(0, 42)}…` : text;
}

export function estimateTokens(text: string): number {
  if (!text.trim()) return 0;
  return Math.ceil(text.length / 3.7);
}

export function messageTokenEstimate(m: Msg): number {
  let total = estimateTokens(m.content);
  if (m.role === "user" && m.attachments) {
    total += m.attachments.reduce(
      (sum, a) => sum + estimateTokens(a.path) + estimateTokens(a.content),
      0
    );
  }
  if (m.role === "user" && m.projectContext) {
    total += estimateProjectContextTokens(m.projectContext.items);
  }
  if (m.role === "assistant") {
    total += estimateTokens(m.thinking ?? "");
    total += estimateTokens(JSON.stringify(m.toolCalls ?? []));
  }
  if (m.role === "tool") total += estimateTokens(m.toolName);
  return total;
}

export function relativeTime(ts: number): string {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++;
  }
  return i === needle.length;
}

export function fuzzyFiles(files: string[], query: string): string[] {
  const q = query.toLowerCase();
  if (!q) return files.slice(0, 8);
  const scored: { path: string; score: number }[] = [];
  for (const path of files) {
    const lower = path.toLowerCase();
    const base = lower.split("/").pop() ?? lower;
    let score = -1;
    if (base.startsWith(q)) score = 0;
    else if (base.includes(q)) score = 1;
    else if (lower.includes(q)) score = 2;
    else if (isSubsequence(q, lower)) score = 3;
    if (score >= 0) scored.push({ path, score });
  }
  scored.sort((a, b) => a.score - b.score || a.path.length - b.path.length);
  return scored.slice(0, 8).map((s) => s.path);
}

const CONVOS_KEY = "klide-conversations";

export function loadConversations<T>(key?: string): T[] {
  try {
    const raw = localStorage.getItem(key ?? CONVOS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveConversations<T>(list: T[], key?: string) {
  try {
    localStorage.setItem(key ?? CONVOS_KEY, JSON.stringify(list));
  } catch {
    /* storage full or unavailable */
  }
}

// A panel's *conversation* identity is separate from its *panel* identity
// (provider/model prefs, keyed by panelId). We persist a tiny per-panel
// record so a transient unmount (view switch) mid-run can re-attach to the
// in-flight conversation, while reopening the panel after the conversation
// finished starts a fresh one — otherwise quick chats pile into a single
// ever-growing transcript that replays its whole history on every turn.
const PANEL_SESSION_PREFIX = "klide.panelSession.";

export interface PanelSession {
  convoId: string;
  /** True while a run is in-flight (or a history convo was explicitly
   *  resumed). On the next mount, only an active session re-attaches; an
   *  inactive one means the conversation is done, so the panel starts fresh. */
  active: boolean;
}

export function loadPanelSession(panelId: string): PanelSession | null {
  try {
    const raw = localStorage.getItem(PANEL_SESSION_PREFIX + panelId);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p && typeof p.convoId === "string" && typeof p.active === "boolean") {
      return p as PanelSession;
    }
    return null;
  } catch {
    return null;
  }
}

export function savePanelSession(panelId: string, convoId: string, active: boolean) {
  try {
    localStorage.setItem(
      PANEL_SESSION_PREFIX + panelId,
      JSON.stringify({ convoId, active })
    );
  } catch {
    /* storage full or unavailable */
  }
}
