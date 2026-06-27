// Mission Control's data layer. A "run" is one agent session. Klide aggregates
// runs from every agentic tool you use — its own AI panel plus external CLIs
// (Claude Code, Codex) whose session logs the Rust `list_agent_runs` command
// reads off disk. The board is read-only for now; steering/resume come later.

import { invoke } from "@tauri-apps/api/core";
import type { AgentEvent } from "./agent/types";
import { foldAgentEvents, foldedToRunMessages } from "./agent/foldEvents";

import type { DelegateId } from "./delegates";

export type RunSource = DelegateId | "klide";
export type RunStatus = "running" | "waiting" | "queued" | "done" | "cancelled" | "error";
export type RunBoardSection = "running" | "blocked" | "ready_for_review" | "done";

/** Why a run landed in the Mission Control attention queue. Discriminated by
 *  `kind` so the row component can pick the right pill tone, copy, and
 *  inline action. `null` (from `runAttentionReason`) means "nothing to do". */
export type RunAttention =
  | { kind: "failed"; agentLabel: string }
  | { kind: "awaiting_input" }
  | { kind: "idle"; idleMs: number }
  | { kind: "awaiting_review"; source: RunSource };

export type RunBoardReasonTone = "active" | "danger" | "warn" | "accent" | "success" | "subtle";

export type RunBoardReason = {
  label: string;
  detail: string;
  tone: RunBoardReasonTone;
};

/** Human label for an attention kind, surfaced on the queue pill. */
export const ATTENTION_LABEL: Record<RunAttention["kind"], string> = {
  failed: "Failed",
  awaiting_input: "Needs you",
  idle: "Idle",
  awaiting_review: "Awaiting review",
};

/** Tone (CSS color token) for an attention kind. Failed/awaiting-input pull
 *  louder tones so the queue reads as a focused action surface. */
export const ATTENTION_TONE: Record<RunAttention["kind"], "danger" | "warn" | "accent" | "subtle"> = {
  failed: "danger",
  awaiting_input: "warn",
  idle: "subtle",
  awaiting_review: "accent",
};

// What this row actually represents on the board. Tasks are Mission Control
// todos (queued or dispatched to an external agent); convos are Klide's own
// AI panel chat sessions; runs are on-disk sessions pulled from
// ~/.claude, ~/.codex, or the opencode DB.
export type RunKind = "task" | "convo" | "run";
export type RunRoutineInfo = {
  cadence: "daily" | "weekly" | "monthly" | "routine";
  label: string;
};

export type RunValidationCheck = {
  id: string;
  label: string;
  status: string;
  required: boolean;
  evidence?: string;
};

export type RunValidationSummary = {
  status: string;
  checks: RunValidationCheck[];
  filesChanged: number;
  commandsRun: number;
  commandsFailed: number;
  diffReviews: number;
  permissionsApproved: number;
  permissionsDenied: number;
  warnings: string[];
};

export type Run = {
  id: string;
  path: string;
  source: RunSource;
  kind: RunKind;
  title: string;
  status: RunStatus;
  model: string | null;
  /** Klide runs carry their AI provider id (ollama, anthropic…); external CLIs don't. */
  provider?: string | null;
  project: string | null;
  cwd: string | null;
  branch: string | null;
  /** Linked git worktree the run executed in; null for a main checkout. */
  worktree?: string | null;
  /** Optional local lineage for Klide conversation forks. */
  forkedFrom?: {
    conversationId: string;
    title: string;
    messageIndex: number;
    createdAt: number;
    mode: "chat" | "worktree";
  } | null;
  messageCount: number;
  /** Real token usage summed from the session log; absent when the source doesn't record it. */
  inputTokens?: number;
  outputTokens?: number;
  /** Unique file paths the agent touched in tool calls. 0 when unknown. */
  filesTouched?: number;
  /**
   * Estimated run cost in USD, computed from model + tokens on the Rust
   * side via the `pricing` table. `null` for local / subscription /
   * passthrough / unknown models; `undefined` for Klide runs (the agent
   * harness doesn't yet surface this).
   */
  costUsd?: number | null;
  updatedMs: number;
  createdMs: number;
  /**
   * Sub-agents this run spawned, counted from its own transcript (Claude's
   * `Agent`/`Task` tool calls). For sources whose sub-agents are separate
   * sessions (OpenCode), those nest as child rows via `parentId` instead and
   * this stays 0. Absent/0 when the source exposes no sub-agent calls.
   */
  subagentCount?: number;
  /**
   * One-line summary of the run's most recent assistant turn ("what it last
   * did"). The title is the *first* user message, which goes stale on a long
   * run; this answers "what changed?". Absent when the source exposes no
   * assistant turn yet.
   */
  lastEvent?: string;
  /** Transcript-derived evidence snapshot: review and command validation, not proof of correctness. */
  validation?: RunValidationSummary | null;
  /** When this run was spawned by another run (e.g. @explore sub-agent). */
  parentId?: string;
};

