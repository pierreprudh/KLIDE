// OrchestratorConsole — the real v0.5 tier-board console, built from the
// prototype's winning "crew board" variant and grounded in Design.md:
//   · bone canvas + charcoal-opacity grays + hairline borders (no drop-shadow)
//   · ONE chromatic moment — sage (--accent) marks LIVE work; amber/brick are
//     the existing status signals. Tiers read by LABEL + a monochrome strength
//     meter, never by an off-brand hue (no teal/blue/purple).
//   · spacing on the Design.md scale (8/12/16/24), --fs ramp, --radius tiers.
//
// The routing + budget math is real (routeTask / budget presets / capacity).
// The planner (goal → task list) is still a stub — decomposition is its own
// slice. Plan-mode (read-only) cards dispatch as REAL harness runs through the
// slice-1 dispatcher seam and stream a live activity line; goal-mode cards wait
// for the diff-review surface, which this view doesn't host yet.

import { useMemo, useRef, useState } from "react";
import {
  routeTask,
  DEFAULT_ROUTING_POLICY,
  type RoutingPolicy,
  type ModelTier,
  type RouteTaskInput,
  type WorkerAssignment,
} from "../agent/routingPolicy";
import { BUDGET_PRESETS, createBudgetLedger, type BudgetPreset } from "../agent/budgetLedger";
import { createCapacityState } from "../agent/capacityPlanner";
import { dispatchAssignment, type DispatchableTask } from "../agent/dispatcher";
import type { AgentEvent } from "../agent/types";

// ── Stub planner ──────────────────────────────────────────────────────────
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

