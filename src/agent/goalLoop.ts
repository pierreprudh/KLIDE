import type { BudgetEnvelope } from "./budgetLedger";
import type { Mission, MissionTask } from "./missionHarness";
import type { ValidationCheck, ValidationCheckStatus } from "./validationContracts";

export type GoalLoopGateKind =
  | "plan"
  | "delivery"
  | "diff-scope"
  | "command-validation"
  | "semantic-review"
  | "budget"
  | "human";

export type GoalLoopGateOwner = "host" | "reviewer" | "klide" | "user";

export type GoalLoopGate = {
  id: string;
  kind: GoalLoopGateKind;
  label: string;
  criteria: string[];
  required: boolean;
  owner: GoalLoopGateOwner;
  maxRevisions: number;
};

export type GoalLoopLimits = {
  /** Hard ceiling on total gate attempts (pass or fail) across the whole loop. */
  maxIterations: number;
  /** Per-gate cap on failed attempts before that gate is exhausted. */
  maxRevisionsPerGate: number;
  /** Consecutive no-progress (same/regressed) failures before the loop stalls. */
  maxStalls: number;
  maxDurationMs: number | null;
  maxCostUsd: number | null;
};

export type GoalLoopSpec = {
  id: string;
  missionId: string | null;
  goal: string;
  contextSources: string[];
  definitionOfDone: string[];
  hostModel: string | null;
  reviewerModel: string | null;
  gates: GoalLoopGate[];
  limits: GoalLoopLimits;
  createdMs: number;
};

export type GoalLoopStatus =
  | "designing"
  | "running"
  | "awaiting-review"
  | "revising"
  | "passed"
  | "failed"
  | "stalled"
  | "budget-exhausted";

export type GoalLoopStopReason =
  | "gates-clean"
  | "gate-revisions-exhausted"
  | "iteration-limit"
  | "stalled"
  | "budget-exhausted";

export type GoalLoopProgress = "improved" | "same" | "regressed" | "unknown";
export type GoalLoopGateVerdict = "pass" | "fail" | "waive";

export type GoalLoopGateAttempt = {
  id: string;
  gateId: string;
  verdict: GoalLoopGateVerdict;
  criteriaPassed: string[];
  criteriaFailed: string[];
  feedback: string | null;
  evidence: string | null;
  progress: GoalLoopProgress;
  ts: number;
};

export type GoalLoopState = {
  specId: string;
  status: GoalLoopStatus;
  iteration: number;
  currentGateId: string | null;
  attempts: GoalLoopGateAttempt[];
  revisionsByGate: Record<string, number>;
  stallCount: number;
  startedMs: number;
  updatedMs: number;
  stopReason: GoalLoopStopReason | null;
};

export type GoalLoopNextAction =
  | { type: "draft-plan"; gateId: string; reason: string }
  | { type: "run-delivery"; gateId: string; reason: string }
  | { type: "revise"; gateId: string; reason: string }
  | { type: "ask-human"; gateId: string; reason: string }
  | { type: "record-result"; reason: string }
  | { type: "stop"; reason: GoalLoopStopReason; detail: string };

export const DEFAULT_GOAL_LOOP_LIMITS: GoalLoopLimits = {
  maxIterations: 12,
  maxRevisionsPerGate: 3,
  maxStalls: 2,
  maxDurationMs: 30 * 60_000,
  maxCostUsd: null,
};

