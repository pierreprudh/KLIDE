// PROTOTYPE — throwaway. Three radically different layouts for the v0.5
// "orchestrator console": goal → plan → route (local-first, budget-aware
// model tiers) → fan-out → review. Switch variants with the floating bottom
// bar (or ← / → keys). The routing/budget math is REAL — it calls
// `routeTask` from src/agent/routingPolicy and the budget presets — only the
// planner (goal → task list) and the run execution are stubbed, since the
// question here is "what should this surface look/feel like", not "does
// dispatch work". Fold the winning variant into a real OrchestratorConsole and
// delete this file. See NOTES at the bottom for the design question.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  routeTask,
  DEFAULT_ROUTING_POLICY,
  type RoutingPolicy,
  type ModelTier,
  type WorkerKind,
  type RouteTaskInput,
  type WorkerAssignment,
} from "../agent/routingPolicy";
import { BUDGET_PRESETS, createBudgetLedger, type BudgetPreset } from "../agent/budgetLedger";
import { createCapacityState } from "../agent/capacityPlanner";

// ── Stub planner ──────────────────────────────────────────────────────────
// A real planner would call a model to decompose the goal. For the prototype
// we hand back a believable, tier-diverse task list so every routing tier
// shows up. Task titles borrow a verb from the goal so it doesn't feel canned.
// PlannedTask extends the real RouteTaskInput with PM-board metadata (phase +
// dependencies). routeTask ignores the extra fields, so the routing stays real.
type Phase = "Understand" | "Build" | "Verify";
type PlannedTask = RouteTaskInput & { phase: Phase; dependsOn?: string[] };

function stubPlan(goal: string): PlannedTask[] {
  const g = goal.trim() || "the feature";
  const short = g.length > 38 ? g.slice(0, 38) + "…" : g;
  return [
    { taskId: "t1", title: `Map modules touched by ${short}`, mode: "plan", risk: "low", writesFiles: false, needsRepoWideContext: true, phase: "Understand" },
    { taskId: "t2", title: "Draft the implementation plan", mode: "plan", risk: "medium", writesFiles: false, needsStrongReasoning: true, phase: "Understand", dependsOn: ["t1"] },
    { taskId: "t3", title: "Scaffold boilerplate + types", mode: "goal", risk: "low", writesFiles: true, phase: "Build", dependsOn: ["t2"] },
    { taskId: "t4", title: `Implement core logic for ${short}`, mode: "goal", risk: "high", writesFiles: true, needsStrongReasoning: true, phase: "Build", dependsOn: ["t3"] },
    { taskId: "t5", title: "Write unit tests", mode: "goal", risk: "medium", writesFiles: true, phase: "Verify", dependsOn: ["t4"] },
    { taskId: "t6", title: "Tidy comments + inline docs", mode: "goal", risk: "low", writesFiles: false, phase: "Build", dependsOn: ["t4"] },
    { taskId: "t7", title: "Cross-file rename / refactor", mode: "goal", risk: "medium", writesFiles: true, needsDelegateCli: true, phase: "Build", dependsOn: ["t4"] },
    { taskId: "t8", title: "Visual QA of the new UI", mode: "goal", risk: "low", writesFiles: false, needsVisualReview: true, phase: "Verify", dependsOn: ["t7"] },
  ];
}

const RISK_META: Record<RouteTaskInput["risk"], { label: string; color: string }> = {
  low: { label: "low", color: "#7A8290" },
  medium: { label: "med", color: "#E0A341" },
  high: { label: "high", color: "#D9544D" },
};

// ── Budget / privacy modes ──────────────────────────────────────────────────
// The headline lever. Each mode is a real RoutingPolicy + budget preset, so
// flipping it re-runs routeTask and the tasks genuinely re-route across tiers.
type ModeKey = "local-first" | "balanced" | "max";
const MODES: Record<ModeKey, { label: string; blurb: string; policy: RoutingPolicy; preset: Exclude<BudgetPreset, "custom"> }> = {
  "local-first": {
    label: "Local-first",
    blurb: "Privacy local-only — every task runs on a local model. $0, slower, fully private.",
    policy: { ...DEFAULT_ROUTING_POLICY, privacy: "local-only", maxParallelWorkers: 4 },
    preset: "lean",
  },
  balanced: {
    label: "Balanced",
    blurb: "Cheap models do the volume; strong models only for high-risk / repo-wide tasks.",
    policy: DEFAULT_ROUTING_POLICY,
    preset: "balanced",
  },
  max: {
    label: "Max quality",
    blurb: "Strong + specialist models freely; delegates allowed; escalates without asking.",
    policy: { ...DEFAULT_ROUTING_POLICY, askBeforeEscalation: false },
    preset: "maximum",
  },
};

