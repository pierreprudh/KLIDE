import type { ProviderId } from "./types";
import type { BudgetDecision, BudgetLedger } from "./budgetLedger";
import { canSpendBudget } from "./budgetLedger";
import type { CapacityDecision, CapacityNeed, CapacityState } from "./capacityPlanner";
import { canReserveCapacity, capacityNeedFor } from "./capacityPlanner";
import type { ValidationCheck } from "./validationContracts";
import { defaultValidationChecks } from "./validationContracts";

export type TaskRisk = "low" | "medium" | "high";
export type PrivacyPolicy = "local-only" | "api-allowed" | "redacted-api-allowed";
export type ModelTier = "local" | "cheap" | "strong" | "specialist";
export type WorkerKind = "native" | "delegate" | "local-model" | "api-model";

export type RoutingPolicy = {
  privacy: PrivacyPolicy;
  allowDelegates: boolean;
  allowWrites: boolean;
  maxParallelWorkers: number;
  askBeforeEscalation: boolean;
  defaultProviderByTier: Record<ModelTier, ProviderId | null>;
};

export type RouteTaskInput = {
  taskId: string;
  title: string;
  mode: "plan" | "goal";
  risk: TaskRisk;
  writesFiles: boolean;
  needsRepoWideContext?: boolean;
  needsStrongReasoning?: boolean;
  needsDelegateCli?: boolean;
  needsVisualReview?: boolean;
  estimatedCostUsd?: number | null;
  estimatedDurationMs?: number | null;
  retry?: boolean;
  escalation?: boolean;
};

export type WorkerAssignment = {
  taskId: string;
  workerKind: WorkerKind;
  provider: ProviderId | null;
  modelTier: ModelTier;
  model: string | null;
  reason: string;
  estimatedCostUsd: number | null;
  estimatedDurationMs: number | null;
  capacityNeed: CapacityNeed;
  validationChecks: ValidationCheck[];
};

export type RoutingDecision =
  | {
      ok: true;
      assignment: WorkerAssignment;
      budget: BudgetDecision;
      capacity: CapacityDecision;
    }
  | {
      ok: false;
      reason: string;
      budget: BudgetDecision;
      capacity?: CapacityDecision;
      suggestedAssignment?: WorkerAssignment;
    };

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  privacy: "api-allowed",
  allowDelegates: true,
  allowWrites: true,
  maxParallelWorkers: 2,
  askBeforeEscalation: true,
  defaultProviderByTier: {
    local: "ollama",
    cheap: "openai",
    strong: "anthropic",
    specialist: "codex",
  },
};

export function routeTask(input: {
  task: RouteTaskInput;
  policy?: RoutingPolicy;
  budget: BudgetLedger;
  capacity: CapacityState;
}): RoutingDecision {
  const policy = input.policy ?? DEFAULT_ROUTING_POLICY;
  const assignment = chooseAssignment(input.task, policy);
  const budget = canSpendBudget(input.budget, {
    costUsd: assignment.estimatedCostUsd,
    durationMs: assignment.estimatedDurationMs,
    retry: input.task.retry,
    escalation: input.task.escalation,
  });

  if (!budget.ok) {
    return {
      ok: false,
      reason: budget.reason,
      budget,
      suggestedAssignment: assignment,
    };
  }

  const capacity = canReserveCapacity(input.capacity, assignment.capacityNeed);
  if (!capacity.ok) {
    return {
      ok: false,
      reason: capacity.reason,
      budget,
      capacity,
      suggestedAssignment: assignment,
    };
  }

  return {
    ok: true,
    assignment,
    budget,
    capacity,
  };
}

export function chooseAssignment(task: RouteTaskInput, policy: RoutingPolicy = DEFAULT_ROUTING_POLICY): WorkerAssignment {
  const modelTier = chooseModelTier(task, policy);
  const workerKind = chooseWorkerKind(task, policy, modelTier);
  const provider = policy.defaultProviderByTier[modelTier];
  const capacityNeed = capacityNeedFor({
    workerKind,
    writesFiles: task.writesFiles,
    orchestrator: task.mode === "plan" && task.needsStrongReasoning === true,
    readOnlyInspector: task.mode === "plan" && !task.writesFiles,
  });

  return {
    taskId: task.taskId,
    workerKind,
    provider,
    modelTier,
    model: null,
    reason: explainAssignment(task, workerKind, modelTier, policy),
    estimatedCostUsd: task.estimatedCostUsd ?? estimateCostForTier(modelTier, task),
    estimatedDurationMs: task.estimatedDurationMs ?? estimateDurationForTask(task),
    capacityNeed,
    validationChecks: defaultValidationChecks({
      taskId: task.taskId,
      risk: task.risk,
      writesFiles: task.writesFiles,
      needsVisualReview: task.needsVisualReview,
    }),
  };
}

export function chooseModelTier(task: RouteTaskInput, policy: RoutingPolicy = DEFAULT_ROUTING_POLICY): ModelTier {
  if (policy.privacy === "local-only") return "local";
  if (task.needsDelegateCli && policy.allowDelegates) return "specialist";
  if (task.risk === "high" || task.needsStrongReasoning || task.needsRepoWideContext) return "strong";
  if (task.risk === "medium" || task.writesFiles) return "cheap";
  return "local";
}

export function chooseWorkerKind(task: RouteTaskInput, policy: RoutingPolicy, tier: ModelTier): WorkerKind {
  if (tier === "local") return "local-model";
  if (tier === "specialist" && policy.allowDelegates) return "delegate";
  if (task.writesFiles && !policy.allowWrites) return "api-model";
  if (task.mode === "goal" && task.writesFiles) return "native";
  return "api-model";
}

function explainAssignment(task: RouteTaskInput, workerKind: WorkerKind, tier: ModelTier, policy: RoutingPolicy): string {
  if (policy.privacy === "local-only") return "Privacy policy requires a local worker.";
  if (task.needsDelegateCli && workerKind === "delegate") return "Task needs a delegate CLI with strong tool handling.";
  if (task.risk === "high") return "High-risk task gets a stronger model tier and stricter validation.";
  if (task.needsRepoWideContext) return "Repo-wide context pushes this task to a stronger model tier.";
  if (task.writesFiles && workerKind === "native") return "Goal-mode write task stays in the Klide native harness.";
  return `Task fits the ${tier} tier.`;
}

function estimateCostForTier(tier: ModelTier, task: RouteTaskInput): number | null {
  if (tier === "local") return 0;
  const base = tier === "cheap" ? 0.15 : tier === "strong" ? 0.75 : 0.5;
  const riskMultiplier = task.risk === "high" ? 2 : task.risk === "medium" ? 1.25 : 1;
  const writeMultiplier = task.writesFiles ? 1.25 : 1;
  return roundCurrency(base * riskMultiplier * writeMultiplier);
}

function estimateDurationForTask(task: RouteTaskInput): number {
  const base = task.mode === "plan" ? 5 * 60_000 : 12 * 60_000;
  const riskMultiplier = task.risk === "high" ? 2 : task.risk === "medium" ? 1.4 : 1;
  const contextMultiplier = task.needsRepoWideContext ? 1.5 : 1;
  return Math.round(base * riskMultiplier * contextMultiplier);
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}
