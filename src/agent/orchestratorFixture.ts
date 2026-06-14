import { createBudgetEntry, budgetReducer } from "./budgetLedger";
import { capacityReducer } from "./capacityPlanner";
import { createMissionTask, missionReducer } from "./missionHarness";
import { addMissionBundle, createMissionBundle, createOrchestratorState } from "./orchestrator";
import type { OrchestratorState } from "./orchestrator";
import { routeTask } from "./routingPolicy";
import { createValidationContract, validationReducer } from "./validationContracts";

export function createOrchestratorPreviewState(nowMs = Date.now()): OrchestratorState {
  const bundle = createMissionBundle({
    title: "Build a budget-aware agent fleet",
    intent: "Plan and dispatch an orchestrated implementation with budget, capacity, routing, and validation gates.",
    mode: "goal",
    budgetPreset: "balanced",
    nowMs,
  });

  let state = addMissionBundle(createOrchestratorState({ nowMs }), bundle);

  const tasks = [
    createMissionTask({
      missionId: bundle.mission.id,
      title: "Draft task graph and acceptance criteria",
      acceptanceCriteria: ["Tasks have dependencies", "Each task has validation criteria"],
      risk: "medium",
      nowMs,
    }),
    createMissionTask({
      missionId: bundle.mission.id,
      title: "Implement routing policy",
      acceptanceCriteria: ["Routes by risk and privacy", "Checks budget and capacity before dispatch"],
      risk: "high",
      nowMs,
    }),
    createMissionTask({
      missionId: bundle.mission.id,
      title: "Run validation pass",
      acceptanceCriteria: ["Build passes", "Diff scope is reviewed", "Final result is approved"],
      risk: "medium",
      dependencies: [],
      nowMs,
    }),
  ];

  for (const task of tasks) {
    state = {
      ...state,
      missions: missionReducer(state.missions, { type: "task_added", task }),
    };
  }

  for (const [index, task] of tasks.entries()) {
    const decision = routeTask({
      task: {
        taskId: task.id,
        title: task.title,
        mode: bundle.mission.mode,
        risk: task.risk,
        writesFiles: index !== 0,
        needsRepoWideContext: index === 1,
        needsStrongReasoning: task.risk === "high",
        needsVisualReview: false,
      },
      budget: state.budgets[bundle.budget.id],
      capacity: state.capacity,
    });

    if (!decision.ok) continue;

    const contract = createValidationContract({
      id: `validation:${task.id}`,
      taskId: task.id,
      checks: decision.assignment.validationChecks,
      createdMs: nowMs,
      updatedMs: nowMs,
    });
    state = {
      ...state,
      missions: missionReducer(state.missions, {
        type: "task_assigned",
        taskId: task.id,
        assignment: decision.assignment,
        validationContractId: contract.id,
        ts: nowMs,
      }),
      validation: validationReducer(state.validation, { type: "contract_created", contract }),
      capacity: capacityReducer(state.capacity, {
        type: index === 1 ? "capacity_reserved" : "capacity_queued",
        kinds: decision.assignment.capacityNeed.kinds,
        ts: nowMs,
      }),
    };
  }

  const budget = state.budgets[bundle.budget.id];
  state = {
    ...state,
    budgets: {
      ...state.budgets,
      [budget.id]: budgetReducer(budget, {
        type: "entry_recorded",
        entry: createBudgetEntry({
          label: "Plan and router estimate",
          kind: "estimate",
          costUsd: 1.85,
          durationMs: 24 * 60_000,
          ts: nowMs,
        }),
      }),
    },
  };

  return state;
}
