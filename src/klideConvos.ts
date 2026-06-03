// Klide's own AI-panel conversations, surfaced to Mission Control. AiPanel
// publishes a snapshot here whenever its messages change; the board lists them
// next to external Claude Code / Codex runs. Module-level (like tasks.ts) so a
// convo stays on the board after its panel closes or the view switches.
// In-memory only for now — convos vanish on app restart (persistence is a
// later slice).

import type { RunMessage, RunStatus } from "./runs";

export type KlideConvo = {
  id: string;
  title: string;
  status: RunStatus;
  model: string | null;
  cwd: string | null;
  messages: RunMessage[];
  updatedMs: number;
};

let convos: KlideConvo[] = [];
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
  convos = [convo, ...convos.filter((c) => c.id !== convo.id)];
  emitChange();
}

// The panel closed or started a fresh chat — the convo is no longer live.
export function settleKlideConvo(id: string): void {
  if (!convos.some((c) => c.id === id && c.status !== "done")) return;
  convos = convos.map((c) => (c.id === id ? { ...c, status: "done" } : c));
  emitChange();
}
