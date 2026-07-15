// Agent races — one task dispatched to two (or more) agents, each in its own
// git worktree, so their evidence can be compared and the winner merged.
//
// Distinct from src/agent/fanout.ts (the goal *decomposition* engine, which
// splits one goal into subtasks): a race gives every agent the SAME task and
// the group is the unit of comparison. Runs themselves live in the Rust
// harness (transcripts + summaries on disk); this store only remembers which
// run ids belong together and what prompt spawned them. localStorage +
// module-level pub/sub, same pattern as memoryDrafts.ts.

import { readValidatedArray } from "./persistedStore";

export type RaceMember = {
  /** Harness run id == transcript id == Mission Control row id. */
  runId: string;
  provider: string;
  model: string;
  /** Absolute path of the linked worktree the run executes in. */
  worktreePath: string;
  branch: string;
  /** Worktree display name (basename), matching the ledger's `worktree`. */
  worktree: string;
};

export type RaceGroup = {
  id: string;
  prompt: string;
  /** The base checkout the worktrees were created from. */
  workspaceRoot: string;
  createdMs: number;
  members: RaceMember[];
};

const STORE_KEY = "klide.races";
// Old races are noise once their runs are archived — keep the store bounded.
const MAX_GROUPS = 40;

type Listener = (groups: RaceGroup[]) => void;
const listeners = new Set<Listener>();

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRaceMember(value: unknown): value is RaceMember {
  if (!value || typeof value !== "object") return false;
  const member = value as Partial<RaceMember>;
  return (
    isNonEmptyString(member.runId) &&
    isNonEmptyString(member.provider) &&
    isNonEmptyString(member.model) &&
    isNonEmptyString(member.worktreePath) &&
    isNonEmptyString(member.branch) &&
    isNonEmptyString(member.worktree)
  );
}

function isRaceGroup(value: unknown): value is RaceGroup {
  if (!value || typeof value !== "object") return false;
  const group = value as Partial<RaceGroup>;
  return (
    isNonEmptyString(group.id) &&
    isNonEmptyString(group.prompt) &&
    isNonEmptyString(group.workspaceRoot) &&
    typeof group.createdMs === "number" &&
    Number.isFinite(group.createdMs) &&
    Array.isArray(group.members) &&
    group.members.length > 0 &&
    group.members.every(isRaceMember)
  );
}

function readAll(): RaceGroup[] {
  return readValidatedArray(STORE_KEY, isRaceGroup);
}

function writeAll(groups: RaceGroup[]): void {
  const bounded = groups.slice(-MAX_GROUPS);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(bounded));
  } catch {
    /* storage full or unavailable — listeners still see the in-memory state */
  }
  for (const l of listeners) l(bounded);
}

export function listRaces(workspaceRoot?: string | null): RaceGroup[] {
  const all = readAll();
  const scoped = workspaceRoot ? all.filter((g) => g.workspaceRoot === workspaceRoot) : all;
  return scoped.sort((a, b) => b.createdMs - a.createdMs);
}

export function addRace(group: RaceGroup): void {
  writeAll([...readAll().filter((g) => g.id !== group.id), group]);
}

export function removeRace(id: string): void {
  writeAll(readAll().filter((g) => g.id !== id));
}

/** The race a run belongs to, or null. A run belongs to at most one race. */
export function raceForRun(runId: string): RaceGroup | null {
  return readAll().find((g) => g.members.some((m) => m.runId === runId)) ?? null;
}

export function subscribeRaces(listener: Listener): () => void {
  listeners.add(listener);
  listener(readAll());
  return () => {
    listeners.delete(listener);
  };
}
