import type { KlideConvo } from "./klideConvos";
import type { Run, RunSource } from "./runs";
import type { TaskSession, TaskSource } from "./tasks";
import { DELEGATE_IDS, isDelegateId } from "./delegates";

export type RunLedgerOrigin = "task" | "klide-convo" | "transcript";

export type RunLedgerEntry = Run & {
  origin: RunLedgerOrigin;
  capabilities: RunCapabilities;
  archived: boolean;
  originalTitle: string;
};

export type RunCapabilities = {
  canRename: boolean;
  canResume: boolean;
  canOpenTerminal: boolean;
  canOpenInOtherAgent: boolean;
  canReviewDiff: boolean;
  canSaveMemory: boolean;
  canFork: boolean;
  canArchive: boolean;
  canExportTranscript: boolean;
};

const NO_CAPABILITIES: RunCapabilities = {
  canRename: false,
  canResume: false,
  canOpenTerminal: false,
  canOpenInOtherAgent: false,
  canReviewDiff: false,
  canSaveMemory: false,
  canFork: false,
  canArchive: false,
  canExportTranscript: false,
};

export type RunLedgerMetadata = {
  title?: string;
  archived?: boolean;
  updatedMs?: number;
};

export type RunLedgerMetadataStore = Record<string, RunLedgerMetadata>;

const LEDGER_METADATA_KEY = "klide.runLedger.metadata";

export function runLedgerKey(run: Pick<Run, "source" | "id">): string {
  return `${run.source}:${run.id}`;
}

