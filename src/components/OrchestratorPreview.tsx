import { useMemo } from "react";
import { createOrchestratorPreviewState } from "../agent/orchestratorFixture";
import { inspectOrchestratorMission, type OrchestratorState } from "../agent/orchestrator";
import { remainingCost, remainingDuration } from "../agent/budgetLedger";
import type { CapacitySlot } from "../agent/capacityPlanner";
import type { MissionTask } from "../agent/missionHarness";
import type { WorkerAssignment } from "../agent/routingPolicy";
import { buildGoalLoopDemo, type GoalLoopDemo } from "../agent/goalLoopDemo";
import { latestGateAttempt, type GoalLoopGate, type GoalLoopGateVerdict } from "../agent/goalLoop";

type Props = {
  state?: OrchestratorState;
  missionId?: string;
};

export function OrchestratorPreview({ state: providedState, missionId }: Props) {
  const state = useMemo(() => providedState ?? createOrchestratorPreviewState(), [providedState]);
  const activeMissionId = missionId ?? state.missions.activeMissionId;
  const inspection = activeMissionId ? inspectOrchestratorMission(state, activeMissionId) : null;

  if (!inspection) {
    return (
      <div style={rootStyle}>
        <div style={emptyStyle}>No orchestrator mission selected.</div>
      </div>
    );
  }

  const { mission, tasks, assignments, budget, capacity, validations, progress } = inspection;
  const assignmentByTask = new Map(assignments.map((assignment) => [assignment.taskId, assignment]));

  // Pure, deterministic worked example — safe to compute after the early return
  // (it is a plain call, not a hook).
  const goalLoop = buildGoalLoopDemo({
    goal: mission.intent || mission.title,
    definitionOfDone: tasks[0]?.acceptanceCriteria ?? [],
  });

  return (
    <div style={rootStyle}>
      <header style={headerStyle}>
        <div style={{ minWidth: 0 }}>
          <div style={eyebrowStyle}>Orchestrator</div>
          <h2 style={titleStyle}>{mission.title}</h2>
          <p style={intentStyle}>{mission.intent}</p>
        </div>
        <div style={headerMetaStyle}>
          <Badge label={mission.mode} tone="accent" />
          <Badge label={mission.status} tone={mission.status === "failed" ? "danger" : "neutral"} />
        </div>
      </header>

      <div style={summaryGridStyle}>
        <Metric label="Tasks" value={`${progress.done}/${progress.total}`} hint={`${progress.running} running`} />
        <Metric
          label="Budget"
          value={budget ? formatMoney(budget.spentCostUsd) : "n/a"}
          hint={budget ? `${formatMoney(remainingCost(budget))} left` : "No ledger"}
        />
        <Metric
          label="Time"
          value={budget ? formatDuration(budget.spentDurationMs) : "n/a"}
          hint={budget ? `${formatDuration(remainingDuration(budget))} left` : "No limit"}
        />
        <Metric
          label="Validation"
          value={`${Object.values(validations).filter((v) => v.blockingFailures.length === 0).length}/${tasks.length}`}
          hint="contracts clear"
        />
      </div>

      <section style={sectionStyle}>
        <div style={sectionHeaderStyle}>
          <span>Plan Graph</span>
          <span style={sectionHintStyle}>routing, cost, capacity, validation</span>
        </div>
        <div style={{ display: "grid", gap: 8 }}>
          {tasks.map((task, index) => (
            <TaskRow
              key={task.id}
              index={index + 1}
              task={task}
              assignment={assignmentByTask.get(task.id)}
              validation={validations[task.id]}
            />
          ))}
        </div>
      </section>

      <GoalLoopSection demo={goalLoop} />

      <div style={twoColumnStyle}>
        <section style={sectionStyle}>
          <div style={sectionHeaderStyle}>
            <span>Capacity</span>
            <span style={sectionHintStyle}>current slots</span>
          </div>
          <div style={{ display: "grid", gap: 7 }}>
            {Object.values(capacity.slots).map((slot) => (
              <CapacityRow key={slot.kind} slot={slot} />
            ))}
          </div>
        </section>

        <section style={sectionStyle}>
          <div style={sectionHeaderStyle}>
            <span>Budget Policy</span>
            <span style={sectionHintStyle}>{budget?.envelope.preset ?? "none"}</span>
          </div>
          {budget ? (
            <div style={{ display: "grid", gap: 9 }}>
              <BudgetLine label="Max spend" value={formatMoney(budget.envelope.maxCostUsd)} />
              <BudgetLine label="Max duration" value={formatDuration(budget.envelope.maxDurationMs)} />
              <BudgetLine label="Retries" value={`${budget.retryCount}/${budget.envelope.maxRetries}`} />
              <BudgetLine label="Escalation" value={budget.envelope.askBeforeEscalation ? "ask first" : "allowed"} />
              <BudgetLine label="Status" value={budget.status} />
            </div>
          ) : (
            <div style={emptyStyle}>No budget attached.</div>
          )}
        </section>
      </div>
    </div>
  );
}

