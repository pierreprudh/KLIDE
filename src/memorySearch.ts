// Memory search — the query half of Memory v4 (browse/search by run,
// decision, and touched files). Pure: MemoryPanel parses the input once and
// filters the already-loaded entries; nothing here touches IPC.
//
// Query language, deliberately tiny:
//   bare terms        match anywhere (title, goal, notes, plan, decisions,
//                     files, run id, provider, model) — AND'd together
//   file:<term>       only Files-touched paths
//   run:<term>        only the run id
//   decision:<term>   only Decision bullets
import type { MemoryEntry } from "./memory";

export type MemoryQuery = {
  text: string[];
  file: string[];
  run: string[];
  decision: string[];
};

export function parseMemoryQuery(raw: string): MemoryQuery {
  const q: MemoryQuery = { text: [], file: [], run: [], decision: [] };
  for (const token of raw.trim().toLowerCase().split(/\s+/)) {
    if (!token) continue;
    const [prefix, ...rest] = token.split(":");
    const value = rest.join(":");
    if (value && (prefix === "file" || prefix === "run" || prefix === "decision")) {
      q[prefix].push(value);
    } else {
      q.text.push(token);
    }
  }
  return q;
}

export function isEmptyMemoryQuery(q: MemoryQuery): boolean {
  return q.text.length === 0 && q.file.length === 0 && q.run.length === 0 && q.decision.length === 0;
}

const contains = (haystack: string, term: string) => haystack.toLowerCase().includes(term);
const anyContains = (list: string[], term: string) => list.some((item) => contains(item, term));

/** Every term must land somewhere (facet terms in their facet). */
export function matchesMemoryQuery(entry: MemoryEntry, q: MemoryQuery): boolean {
  if (!q.file.every((t) => anyContains(entry.filesTouched, t))) return false;
  if (!q.run.every((t) => contains(entry.runId ?? "", t))) return false;
  if (!q.decision.every((t) => anyContains(entry.decisions, t))) return false;
  return q.text.every(
    (t) =>
      contains(entry.title, t) ||
      contains(entry.goal, t) ||
      contains(entry.notes, t) ||
      anyContains(entry.plan, t) ||
      anyContains(entry.decisions, t) ||
      anyContains(entry.filesTouched, t) ||
      contains(entry.runId ?? "", t) ||
      contains(entry.provider ?? "", t) ||
      contains(entry.model ?? "", t)
  );
}

/** Why a matching entry matched, when the evidence is NOT already visible in
 *  the list row (title/goal are; files, decisions, and run id aren't).
 *  Returns e.g. `file src/pty.rs` / `decision keep the two folds separate` /
 *  `run ses_ab12` — or null when the visible fields explain the hit. */
export function memoryMatchNote(entry: MemoryEntry, q: MemoryQuery): string | null {
  if (isEmptyMemoryQuery(q)) return null;
  const fileTerms = [...q.file, ...q.text];
  const decisionTerms = [...q.decision, ...q.text];
  const runTerms = [...q.run, ...q.text];

  // Facet-prefixed terms always explain themselves; bare terms only when they
  // did NOT hit a visible field (title/goal).
  const visibleHit = (t: string) => contains(entry.title, t) || contains(entry.goal, t);

  for (const t of fileTerms) {
    if (q.text.includes(t) && visibleHit(t)) continue;
    const hit = entry.filesTouched.find((p) => contains(p, t));
    if (hit) return `file ${hit}`;
  }
  for (const t of decisionTerms) {
    if (q.text.includes(t) && visibleHit(t)) continue;
    const hit = entry.decisions.find((d) => contains(d, t));
    if (hit) return `decision ${hit.length > 72 ? `${hit.slice(0, 72)}…` : hit}`;
  }
  for (const t of runTerms) {
    if (q.text.includes(t) && visibleHit(t)) continue;
    if (contains(entry.runId ?? "", t)) return `run ${entry.runId}`;
  }
  return null;
}