export function createGoalLoopSpec(input: {
  goal?: string;
  mission?: Mission;
  tasks?: MissionTask[];
  contextSources?: string[];
  definitionOfDone?: string[];
  gates?: GoalLoopGate[];
  limits?: Partial<GoalLoopLimits>;
  budgetEnvelope?: BudgetEnvelope;
  validationChecks?: ValidationCheck[];
  hostModel?: string | null;
  reviewerModel?: string | null;
  requireHumanApproval?: boolean;
  id?: string;
  nowMs?: number;
}): GoalLoopSpec {
  const limits = mergeGoalLoopLimits(input.limits, input.budgetEnvelope);
  const taskCriteria = criteriaFromTasks(input.tasks ?? []);
  const definitionOfDone = nonEmptyList(input.definitionOfDone).length
    ? nonEmptyList(input.definitionOfDone)
    : taskCriteria.length
      ? taskCriteria
      : ["The requested outcome is implemented or answered.", "Validation evidence is recorded when files change."];
  const goal =
    clean(input.goal)
    ?? clean(input.mission?.intent)
    ?? clean(input.mission?.title)
    ?? "Complete the requested work.";
  const validationGates = gatesFromValidationChecks(input.validationChecks ?? [], limits);
  return {
    id: input.id ?? makeId("loop"),
    missionId: input.mission?.id ?? null,
    goal,
    contextSources: nonEmptyList(input.contextSources),
    definitionOfDone,
    hostModel: input.hostModel ?? null,
    reviewerModel: input.reviewerModel ?? null,
    gates: input.gates ?? defaultGoalLoopGates({
      definitionOfDone,
      limits,
      validationGates,
      requireHumanApproval: input.requireHumanApproval ?? false,
    }),
    limits,
    createdMs: input.nowMs ?? Date.now(),
  };
}

export function createGoalLoopState(spec: GoalLoopSpec, nowMs = Date.now()): GoalLoopState {
  return {
    specId: spec.id,
    status: "designing",
    iteration: 0,
    currentGateId: firstOpenGate(spec, [])?.id ?? null,
    attempts: [],
    revisionsByGate: {},
    stallCount: 0,
    startedMs: nowMs,
    updatedMs: nowMs,
    stopReason: null,
  };
}

export function decideGoalLoopNextAction(
  spec: GoalLoopSpec,
  state: GoalLoopState,
  spent?: { costUsd?: number | null; durationMs?: number | null }
): GoalLoopNextAction {
  if (state.status === "passed") {
    return { type: "record-result", reason: "Every required gate has passed." };
  }
  if (state.stopReason) {
    return { type: "stop", reason: state.stopReason, detail: stopReasonDetail(state.stopReason) };
  }

  const budgetStop = budgetStopReason(spec, spent);
  if (budgetStop) return { type: "stop", reason: "budget-exhausted", detail: budgetStop };
  if (state.iteration >= spec.limits.maxIterations) {
    return {
      type: "stop",
      reason: "iteration-limit",
      detail: `Loop reached ${spec.limits.maxIterations} iterations.`,
    };
  }
  if (state.stallCount >= spec.limits.maxStalls) {
    return {
      type: "stop",
      reason: "stalled",
      detail: `Loop made no progress for ${spec.limits.maxStalls} consecutive failed gate attempt(s).`,
    };
  }

  const gate = gateById(spec, state.currentGateId) ?? firstOpenGate(spec, state.attempts);
  if (!gate) return { type: "record-result", reason: "No open gates remain." };

  const latest = latestGateAttempt(state.attempts, gate.id);
  if (latest?.verdict === "fail") {
    return { type: "revise", gateId: gate.id, reason: latest.feedback ?? "The current gate failed." };
  }

  if (gate.kind === "plan") return { type: "draft-plan", gateId: gate.id, reason: "Draft the plan before delivery work." };
  if (gate.kind === "human") return { type: "ask-human", gateId: gate.id, reason: "Human approval is required before completion." };
  return { type: "run-delivery", gateId: gate.id, reason: `Produce evidence for ${gate.label}.` };
}