export type RunToolCall = {
  id?: string;
  name: string;
  input?: unknown;
  summary?: string;
  result?: string;
  ok?: boolean;
  status?: "started" | "finished" | "unknown";
};

// One readable turn of a run's conversation (from `read_agent_run`).
export type RunMessage = {
  role: "user" | "assistant";
  text: string;
  tools?: RunToolCall[];
};

// Shape returned by the Rust command (serde camelCase).
type AgentRunDto = {
  id: string;
  path: string;
  source: string;
  title: string;
  provider?: string;
  model: string | null;
  cwd: string | null;
  project: string | null;
  gitBranch: string | null;
  worktree?: string | null;
  createdMs?: number;
  updatedMs: number;
  messageCount: number;
  inputTokens?: number;
  outputTokens?: number;
  filesTouched?: number;
  costUsd?: number | null;
  status: string;
  subagentCount?: number;
  lastEvent?: string;
  validation?: RunValidationSummary | null;
  parentId?: string;
};

export const STATUS_ORDER: RunStatus[] = [
  "running",
  "waiting",
  "queued",
  "done",
  "cancelled",
  "error",
];

export const STATUS_LABEL: Record<RunStatus, string> = {
  running: "Active",
  waiting: "Needs you",
  queued: "Queued",
  done: "Done",
  cancelled: "Stopped",
  error: "Failed",
};

export const BOARD_SECTION_ORDER: RunBoardSection[] = [
  "running",
  "blocked",
  "ready_for_review",
  "done",
];

export const BOARD_SECTION_LABEL: Record<RunBoardSection, string> = {
  running: "Running",
  blocked: "Needs you",
  ready_for_review: "Ready for Review",
  done: "Done",
};

export const BOARD_SECTION_HINT: Record<RunBoardSection, string> = {
  running: "Active or queued work",
  blocked: "Awaiting your answer, failed, or gone idle — needs a nudge",
  ready_for_review: "Delegated subtask output to inspect",
  done: "Finished conversations you ran",
};

export function boardSectionForRun(run: Pick<Run, "status" | "kind" | "parentId" | "updatedMs">): RunBoardSection {
  if (run.status === "error" || run.status === "waiting") return "blocked";
  if (run.status === "running") {
    const idle = Date.now() - run.updatedMs;
    return idle >= STALE_RUNNING_MS ? "blocked" : "running";
  }
  if (run.status === "queued") {
    return "running";
  }
  if (run.status === "cancelled") {
    return run.kind === "task" ? "ready_for_review" : "done";
  }
  // "Ready for Review" is for delegated work an agent produced on your behalf:
  // Mission Control todos are explicit assignments you created and may want
  // to inspect. Subagents with parentId stay nested under their parent instead
  // of becoming top-level review work.
  if (run.kind === "task") return "ready_for_review";
  return "done";
}

export function runNeedsAttention(run: Pick<Run, "status" | "kind" | "parentId" | "source" | "updatedMs">): boolean {
  return runAttentionReason(run) !== null;
}