function TaskRow({
  index,
  task,
  assignment,
  validation,
}: {
  index: number;
  task: MissionTask;
  assignment?: WorkerAssignment;
  validation?: { total: number; required: number; passed: number; failed: number; blockingFailures: unknown[] };
}) {
  return (
    <div style={taskRowStyle}>
      <div style={taskNumberStyle}>{index}</div>
      <div style={{ minWidth: 0, display: "grid", gap: 5 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <strong style={taskTitleStyle}>{task.title}</strong>
          <Badge label={task.risk} tone={task.risk === "high" ? "danger" : task.risk === "medium" ? "warn" : "neutral"} />
          <Badge label={task.status} tone="neutral" />
        </div>
        <div style={taskMetaStyle}>
          <span>{assignment ? `${assignment.workerKind} / ${assignment.modelTier}` : "unassigned"}</span>
          <span>{assignment?.provider ?? "no provider"}</span>
          <span>{formatMoney(assignment?.estimatedCostUsd ?? null)}</span>
          <span>{formatDuration(assignment?.estimatedDurationMs ?? null)}</span>
        </div>
        {assignment && <div style={reasonStyle}>{assignment.reason}</div>}
        <div style={criteriaStyle}>
          {task.acceptanceCriteria.map((criterion) => (
            <span key={criterion}>{criterion}</span>
          ))}
        </div>
      </div>
      <div style={validationStyle}>
        <span style={{ color: validation?.blockingFailures.length ? "var(--danger)" : "var(--fg-strong)" }}>
          {validation ? `${validation.passed}/${validation.total}` : "0/0"}
        </span>
        <span style={{ color: "var(--fg-dim)" }}>checks</span>
      </div>
    </div>
  );
}

function CapacityRow({ slot }: { slot: CapacitySlot }) {
  const pct = slot.limit > 0 ? Math.min(100, Math.round((slot.used / slot.limit) * 100)) : 0;
  return (
    <div style={{ display: "grid", gap: 5 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--fg-strong)" }}>{slot.label}</span>
        <span style={monoStyle}>
          {slot.used}/{slot.limit}
          {slot.queued > 0 ? ` +${slot.queued}` : ""}
        </span>
      </div>
      <div style={meterTrackStyle}>
        <div style={{ ...meterFillStyle, width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div style={metricStyle}>
      <span style={metricLabelStyle}>{label}</span>
      <strong style={metricValueStyle}>{value}</strong>
      <span style={metricHintStyle}>{hint}</span>
    </div>
  );
}

function BudgetLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12 }}>
      <span style={{ color: "var(--fg-subtle)" }}>{label}</span>
      <span style={monoStyle}>{value}</span>
    </div>
  );
}

// Plain colored text — the tone carries state, no chip box (Design.md).
function Badge({ label, tone }: { label: string; tone: "accent" | "danger" | "warn" | "neutral" }) {
  const color =
    tone === "accent"
      ? "var(--accent)"
      : tone === "danger"
        ? "var(--danger)"
        : tone === "warn"
          ? "var(--warning)"
          : "var(--fg-subtle)";
  return (
    <span
      style={{
        color,
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

function GoalLoopSection({ demo }: { demo: GoalLoopDemo }) {
  const { spec, state, next } = demo;
  const gateLabel = (id: string) => spec.gates.find((g: GoalLoopGate) => g.id === id)?.label ?? id;
  const stopReason = state.stopReason;
  const statusTone =
    state.status === "passed"
      ? "accent"
      : state.status === "failed" || state.status === "stalled" || state.status === "budget-exhausted"
        ? "danger"
        : "neutral";

  return (
    <section style={sectionStyle}>
      <div style={sectionHeaderStyle}>
        <span>Goal Loop</span>
        <span style={sectionHintStyle}>run snapshot → gates → done</span>
      </div>
      <div style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={goalTextStyle}>{spec.goal}</span>
          <Badge label={state.status} tone={statusTone} />
          <span style={loopMetaStyle}>
            iter {state.iteration}/{spec.limits.maxIterations}
          </span>
        </div>

        <div style={{ display: "grid", gap: 4 }}>
          <span style={metricLabelStyle}>Definition of done</span>
          <div style={criteriaStyle}>
            {spec.definitionOfDone.map((d) => (
              <span key={d}>{d}</span>
            ))}
          </div>
        </div>

        <div style={{ display: "grid", gap: 5 }}>
          <span style={metricLabelStyle}>Run snapshots (sample)</span>
          {demo.snapshots.map((s) => (
            <div key={s.label} style={tapeRowStyle}>
              <Badge label={s.summary.status} tone={s.summary.status === "passed" ? "accent" : "danger"} />
              <span style={{ color: "var(--fg-strong)" }}>{s.label}</span>
              <span style={tapeDetailStyle}>
                {s.summary.filesChanged} files · {s.summary.commandsRun} cmd · {s.summary.commandsFailed} failed
              </span>
            </div>
          ))}
        </div>

        <div style={{ display: "grid", gap: 6 }}>
          <span style={metricLabelStyle}>Gates</span>
          {spec.gates.map((gate: GoalLoopGate) => {
            const latest = latestGateAttempt(state.attempts, gate.id);
            const revisions = state.revisionsByGate[gate.id] ?? 0;
            return (
              <div key={gate.id} style={gateRowStyle}>
                <VerdictDot verdict={latest?.verdict ?? null} />
                <span style={gateLabelStyle}>{gate.label}</span>
                <span style={gateOwnerStyle}>
                  {gate.owner}
                  {gate.required ? "" : " · optional"}
                  {revisions > 0 ? ` · ${revisions} revise` : ""}
                </span>
              </div>
            );
          })}
        </div>

        <div style={{ display: "grid", gap: 5 }}>
          <span style={metricLabelStyle}>Loop tape</span>
          {state.attempts.map((a, i) => (
            <div key={`${a.id}:${i}`} style={tapeRowStyle}>
              <VerdictDot verdict={a.verdict} />
              <span style={{ color: "var(--fg-strong)" }}>{gateLabel(a.gateId)}</span>
              <span style={tapeDetailStyle}>{a.feedback ?? a.evidence ?? ""}</span>
            </div>
          ))}
        </div>

        <div style={loopFooterStyle}>
          {stopReason ? (
            <Badge label={stopReason} tone={stopReason === "gates-clean" ? "accent" : "danger"} />
          ) : null}
          <span style={tapeDetailStyle}>{describeNext(next)}</span>
        </div>
      </div>
    </section>
  );
}

function VerdictDot({ verdict }: { verdict: GoalLoopGateVerdict | null }) {
  const map: Record<GoalLoopGateVerdict, { ch: string; color: string }> = {
    pass: { ch: "✓", color: "var(--accent)" },
    fail: { ch: "✗", color: "var(--danger)" },
    waive: { ch: "~", color: "var(--fg-subtle)" },
  };
  const v = verdict ? map[verdict] : { ch: "·", color: "var(--fg-dim)" };
  return (
    <span style={{ width: 14, textAlign: "center", color: v.color, fontFamily: "var(--font-mono)", fontSize: 12 }}>
      {v.ch}
    </span>
  );
}

function describeNext(next: GoalLoopDemo["next"]): string {
  switch (next.type) {
    case "record-result":
      return "Record the result — every required gate passed.";
    case "stop":
      return next.detail;
    case "revise":
      return `Revise: ${next.reason}`;
    case "ask-human":
      return next.reason;
    case "draft-plan":
    case "run-delivery":
      return next.reason;
  }
}

function formatMoney(value: number | null): string {
  if (value === null) return "unlimited";
  if (value === 0) return "$0";
  return `$${value.toFixed(value >= 10 ? 0 : 2)}`;
}

function formatDuration(value: number | null): string {
  if (value === null) return "unlimited";
  if (value <= 0) return "0m";
  const minutes = Math.round(value / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

const rootStyle = {
  height: "100%",
  minHeight: 0,
  overflow: "auto",
  padding: 18,
  display: "grid",
  alignContent: "start",
  gap: 14,
  background: "var(--bg)",
  color: "var(--fg)",
} satisfies React.CSSProperties;

const headerStyle = {
  display: "flex",
  alignItems: "start",
  justifyContent: "space-between",
  gap: 16,
  paddingBottom: 2,
} satisfies React.CSSProperties;

const eyebrowStyle = {
  marginBottom: 5,
  color: "var(--fg-dim)",
  fontSize: 11,
  fontFamily: "var(--font-mono)",
  textTransform: "uppercase",
} satisfies React.CSSProperties;

const titleStyle = {
  margin: 0,
  color: "var(--fg-strong)",
  fontSize: 18,
  lineHeight: 1.2,
  fontWeight: 650,
} satisfies React.CSSProperties;

const intentStyle = {
  margin: "7px 0 0",
  maxWidth: 760,
  color: "var(--fg-subtle)",
  fontSize: 13,
  lineHeight: 1.45,
} satisfies React.CSSProperties;

const headerMetaStyle = {
  display: "flex",
  gap: 6,
  flexWrap: "wrap",
  justifyContent: "end",
} satisfies React.CSSProperties;

const summaryGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(120px, 1fr))",
  gap: 8,
} satisfies React.CSSProperties;

const metricStyle = {
  minWidth: 0,
  padding: "10px 11px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--bg-elevated)",
  display: "grid",
  gap: 3,
} satisfies React.CSSProperties;

const metricLabelStyle = {
  color: "var(--fg-dim)",
  fontSize: 10,
  fontFamily: "var(--font-mono)",
  textTransform: "uppercase",
} satisfies React.CSSProperties;

const metricValueStyle = {
  color: "var(--fg-strong)",
  fontSize: 17,
  lineHeight: 1.1,
} satisfies React.CSSProperties;

const metricHintStyle = {
  color: "var(--fg-subtle)",
  fontSize: 11,
} satisfies React.CSSProperties;

const sectionStyle = {
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--bg-elevated)",
  padding: 12,
  minWidth: 0,
} satisfies React.CSSProperties;

const sectionHeaderStyle = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 10,
  marginBottom: 10,
  color: "var(--fg-strong)",
  fontSize: 12,
  fontWeight: 650,
} satisfies React.CSSProperties;

const sectionHintStyle = {
  color: "var(--fg-dim)",
  fontSize: 11,
  fontWeight: 400,
} satisfies React.CSSProperties;

const twoColumnStyle = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1.2fr) minmax(260px, 0.8fr)",
  gap: 14,
} satisfies React.CSSProperties;

const taskRowStyle = {
  display: "grid",
  gridTemplateColumns: "24px minmax(0, 1fr) auto",
  gap: 10,
  alignItems: "start",
  padding: "10px 0",
  borderTop: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
} satisfies React.CSSProperties;

const taskNumberStyle = {
  width: 22,
  height: 22,
  display: "grid",
  placeItems: "center",
  color: "var(--fg-subtle)",
  fontSize: 11,
  fontFamily: "var(--font-mono)",
} satisfies React.CSSProperties;

const taskTitleStyle = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "var(--fg-strong)",
  fontSize: 13,
  fontWeight: 650,
} satisfies React.CSSProperties;