export function recordGoalLoopGateAttempt(
  spec: GoalLoopSpec,
  state: GoalLoopState,
  attempt: GoalLoopGateAttempt
): GoalLoopState {
  const gate = gateById(spec, attempt.gateId);
  if (!gate) return { ...state, updatedMs: attempt.ts };

  const attempts = [...state.attempts, attempt];
  if (attempt.verdict === "fail") {
    const revisions = (state.revisionsByGate[gate.id] ?? 0) + 1;
    const revisionsByGate = { ...state.revisionsByGate, [gate.id]: revisions };
    const stallCount = attempt.progress === "same" || attempt.progress === "regressed"
      ? state.stallCount + 1
      : 0;
    const exhausted = revisions > Math.min(gate.maxRevisions, spec.limits.maxRevisionsPerGate);
    const stalled = stallCount >= spec.limits.maxStalls;
    return {
      ...state,
      status: exhausted ? "failed" : stalled ? "stalled" : "revising",
      iteration: state.iteration + 1,
      currentGateId: gate.id,
      attempts,
      revisionsByGate,
      stallCount,
      updatedMs: attempt.ts,
      stopReason: exhausted ? "gate-revisions-exhausted" : stalled ? "stalled" : null,
    };
  }

  // A pass (or waive) is still one iteration through the loop — count it so
  // `maxIterations` caps total work cycles, not only failed ones.
  const nextGate = firstOpenGate(spec, attempts);
  return {
    ...state,
    status: nextGate ? statusForGate(nextGate) : "passed",
    iteration: state.iteration + 1,
    currentGateId: nextGate?.id ?? null,
    attempts,
    stallCount: 0,
    updatedMs: attempt.ts,
    stopReason: nextGate ? null : "gates-clean",
  };
}

export function latestGateAttempt(
  attempts: GoalLoopGateAttempt[],
  gateId: string
): GoalLoopGateAttempt | null {
  for (let i = attempts.length - 1; i >= 0; i -= 1) {
    if (attempts[i].gateId === gateId) return attempts[i];
  }
  return null;
}

export function gatesFromValidationChecks(
  checks: ValidationCheck[],
  limits: GoalLoopLimits = DEFAULT_GOAL_LOOP_LIMITS
): GoalLoopGate[] {
  return checks.map((check) => ({
    id: `validation:${check.id}`,
    kind: gateKindForValidation(check),
    label: check.label,
    criteria: [
      check.command ? `Command succeeds: ${check.command}` : `${check.label} is satisfied.`,
    ],
    required: check.required,
    owner: check.reviewer === "user" ? "user" : check.reviewer === "orchestrator" ? "reviewer" : "klide",
    maxRevisions: limits.maxRevisionsPerGate,
  }));
}

export function gateAttemptFromValidationCheck(
  check: ValidationCheck,
  ts = check.updatedMs
): GoalLoopGateAttempt | null {
  const verdict = verdictForValidationStatus(check.status);
  if (!verdict) return null;
  return {
    id: makeId("attempt"),
    gateId: `validation:${check.id}`,
    verdict,
    criteriaPassed: verdict === "pass" ? [check.label] : [],
    criteriaFailed: verdict === "fail" ? [check.label] : [],
    feedback: check.message ?? null,
    evidence: check.command ?? null,
    progress: "unknown",
    ts,
  };
}

function defaultGoalLoopGates(input: {
  definitionOfDone: string[];
  limits: GoalLoopLimits;
  validationGates: GoalLoopGate[];
  requireHumanApproval: boolean;
}): GoalLoopGate[] {
  const gates: GoalLoopGate[] = [
    {
      id: "gate:plan",
      kind: "plan",
      label: "Plan covers the goal",
      criteria: [
        "Goal is specific and falsifiable.",
        "Plan names the files, commands, or artifacts it expects to touch.",
        "Plan includes validation evidence for any write.",
      ],
      required: true,
      owner: "reviewer",
      maxRevisions: input.limits.maxRevisionsPerGate,
    },
    {
      id: "gate:delivery",
      kind: "delivery",
      label: "Delivery covers the definition of done",
      criteria: input.definitionOfDone,
      required: true,
      owner: "reviewer",
      maxRevisions: input.limits.maxRevisionsPerGate,
    },
  ];

  gates.push(...input.validationGates);
  // No default budget *gate*: budget is a continuous limit, enforced by
  // `budgetStopReason` (the short-circuit at the top of
  // `decideGoalLoopNextAction`), which produces a `budget-exhausted` stop. A
  // closing budget gate would have no attempt producer here and could only
  // deadlock. (An explicit budget ValidationCheck still maps to a gate that
  // closes via `gateAttemptFromValidationCheck` when its status resolves.)

  if (input.requireHumanApproval) {
    gates.push({
      id: "gate:human",
      kind: "human",
      label: "User approves final result",
      criteria: ["The user accepts the final result or explicitly waives this gate."],
      required: true,
      owner: "user",
      maxRevisions: input.limits.maxRevisionsPerGate,
    });
  }

  return gates;
}

