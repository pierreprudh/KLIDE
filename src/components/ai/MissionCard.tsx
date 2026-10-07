// MissionCard — a Mission drawn in the conversation that planned it.
//
// `plan_mission` returns a draft's id and the route this Run would give it;
// the card reads the durable bundle from disk (the same `mission_list` the
// console polls — Rust emits no Mission event), draws it with MissionFlow,
// and offers the one decision that is the operator's: approve and run. After
// approval the card keeps following the supervisor until the Mission
// completes or parks, so the thread shows the work landing without a visit
// to Mission Control. A Delegate attempt that ends needs a human verdict;
// the selected card offers it in place.
//
// Nothing here is a source of truth: statuses come from the board's
// arbitration over the compiled bundle, and every button is a Rust command.
import { useEffect, useMemo, useState } from "react";
import {
  approveDurableMission,
  compileDurableMissionBundle,
  listDurableMissions,
  reviewDurableMissionAttempt,
  terminalOutcome,
  type DurableMissionBundle,
  type DurableMissionTaskDispatch,
} from "../../agent/durableMissions";
import { presentMissionBoard, type MissionTaskRow } from "../../agent/missionBoard";
import type { GraphTask } from "../../agent/missionGraph";
import { MissionFlow, type MissionFlowMeta } from "../MissionFlow";
import { notify } from "../../toast";
import { errMessage } from "../../errors";

/** What `plan_mission` hands back, as the handler shaped it. */
export type PlanMissionReceipt = {
  missionId: string;
  title: string;
  route?: DurableMissionTaskDispatch;
};

export function parsePlanMissionReceipt(content: string): PlanMissionReceipt | null {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    if (value?.action !== "plan" || typeof value.missionId !== "string") return null;
    const route = value.route as DurableMissionTaskDispatch | undefined;
    return {
      missionId: value.missionId,
      title: typeof value.title === "string" ? value.title : value.missionId,
      route: route && typeof route.provider === "string" && typeof route.model === "string" ? route : undefined,
    };
  } catch {
    return null;
  }
}

const POLL_MS = 1200;

