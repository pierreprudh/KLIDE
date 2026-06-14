import type { BudgetAction, BudgetLedger, BudgetPreset } from "./budgetLedger";
import { budgetReducer, createBudgetLedger } from "./budgetLedger";
import type { CapacityAction, CapacityState } from "./capacityPlanner";
import { capacityReducer, createCapacityState } from "./capacityPlanner";
import type { Mission, MissionAction, MissionInspection, MissionState } from "./missionHarness";
import { createMission, EMPTY_MISSION_STATE, inspectMission, missionReducer } from "./missionHarness";
import type { ValidationAction, ValidationState, ValidationSummary } from "./validationContracts";
import { EMPTY_VALIDATION_STATE, summarizeValidation, validationReducer } from "./validationContracts";

export type OrchestratorState = {
  missions: MissionState;
  budgets: Record<string, BudgetLedger>;
  capacity: CapacityState;
  validation: ValidationState;
};

export type OrchestratorAction =
  | { type: "mission"; action: MissionAction }
  | { type: "budget"; budgetId: string; action: BudgetAction }
  | { type: "capacity"; action: CapacityAction }
  | { type: "validation"; action: ValidationAction };

export type MissionBundle = {
  mission: Mission;
  budget: BudgetLedger;
};

export type OrchestratorMissionInspection = MissionInspection & {
  budget: BudgetLedger | null;
  validations: Record<string, ValidationSummary>;
  capacity: CapacityState;
};

export function createOrchestratorState(input?: { nowMs?: number }): OrchestratorState {
  return {
    missions: EMPTY_MISSION_STATE,
    budgets: {},
    capacity: createCapacityState({ nowMs: input?.nowMs }),
    validation: EMPTY_VALIDATION_STATE,
  };
}

export function createMissionBundle(input: {
  title: string;
  intent: string;
  mode?: "plan" | "goal";
  budgetPreset?: Exclude<BudgetPreset, "custom">;
  nowMs?: number;
}): MissionBundle {
  const mission = createMission({
    title: input.title,
    intent: input.intent,
    mode: input.mode,
    nowMs: input.nowMs,
  });
  const budget = createBudgetLedger({
    missionId: mission.id,
    preset: input.budgetPreset ?? "balanced",
    nowMs: input.nowMs,
  });
  return {
    mission: {
      ...mission,
      budgetId: budget.id,
    },
    budget,
  };
}

export function orchestratorReducer(
  state: OrchestratorState = createOrchestratorState(),
  action: OrchestratorAction
): OrchestratorState {
  if (action.type === "mission") {
    return { ...state, missions: missionReducer(state.missions, action.action) };
  }

  if (action.type === "capacity") {
    return { ...state, capacity: capacityReducer(state.capacity, action.action) };
  }

  if (action.type === "validation") {
    return { ...state, validation: validationReducer(state.validation, action.action) };
  }

  const ledger = state.budgets[action.budgetId];
  if (!ledger) return state;
  return {
    ...state,
    budgets: {
      ...state.budgets,
      [action.budgetId]: budgetReducer(ledger, action.action),
    },
  };
}

export function addMissionBundle(state: OrchestratorState, bundle: MissionBundle): OrchestratorState {
  return {
    ...state,
    missions: missionReducer(state.missions, { type: "mission_created", mission: bundle.mission }),
    budgets: {
      ...state.budgets,
      [bundle.budget.id]: bundle.budget,
    },
  };
}

export function inspectOrchestratorMission(
  state: OrchestratorState,
  missionId: string
): OrchestratorMissionInspection | null {
  const missionInspection = inspectMission(state.missions, missionId);
  if (!missionInspection) return null;
  const validations = Object.fromEntries(
    missionInspection.tasks
      .filter((task) => task.validationContractId !== null)
      .map((task) => {
        const contract = state.validation.contracts[task.validationContractId as string];
        return [task.id, summarizeValidation(contract)];
      })
  );

  return {
    ...missionInspection,
    budget: missionInspection.mission.budgetId ? state.budgets[missionInspection.mission.budgetId] ?? null : null,
    validations,
    capacity: state.capacity,
  };
}