const TIER_META: Record<ModelTier, { label: string; role: string; color: string }> = {
  local: { label: "Local", role: "on-device crew · free", color: "#3FB68B" },
  cheap: { label: "Cheap API", role: "the junior — does the volume", color: "#5B8DEF" },
  strong: { label: "Strong API", role: "the senior — hard calls", color: "#A06BE0" },
  specialist: { label: "Specialist", role: "the contractor — delegate CLI", color: "#E0A341" },
};
const TIER_ORDER: ModelTier[] = ["local", "cheap", "strong", "specialist"];

const WORKER_LABEL: Record<WorkerKind, string> = {
  native: "Klide harness",
  delegate: "Delegate CLI",
  "local-model": "Local model",
  "api-model": "API model",
};

// ── Shared data model (data, not layout — fine to share) ─────────────────────
type Routed = { task: PlannedTask; assignment: WorkerAssignment; ok: boolean };

function useOrchestratorModel(goal: string, mode: ModeKey) {
  return useMemo(() => {
    const { policy, preset } = MODES[mode];
    const tasks = stubPlan(goal);
    const routed: Routed[] = tasks.map((task) => {
      const decision = routeTask({
        task,
        policy,
        budget: createBudgetLedger({ missionId: "proto", preset }),
        capacity: createCapacityState(),
      });
      const assignment = decision.ok ? decision.assignment : decision.suggestedAssignment!;
      return { task, assignment, ok: decision.ok };
    });
    const totalCost = routed.reduce((s, r) => s + (r.assignment.estimatedCostUsd ?? 0), 0);
    const totalMs = routed.reduce((s, r) => s + (r.assignment.estimatedDurationMs ?? 0), 0);
    const envelope = BUDGET_PRESETS[preset];
    const byTier: Record<ModelTier, Routed[]> = { local: [], cheap: [], strong: [], specialist: [] };
    for (const r of routed) byTier[r.assignment.modelTier].push(r);
    return { routed, totalCost, totalMs, envelope, byTier };
  }, [goal, mode]);
}

// ── Shared run simulation ────────────────────────────────────────────────────
type RunStatus = "idle" | "running" | "done";
function useRunSim(taskIds: string[]) {
  const [statuses, setStatuses] = useState<Record<string, RunStatus>>({});
  const [running, setRunning] = useState(false);
  const timers = useRef<number[]>([]);
  const key = taskIds.join(",");

  useEffect(() => {
    // Reset whenever the task set changes (new goal / mode).
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setStatuses({});
    setRunning(false);
  }, [key]);

  function dispatch() {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setRunning(true);
    setStatuses(Object.fromEntries(taskIds.map((id) => [id, "running" as RunStatus])));
    taskIds.forEach((id, i) => {
      const t = window.setTimeout(() => {
        setStatuses((s) => ({ ...s, [id]: "done" }));
        if (i === taskIds.length - 1) setRunning(false);
      }, 500 + i * 420);
      timers.current.push(t);
    });
  }

  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const doneCount = Object.values(statuses).filter((s) => s === "done").length;
  return { statuses, running, dispatch, doneCount, total: taskIds.length };
}

function fmtUsd(n: number): string {
  return n === 0 ? "$0" : `$${n.toFixed(2)}`;
}
function fmtMin(ms: number): string {
  return `${Math.round(ms / 60_000)}m`;
}

// ── Small shared atoms (atoms, not layout) ───────────────────────────────────
function TierChip({ tier }: { tier: ModelTier }) {
  const m = TIER_META[tier];
  return (
    <span
      style={{
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        padding: "1px 7px",
        borderRadius: 999,
        color: m.color,
        background: `color-mix(in srgb, ${m.color} 14%, transparent)`,
        border: `1px solid color-mix(in srgb, ${m.color} 38%, var(--border))`,
        whiteSpace: "nowrap",
      }}
    >
      {m.label}
    </span>
  );
}

