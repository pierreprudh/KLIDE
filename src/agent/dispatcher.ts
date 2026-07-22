// The dispatcher seam — the one wire the orchestrator brain was missing.
//
// `routeTask` (src/agent/routingPolicy.ts) decides WHO runs a task: a model
// tier, a provider, a worker kind. But it stops at the decision — its
// `WorkerAssignment.model` is always null and nothing spawns a run. This module
// is the translator between that decision and `startAgentRun` (the live Rust
// harness): it resolves a concrete model, decides harness-vs-delegate, and
// builds the `StartAgentRunInput`.
//
// Slice 1 (this file) wires the HARNESS path — local / cheap / strong tiers all
// run through the single Rust agent loop with a model swap. The SPECIALIST tier
// (delegate CLIs: Claude Code / Codex / OpenCode / omp) is recognised and
// returned as a `delegate` plan, but spawning it lands in a later slice. Keeping
// the seam pure (planDispatch has no side effects) makes the routing decision
// unit-testable without touching the backend.

import type { WorkerAssignment } from "./routingPolicy";
import { isDelegateProvider, DEFAULT_MODELS } from "./providers";
import { startAgentRun, type AgentRunSession } from "./client";
import type { AgentEvent, AgentMode, ProviderId, StartAgentRunInput } from "./types";

/** A task ready to dispatch. The brain owns the `assignment` (tier/provider);
 *  the board owns the `prompt` — the actual instruction the model receives,
 *  which is NOT the same as a card's display title. */
export type DispatchableTask = {
  /** Stable Mission task identity. Never reused as a Harness run id. */
  taskId: string;
  /** One concrete attempt of this Task. Omit outside a durable Mission and the
   *  Rust Harness will mint a run id. Retries/races each receive a fresh id. */
  attemptRunId?: string;
  /** Durable Mission linkage for Rust-side acceptance recording. */
  missionId?: string;
  /** The instruction text sent to the model — distinct from the card title. */
  prompt: string;
  /** plan = read + propose; goal = tool-using, diff-reviewed edits. */
  mode: AgentMode;
};

export type DispatchContext = {
  workspaceRoot: string | null;
  /** Concrete model per provider — e.g. the user pinned a model to the cheap
   *  tier. Takes priority over the assignment's model and the built-in default. */
  modelOverrides?: Partial<Record<ProviderId, string>>;
  /** false = auto-accept edits (still checkpointed). Omit/true = review each. */
  requireDiffReview?: boolean;
};

/** The concrete outcome of translating an assignment. `harness` is ready to
 *  spawn; `delegate` is recognised but parked for a later slice; `unresolved`
 *  means routing couldn't be turned into a runnable plan (and why). */
export type DispatchPlan =
  | { kind: "harness"; provider: ProviderId; model: string; input: StartAgentRunInput }
  | { kind: "delegate"; provider: ProviderId; reason: string }
  | { kind: "unresolved"; reason: string };

/** Pure translation: assignment → concrete dispatch plan. No side effects, so
 *  the routing-to-run decision can be asserted in isolation. */
export function planDispatch(
  task: DispatchableTask,
  assignment: WorkerAssignment,
  ctx: DispatchContext
): DispatchPlan {
  const provider = assignment.provider;
  if (provider == null) {
    return {
      kind: "unresolved",
      reason: "Routing returned no provider — the local tier has no configured local provider.",
    };
  }

  // Specialist tier / delegate CLIs spawn a delegate PTY, not a harness run.
  // Recognise the boundary explicitly so the board can show "needs delegate"
  // instead of silently failing; the actual spawn arrives in a later slice.
  if (assignment.workerKind === "delegate" || isDelegateProvider(provider)) {
    return {
      kind: "delegate",
      provider,
      reason: `${provider} runs as a delegate CLI — delegate dispatch lands in a later slice.`,
    };
  }

  const model = resolveModel(provider, assignment, ctx);
  if (!model) {
    return { kind: "unresolved", reason: `No model resolved for provider "${provider}".` };
  }

  const input: StartAgentRunInput = {
    runId: task.attemptRunId,
    workspaceRoot: ctx.workspaceRoot,
    mode: task.mode,
    provider,
    model,
    text: task.prompt,
    attachments: [],
    requireDiffReview: ctx.requireDiffReview,
    missionId: task.missionId,
    missionTaskId: task.missionId ? task.taskId : undefined,
  };

  return { kind: "harness", provider, model, input };
}

/** Resolve the concrete model the assignment left null: explicit override →
 *  assignment.model → built-in default for the provider. Defensive index so a
 *  runtime `custom:` provider with no default returns null instead of undefined. */
export function resolveModel(
  provider: ProviderId,
  assignment: WorkerAssignment,
  ctx: DispatchContext
): string | null {
  const defaults = DEFAULT_MODELS as Partial<Record<ProviderId, string>>;
  return ctx.modelOverrides?.[provider] ?? assignment.model ?? defaults[provider] ?? null;
}

/** Wire: plan, then (only for a harness plan) spawn the live run. Returns the
 *  plan always, and the run session when one was started. The caller subscribes
 *  via `onEvent` for the honest per-card activity line (slice 2). */
export async function dispatchAssignment(
  task: DispatchableTask,
  assignment: WorkerAssignment,
  ctx: DispatchContext,
  onEvent: (event: AgentEvent) => void
): Promise<{ plan: DispatchPlan; session?: AgentRunSession }> {
  const plan = planDispatch(task, assignment, ctx);
  if (plan.kind !== "harness") return { plan };
  const session = await startAgentRun(plan.input, onEvent);
  return { plan, session };
}
