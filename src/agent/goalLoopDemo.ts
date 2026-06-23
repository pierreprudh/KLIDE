// A worked example of the Goal loop driven by the run-projection seam, for the
// Orchestrator preview. It uses the REAL `goalLoop` reducers and the REAL
// `runProjection` seam — only the two run snapshots are sample data (a live run
// would supply its own `AgentRunSummary.validation`). It demonstrates the
// gutter loop: a first run fails the definition-of-done gate (revise), a second
// run clears delivery + every validation gate (gates clean).

import {
  createGoalLoopSpec,
  createGoalLoopState,
  recordGoalLoopGateAttempt,
  type GoalLoopGateAttempt,
  type GoalLoopNextAction,
  type GoalLoopSpec,
  type GoalLoopState,
} from "./goalLoop";
import { advanceGoalLoopWithRunSummary } from "./runProjection";
import { createValidationCheck } from "./validationContracts";
import type { RunValidationSummary } from "../runs";

export type GoalLoopDemoSnapshot = { label: string; summary: RunValidationSummary };

export type GoalLoopDemo = {
  spec: GoalLoopSpec;
  state: GoalLoopState;
  next: GoalLoopNextAction;
  snapshots: GoalLoopDemoSnapshot[];
};

export function buildGoalLoopDemo(input: {
  goal: string;
  definitionOfDone: string[];
  hostModel?: string | null;
  reviewerModel?: string | null;
  nowMs?: number;
}): GoalLoopDemo {
  const ts = input.nowMs ?? 1_700_000_000_000;

  const spec = createGoalLoopSpec({
    goal: input.goal,
    definitionOfDone: input.definitionOfDone.length
      ? input.definitionOfDone
      : ["The requested change is implemented.", "Typecheck passes after the change."],
    hostModel: input.hostModel ?? "codex / gpt-5",
    reviewerModel: input.reviewerModel ?? "claude (reviewer)",
    validationChecks: [
      createValidationCheck({
        id: "typecheck",
        kind: "typecheck",
        label: "Typecheck passes",
        required: true,
        command: "npm run build",
        updatedMs: ts,
      }),
      createValidationCheck({
        id: "diff-scope",
        kind: "diff-scope",
        label: "Changed files match task scope",
        required: true,
        reviewer: "klide",
        updatedMs: ts,
      }),
    ],
    nowMs: ts,
  });

  // The plan gate is a reviewer step that precedes the run — mark it approved
  // so the run projection can drive the delivery + validation gates.
  const planGate = spec.gates.find((g) => g.kind === "plan");
  let state = createGoalLoopState(spec, ts);
  if (planGate) {
    const planPass: GoalLoopGateAttempt = {
      id: "attempt:plan",
      gateId: planGate.id,
      verdict: "pass",
      criteriaPassed: planGate.criteria,
      criteriaFailed: [],
      feedback: null,
      evidence: "Reviewer approved the plan.",
      progress: "unknown",
      ts,
    };
    state = recordGoalLoopGateAttempt(spec, state, planPass);
  }

  const failSummary = sampleSummary({
    status: "failed",
    typecheck: "failed",
    typecheckEvidence: "tsc: 2 errors after the edit",
    commandsFailed: 1,
    warnings: ["1 validation command failed"],
  });
  const passSummary = sampleSummary({ status: "passed", typecheck: "passed", commandsFailed: 0, warnings: [] });

  const run1 = advanceGoalLoopWithRunSummary(spec, state, failSummary, { ts: ts + 1 });
  const run2 = advanceGoalLoopWithRunSummary(spec, run1.state, passSummary, {
    ts: ts + 2,
    previousSummary: failSummary,
  });

  return {
    spec,
    state: run2.state,
    next: run2.next,
    snapshots: [
      { label: "Run 1 (host model)", summary: failSummary },
      { label: "Run 2 (after revise)", summary: passSummary },
    ],
  };
}

function sampleSummary(input: {
  status: string;
  typecheck: string;
  typecheckEvidence?: string;
  commandsFailed: number;
  warnings: string[];
}): RunValidationSummary {
  return {
    status: input.status,
    checks: [
      {
        id: "typecheck",
        label: "Typecheck passes",
        status: input.typecheck,
        required: true,
        evidence: input.typecheckEvidence,
      },
      { id: "diff-scope", label: "Changed files match task scope", status: "passed", required: true },
    ],
    filesChanged: 2,
    commandsRun: 1,
    commandsFailed: input.commandsFailed,
    diffReviews: 2,
    permissionsApproved: 1,
    permissionsDenied: 0,
    warnings: input.warnings,
  };
}
