// Mission chaining — the pure decision behind the orchestrator's "Run mission".
//
// The console dispatches the dep-free tasks, then re-runs `chainStep` on every
// live-status change: it answers "what launches now?" and "has the mission
// drained?" without touching the harness. Keeping the graph walk pure (same
// idea as `planDispatch`) means the unlock/block/settle rules are unit-testable
// with plain objects — no React, no Rust.

export type ChainStatus = "running" | "done" | "error" | "idle";

export type ChainTask = {
  taskId: string;
  /** Ids of tasks that must finish first. Ids not present in the task list
   *  (planner hallucination / trimmed plan) count as satisfied — otherwise
   *  their dependents would wait forever. */
  dependsOn?: string[];
};

export type ChainStep = {
  /** Task ids whose dependencies are all done — launch these now. */
  launch: string[];
  /** True while at least one task is still running (mission stays open). */
  running: boolean;
  /** True when nothing is running and nothing can launch — the mission has
   *  drained (all done, or the rest are blocked behind failures). */
  settled: boolean;
};

export function chainStep(
  tasks: ChainTask[],
  statusOf: (taskId: string) => ChainStatus | undefined,
  alreadyLaunched: ReadonlySet<string>
): ChainStep {
  const inPlan = new Set(tasks.map((t) => t.taskId));
  const launch: string[] = [];
  let running = false;
  for (const t of tasks) {
    const status = statusOf(t.taskId);
    if (status === "running") running = true;
    // Anything with a status has been dispatched; `alreadyLaunched` also covers
    // tasks whose "running" status hasn't landed in state yet.
    if (status || alreadyLaunched.has(t.taskId)) continue;
    const deps = (t.dependsOn ?? []).filter((d) => inPlan.has(d));
    // A failed dependency parks the task — never run on top of a broken upstream.
    if (deps.some((d) => statusOf(d) === "error")) continue;
    if (deps.every((d) => statusOf(d) === "done")) launch.push(t.taskId);
  }
  return { launch, running, settled: !running && launch.length === 0 };
}