// ── Budget / privacy modes ──────────────────────────────────────────────────
type ModeKey = "local-first" | "balanced" | "max";
const MODES: Record<ModeKey, { label: string; blurb: string; policy: RoutingPolicy; preset: Exclude<BudgetPreset, "custom"> }> = {
  "local-first": {
    label: "Local-first",
    blurb: "Every task runs on a local model. $0, slower, fully private.",
    policy: { ...DEFAULT_ROUTING_POLICY, privacy: "local-only", maxParallelWorkers: 4 },
    preset: "lean",
  },
  balanced: {
    label: "Balanced",
    blurb: "Cheap models do the volume; strong models only for high-risk or repo-wide work.",
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

// Tiers carry NO hue — only a label, a role, and a 1–4 strength level rendered
// as a monochrome meter. Level encodes escalating capability/cost.
const TIER_META: Record<ModelTier, { label: string; role: string; level: 1 | 2 | 3 | 4 }> = {
  local: { label: "Local", role: "on-device crew · free", level: 1 },
  cheap: { label: "Cheap API", role: "the junior — volume", level: 2 },
  strong: { label: "Strong API", role: "the senior — hard calls", level: 3 },
  specialist: { label: "Specialist", role: "the contractor — delegate", level: 4 },
};
const TIER_ORDER: ModelTier[] = ["local", "cheap", "strong", "specialist"];

const WORKER_LABEL: Record<WorkerAssignment["workerKind"], string> = {
  native: "Klide harness",
  delegate: "Delegate CLI",
  "local-model": "Local model",
  "api-model": "API model",
};

const RISK_LABEL: Record<RouteTaskInput["risk"], string> = { low: "low", medium: "med", high: "high" };

// ── Routing model (real) ─────────────────────────────────────────────────────
type Routed = { task: PlannedTask; assignment: WorkerAssignment };

function useOrchestratorModel(goal: string, mode: ModeKey) {
  return useMemo(() => {
    const { policy, preset } = MODES[mode];
    const tasks = stubPlan(goal);
    const routed: Routed[] = tasks.map((task) => {
      const decision = routeTask({
        task,
        policy,
        budget: createBudgetLedger({ missionId: "console", preset }),
        capacity: createCapacityState(),
      });
      const assignment = decision.ok ? decision.assignment : decision.suggestedAssignment!;
      return { task, assignment };
    });
    const totalCost = routed.reduce((s, r) => s + (r.assignment.estimatedCostUsd ?? 0), 0);
    const totalMs = routed.reduce((s, r) => s + (r.assignment.estimatedDurationMs ?? 0), 0);
    const envelope = BUDGET_PRESETS[preset];
    const byTier: Record<ModelTier, Routed[]> = { local: [], cheap: [], strong: [], specialist: [] };
    for (const r of routed) byTier[r.assignment.modelTier].push(r);
    const readyCount = routed.filter((r) => (r.task.dependsOn ?? []).length === 0).length;
    return { routed, totalCost, totalMs, envelope, byTier, readyCount };
  }, [goal, mode]);
}

// ── Real dispatch (slice-1 seam) ─────────────────────────────────────────────
type CardStatus = "idle" | "running" | "done" | "error";
type LiveCard = { status: CardStatus; activity: string };

function activityFromEvent(prev: LiveCard, ev: AgentEvent): LiveCard {
  switch (ev.type) {
    case "tool_call_started":
      return { ...prev, activity: ev.summary || ev.name };
    case "assistant_delta":
      return prev.activity === "thinking…" ? prev : { ...prev, activity: "thinking…" };
    case "run_result":
      return { status: "done", activity: ev.result.message?.slice(0, 80) || "done" };
    case "run_error":
      return { status: "error", activity: ev.error.message.slice(0, 80) };
    default:
      return prev;
  }
}

function useRealDispatch(workspaceRoot: string | null) {
  const [live, setLive] = useState<Record<string, LiveCard>>({});
  const counter = useRef(0);

  async function run(task: PlannedTask, assignment: WorkerAssignment) {
    counter.current += 1;
    const dispatchable: DispatchableTask = {
      taskId: `orch-${task.taskId}-${counter.current}`,
      prompt: task.title,
      mode: task.mode,
    };
    setLive((s) => ({ ...s, [task.taskId]: { status: "running", activity: "starting…" } }));
    try {
      const { plan } = await dispatchAssignment(
        dispatchable,
        assignment,
        { workspaceRoot, requireDiffReview: true },
        (ev) => setLive((s) => (s[task.taskId] ? { ...s, [task.taskId]: activityFromEvent(s[task.taskId], ev) } : s))
      );
      if (plan.kind !== "harness") {
        setLive((s) => ({ ...s, [task.taskId]: { status: "error", activity: plan.reason } }));
      }
    } catch (e) {
      setLive((s) => ({ ...s, [task.taskId]: { status: "error", activity: String(e).slice(0, 80) } }));
    }
  }

  return { live, run };
}

// ── Formatters ────────────────────────────────────────────────────────────
const fmtUsd = (n: number) => (n === 0 ? "$0" : `$${n.toFixed(2)}`);
const fmtMin = (ms: number) => `${Math.round(ms / 60_000)}m`;

// ── Atoms ───────────────────────────────────────────────────────────────────
// Status: sage = live, amber = needs you, brick = failed, muted = idle/done.
// "done" recedes to a quiet muted check so the live work stays the focus.
function StatusBadge({ status }: { status: CardStatus }) {
  if (status === "done") return <span style={{ fontSize: 11, color: "var(--fg-subtle)", lineHeight: 1 }}>✓</span>;
  const color = status === "error" ? "var(--danger)" : status === "running" ? "var(--accent)" : "var(--fg-dim)";
  return (
    <span
      aria-hidden
      style={{
        width: 8,
        height: 8,
        borderRadius: 999,
        background: status === "idle" ? "transparent" : color,
        border: status === "idle" ? "1.5px solid var(--fg-dim)" : "none",
        display: "inline-block",
        animation: status === "running" ? "klide-pulse 1.1s ease-in-out infinite" : undefined,
      }}
    />
  );
}

// Monochrome 4-segment tier-strength meter — more filled bars = stronger tier.
function TierMeter({ level }: { level: 1 | 2 | 3 | 4 }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "flex-end", gap: 1.5, height: 11 }} aria-label={`tier ${level} of 4`}>
      {[1, 2, 3, 4].map((i) => (
        <span
          key={i}
          style={{
            width: 3,
            height: 3 + i * 2,
            borderRadius: 1,
            background: i <= level ? "var(--fg-strong)" : "var(--border-strong)",
            opacity: i <= level ? 0.78 : 0.34,
          }}
        />
      ))}
    </span>
  );
}

