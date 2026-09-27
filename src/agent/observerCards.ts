import type { Observer } from "./observers";
import type { GithubObserver } from "./githubObserver";

type Card = { observer: Observer; watch?: GithubObserver };
const key = (runId: string) => `klide.observer-cards.${runId}`;
export function readObserverCards(runId: string): Card[] {
  try {
    const value = JSON.parse(localStorage.getItem(key(runId)) ?? "[]");
    return Array.isArray(value) ? value.filter(card => card?.observer?.id && card.observer.githubWatch) : [];
  } catch { return []; }
}
export function saveObserverCard(runId: string, observer: Observer, watch?: GithubObserver) {
  if (!observer.githubWatch) return;
  const cards = readObserverCards(runId);
  const previous = cards.find(card => card.observer.id === observer.id);
  const next = { observer, watch: watch ?? previous?.watch };
  if (JSON.stringify(previous) === JSON.stringify(next)) return;
  try { localStorage.setItem(key(runId), JSON.stringify([...cards.filter(card => card.observer.id !== observer.id), next])); } catch { /* Storage may be unavailable. */ }
}
export function clearObserverCards(runId: string) {
  try { localStorage.removeItem(key(runId)); } catch { /* Storage may be unavailable. */ }
}
export function mergeObserverCards(runId: string, live: Observer[]): Observer[] {
  live.forEach(observer => saveObserverCard(runId, observer));
  const ids = new Set(live.map(observer => observer.id));
  const restored = readObserverCards(runId).filter(card => !ids.has(card.observer.id)).map(card => ({ ...card.observer, restored: true }));
  return [...live, ...restored].sort((a, b) => a.startedMs - b.startedMs);
}
