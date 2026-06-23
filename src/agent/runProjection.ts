// The projection seam: a real Run's Harness-derived evidence -> Goal loop gate
// attempts.
//
// The Harness (Rust) already folds a Run's transcript into an
// `AgentRunSummary.validation` snapshot (`RunValidationSummary` on the TS
// side) — files changed, commands run/failed, diff reviews, per-check
// statuses. Mission Control already consumes it. This module is the missing
// link that lets a Goal loop *decide* gates from that same snapshot instead of
// from a fixture.
//
// It is deliberately a PURE function over the canonical snapshot — it holds no
// run state of its own. The Harness stays the single source of truth about
// what a run did; the Goal loop only judges whether the evidence clears a gate.

import type {
  GoalLoopGate,
  GoalLoopGateAttempt,
  GoalLoopGateVerdict,
  GoalLoopNextAction,
  GoalLoopProgress,
  GoalLoopSpec,
  GoalLoopState,
} from "./goalLoop";
import { decideGoalLoopNextAction, recordGoalLoopGateAttempt } from "./goalLoop";
import type { RunValidationSummary } from "../runs";

const VALIDATION_GATE_PREFIX = "validation:";

export type RunProjectionSpent = { costUsd?: number | null; durationMs?: number | null };

export type RunProjectionResult = {
  /** Loop state after applying every gate this summary could decide. */
  state: GoalLoopState;
  /** What the loop wants next: revise, draft a plan, ask a human, record, or stop. */
  next: GoalLoopNextAction;
  /** The attempts this summary produced, in the order they were applied. */
  applied: GoalLoopGateAttempt[];
};

/** Map a Harness check/summary status string to a loop verdict.
 *  `pending` / `running` / `unverified` are inconclusive — no attempt. */
function verdictFromStatus(status: string): GoalLoopGateVerdict | null {
  const s = status.trim().toLowerCase();
  if (s === "passed" || s === "pass") return "pass";
  if (s === "failed" || s === "fail") return "fail";
  if (s === "waived" || s === "skipped" || s === "waive" || s === "skip") return "waive";
  return null;
}

function evidenceLine(summary: RunValidationSummary): string {
  const parts = [
    `${summary.filesChanged} file(s) changed`,
    `${summary.commandsRun} command(s), ${summary.commandsFailed} failed`,
    `${summary.diffReviews} diff review(s)`,
  ];
  return parts.join(" · ");
}

function deliveryFeedback(summary: RunValidationSummary): string {
  const reasons: string[] = [];
  if (summary.commandsFailed > 0) reasons.push(`${summary.commandsFailed} command(s) failed`);
  const failedChecks = summary.checks.filter((c) => verdictFromStatus(c.status) === "fail");
  for (const c of failedChecks) reasons.push(c.label);
  if (summary.warnings.length) reasons.push(...summary.warnings);
  return reasons.length ? reasons.join("; ") : "Delivery did not meet the definition of done.";
}

/** Score a summary's failure signal so successive runs can be compared for
 *  no-progress (stall) detection. Lower is better. */
function failureScore(summary: RunValidationSummary): number {
  return summary.commandsFailed + summary.checks.filter((c) => verdictFromStatus(c.status) === "fail").length;
}

export function runProgress(
  prev: RunValidationSummary | null | undefined,
  next: RunValidationSummary
): GoalLoopProgress {
  if (!prev) return "unknown";
  const p = failureScore(prev);
  const n = failureScore(next);
  if (n < p) return "improved";
  if (n > p) return "regressed";
  return "same";
}

/** Produce a gate attempt from a run summary, or null when the summary cannot
 *  conclusively decide this gate (e.g. a plan gate, a reviewer/human gate, or
 *  a gate whose evidence is still pending — the loop should route elsewhere). */