const STALE_RUNNING_MS = 5 * 60_000;

/** What the Mission Control attention queue should surface for a run, if
 *  anything. The queue is a focused action surface, not a status mirror —
 *  `null` means "this run is fine where it is in the sectioned board". */
export function runAttentionReason(
  run: Pick<Run, "status" | "kind" | "parentId" | "source" | "updatedMs">
): RunAttention | null {
  if (run.status === "error") {
    return { kind: "failed", agentLabel: SOURCE_LABEL[run.source] };
  }
  if (run.status === "waiting") {
    return { kind: "awaiting_input" };
  }
  if (run.status === "running") {
    return null;
  }
  // Completed work stays in the board sections/history. The top Attention
  // strip is reserved for things that are actively blocked on the user or
  // failed, not "maybe worth reading later" review work.
  return null;
}

export function runBoardReason(
  run: Pick<Run, "status" | "kind" | "parentId" | "source" | "updatedMs">
): RunBoardReason {
  const attention = runAttentionReason(run);
  if (attention) {
    switch (attention.kind) {
      case "failed":
        return {
          label: "Failed",
          detail: `${attention.agentLabel} failed. Resume the run or inspect the transcript.`,
          tone: "danger",
        };
      case "awaiting_input":
        return {
          label: "Needs you",
          detail: `${SOURCE_LABEL[run.source]} is waiting for input or approval.`,
          tone: "warn",
        };
      case "idle": {
        const min = Math.floor(attention.idleMs / 60_000);
        return {
          label: "Idle",
          detail: min < 60 ? `No activity for ${min}m.` : `No activity for ${Math.floor(min / 60)}h.`,
          tone: "subtle",
        };
      }
      case "awaiting_review":
        return {
          label: "Review",
          detail: run.parentId || run.kind === "task"
            ? `${SOURCE_LABEL[run.source]} finished delegated work. Review the output before calling it done.`
            : "Finished work is ready to inspect.",
          tone: "accent",
        };
    }
  }

  switch (run.status) {
    case "running":
      return {
        label: "Active",
        detail: `${SOURCE_LABEL[run.source]} is actively working.`,
        tone: "active",
      };
    case "queued":
      return {
        label: "Queued",
        detail: "Waiting to be dispatched.",
        tone: "subtle",
      };
    case "cancelled":
      return {
        label: "Stopped",
        detail: "This run was stopped.",
        tone: "subtle",
      };
    case "done":
      return {
        label: "Done",
        detail: "Top-level work you already drove or inspected.",
        tone: "success",
      };
    case "waiting":
      return {
        label: "Needs you",
        detail: `${SOURCE_LABEL[run.source]} is waiting for input or approval.`,
        tone: "warn",
      };
    case "error":
      return {
        label: "Failed",
        detail: `${SOURCE_LABEL[run.source]} failed. Resume the run or inspect the transcript.`,
        tone: "danger",
      };
  }
}

export function runRoutineInfo(run: Pick<Run, "title">): RunRoutineInfo | null {
  const title = run.title.trim().toLowerCase();
  if (!title) return null;
  const hasReportTerm = /\b(recap|review|check[- ]?in|standup|status|digest|report)\b/.test(title);
  const explicitRoutine = /\b(routine|recurring|scheduled)\b/.test(title);
  if (/\bdaily\b/.test(title) && hasReportTerm) {
    return { cadence: "daily", label: "Daily routine" };
  }
  if (/\bweekly\b/.test(title) && hasReportTerm) {
    return { cadence: "weekly", label: "Weekly routine" };
  }
  if (/\bmonthly\b/.test(title) && hasReportTerm) {
    return { cadence: "monthly", label: "Monthly routine" };
  }
  if (explicitRoutine && hasReportTerm) {
    return { cadence: "routine", label: "Routine" };
  }
  return null;
}

