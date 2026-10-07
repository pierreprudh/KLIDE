// MissionGraph — the dependency-graph view of a Mission's tasks, and the
// primary way to inspect a plan.
//
// It is a pure projection of the same `dependencies` the tier board and the
// durable Markdown read (v0.6 slice 2: no second graph state model). The
// picture itself is `MissionFlow` — cards on a dotted canvas, top to bottom —
// so the same drawing can later sit in a conversation. Clicking a card opens a detail
// panel (title, phase/risk, worker, estimated cost·time, status, dependencies);
// dependency edits toggle back through the task's Markdown via
// `onToggleDependency`, so the graph never owns state the store doesn't.
import { useState } from "react";
import { wouldCreateCycle, type GraphTask } from "../agent/missionGraph";
import { MissionFlow, type MissionFlowMeta } from "./MissionFlow";
import { presentMissionCardTone, toneColor } from "../runPresentation";
import type { MissionTaskStatus } from "../agent/missionHarness";

export type MissionGraphMeta = {
  title: string;
  phase: string;
  /** Compiled task status: queued | ready | blocked | running | done | failed | … */
  status: string;
  risk?: "low" | "medium" | "high";
  description?: string;
  /** Effective worker/model label. */
  worker?: string;
  /** Pre-formatted estimate strings so the graph stays formatter-free. */
  cost?: string;
  time?: string;
  /** True when the estimated cost is above zero → render it emphasised. */
  costEmphasis?: boolean;
};

type MissionGraphProps = {
  tasks: GraphTask[];
  meta: Record<string, MissionGraphMeta>;
  editable: boolean;
  savingTaskId: string | null;
  onToggleDependency: (dependentId: string, prerequisiteId: string) => void;
};

function riskColor(risk?: string): string {
  if (risk === "high") return "var(--danger)";
  if (risk === "medium") return "var(--warning)";
  return "var(--fg-dim)";
}

export function MissionGraph({ tasks, meta, editable, savingTaskId, onToggleDependency }: MissionGraphProps) {
  const [selected, setSelected] = useState<string | null>(null);

  const selectedTask = selected ? tasks.find((task) => task.id === selected) ?? null : null;
  const selectedMeta = selected ? meta[selected] : null;

  // The canvas reads a smaller row than the detail panel: title, phase, the
  // status word when it isn't quiet, and who does it.
  const flowMeta: Record<string, MissionFlowMeta> = {};
  for (const [id, m] of Object.entries(meta)) {
    flowMeta[id] = {
      title: m.title,
      phase: m.phase,
      status: savingTaskId === id ? "saving…" : m.status,
      caption: m.worker,
    };
  }

  // Would linking `selected` to depend on `prereqId` close a loop?
  function wouldCycle(dependentId: string, prereqId: string): boolean {
    if (dependentId === prereqId) return true;
    if (tasks.find((task) => task.id === dependentId)?.dependencies.includes(prereqId)) return false; // unlink is always ok
    return wouldCreateCycle(tasks, dependentId, prereqId);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      <MissionFlow tasks={tasks} meta={flowMeta} selected={selected} onSelect={setSelected} />

      {selectedTask && selectedMeta && (
        <section style={{ minWidth: 0, border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--bg-elevated)", overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 14, padding: "12px 18px", borderBottom: "1px solid var(--border)" }}>
            <span style={{ fontSize: "var(--fs-xs)", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--fg-dim)" }}>{selectedMeta.phase}</span>
            <span style={{ fontSize: "var(--fs-xs)", textTransform: "uppercase", letterSpacing: "0.05em", color: riskColor(selectedMeta.risk) }}>{selectedMeta.risk ?? "low"}</span>
            <span style={{ fontSize: "var(--fs-xs)", fontFamily: "var(--font-mono)", color: toneColor(presentMissionCardTone(selectedMeta.status as MissionTaskStatus)) }}>{selectedMeta.status}</span>
            <button
              onClick={() => setSelected(null)}
              aria-label="Close detail"
              style={{ marginLeft: "auto", background: "transparent", border: "none", color: "var(--fg-dim)", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0 }}
            >
              ×
            </button>
          </div>
          <div style={{ padding: "16px 18px", display: "grid", gap: 16 }}>
            {/* Prose and the routing facts share a row until the panel narrows. */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16, alignItems: "start" }}>
              <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
                <div style={{ fontSize: "var(--fs-lg, 15px)", fontWeight: 600, color: "var(--fg-strong)", lineHeight: 1.35 }}>{selectedMeta.title}</div>
                {selectedMeta.description && (
                  <div style={{ fontSize: "var(--fs-base)", color: "var(--fg-subtle)", lineHeight: 1.6, maxWidth: "68ch" }}>{selectedMeta.description}</div>
                )}
              </div>
              <div style={{ display: "grid", gap: 8, minWidth: 0, justifySelf: "stretch" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                  <span style={{ fontSize: "var(--fs-xs)", color: "var(--fg-dim)" }}>Worker</span>
                  <span style={{ fontSize: "var(--fs-xs)", color: "var(--fg-subtle)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selectedMeta.worker ?? "—"}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                  <span style={{ fontSize: "var(--fs-xs)", color: "var(--fg-dim)" }}>Estimated</span>
                  <span style={{ display: "inline-flex", gap: 10, fontSize: "var(--fs-xs)", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", color: "var(--fg-subtle)" }}>
                    <span style={{ color: selectedMeta.costEmphasis ? "var(--fg-strong)" : "var(--fg-subtle)" }}>{selectedMeta.cost ?? "—"}</span>
                    <span style={{ color: "var(--fg-dim)" }}>~{selectedMeta.time ?? "—"}</span>
                  </span>
                </div>
              </div>
            </div>

            {/* Dependencies span the full width so the toggles flow across the
                panel instead of wrapping inside a narrow column. */}
            <div style={{ paddingTop: 14, borderTop: "1px solid color-mix(in srgb, var(--border) 70%, transparent)" }}>
              <div style={{ fontSize: "var(--fs-xs)", color: "var(--fg-dim)", marginBottom: 9 }}>Depends on</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 6 }}>
                {tasks.filter((task) => task.id !== selected).map((task) => {
                  const linked = selectedTask.dependencies.includes(task.id);
                  const blocked = !linked && wouldCycle(selected!, task.id);
                  const label = meta[task.id]?.title ?? task.id;
                  return (
                    <button
                      key={task.id}
                      onClick={() => { if (editable && !blocked) onToggleDependency(selected!, task.id); }}
                      disabled={!editable || blocked || savingTaskId !== null}
                      aria-pressed={linked}
                      title={blocked ? "Linking here would create a cycle" : label}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        minWidth: 0,
                        textAlign: "left",
                        padding: "5px 10px",
                        borderRadius: "var(--radius-sm)",
                        border: "1px solid",
                        borderColor: linked ? "var(--accent)" : "var(--border)",
                        background: linked ? "color-mix(in srgb, var(--accent-soft) 40%, transparent)" : "transparent",
                        color: linked ? "var(--fg-strong)" : "var(--fg-subtle)",
                        cursor: editable && !blocked ? "pointer" : "default",
                        opacity: blocked ? 0.4 : 1,
                        fontSize: "var(--fs-xs)",
                      }}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
                    </button>
                  );
                })}
                {tasks.length <= 1 && <div style={{ fontSize: "var(--fs-xs)", color: "var(--fg-dim)" }}>No other tasks</div>}
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
