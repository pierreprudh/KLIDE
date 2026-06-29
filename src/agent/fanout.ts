// Goal fan-out engine — the backend half of "auto fan-out on goal" (#4).
//
// Pipeline: decompose a goal into tasks (planner.ts) → group tasks into
// dependency *waves* → run each wave's tasks in parallel as typed subagent
// child runs → fold each child's observed events into a RunValidationSummary
// so the goal loop / projection seam (runProjection.ts) can gate on real
// evidence.
//
// Decoupled on purpose so it stays UI-agnostic and testable-by-inspection:
//   - the dispatcher is injected (`dispatch`, defaults to startAgentRun),
//   - the system-prompt builder is injected (`buildPrompt`), so the engine
//     doesn't depend on AiPanel's skills / project-rules wiring.
//
// The pure parts — `roleForTask` and `planWaves` — hold no run state and are
// the natural seams a UI (or a future test) exercises directly.

import { planGoal, stubPlan, type PlannedTask } from "./planner";
import {
  resolveSubagent,
  buildSubagentSystemPrompt,
  type Subagent,
  type SubagentId,
} from "./subagents";
import { startAgentRun } from "./client";
import type { AgentEvent, ProviderId } from "./types";
import type { RunValidationSummary } from "../runs";

// ── Role mapping (pure) ──────────────────────────────────────────────────────
/** Map a planned task to the subagent role that should run it. Read-only
 *  (`plan`) tasks go to the explorer, unless the title reads like a critique →
 *  reviewer. Editing (`goal`) tasks go to the implementer, or the tester in the
 *  Verify phase. */
export function roleForTask(task: PlannedTask): SubagentId {
  if (task.mode === "plan") {
    return /\b(review|audit|critique|inspect|check)\b/i.test(task.title) ? "reviewer" : "explorer";
  }
  return task.phase === "Verify" ? "tester" : "implementer";
}

export type FanOutTask = PlannedTask & { role: SubagentId };

// ── Wave planning (pure) ─────────────────────────────────────────────────────
/** Group tasks into ordered waves: every task in a wave has all its `dependsOn`
 *  satisfied by an earlier wave, so a wave's tasks can run in parallel. Dangling
 *  deps (ids not in the list) are ignored. A dependency cycle can't stall the
 *  whole run — if no task is ready, the remaining tasks form one final wave. */
export function planWaves(tasks: PlannedTask[]): FanOutTask[][] {
  const known = new Set(tasks.map((t) => t.taskId));
  const done = new Set<string>();
  const waves: FanOutTask[][] = [];
  let remaining = tasks.slice();

  while (remaining.length) {
    const ready = remaining.filter((t) =>
      (t.dependsOn ?? []).every((d) => done.has(d) || !known.has(d))
    );
    // Cycle / unsatisfiable deps: break the deadlock by running the rest.
    const wave = ready.length ? ready : remaining;
    waves.push(wave.map((t) => ({ ...t, role: roleForTask(t) })));
    const ids = new Set(wave.map((t) => t.taskId));
    wave.forEach((t) => done.add(t.taskId));
    remaining = remaining.filter((t) => !ids.has(t.taskId));
  }
  return waves;
}

// ── Event → validation summary (pure over an observed event stream) ──────────
/** Fold the events the engine observed for one child run into the same
 *  RunValidationSummary shape the Rust harness derives from a transcript — the
 *  fields runProjection.ts reads. Built from observed events so the engine
 *  needs no second disk read. */
export function summarizeRunEvents(events: AgentEvent[]): RunValidationSummary {
  const toolName = new Map<string, string>();
  const changedFiles = new Set<string>();
  let commandsRun = 0;
  let commandsFailed = 0;
  let diffReviews = 0;
  let permissionsApproved = 0;
  let permissionsDenied = 0;
  let errored = false;
  const warnings: string[] = [];

  for (const ev of events) {
    switch (ev.type) {
      case "tool_call_started":
        toolName.set(ev.toolCallId, ev.name);
        break;
      case "tool_call_finished":
        if (toolName.get(ev.toolCallId) === "run_command") {
          commandsRun += 1;
          if (!ev.result.ok) commandsFailed += 1;
        }
        break;
      case "file_changed":
        changedFiles.add(ev.path);
        break;
      case "diff_resolved":
        diffReviews += 1;
        break;
      case "permission_resolved":
        // decision shape varies by adapter; treat any non-"deny" as approval.
        if (JSON.stringify(ev.decision).toLowerCase().includes("den")) permissionsDenied += 1;
        else permissionsApproved += 1;
        break;
      case "run_error":
        errored = true;
        warnings.push(ev.error.message);
        break;
      default:
        break;
    }
  }

  const filesChanged = changedFiles.size;
  const status = errored || commandsFailed > 0
    ? "failed"
    : commandsRun > 0 || filesChanged > 0
      ? "passed"
      : "unverified";

  return {
    status,
    checks: [],
    filesChanged,
    commandsRun,
    commandsFailed,
    diffReviews,
    permissionsApproved,
    permissionsDenied,
    warnings,
  };
}

/** Combine per-task summaries into one fan-out-wide RunValidationSummary, so a
 *  caller can feed the whole fan-out to `advanceGoalLoopWithRunSummary`
 *  (runProjection.ts) and gate on it. Failed wins the overall status; counts
 *  and warnings sum across tasks. */