const eyebrow: React.CSSProperties = {
  fontSize: 11,
  fontFamily: "var(--font-mono)",
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--fg-dim)",
};

function GoalBar({ goal, setGoal, mode, setMode }: { goal: string; setGoal: (v: string) => void; mode: ModeKey; setMode: (m: ModeKey) => void }) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <input
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        placeholder="Describe the goal — e.g. add rate limiting to the API"
        className="klide-field"
        style={{ flex: 1, minWidth: 240, height: 36, padding: "0 12px", fontSize: "var(--fs-base)" }}
      />
      <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 999, overflow: "hidden" }}>
        {(Object.keys(MODES) as ModeKey[]).map((k) => (
          <button
            key={k}
            onClick={() => setMode(k)}
            style={{
              padding: "7px 14px",
              fontSize: 12,
              borderRadius: 0,
              color: mode === k ? "var(--control-primary-fg)" : "var(--fg-subtle)",
              background: mode === k ? "var(--control-primary-bg)" : "transparent",
              transition: "background var(--motion-fast), color var(--motion-fast)",
            }}
          >
            {MODES[k].label}
          </button>
        ))}
      </div>
    </div>
  );
}

function CrewStat({ n, label }: { n: string | number; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 5 }}>
      <span style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-strong)", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>{n}</span>
      <span style={{ color: "var(--fg-subtle)" }}>{label}</span>
    </span>
  );
}

function BudgetMeter({ spent, max }: { spent: number; max: number | null }) {
  const pct = max ? Math.min(100, (spent / max) * 100) : 0;
  const over = max != null && spent > max;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--fg-subtle)", marginBottom: 4 }}>
        <span>Estimated spend</span>
        <span style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", color: over ? "var(--danger)" : "var(--fg-strong)" }}>
          {fmtUsd(spent)} {max != null ? `/ ${fmtUsd(max)}` : ""}
        </span>
      </div>
      <div style={{ height: 6, borderRadius: 999, background: "var(--bg-hover)", overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: over ? "var(--danger)" : "var(--accent)", transition: "width 220ms var(--ease-out)" }} />
      </div>
    </div>
  );
}