// Quiet, theme-aware tones. Amber matches the AI panel's context meter; danger
// reuses the existing token; success is a restrained desaturated green.
export const STATUS_COLOR: Record<RunStatus, string> = {
  running: "var(--accent)",
  waiting: "#A15C00",
  queued: "var(--fg-subtle)",
  done: "#3E7C5A",
  cancelled: "var(--fg-subtle)",
  error: "var(--danger, #B42318)",
};

export const SOURCE_LABEL: Record<RunSource, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  omp: "Oh My Pi",
  klide: "Klide",
};

// A subtle per-source tint for the row badge — distinct but never loud.
export const SOURCE_COLOR: Record<RunSource, string> = {
  "claude-code": "#D97757",
  codex: "var(--fg-strong)",
  // Matches the opencode brand mark's neutral graphite (the logo uses
  // #211E1E on the outer square). Quieter than Claude/Codex so the paid
  // `opencode-go/*` runs don't shout on the board.
  opencode: "#3A3A3A",
  // Oh My Pi's mark is a warm violet (the ⌥ glyph); a muted version keeps it
  // distinct from the others without shouting.
  omp: "#7C6BAE",
  klide: "var(--accent)",
};

function toSource(raw: string): RunSource {
  return raw === "claude-code" ||
    raw === "codex" ||
    raw === "opencode" ||
    raw === "omp"
    ? raw
    : "klide";
}

function toStatus(raw: string): RunStatus {
  return STATUS_ORDER.includes(raw as RunStatus) ? (raw as RunStatus) : "done";
}

function fromDto(a: AgentRunDto): Run {
  return {
    id: a.id,
    path: a.path,
    source: toSource(a.source),
    kind: "run",
    title: a.title?.trim() || "Untitled session",
    status: toStatus(a.status),
    model: a.model ?? null,
    provider: a.provider ?? null,
    project: a.project ?? null,
    cwd: a.cwd ?? null,
    branch: a.gitBranch ?? null,
    worktree: a.worktree ?? null,
    messageCount: a.messageCount ?? 0,
    inputTokens: a.inputTokens ?? 0,
    outputTokens: a.outputTokens ?? 0,
    // `filesTouched` is 0 when the source doesn't record it; `costUsd` is
    // null when the model has no known price (local / subscription /
    // passthrough). Both stay absent (undefined) for Klide runs until the
    // agent harness surfaces them on `AgentRunSummary`.
    filesTouched: a.filesTouched,
    costUsd: a.costUsd,
    updatedMs: a.updatedMs ?? 0,
    createdMs: a.createdMs ?? a.updatedMs ?? 0,
    subagentCount: a.subagentCount,
    lastEvent: a.lastEvent,
    validation: a.validation ?? null,
    parentId: a.parentId,
  };
}

// Pull a page of real runs from the backend (newest first). Throws if the
// command is unavailable (e.g. running outside Tauri) — callers fall back to
// the seed. Pages are offset-based so loading more never re-parses earlier runs.
export async function fetchAgentRuns(
  limit = 10,
  offset = 0
): Promise<{ runs: Run[]; hasMore: boolean }> {
  const [external, klide] = await Promise.allSettled([
    invoke<AgentRunDto[]>("list_agent_runs", { limit, offset }),
    invoke<AgentRunDto[]>("agent_list_runs", { limit, offset }),
  ]);
  if (external.status === "rejected" && klide.status === "rejected") {
    throw external.reason;
  }
  const externalRows = external.status === "fulfilled" ? external.value : [];
  const klideRows = klide.status === "fulfilled" ? klide.value : [];
  // Both sources are paged independently by the same offset, so each run is
  // returned at most once across pages. Merge the FULL page from both — do not
  // slice to `limit`, or the trimmed overflow gets skipped by the next offset
  // and those runs vanish from the board. Callers dedupe by id on append.
  const runs = [...externalRows, ...klideRows]
    .map(fromDto)
    .sort((a, b) => b.updatedMs - a.updatedMs);
  // There's another page to pull if either source filled this one.
  const hasMore = externalRows.length === limit || klideRows.length === limit;
  return { runs, hasMore };
}