function StatusDot({ status }: { status: RunStatus }) {
  const color = status === "done" ? "var(--accent)" : status === "running" ? "#E0A341" : "var(--fg-dim)";
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: 999,
        background: color,
        display: "inline-block",
        animation: status === "running" ? "klidePulse 1.1s ease-in-out infinite" : undefined,
      }}
    />
  );
}

function GoalBar({
  goal,
  setGoal,
  mode,
  setMode,
}: {
  goal: string;
  setGoal: (v: string) => void;
  mode: ModeKey;
  setMode: (m: ModeKey) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <input
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        placeholder="Describe the goal — e.g. add rate limiting to the API"
        style={{
          flex: 1,
          minWidth: 240,
          padding: "9px 12px",
          fontSize: 13,
          color: "var(--fg-strong)",
          background: "var(--bg-elevated, var(--bg))",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm, 6px)",
          outline: "none",
        }}
      />
      <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 999, overflow: "hidden" }}>
        {(Object.keys(MODES) as ModeKey[]).map((k) => (
          <button
            key={k}
            onClick={() => setMode(k)}
            style={{
              padding: "7px 14px",
              fontSize: 12,
              border: "none",
              cursor: "pointer",
              color: mode === k ? "var(--bg)" : "var(--fg-dim)",
              background: mode === k ? "var(--accent)" : "transparent",
              transition: "background 120ms, color 120ms",
            }}
          >
            {MODES[k].label}
          </button>
        ))}
      </div>
    </div>
  );
}

function BudgetMeter({ spent, max }: { spent: number; max: number | null }) {
  const pct = max ? Math.min(100, (spent / max) * 100) : 0;
  const over = max != null && spent > max;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--fg-dim)", marginBottom: 4 }}>
        <span>Estimated spend</span>
        <span style={{ fontFamily: "var(--font-mono)", color: over ? "var(--danger, #B42318)" : "var(--fg-strong)" }}>
          {fmtUsd(spent)} {max != null ? `/ ${fmtUsd(max)}` : ""}
        </span>
      </div>
      <div style={{ height: 6, borderRadius: 999, background: "color-mix(in srgb, var(--fg) 8%, transparent)", overflow: "hidden" }}>
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: over ? "var(--danger, #B42318)" : "var(--accent)",
            transition: "width 220ms ease",
          }}
        />
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// VARIANT A — "Flow pipeline": a vertical narrative of the 5 stages, rail on
// the left, the Route stage expands inline to show per-task assignments.
// Emphasis: the staged journey from goal to merge.
// ════════════════════════════════════════════════════════════════════════════
function VariantA({ goal, setGoal, mode, setMode }: VariantProps) {
  const { routed, totalCost, totalMs, envelope } = useOrchestratorModel(goal, mode);
  const sim = useRunSim(routed.map((r) => r.task.taskId));
  const stages = [
    { key: "goal", label: "Goal", done: true },
    { key: "plan", label: "Plan", done: true },
    { key: "route", label: "Route", done: true },
    { key: "fanout", label: "Fan-out", done: sim.doneCount > 0 },
    { key: "review", label: "Review", done: sim.doneCount === sim.total && sim.total > 0 },
  ];
  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "28px 24px 96px" }}>
      <h2 style={pageTitle}>Orchestrator · flow</h2>
      <div style={{ marginBottom: 20 }}>
        <GoalBar goal={goal} setGoal={setGoal} mode={mode} setMode={setMode} />
        <p style={{ fontSize: 12, color: "var(--fg-dim)", margin: "8px 2px 0" }}>{MODES[mode].blurb}</p>
      </div>
      <div style={{ display: "flex", gap: 16 }}>
        {/* rail */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 6 }}>
          {stages.map((s, i) => (
            <div key={s.key} style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <div
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 999,
                  background: s.done ? "var(--accent)" : "transparent",
                  border: `2px solid ${s.done ? "var(--accent)" : "var(--border)"}`,
                }}
              />
              {i < stages.length - 1 && <div style={{ width: 2, height: 92, background: "var(--border)" }} />}
            </div>
          ))}
        </div>
        {/* stage cards */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16 }}>
          <StageCard title="Goal" subtitle={goal || "—"} />
          <StageCard title="Plan" subtitle={`${routed.length} tasks decomposed`} />
          <StageCard title="Route" subtitle={`${fmtUsd(totalCost)} · ${fmtMin(totalMs)} across model tiers`}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
              {routed.map((r) => (
                <div key={r.task.taskId} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <StatusDot status={sim.statuses[r.task.taskId] ?? "idle"} />
                  <span style={{ flex: 1, fontSize: 13, color: "var(--fg-strong)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.task.title}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--fg-dim)" }}>{WORKER_LABEL[r.assignment.workerKind]}</span>
                  <TierChip tier={r.assignment.modelTier} />
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-dim)", width: 44, textAlign: "right" }}>
                    {fmtUsd(r.assignment.estimatedCostUsd ?? 0)}
                  </span>
                </div>
              ))}
            </div>
          </StageCard>
          <StageCard title="Fan-out" subtitle={sim.total ? `${sim.doneCount}/${sim.total} complete` : "not started"}>
            <button onClick={sim.dispatch} disabled={sim.running} style={primaryBtn}>
              {sim.running ? "Running…" : sim.doneCount ? "Re-run fan-out" : "Dispatch fan-out"}
            </button>
          </StageCard>
          <StageCard
            title="Review"
            subtitle={sim.doneCount === sim.total && sim.total > 0 ? "All tasks complete — ready to merge" : "waiting on fan-out"}
          >
            <div style={{ marginTop: 10 }}>
              <BudgetMeter spent={totalCost} max={envelope.maxCostUsd} />
            </div>
          </StageCard>
        </div>
      </div>
    </div>
  );
}