export function readRunLedgerMetadata(): RunLedgerMetadataStore {
  try {
    const raw = localStorage.getItem(LEDGER_METADATA_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: RunLedgerMetadataStore = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const meta = value as Partial<RunLedgerMetadata>;
      out[key] = {
        title: typeof meta.title === "string" && meta.title.trim() ? meta.title : undefined,
        archived: typeof meta.archived === "boolean" ? meta.archived : undefined,
        updatedMs: typeof meta.updatedMs === "number" ? meta.updatedMs : undefined,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function writeRunLedgerMetadata(store: RunLedgerMetadataStore): void {
  try {
    localStorage.setItem(LEDGER_METADATA_KEY, JSON.stringify(store));
  } catch {
    /* storage full or unavailable */
  }
}

/**
 * The project a run belongs to: the basename of its working directory. Shared
 * by ledger construction (per-run `project`) and Mission Control's project
 * filter so the dropdown's "current project" default matches run labels exactly.
 */
export function projectName(cwd: string | null): string | null {
  return cwd ? cwd.split("/").filter(Boolean).pop() ?? null : null;
}

function capabilitiesFor(run: Run, origin: RunLedgerOrigin): RunCapabilities {
  const delegate = isDelegateId(run.source);
  const hasContent = run.kind === "convo" || run.kind === "run";
  const hasWorkspace = !!run.cwd;
  return {
    ...NO_CAPABILITIES,
    canRename: run.status !== "running" && run.status !== "waiting",
    canResume: delegate || run.source === "klide",
    canOpenTerminal: delegate || origin === "task",
    canOpenInOtherAgent: run.source === "klide" || delegate,
    canReviewDiff: hasWorkspace && run.status !== "queued",
    canSaveMemory: hasContent,
    canFork: hasContent,
    canArchive: run.status !== "running" && run.status !== "waiting",
    canExportTranscript: hasContent,
  };
}

function withCapabilities(
  run: Run,
  origin: RunLedgerOrigin,
  metadata: RunLedgerMetadataStore = {},
): RunLedgerEntry {
  const meta = metadata[runLedgerKey(run)];
  const title = meta?.title?.trim() || run.title;
  return {
    ...run,
    title,
    originalTitle: run.title,
    origin,
    archived: meta?.archived === true,
    capabilities: capabilitiesFor(run, origin),
  };
}

export function taskToLedgerEntry(
  t: TaskSession,
  metadata?: RunLedgerMetadataStore,
): RunLedgerEntry {
  const run: Run = {
    id: t.id,
    path: "",
    kind: "task",
    source: t.source ?? "klide",
    title: t.title,
    status: t.status,
    model: t.model,
    project: projectName(t.cwd),
    cwd: t.cwd,
    branch: null,
    messageCount: 0,
    updatedMs: t.startedMs,
    createdMs: t.startedMs,
  };
  return withCapabilities(run, "task", metadata);
}

export function convoToLedgerEntry(
  c: KlideConvo,
  metadata?: RunLedgerMetadataStore,
): RunLedgerEntry {
  const run: Run = {
    id: c.id,
    path: "",
    kind: "convo",
    source: "klide",
    title: c.title,
    status: c.status,
    model: c.model,
    project: projectName(c.cwd),
    cwd: c.cwd,
    branch: c.branch ?? null,
    worktree: c.worktree ?? null,
    forkedFrom: c.forkedFrom ?? null,
    messageCount: c.messages?.length ?? 0,
    updatedMs: c.updatedMs,
    createdMs: c.updatedMs,
  };
  return withCapabilities(run, "klide-convo", metadata);
}

export function transcriptToLedgerEntry(
  run: Run,
  metadata?: RunLedgerMetadataStore,
): RunLedgerEntry {
  return withCapabilities(run, "transcript", metadata);
}

export type BuildRunLedgerInput = {
  tasks: TaskSession[];
  convos: KlideConvo[];
  runs: Run[];
  workspaceRoot: string | null;
  dismissedBoardRuns?: Set<string>;
  dismissKey?: (run: Run) => string;
  metadata?: RunLedgerMetadataStore;
  showArchived?: boolean;
};

export function buildRunLedger({
  tasks,
  convos,
  runs,
  workspaceRoot,
  dismissedBoardRuns,
  dismissKey,
  metadata = {},
  showArchived = false,
}: BuildRunLedgerInput): RunLedgerEntry[] {
  const workspaceConvos = convos.filter((c) => !workspaceRoot || !c.cwd || c.cwd === workspaceRoot);
  const diskIds = new Set(runs.map((r) => r.id));
  const entries = [
    ...tasks.map((task) => taskToLedgerEntry(task, metadata)),
    ...workspaceConvos.map((convo) => convoToLedgerEntry(convo, metadata)).filter((c) => !diskIds.has(c.id)),
    ...runs.map((run) => transcriptToLedgerEntry(run, metadata)),
  ].filter((entry) => showArchived || !entry.archived);
  if (!dismissedBoardRuns || !dismissKey) return entries;
  return entries.filter((r) => r.kind === "task" || !dismissedBoardRuns.has(dismissKey(r)));
}

export type RunSourceFilter = RunSource | "all" | "subagent";

export function sourceMatchesFilter(run: Pick<RunLedgerEntry, "source">, filter: RunSourceFilter): boolean {
  if (filter === "all") return true;
  if (filter === "subagent") return isDelegateId(run.source);
  return run.source === filter;
}

export function presentRunSources(entries: Pick<RunLedgerEntry, "source">[]): RunSource[] {
  const set = new Set<RunSource>();
  for (const entry of entries) set.add(entry.source);
  return Array.from(set);
}

export type ProjectFilter = string | "all";

export function projectMatchesFilter(
  run: Pick<RunLedgerEntry, "project">,
  filter: ProjectFilter,
): boolean {
  if (filter === "all") return true;
  return run.project === filter;
}

/** Unique, sorted project names present across the given runs (skips unscoped runs). */
export function presentProjects(entries: Pick<RunLedgerEntry, "project">[]): string[] {
  const set = new Set<string>();
  for (const entry of entries) if (entry.project) set.add(entry.project);
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

export function handoffTargetsFor(run: Pick<RunLedgerEntry, "source">): TaskSource[] {
  return DELEGATE_IDS.filter((source) => source !== run.source);
}

export function runMatchesLedgerQuery(run: RunLedgerEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const fields = [
    run.id,
    run.title,
    run.source,
    run.origin,
    run.status,
    run.kind,
    run.model,
    run.provider,
    run.project,
    run.cwd,
    run.branch,
    run.worktree,
    run.forkedFrom?.title,
    run.forkedFrom?.mode,
    run.forkedFrom ? `message ${run.forkedFrom.messageIndex + 1}` : null,
    run.lastEvent,
    run.archived ? "archived" : null,
  ];
  return fields.some((field) => field?.toLowerCase().includes(q));
}