// ── Stats panel cache ──────────────────────────────────────────────────────
// fetchAgentRuns reads + JSON-parses every session log on disk (can be hundreds
// of MB across hundreds of files). Re-running that on every Stats panel open is
// the main source of the panel's lag, so cache the result for the session.
// Within STATS_CACHE_TTL_MS a reopen is instant; after that it refreshes.
const STATS_CACHE_TTL_MS = 60_000;
type RunsCacheEntry = {
  key: string;
  runs: Run[] | null; // resolved value, or null while in flight
  promise: Promise<Run[]>;
  at: number; // performance.now() when the runs resolved
};
let runsCache: RunsCacheEntry | null = null;

const runsCacheKey = (limit: number, offset: number) => `${limit}:${offset}`;

// Cached variant of fetchAgentRuns. Dedupes concurrent calls (returns the same
// in-flight promise) and reuses a resolved result within the TTL. Pass
// { force: true } to bypass the cache and re-read from disk.
export function fetchAgentRunsCached(
  limit = 10,
  offset = 0,
  opts: { force?: boolean } = {}
): Promise<Run[]> {
  const key = runsCacheKey(limit, offset);
  const fresh =
    runsCache?.key === key &&
    (runsCache.runs === null || // in flight — reuse the promise
      performance.now() - runsCache.at < STATS_CACHE_TTL_MS);
  if (!opts.force && fresh) return runsCache!.promise;

  const entry: RunsCacheEntry = {
    key,
    runs: null,
    at: performance.now(),
    promise: Promise.resolve([]),
  };
  entry.promise = fetchAgentRuns(limit, offset)
    .then(({ runs }) => {
      entry.runs = runs;
      entry.at = performance.now();
      return runs;
    })
    .catch((e) => {
      // Don't cache failures — allow a retry on the next open.
      if (runsCache === entry) runsCache = null;
      throw e;
    });
  runsCache = entry;
  return entry.promise;
}

// Synchronous peek at already-resolved cached runs (within the TTL), or null.
// Lets a component render warm data immediately without showing a loader.
export function peekAgentRunsCache(limit = 10, offset = 0): Run[] | null {
  const key = runsCacheKey(limit, offset);
  if (!runsCache || runsCache.key !== key || runsCache.runs === null) return null;
  if (performance.now() - runsCache.at >= STATS_CACHE_TTL_MS) return null;
  return runsCache.runs;
}

// Drop the cache so the next fetch re-reads from disk (e.g. after new runs).
export function invalidateAgentRunsCache() {
  runsCache = null;
}

// Read a single run's conversation (the detail pane's résumé). Throws if the
// command is unavailable; callers handle the empty/error state.
export async function fetchRunMessages(run: Run): Promise<RunMessage[]> {
  if (run.source === "klide") {
    const events = await invoke<AgentEvent[]>("agent_read_run", { runId: run.id });
    return foldedToRunMessages(foldAgentEvents(events));
  }
  if (run.source === "opencode") {
    // OpenCode stores its history in SQLite (opencode.db), so the read path
    // takes the session id instead of a file path on disk.
    return invoke<RunMessage[]>("read_opencode_run", { sessionId: run.id });
  }
  return invoke<RunMessage[]>("read_agent_run", {
    path: run.path,
    source: run.source,
  });
}

