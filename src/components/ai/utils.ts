import { invoke } from "@tauri-apps/api/core";
import type { ProviderId } from "../../agent/types";
import type { Conversation, Msg } from "./types";
import { estimateProjectContextTokens } from "../../contextTray";

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Exact token count for a string under a specific model's own tokenizer, where
// the provider exposes one (Ollama /api/tokenize, Anthropic count_tokens);
// otherwise a length-based estimate with `exact: false`. Counts message
// content only — the chat-template wrapper the model also sees is not included,
// so per-message counts won't sum to a full-prompt total.
export async function countMessageTokens(
  provider: string,
  model: string,
  text: string,
): Promise<{ count: number; exact: boolean }> {
  const res = await invoke<{ tokens: number; exact: boolean }>("ai_count_tokens", {
    provider,
    model,
    text,
  });
  return { count: res.tokens, exact: res.exact };
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
const MAX_CONVERSATIONS = 100;

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

export function saveConversations<T>(list: T[], key?: string) {
  try {
    localStorage.setItem(key ?? CONVOS_KEY, JSON.stringify(list));
  } catch {
    /* storage full or unavailable */
  }
}

export function upsertConversation(
  conv: Conversation,
  existing: Conversation[] = loadConversations<Conversation>(),
): Conversation[] {
  const next = [conv, ...existing.filter((c) => c.id !== conv.id)];
  return next.slice(0, MAX_CONVERSATIONS);
}

export function persistConversation(
  conv: Conversation,
  existing?: Conversation[],
): Conversation[] {
  const next = upsertConversation(conv, existing);
  saveConversations(next);
  return next;
}

const DELEGATE_PROVIDER_IDS = new Set(["claude-code", "codex", "opencode"]);

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
    .filter((conv) => hasRestorableMessages(conv))
    .filter((conv) => !conv.provider || !DELEGATE_PROVIDER_IDS.has(conv.provider))
    .filter((conv) => !workspaceRoot || !conv.cwd || conv.cwd === workspaceRoot)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const providerMatch = provider
    ? conversations.find((conv) => conv.provider === provider)
    : null;
  return (providerMatch ?? conversations[0])?.id ?? null;
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

export function savePanelSession(panelId: string, session: PanelSession) {
  try {
    localStorage.setItem(
      PANEL_SESSION_PREFIX + panelId,
      JSON.stringify(session)
    );
  } catch {
    /* storage full or unavailable */
  }
}