export function gateAttemptFromRunSummary(
  gate: GoalLoopGate,
  summary: RunValidationSummary,
  opts: { ts?: number; progress?: GoalLoopProgress } = {}
): GoalLoopGateAttempt | null {
  const ts = opts.ts ?? Date.now();
  const progress = opts.progress ?? "unknown";

  const attempt = (
    verdict: GoalLoopGateVerdict,
    criteriaPassed: string[],
    criteriaFailed: string[],
    feedback: string | null,
    evidence: string | null
  ): GoalLoopGateAttempt => ({
    id: makeAttemptId(),
    gateId: gate.id,
    verdict,
    criteriaPassed,
    criteriaFailed,
    feedback,
    evidence,
    progress,
    ts,
  });

  // Gates minted from a ValidationCheck carry the check id — match it directly.
  if (gate.id.startsWith(VALIDATION_GATE_PREFIX)) {
    const checkId = gate.id.slice(VALIDATION_GATE_PREFIX.length);
    const check = summary.checks.find((c) => c.id === checkId);
    if (!check) return null;
    const verdict = verdictFromStatus(check.status);
    if (!verdict) return null;
    return attempt(
      verdict,
      verdict === "pass" ? [check.label] : [],
      verdict === "fail" ? [check.label] : [],
      verdict === "fail" ? (check.evidence ?? check.label) : null,
      check.evidence ?? null
    );
  }

  switch (gate.kind) {
    case "delivery": {
      // The definition-of-done gate reads the overall snapshot verdict.
      const verdict = verdictFromStatus(summary.status);
      if (!verdict) return null; // "unverified"/pending -> needs more evidence
      return attempt(
        verdict,
        verdict === "pass" ? gate.criteria : [],
        verdict === "fail" ? gate.criteria : [],
        verdict === "fail" ? deliveryFeedback(summary) : null,
        evidenceLine(summary)
      );
    }
    case "command-validation": {
      if (summary.commandsRun === 0) return null; // no command evidence yet
      const ok = summary.commandsFailed === 0;
      return attempt(
        ok ? "pass" : "fail",
        ok ? gate.criteria : [],
        ok ? [] : gate.criteria,
        ok ? null : `${summary.commandsFailed} validation command(s) failed.`,
        evidenceLine(summary)
      );
    }
    case "diff-scope": {
      if (summary.filesChanged === 0) return null; // nothing changed -> nothing to scope
      // Counts alone can't prove out-of-scope edits; reviewed changes count as
      // in-scope for now. A reviewer-owned semantic check tightens this later.
      return attempt("pass", gate.criteria, [], null, evidenceLine(summary));
    }
    // plan precedes the run; semantic-review and human need a reviewer/user;
    // budget is enforced by the loop's short-circuit, not a closing gate.
    default:
      return null;
  }
}

/** Apply a single run's snapshot to the loop, advancing through every gate the
 *  snapshot can decide (a delivery run typically clears delivery + several
 *  validation gates at once). Stops at the first gate it cannot decide — a
 *  plan/reviewer/human gate, or a failed gate that needs a fresh revision run. */
export function advanceGoalLoopWithRunSummary(
  spec: GoalLoopSpec,
  state: GoalLoopState,
  summary: RunValidationSummary,
  opts: { ts?: number; spent?: RunProjectionSpent; previousSummary?: RunValidationSummary | null } = {}
): RunProjectionResult {
  const progress = runProgress(opts.previousSummary, summary);
  const applied: GoalLoopGateAttempt[] = [];
  let current = state;

  // Bounded: at most one pass per gate, plus slack.
  const guard = spec.gates.length + 2;
  for (let i = 0; i < guard; i += 1) {
    const next = decideGoalLoopNextAction(spec, current, opts.spent);
    // Only run-driven gate work can be decided from a run summary.
    if (next.type !== "run-delivery" && next.type !== "revise") break;

    const gate = spec.gates.find((g) => g.id === next.gateId);
    if (!gate) break;

    const attempt = gateAttemptFromRunSummary(gate, summary, { ts: opts.ts, progress });
    if (!attempt) break; // summary can't decide this gate -> block

    current = recordGoalLoopGateAttempt(spec, current, attempt);
    applied.push(attempt);

    // A failed gate routes to revision, which requires a NEW run — don't keep
    // re-judging the same snapshot.
    if (attempt.verdict === "fail") break;
  }

  return { state: current, next: decideGoalLoopNextAction(spec, current, opts.spent), applied };
}

function makeAttemptId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `attempt:${crypto.randomUUID()}`;
  return `attempt:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}