// Illustrative fallback so the board is never blank in a non-Tauri dev preview.
export function seedRuns(): Run[] {
  const now = Date.now();
  const min = 60_000;
  return [
    {
      id: "seed-klide-1",
      path: "seed://klide/1",
      source: "klide",
      kind: "run",
      title: "Tour the project and report current state",
      status: "done",
      model: "llama3.1:8b",
      project: null,
      cwd: null,
      branch: "main",
      messageCount: 6,
      updatedMs: now - 4 * min,
      createdMs: now - 30 * min,
    },
    {
      id: "ses_seed_3",
      path: "ses_seed_3",
      source: "opencode",
      kind: "run",
      title: "Explore codebase architecture",
      status: "done",
      model: "opencode-go/minimax-m3",
      project: null,
      cwd: null,
      branch: "main",
      messageCount: 8,
      updatedMs: now - 8 * min,
      createdMs: now - 30 * min,
      parentId: "seed-klide-1",
    },
    {
      id: "seed-klide-2",
      path: "seed://klide/2",
      source: "klide",
      kind: "run",
      title: "Add a dark-mode toggle to the settings panel",
      status: "running",
      model: "llama3.1:8b",
      project: null,
      cwd: null,
      branch: "main",
      messageCount: 24,
      updatedMs: now - 6_000,
      createdMs: now - 12 * min,
    },
    {
      id: "seed-claude-1",
      path: "seed://claude-code/1",
      source: "claude-code",
      kind: "run",
      title: "Implement the color scheme tokens",
      status: "done",
      model: "claude-opus-4-8",
      project: null,
      cwd: null,
      branch: "main",
      messageCount: 14,
      updatedMs: now - 2 * min,
      createdMs: now - 12 * min,
      parentId: "seed-klide-2",
    },
    {
      id: "seed-opencode-1",
      path: "seed://opencode/1",
      source: "opencode",
      kind: "run",
      title: "Find CSS variable usage across components",
      status: "done",
      model: "opencode-go/minimax-m3",
      project: null,
      cwd: null,
      branch: "main",
      messageCount: 5,
      updatedMs: now - 5 * min,
      createdMs: now - 12 * min,
      parentId: "seed-klide-2",
    },
    {
      id: "seed-2",
      path: "seed://codex/2",
      source: "codex",
      kind: "run",
      title: "Refactor the terminal panel resize handle",
      status: "done",
      model: "gpt-5.5",
      project: null,
      cwd: null,
      branch: "main",
      messageCount: 11,
      updatedMs: now - 38 * min,
      createdMs: now - 38 * min,
    },
  ];
}

export function relativeTime(ts: number): string {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/** Human-readable cost: "$0.12" for sub-dollar, "$1.23" once we cross a buck.
 *  Returns null for null/undefined/zero — the row should suppress the cost
 *  chip rather than show "$0.00" (which is misleading and noisy). */
export function formatCost(usd: number | null | undefined): string | null {
  if (usd === null || usd === undefined) return null;
  if (usd <= 0) return null;
  if (usd < 0.01) return "<$0.01";
  if (usd < 1) return `$${usd.toFixed(2)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd)}`;
}

/** Short files-touched label: "5 files" or null when zero/unknown. */
export function formatFilesTouched(n: number | null | undefined): string | null {
  if (n === null || n === undefined || n <= 0) return null;
  return `${n} ${n === 1 ? "file" : "files"}`;
}

export function formatValidationStatus(validation: RunValidationSummary | null | undefined): string | null {
  if (!validation) return null;
  if (validation.status === "passed") return "Passed";
  if (validation.status === "failed") return "Failed";
  if (validation.status === "unverified") return "Unverified";
  if (validation.status === "skipped") return "Skipped";
  return validation.status
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function formatValidationTitle(validation: RunValidationSummary | null | undefined): string | undefined {
  if (!validation) return undefined;
  const parts = [
    `${validation.filesChanged} ${validation.filesChanged === 1 ? "file" : "files"}`,
    `${validation.commandsRun} ${validation.commandsRun === 1 ? "command" : "commands"}`,
  ];
  if (validation.commandsFailed > 0) {
    parts.push(`${validation.commandsFailed} failed`);
  }
  if (validation.diffReviews > 0) {
    parts.push(`${validation.diffReviews} diff ${validation.diffReviews === 1 ? "review" : "reviews"}`);
  }
  if (validation.permissionsDenied > 0) {
    parts.push(`${validation.permissionsDenied} denied permission`);
  }
  if (validation.warnings.length > 0) {
    parts.push(validation.warnings[0]);
  }
  return parts.join(" · ");
}