function mergeGoalLoopLimits(
  limits: Partial<GoalLoopLimits> | undefined,
  budgetEnvelope: BudgetEnvelope | undefined
): GoalLoopLimits {
  return {
    ...DEFAULT_GOAL_LOOP_LIMITS,
    maxDurationMs: budgetEnvelope?.maxDurationMs ?? DEFAULT_GOAL_LOOP_LIMITS.maxDurationMs,
    maxCostUsd: budgetEnvelope?.maxCostUsd ?? DEFAULT_GOAL_LOOP_LIMITS.maxCostUsd,
    maxRevisionsPerGate: budgetEnvelope?.maxRetries ?? DEFAULT_GOAL_LOOP_LIMITS.maxRevisionsPerGate,
    ...limits,
  };
}

function firstOpenGate(spec: GoalLoopSpec, attempts: GoalLoopGateAttempt[]): GoalLoopGate | null {
  return spec.gates.find((gate) => !gateIsClosed(gate, attempts)) ?? null;
}

function gateIsClosed(gate: GoalLoopGate, attempts: GoalLoopGateAttempt[]): boolean {
  const latest = latestGateAttempt(attempts, gate.id);
  if (!latest) return false;
  if (latest.verdict === "pass") return true;
  return !gate.required && latest.verdict === "waive";
}

function gateById(spec: GoalLoopSpec, gateId: string | null): GoalLoopGate | null {
  if (!gateId) return null;
  return spec.gates.find((gate) => gate.id === gateId) ?? null;
}

function statusForGate(gate: GoalLoopGate): GoalLoopStatus {
  if (gate.kind === "human" || gate.kind === "semantic-review") return "awaiting-review";
  return "running";
}

function budgetStopReason(
  spec: GoalLoopSpec,
  spent: { costUsd?: number | null; durationMs?: number | null } | undefined
): string | null {
  const costUsd = spent?.costUsd ?? 0;
  const durationMs = spent?.durationMs ?? 0;
  if (spec.limits.maxCostUsd !== null && costUsd > spec.limits.maxCostUsd) {
    return `Loop spent $${costUsd.toFixed(2)}, above the $${spec.limits.maxCostUsd.toFixed(2)} limit.`;
  }
  if (spec.limits.maxDurationMs !== null && durationMs > spec.limits.maxDurationMs) {
    return `Loop ran for ${Math.round(durationMs / 60_000)}m, above the ${Math.round(spec.limits.maxDurationMs / 60_000)}m limit.`;
  }
  return null;
}

function gateKindForValidation(check: ValidationCheck): GoalLoopGateKind {
  if (check.kind === "typecheck" || check.kind === "test" || check.kind === "lint" || check.kind === "format") {
    return "command-validation";
  }
  if (check.kind === "diff-scope" || check.kind === "visual") return "diff-scope";
  if (check.kind === "semantic-review") return "semantic-review";
  if (check.kind === "human") return "human";
  if (check.kind === "budget") return "budget";
  return "delivery";
}

function verdictForValidationStatus(status: ValidationCheckStatus): GoalLoopGateVerdict | null {
  if (status === "passed") return "pass";
  if (status === "failed") return "fail";
  if (status === "waived" || status === "skipped") return "waive";
  return null;
}

function criteriaFromTasks(tasks: MissionTask[]): string[] {
  return nonEmptyList(tasks.flatMap((task) => task.acceptanceCriteria));
}

function nonEmptyList(values: readonly (string | null | undefined)[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function stopReasonDetail(reason: GoalLoopStopReason): string {
  if (reason === "gates-clean") return "Every required loop gate passed.";
  if (reason === "gate-revisions-exhausted") return "A gate failed too many times.";
  if (reason === "iteration-limit") return "The loop reached its iteration limit.";
  if (reason === "stalled") return "The loop stopped after repeated no-progress revisions.";
  return "The loop exceeded an approved budget limit.";
}

function makeId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `${prefix}:${crypto.randomUUID()}`;
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}