const taskMetaStyle = {
  display: "flex",
  flexWrap: "wrap",
  gap: "5px 10px",
  color: "var(--fg-subtle)",
  fontSize: 11,
  fontFamily: "var(--font-mono)",
} satisfies React.CSSProperties;

const reasonStyle = {
  color: "var(--fg-subtle)",
  fontSize: 12,
  lineHeight: 1.4,
} satisfies React.CSSProperties;

const criteriaStyle = {
  display: "flex",
  flexWrap: "wrap",
  gap: 5,
  color: "var(--fg-dim)",
  fontSize: 11,
} satisfies React.CSSProperties;

const validationStyle = {
  display: "grid",
  justifyItems: "end",
  gap: 2,
  fontSize: 11,
  fontFamily: "var(--font-mono)",
} satisfies React.CSSProperties;

const monoStyle = {
  color: "var(--fg-strong)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  whiteSpace: "nowrap",
} satisfies React.CSSProperties;

const goalTextStyle = {
  flex: 1,
  minWidth: 0,
  color: "var(--fg-strong)",
  fontSize: 13,
  fontWeight: 650,
  lineHeight: 1.3,
} satisfies React.CSSProperties;

const loopMetaStyle = {
  color: "var(--fg-dim)",
  fontSize: 11,
  fontFamily: "var(--font-mono)",
  whiteSpace: "nowrap",
} satisfies React.CSSProperties;

const gateRowStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 12,
} satisfies React.CSSProperties;

const gateLabelStyle = {
  flex: 1,
  minWidth: 0,
  color: "var(--fg)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} satisfies React.CSSProperties;

const gateOwnerStyle = {
  color: "var(--fg-dim)",
  fontSize: 10,
  fontFamily: "var(--font-mono)",
  whiteSpace: "nowrap",
} satisfies React.CSSProperties;

const tapeRowStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 12,
  minWidth: 0,
} satisfies React.CSSProperties;

const tapeDetailStyle = {
  flex: 1,
  minWidth: 0,
  color: "var(--fg-subtle)",
  fontSize: 11,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} satisfies React.CSSProperties;

const loopFooterStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  paddingTop: 10,
  borderTop: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
} satisfies React.CSSProperties;

const meterTrackStyle = {
  height: 5,
  borderRadius: 999,
  background: "var(--bg)",
  overflow: "hidden",
  border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
} satisfies React.CSSProperties;

const meterFillStyle = {
  height: "100%",
  background: "var(--accent)",
  borderRadius: 999,
} satisfies React.CSSProperties;

const emptyStyle = {
  color: "var(--fg-subtle)",
  fontSize: 12,
  lineHeight: 1.45,
} satisfies React.CSSProperties;