// ── Console ───────────────────────────────────────────────────────────────
export function OrchestratorConsole({ workspaceRoot = null }: { workspaceRoot?: string | null }) {
  const [goal, setGoal] = useState("add rate limiting to the API");
  const [mode, setMode] = useState<ModeKey>("balanced");
  const { routed, byTier, totalCost, totalMs, envelope, readyCount } = useOrchestratorModel(goal, mode);
  const real = useRealDispatch(workspaceRoot ?? null);
  const titleById = useMemo(() => Object.fromEntries(routed.map((r) => [r.task.taskId, r.task.title])), [routed]);

  function dispatchAllPlan() {
    routed.filter((r) => r.task.mode === "plan").forEach((r) => real.run(r.task, r.assignment));
  }

  return (
    <div style={{ height: "100%", overflow: "auto", background: "var(--bg)", color: "var(--fg)" }} className="shell-enter">
      {/* Console-scoped motion. Klide idiom: spring-settle (no bounce), de-blur
          rise — same family as klide-welcome-rise. fill-mode backwards (not
          both) so the held end-state doesn't override the hover transform. */}
      <style>{`
        @keyframes klide-orch-in {
          from { opacity: 0; transform: translateY(8px); filter: blur(2px); }
          to   { opacity: 1; transform: translateY(0);   filter: blur(0); }
        }
        @keyframes klide-orch-fade { from { opacity: 0; } to { opacity: 1; } }
        .klide-orch-card {
          animation: klide-orch-in 460ms var(--ease-spring) backwards;
          transition:
            transform var(--motion-fast) var(--ease-out),
            border-color var(--motion-fast) var(--ease-out);
        }
        .klide-orch-card:hover {
          transform: translateY(-1px);
          border-color: var(--border-strong) !important;
        }
        .klide-orch-activity { animation: klide-orch-fade var(--motion-med) var(--ease-soft) backwards; }
        .klide-orch-run { transition: border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
        .klide-orch-run:hover { border-color: var(--accent) !important; color: var(--accent) !important; }
        @media (prefers-reduced-motion: reduce) {
          .klide-orch-card, .klide-orch-activity { animation: none; }
          .klide-orch-card:hover { transform: none; }
        }
      `}</style>
      <div style={{ padding: "24px 28px 64px", display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        <h2 style={{ fontSize: "var(--fs-xl)", fontWeight: 600, color: "var(--fg-strong)", margin: "0 0 16px", letterSpacing: "-0.01em" }}>
          Orchestrator
        </h2>

        <div style={{ marginBottom: 16 }}>
          <GoalBar goal={goal} setGoal={setGoal} mode={mode} setMode={setMode} />
        </div>

        {/* crew summary strip */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 24,
            padding: "10px 16px",
            marginBottom: 16,
            borderRadius: "var(--radius-lg)",
            background: "var(--accent-soft)",
            border: "1px solid color-mix(in srgb, var(--accent) 18%, var(--border))",
            fontSize: 12,
            flexWrap: "wrap",
          }}
        >
          <CrewStat n={routed.length} label="tasks planned" />
          <CrewStat n={readyCount} label="ready to start" />
          <CrewStat n={fmtUsd(totalCost)} label="est. cost" />
          <CrewStat n={fmtMin(totalMs)} label="est. time" />
          <span style={{ color: "var(--fg-subtle)", marginLeft: "auto" }}>{MODES[mode].blurb}</span>
        </div>

        <div style={{ display: "flex", gap: 16, flex: 1, minHeight: 0 }}>
          {/* tier columns */}
          <div style={{ display: "flex", gap: 16, flex: 1, minHeight: 0 }}>
            {TIER_ORDER.map((tier) => {
              const m = TIER_META[tier];
              const items = byTier[tier];
              const colCost = items.reduce((s, r) => s + (r.assignment.estimatedCostUsd ?? 0), 0);
              return (
                <div key={tier} style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <TierMeter level={m.level} />
                      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--fg-strong)" }}>{m.label}</span>
                      <span style={{ fontSize: 11, color: "var(--fg-dim)" }}>{items.length}</span>
                      <span style={{ marginLeft: "auto", fontSize: 11, fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", color: "var(--fg-subtle)" }}>
                        {fmtUsd(colCost)}
                      </span>
                    </div>
                    <div style={{ fontSize: 10.5, color: "var(--fg-dim)", marginLeft: 22, marginTop: 1 }}>{m.role}</div>
                  </div>
                  <div
                    style={{
                      flex: 1,
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                      padding: 12,
                      borderRadius: "var(--radius-lg)",
                      background: "var(--bg-hover)",
                      border: "1px solid var(--border)",
                      overflow: "auto",
                    }}
                  >
                    {items.map((r, i) => {
                      const t = r.task;
                      const dep = t.dependsOn?.[0];
                      const liveCard = real.live[t.taskId];
                      const status: CardStatus = liveCard?.status ?? "idle";
                      const canRunReal = !!workspaceRoot && t.mode === "plan" && status !== "running";
                      return (
                        <div
                          // key carries `mode` so flipping the budget mode
                          // remounts the cards and replays the rise cascade —
                          // routing visibly redistributing across the lanes.
                          key={`${t.taskId}-${mode}`}
                          className="klide-orch-card"
                          style={{
                            padding: 12,
                            borderRadius: "var(--radius-md)",
                            background: "var(--bg-elevated)",
                            border: "1px solid var(--border)",
                            animationDelay: `${i * 55}ms`,
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                            <span style={eyebrow}>{t.phase}</span>
                            <span style={{ ...eyebrow, color: t.risk === "high" ? "var(--danger)" : t.risk === "medium" ? "var(--warning)" : "var(--fg-dim)" }}>
                              ·{RISK_LABEL[t.risk]}
                            </span>
                            <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center" }}>
                              <StatusBadge status={status} />
                            </span>
                          </div>
                          <div style={{ fontSize: "var(--fs-base)", color: "var(--fg-strong)", lineHeight: 1.3, marginBottom: 6 }}>{t.title}</div>
                          {dep && (
                            <div style={{ fontSize: 10.5, color: "var(--fg-dim)", marginBottom: 6 }}>
                              ↳ after {(titleById[dep] ?? dep).slice(0, 24)}
                            </div>
                          )}
                          {liveCard && (
                            <div
                              className="klide-orch-activity"
                              style={{
                                fontSize: 11,
                                fontFamily: "var(--font-mono)",
                                color: liveCard.status === "error" ? "var(--danger)" : liveCard.status === "done" ? "var(--fg-subtle)" : "var(--accent)",
                                marginBottom: 6,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {liveCard.status === "running" ? "▸ " : liveCard.status === "done" ? "✓ " : "✗ "}
                              {liveCard.activity}
                            </div>
                          )}
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                            <span style={{ fontSize: 11, color: "var(--fg-subtle)" }}>{WORKER_LABEL[r.assignment.workerKind]}</span>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              {canRunReal && (
                                <button
                                  onClick={() => real.run(t, r.assignment)}
                                  title="Dispatch this plan-mode task as a real Klide harness run"
                                  className="klide-orch-run"
                                  style={{
                                    fontSize: 10,
                                    padding: "1px 8px",
                                    borderRadius: 999,
                                    border: "1px solid var(--border-strong)",
                                    color: "var(--fg-subtle)",
                                  }}
                                >
                                  ▶ run
                                </button>
                              )}
                              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontVariantNumeric: "tabular-nums", color: "var(--fg-subtle)" }}>
                                {fmtUsd(r.assignment.estimatedCostUsd ?? 0)}
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {items.length === 0 && <div style={{ fontSize: 11, color: "var(--fg-dim)", textAlign: "center", paddingTop: 16 }}>idle</div>}
                  </div>
                </div>
              );
            })}
          </div>

          {/* right rail */}
          <div style={{ width: 220, display: "flex", flexDirection: "column", gap: 16, flex: "0 0 220px" }}>
            <div className="klide-surface" style={{ padding: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--fg-strong)", marginBottom: 10 }}>Budget</div>
              <BudgetMeter spent={totalCost} max={envelope.maxCostUsd} />
              <div style={{ fontSize: 11, color: "var(--fg-subtle)", marginTop: 10 }}>Est. time {fmtMin(totalMs)}</div>
            </div>
            <button className="klide-button klide-button-primary" onClick={dispatchAllPlan} disabled={!workspaceRoot}>
              {workspaceRoot ? "Dispatch ready" : "Open a workspace"}
            </button>
            <div className="klide-surface" style={{ padding: 16, fontSize: 12, color: "var(--fg-subtle)" }}>
              <div style={{ fontWeight: 600, color: "var(--fg-strong)", marginBottom: 6 }}>Note</div>
              Plan-mode (read-only) tasks dispatch for real now. Goal-mode writes wait for the diff-review surface.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