/** The bundle for one Mission, re-read while it can still change. */
function useMissionBundle(workspaceRoot: string | null | undefined, missionId: string) {
  const [bundle, setBundle] = useState<DurableMissionBundle | null>(null);
  const [missing, setMissing] = useState(false);
  const settled = bundle ? terminalOutcome(bundle.events) !== null : false;

  useEffect(() => {
    if (!workspaceRoot) return;
    let live = true;
    let timer: number | null = null;
    const read = async () => {
      try {
        const found = (await listDurableMissions(workspaceRoot)).find((b) => b.mission.id === missionId) ?? null;
        if (!live) return;
        setMissing(found === null);
        setBundle((prev) => {
          if (!found) return prev;
          const prevSeq = prev?.events[prev.events.length - 1]?.seq ?? -1;
          const nextSeq = found.events[found.events.length - 1]?.seq ?? -1;
          return prev && prevSeq === nextSeq && prev.tasks.length === found.tasks.length ? prev : found;
        });
      } catch {
        if (live) setMissing(true);
      }
      if (live && !settled) timer = window.setTimeout(() => void read(), POLL_MS);
    };
    void read();
    return () => {
      live = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [workspaceRoot, missionId, settled]);

  return { bundle, missing };
}

export function MissionCard({ receipt, workspaceRoot }: { receipt: PlanMissionReceipt; workspaceRoot?: string | null }) {
  const { bundle, missing } = useMissionBundle(workspaceRoot, receipt.missionId);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const view = useMemo(() => {
    if (!bundle) return null;
    const state = compileDurableMissionBundle(bundle);
    const mission = state.missions[bundle.mission.id];
    const approved = mission?.approvedAtMs != null;
    const terminal = terminalOutcome(bundle.events);
    const rows = presentMissionBoard({
      state,
      missionId: bundle.mission.id,
      plan: bundle.tasks.map((task) => ({ taskId: task.id, title: task.title, dependsOn: task.dependencies })),
      liveCards: {},
      missionLive: approved && terminal === null,
    });
    const rowById = new Map(rows.map((row) => [row.taskId, row]));
    const tasks: GraphTask[] = bundle.tasks.map((task) => ({ id: task.id, dependencies: task.dependencies }));
    const meta: Record<string, MissionFlowMeta> = {};
    for (const task of bundle.tasks) {
      const row = rowById.get(task.id);
      meta[task.id] = {
        title: task.title,
        phase: task.phase,
        status: row?.status ?? "queued",
        caption: approved ? routeLabel(task.dispatch) : row?.block?.reason,
      };
    }
    const done = rows.filter((row) => row.status === "done").length;
    return { approved, terminal, rows, rowById, tasks, meta, done };
  }, [bundle]);

  async function approveAndRun() {
    if (!workspaceRoot || !bundle || !receipt.route || busy) return;
    setBusy(true);
    try {
      await approveDurableMission(workspaceRoot, bundle.mission.id, {
        tasks: bundle.tasks.map((task) => ({ taskId: task.id, ...receipt.route! })),
        autoStart: true,
      });
    } catch (error) {
      notify(`Couldn't start the Mission — ${errMessage(error)}`, { tone: "warn" });
    } finally {
      setBusy(false);
    }
  }

  async function review(row: MissionTaskRow, accepted: boolean) {
    if (!workspaceRoot || !bundle || !row.lastAttempt || busy) return;
    setBusy(true);
    try {
      await reviewDurableMissionAttempt(workspaceRoot, bundle.mission.id, { taskId: row.taskId, runId: row.lastAttempt.runId, accepted });
    } catch (error) {
      notify(`Couldn't record the review — ${errMessage(error)}`, { tone: "warn" });
    } finally {
      setBusy(false);
    }
  }

  if (missing && !bundle) {
    return <Frame title={receipt.title}><Line dim>This Mission is no longer on disk.</Line></Frame>;
  }
  if (!view || !bundle) {
    return <Frame title={receipt.title}><Line dim>Reading the plan…</Line></Frame>;
  }

  const selectedTask = selected ? bundle.tasks.find((task) => task.id === selected) ?? null : null;
  const selectedRow = selected ? view.rowById.get(selected) ?? null : null;
  const total = bundle.tasks.length;

  return (
    <Frame title={bundle.mission.title}>
      <MissionFlow tasks={view.tasks} meta={view.meta} selected={selected} onSelect={setSelected} />

      {selectedTask && (
        <div style={{ display: "grid", gap: 6, padding: "10px 14px 2px" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-strong)" }}>{selectedTask.title}</span>
          {selectedTask.bodyMarkdown.trim() && (
            <span style={{ fontSize: 12.5, lineHeight: 1.55, color: "var(--fg-subtle)", whiteSpace: "pre-wrap" }}>{selectedTask.bodyMarkdown.trim()}</span>
          )}
          {selectedTask.acceptanceCriteria.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.55, color: "var(--fg-subtle)" }}>
              {selectedTask.acceptanceCriteria.map((criterion, i) => <li key={i}>{criterion}</li>)}
            </ul>
          )}
          {selectedRow?.status === "review" && selectedRow.lastAttempt && (
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <button className="klide-button klide-button-primary" disabled={busy} onClick={() => void review(selectedRow, true)}>Accept</button>
              <button className="klide-button" disabled={busy} onClick={() => void review(selectedRow, false)}>Reject</button>
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px 12px", minHeight: 40 }}>
        {!view.approved ? (
          <>
            <button className="klide-button klide-button-primary" disabled={busy || !receipt.route || !workspaceRoot} onClick={() => void approveAndRun()}>
              {busy ? "Starting…" : `Approve and run (${total})`}
            </button>
            <Line dim>{receipt.route ? `${routeLabel(receipt.route)} · ${receipt.route.requireDiffReview ? "edits reviewed" : "edits auto-applied"}` : "No route for this Run"}</Line>
          </>
        ) : view.terminal?.event.type === "mission_parked" ? (
          <Line tone="var(--warning)">Parked · {view.terminal.event.reason}</Line>
        ) : view.terminal ? (
          <Line>Done · {view.done} of {total}</Line>
        ) : (
          <Line dim>{view.done} of {total} done · running</Line>
        )}
      </div>
    </Frame>
  );
}

function routeLabel(route: DurableMissionTaskDispatch | undefined): string {
  if (!route) return "";
  return route.workerKind === "delegate" ? route.provider : `${route.provider} · ${route.model}`;
}

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      aria-label="Mission"
      style={{ margin: "10px 0 6px", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--bg-elevated)", overflow: "hidden", minWidth: 0 }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "10px 14px 8px", borderBottom: "1px solid var(--border)" }}>
        <span style={{ fontSize: 11, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--fg-dim)" }}>Mission</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
      </div>
      {children}
    </section>
  );
}

function Line({ children, dim, tone }: { children: React.ReactNode; dim?: boolean; tone?: string }) {
  return <span style={{ fontSize: 12, color: tone ?? (dim ? "var(--fg-dim)" : "var(--fg-subtle)"), fontVariantNumeric: "tabular-nums" }}>{children}</span>;
}