export function aggregateSummaries(results: { summary: RunValidationSummary }[]): RunValidationSummary {
  const acc: RunValidationSummary = {
    status: "unverified",
    checks: [],
    filesChanged: 0,
    commandsRun: 0,
    commandsFailed: 0,
    diffReviews: 0,
    permissionsApproved: 0,
    permissionsDenied: 0,
    warnings: [],
  };
  let anyPassed = false;
  for (const { summary } of results) {
    acc.filesChanged += summary.filesChanged;
    acc.commandsRun += summary.commandsRun;
    acc.commandsFailed += summary.commandsFailed;
    acc.diffReviews += summary.diffReviews;
    acc.permissionsApproved += summary.permissionsApproved;
    acc.permissionsDenied += summary.permissionsDenied;
    acc.checks.push(...summary.checks);
    acc.warnings.push(...summary.warnings);
    if (summary.status === "failed") acc.status = "failed";
    if (summary.status === "passed") anyPassed = true;
  }
  if (acc.status !== "failed") acc.status = anyPassed ? "passed" : "unverified";
  return acc;
}

// ── Orchestration ────────────────────────────────────────────────────────────
export type FanOutTaskStatus = "done" | "failed" | "cancelled";

export type FanOutTaskResult = {
  task: FanOutTask;
  runId: string;
  summary: RunValidationSummary;
  /** The subagent's final assistant text — its report. */
  report: string;
  status: FanOutTaskStatus;
};

export type FanOutHooks = {
  /** The decomposed plan, grouped into waves (before any run starts). */
  onPlan?: (waves: FanOutTask[][]) => void;
  onTaskStart?: (task: FanOutTask, runId: string) => void;
  /** Every child event — the UI routes diff_proposed / permission here. */
  onTaskEvent?: (task: FanOutTask, event: AgentEvent) => void;
  onTaskDone?: (result: FanOutTaskResult) => void;
};

export type FanOutOptions = {
  workspaceRoot: string | null;
  provider: ProviderId;
  model: string;
  /** The parent run's id — every child is dispatched with this as `parentId`
   *  so Mission Control nests the fan-out under it. */
  parentRunId: string;
  /** false (default) = autonomous, auto-accepted (still checkpointed) edits —
   *  there is no review UI in the engine. The UI slice flips this to true and
   *  routes diffs through `onTaskEvent`. */
  requireDiffReview?: boolean;
  /** Build a child's system prompt. Injected so the engine stays decoupled from
   *  AiPanel's skills / project-rules; defaults to the role prompt + workspace. */
  buildPrompt?: (def: Subagent, task: FanOutTask) => string;
  /** Injected dispatcher (defaults to the live harness) for testability. */
  dispatch?: typeof startAgentRun;
};

function defaultPrompt(def: Subagent, _task: FanOutTask, workspaceRoot: string | null): string {
  const base = `You are Klide's coding agent, embedded in a code editor.${
    workspaceRoot ? ` Workspace root: ${workspaceRoot}.` : ""
  } Paths are workspace-relative (use "." for the root).`;
  return buildSubagentSystemPrompt(def, base);
}

async function runTask(
  task: FanOutTask,
  opts: FanOutOptions,
  hooks: FanOutHooks
): Promise<FanOutTaskResult> {
  const dispatch = opts.dispatch ?? startAgentRun;
  const def = resolveSubagent(task.role);
  const runId = `${opts.parentRunId}-${task.taskId}`;
  const events: AgentEvent[] = [];
  let report = "";
  let status: FanOutTaskStatus = "done";

  if (!def) {
    const summary = summarizeRunEvents(events);
    const result: FanOutTaskResult = { task, runId, summary, report: `Unknown subagent role "${task.role}".`, status: "failed" };
    hooks.onTaskDone?.(result);
    return result;
  }

  hooks.onTaskStart?.(task, runId);
  const systemPrompt = (opts.buildPrompt ?? ((d, t) => defaultPrompt(d, t, opts.workspaceRoot)))(def, task);

  try {
    const session = await dispatch(
      {
        runId,
        workspaceRoot: opts.workspaceRoot,
        mode: def.mode,
        provider: opts.provider,
        model: def.model ?? opts.model,
        text: task.description ? `${task.title}\n\n${task.description}` : task.title,
        attachments: [],
        systemPrompt,
        parentId: opts.parentRunId,
        requireDiffReview: opts.requireDiffReview ?? false,
      },
      (ev) => {
        events.push(ev);
        if (ev.type === "assistant_message") {
          const text = ev.content.filter((b) => b.type === "text").map((b) => b.text).join("");
          if (text.trim()) report = text;
        }
        if (ev.type === "run_error") status = "failed";
        hooks.onTaskEvent?.(task, ev);
      }
    );
    await session.done;
  } catch (e) {
    status = "failed";
    report = `Task run failed: ${(e as Error).message}`;
  }

  const summary = summarizeRunEvents(events);
  const finalStatus: FanOutTaskStatus =
    status === "failed" || summary.status === "failed" ? "failed" : status;
  const result: FanOutTaskResult = { task, runId, summary, report, status: finalStatus };
  hooks.onTaskDone?.(result);
  return result;
}

/** Decompose a goal and run it as parallel subagent waves. Returns every task
 *  result. Stops launching further waves once a wave contains a failed task —
 *  later waves depend on it, so racing ahead would waste runs. Decomposition
 *  falls back to `stubPlan` when the planner model is unreachable. */
export async function runFanOut(
  goal: string,
  opts: FanOutOptions,
  hooks: FanOutHooks = {}
): Promise<FanOutTaskResult[]> {
  let tasks: PlannedTask[];
  try {
    tasks = await planGoal(goal, { provider: opts.provider, model: opts.model });
  } catch {
    tasks = stubPlan(goal);
  }

  const waves = planWaves(tasks);
  hooks.onPlan?.(waves);

  const results: FanOutTaskResult[] = [];
  for (const wave of waves) {
    const waveResults = await Promise.all(wave.map((task) => runTask(task, opts, hooks)));
    results.push(...waveResults);
    if (waveResults.some((r) => r.status === "failed")) break;
  }
  return results;
}