function StageCard({ title, subtitle, children }: { title: string; subtitle: string; children?: React.ReactNode }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-md, 10px)", padding: "14px 16px", background: "var(--bg-elevated, var(--bg))" }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-strong)" }}>{title}</div>
      <div style={{ fontSize: 12, color: "var(--fg-dim)", marginTop: 2 }}>{subtitle}</div>
      {children}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// VARIANT B — "Routing table": dense operator view. Goal inline up top, a
// sortable-looking table of every task with tier/worker/provider/cost/checks,
// budget footer. Mission Control DNA — for someone who wants the whole plan
// legible at a glance.
// ════════════════════════════════════════════════════════════════════════════
function VariantB({ goal, setGoal, mode, setMode }: VariantProps) {
  const { routed, totalCost, totalMs, envelope } = useOrchestratorModel(goal, mode);
  const sim = useRunSim(routed.map((r) => r.task.taskId));
  return (
    <div style={{ padding: "24px 28px 96px", display: "flex", flexDirection: "column", height: "100%" }}>
      <h2 style={pageTitle}>Orchestrator · routing table</h2>
      <div style={{ marginBottom: 16 }}>
        <GoalBar goal={goal} setGoal={setGoal} mode={mode} setMode={setMode} />
      </div>
      <div style={{ display: "flex", gap: 24, marginBottom: 14 }}>
        <Stat label="Tasks" value={String(routed.length)} />
        <Stat label="Est. cost" value={fmtUsd(totalCost)} />
        <Stat label="Est. time" value={fmtMin(totalMs)} />
        <Stat label="Mode" value={MODES[mode].label} />
      </div>
      <div style={{ flex: 1, overflow: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius-md, 10px)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ position: "sticky", top: 0, background: "var(--bg)", textAlign: "left" }}>
              {["", "Task", "Tier", "Worker", "Provider", "Checks", "Cost", "Status"].map((h, i) => (
                <th key={i} style={{ padding: "9px 12px", fontSize: 11, fontWeight: 500, color: "var(--fg-dim)", borderBottom: "1px solid var(--border)" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {routed.map((r) => {
              const tc = TIER_META[r.assignment.modelTier].color;
              return (
                <tr key={r.task.taskId} style={{ borderBottom: "1px solid color-mix(in srgb, var(--border) 60%, transparent)" }}>
                  <td style={{ padding: "9px 12px", borderLeft: `3px solid ${tc}` }}>
                    <StatusDot status={sim.statuses[r.task.taskId] ?? "idle"} />
                  </td>
                  <td style={{ padding: "9px 12px", color: "var(--fg-strong)" }}>{r.task.title}</td>
                  <td style={{ padding: "9px 12px" }}><TierChip tier={r.assignment.modelTier} /></td>
                  <td style={{ padding: "9px 12px", color: "var(--fg-dim)" }}>{WORKER_LABEL[r.assignment.workerKind]}</td>
                  <td style={{ padding: "9px 12px", color: "var(--fg-dim)", fontFamily: "var(--font-mono)", fontSize: 12 }}>{r.assignment.provider ?? "—"}</td>
                  <td style={{ padding: "9px 12px", color: "var(--fg-dim)", fontFamily: "var(--font-mono)", fontSize: 12 }}>{r.assignment.validationChecks.length}</td>
                  <td style={{ padding: "9px 12px", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-strong)" }}>{fmtUsd(r.assignment.estimatedCostUsd ?? 0)}</td>
                  <td style={{ padding: "9px 12px", fontSize: 12, color: "var(--fg-dim)" }}>{sim.statuses[r.task.taskId] ?? "idle"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 24, marginTop: 14 }}>
        <div style={{ flex: 1 }}>
          <BudgetMeter spent={totalCost} max={envelope.maxCostUsd} />
        </div>
        <button onClick={sim.dispatch} disabled={sim.running} style={primaryBtn}>
          {sim.running ? `Running ${sim.doneCount}/${sim.total}…` : "Run all"}
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--fg-dim)" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: "var(--fg-strong)", fontFamily: "var(--font-mono)" }}>{value}</div>
    </div>
  );
}

function CrewStat({ n, label }: { n: string | number; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 5 }}>
      <span style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-strong)", fontFamily: "var(--font-mono)" }}>{n}</span>
      <span style={{ color: "var(--fg-dim)" }}>{label}</span>
    </span>
  );
}

// Tiny "assignee" pill — the worker the task is handed to, with the provider as
// a one-letter avatar. Reinforces the project-manager metaphor (each task has
// someone on it) without pulling in real provider logos for a prototype.
function Assignee({ provider, workerKind, color }: { provider: string | null; workerKind: WorkerKind; color: string }) {
  const initial = (provider ?? "local").charAt(0).toUpperCase();
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--fg-dim)" }}>
      <span
        style={{
          width: 16,
          height: 16,
          borderRadius: 999,
          background: `color-mix(in srgb, ${color} 22%, transparent)`,
          color,
          fontSize: 9,
          fontWeight: 700,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {initial}
      </span>
      {WORKER_LABEL[workerKind]}
    </span>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// VARIANT C — "Tier board": kanban-by-tier. Four columns (Local / Cheap /
// Strong / Specialist); tasks live as cards in their routed column. Flip the
// mode and cards visibly redistribute — the most literal dramatization of
// "budget → re-route". Budget + review live in a right rail.
// ════════════════════════════════════════════════════════════════════════════
function VariantC({ goal, setGoal, mode, setMode }: VariantProps) {
  const { routed, byTier, totalCost, totalMs, envelope } = useOrchestratorModel(goal, mode);
  const allIds = TIER_ORDER.flatMap((t) => byTier[t].map((r) => r.task.taskId));
  const sim = useRunSim(allIds);
  const titleById = useMemo(() => Object.fromEntries(routed.map((r) => [r.task.taskId, r.task.title as string])), [routed]);
  // Tasks with no unfinished dependency can start now — the PM's "ready" lane.
  const readyCount = routed.filter((r) => (r.task.dependsOn ?? []).length === 0).length;
  return (
    <div style={{ padding: "24px 28px 96px", height: "100%", display: "flex", flexDirection: "column" }}>
      <h2 style={pageTitle}>Orchestrator · crew board</h2>
      <div style={{ marginBottom: 14 }}>
        <GoalBar goal={goal} setGoal={setGoal} mode={mode} setMode={setMode} />
      </div>
      {/* crew summary strip */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 18,
          padding: "10px 14px",
          marginBottom: 16,
          borderRadius: "var(--radius-md, 10px)",
          background: "color-mix(in srgb, var(--accent) 6%, transparent)",
          border: "1px solid color-mix(in srgb, var(--accent) 18%, var(--border))",
          fontSize: 12,
          flexWrap: "wrap",
        }}
      >
        <CrewStat n={routed.length} label="tasks planned" />
        <CrewStat n={readyCount} label="ready to start" />
        <CrewStat n={fmtUsd(totalCost)} label="est. cost" />
        <CrewStat n={fmtMin(totalMs)} label="est. time" />
        <span style={{ color: "var(--fg-dim)", marginLeft: "auto" }}>{MODES[mode].blurb}</span>
      </div>
      <div style={{ display: "flex", gap: 18, flex: 1, minHeight: 0 }}>
        <div style={{ display: "flex", gap: 12, flex: 1, minHeight: 0 }}>
          {TIER_ORDER.map((tier) => {
            const m = TIER_META[tier];
            const items = byTier[tier];
            const colCost = items.reduce((s, r) => s + (r.assignment.estimatedCostUsd ?? 0), 0);
            return (
              <div key={tier} style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
                <div style={{ marginBottom: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 999, background: m.color }} />
                    <span style={{ fontSize: 12, fontWeight: 600, color: "var(--fg-strong)" }}>{m.label}</span>
                    <span style={{ fontSize: 11, color: "var(--fg-dim)" }}>{items.length}</span>
                    {/* per-column spend — the column is a budget lane, not just a status */}
                    <span style={{ marginLeft: "auto", fontSize: 11, fontFamily: "var(--font-mono)", color: m.color }}>{fmtUsd(colCost)}</span>
                  </div>
                  <div style={{ fontSize: 10.5, color: "var(--fg-subtle)", marginLeft: 14, marginTop: 1 }}>{m.role}</div>
                </div>
                <div
                  style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    padding: 8,
                    borderRadius: "var(--radius-md, 10px)",
                    background: `color-mix(in srgb, ${m.color} 6%, transparent)`,
                    border: `1px solid color-mix(in srgb, ${m.color} 20%, var(--border))`,
                    overflow: "auto",
                  }}
                >
                  {items.map((r) => {
                    const t = r.task as PlannedTask;
                    const dep = t.dependsOn?.[0];
                    const risk = RISK_META[r.task.risk];
                    return (
                      <div
                        key={r.task.taskId}
                        style={{
                          padding: "9px 10px",
                          borderRadius: "var(--radius-sm, 6px)",
                          background: "var(--bg-elevated, var(--bg))",
                          border: "1px solid var(--border)",
                          transition: "all 200ms ease",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
                          <span style={{ fontSize: 9.5, color: "var(--fg-subtle)", textTransform: "uppercase", letterSpacing: 0.4 }}>{t.phase}</span>
                          <span style={{ fontSize: 9.5, color: risk.color, fontFamily: "var(--font-mono)" }}>·{risk.label}</span>
                          <span style={{ marginLeft: "auto" }}>
                            <StatusDot status={sim.statuses[r.task.taskId] ?? "idle"} />
                          </span>
                        </div>
                        <div style={{ fontSize: 12.5, color: "var(--fg-strong)", lineHeight: 1.3, marginBottom: 6 }}>{r.task.title}</div>
                        {dep && (
                          <div style={{ fontSize: 10.5, color: "var(--fg-subtle)", marginBottom: 6 }}>
                            ↳ after {(titleById[dep] ?? dep).slice(0, 22)}
                          </div>
                        )}
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          <Assignee provider={r.assignment.provider} workerKind={r.assignment.workerKind} color={m.color} />
                          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-dim)" }}>{fmtUsd(r.assignment.estimatedCostUsd ?? 0)}</span>
                        </div>
                      </div>
                    );
                  })}
                  {items.length === 0 && <div style={{ fontSize: 11, color: "var(--fg-subtle)", textAlign: "center", paddingTop: 16 }}>idle</div>}
                </div>
              </div>
            );
          })}
        </div>
        {/* right rail */}
        <div style={{ width: 220, display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-md, 10px)", padding: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--fg-strong)", marginBottom: 10 }}>Budget</div>
            <BudgetMeter spent={totalCost} max={envelope.maxCostUsd} />
            <div style={{ fontSize: 11, color: "var(--fg-dim)", marginTop: 10 }}>Est. time {fmtMin(totalMs)}</div>
          </div>
          <button onClick={sim.dispatch} disabled={sim.running} style={primaryBtn}>
            {sim.running ? `Running ${sim.doneCount}/${sim.total}…` : "Dispatch all"}
          </button>
          <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-md, 10px)", padding: 14, fontSize: 12, color: "var(--fg-dim)" }}>
            <div style={{ fontWeight: 600, color: "var(--fg-strong)", marginBottom: 6 }}>Review gate</div>
            {sim.doneCount === sim.total && sim.total > 0 ? "All tasks done — review diffs & merge." : `${sim.doneCount}/${sim.total} complete.`}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Switcher + shared styles ─────────────────────────────────────────────────
type VariantProps = {
  goal: string;
  setGoal: (v: string) => void;
  mode: ModeKey;
  setMode: (m: ModeKey) => void;
};

const pageTitle: React.CSSProperties = { fontSize: 15, fontWeight: 600, color: "var(--fg-strong)", margin: "0 0 16px" };
const primaryBtn: React.CSSProperties = {
  padding: "8px 16px",
  fontSize: 13,
  color: "var(--bg)",
  background: "var(--accent)",
  border: "none",
  borderRadius: "var(--radius-sm, 6px)",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const VARIANTS: { key: string; name: string; Comp: (p: VariantProps) => React.JSX.Element }[] = [
  { key: "A", name: "Flow pipeline", Comp: VariantA },
  { key: "B", name: "Routing table", Comp: VariantB },
  { key: "C", name: "Tier board", Comp: VariantC },
];

export function OrchestratorConsolePrototype() {
  const [idx, setIdx] = useState(0);
  const [goal, setGoal] = useState("add rate limiting to the API");
  const [mode, setMode] = useState<ModeKey>("balanced");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable)) return;
      if (e.key === "ArrowLeft") setIdx((i) => (i - 1 + VARIANTS.length) % VARIANTS.length);
      if (e.key === "ArrowRight") setIdx((i) => (i + 1) % VARIANTS.length);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const Active = VARIANTS[idx].Comp;
  return (
    <div style={{ height: "100%", overflow: "auto", background: "var(--bg)", color: "var(--fg)", position: "relative" }}>
      <style>{`@keyframes klidePulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }`}</style>
      <Active goal={goal} setGoal={setGoal} mode={mode} setMode={setMode} />
      {/* floating prototype switcher */}
      <div
        style={{
          position: "fixed",
          bottom: 18,
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "5px 6px",
          borderRadius: 999,
          background: "var(--fg-strong)",
          color: "var(--bg)",
          boxShadow: "0 6px 24px rgba(0,0,0,0.28)",
          zIndex: 50,
          fontSize: 12,
        }}
      >
        <SwitchBtn onClick={() => setIdx((i) => (i - 1 + VARIANTS.length) % VARIANTS.length)}>←</SwitchBtn>
        <span style={{ padding: "0 10px", whiteSpace: "nowrap" }}>
          {VARIANTS[idx].key} — {VARIANTS[idx].name} <span style={{ opacity: 0.5 }}>(prototype)</span>
        </span>
        <SwitchBtn onClick={() => setIdx((i) => (i + 1) % VARIANTS.length)}>→</SwitchBtn>
      </div>
    </div>
  );
}

function SwitchBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: 26,
        height: 26,
        borderRadius: 999,
        border: "none",
        background: "color-mix(in srgb, var(--bg) 22%, transparent)",
        color: "var(--bg)",
        cursor: "pointer",
        fontSize: 14,
        lineHeight: 1,
      }}
    >
      {children}
    </button>
  );
}

// NOTES — VERDICT (2026-06-25): Variant C (tier/crew board) won — "felt like a
// project manager." A and B are kept only for reference until the real console
// lands; delete them then. Design directions, competitive research, and the
// open dispatcher question are written up in docs/orchestrator-console.md.
// Next: build the real OrchestratorConsole from C, then wire the dispatcher
// seam (route decision → spawn harness/delegate run) and delete this file.
