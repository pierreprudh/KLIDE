import { MissionWorkflowIcon, ChevronIcon } from "../../icons";
import { renderMarkdown } from "../markdown";
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
  saveDurableMissionTask,
  requestDurableMissionTask,
  setDurableMissionPolicy,
  terminalOutcome,
  type DurableMissionBundle,
  type DurableMissionTaskDispatch,
} from "../../agent/durableMissions";
import { presentMissionBoard, type MissionTaskRow } from "../../agent/missionBoard";
import type { GraphTask } from "../../agent/missionGraph";
import { MissionFlow, type MissionFlowMeta } from "../MissionFlow";
import { notify } from "../../toast";
import { errMessage } from "../../errors";
import { makerMark, modelIdentity } from "../../modelIdentity";
import { useMissionGates, type MissionGate } from "./missionGates";
import { InlineCommandReview, type CommandInterpreter } from "../InlineCommandReview";
import { InlineDiffReview } from "../InlineDiffReview";
import { ProviderLogo } from "./icons";
import { Tooltip } from "../Tooltip";
import { MissionTaskEditor } from "./MissionTaskEditor";
import { GOAL_POLICIES, nextGoalPolicy, type GoalPolicy } from "./autonomyLadder";
import { QuestionCard } from "./QuestionCard";
import { providerName } from "../../agent/providers";
import type { ProviderId } from "../../agent/types";

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
  const settled = bundle ? terminalOutcome(bundle.events)?.event.type === "mission_completed" : false;

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
          return prev && prevSeq >= nextSeq && prev.tasks.length === found.tasks.length && prev.report?.markdown === found.report?.markdown ? prev : found;
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

  return { bundle, missing, setBundle };
}

type MissionCardProps = { variant?: "conversation" | "sidebar"; receipt: PlanMissionReceipt; workspaceRoot?: string | null; onOpenRun?: (runId: string) => void };

export function MissionCard(props: MissionCardProps) {
  return <MissionCardBody key={`${props.workspaceRoot}:${props.receipt.missionId}`} {...props} />;
}

function MissionCardBody({ receipt, workspaceRoot, onOpenRun, variant = "conversation" }: MissionCardProps) {
  const { bundle, missing, setBundle } = useMissionBundle(workspaceRoot, receipt.missionId);
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [policy, setPolicy] = useState<GoalPolicy>("review");
  const [dirty, setDirty] = useState(false);
  const [routes, setRoutes] = useState<Record<string, DurableMissionTaskDispatch>>({});

  // The running attempts, so their gates reach this card. A Delegate attempt
  // has no Harness transcript to follow; its verdict comes after exit.
  const running = useMemo(() => {
    if (!bundle) return [];
    const out: Array<{ taskId: string; runId: string }> = [];
    for (const task of bundle.tasks) {
      if (task.dispatch?.workerKind === "delegate") continue;
      const attached = bundle.events.filter((line) => line.event.type === "attempt_attached" && line.event.taskId === task.id);
      const last = attached[attached.length - 1];
      if (!last || last.event.type !== "attempt_attached") continue;
      const runId = last.event.runId;
      const settled = bundle.events.some((line) =>
        (line.event.type === "attempt_validation_recorded" || line.event.type === "attempt_settled" || line.event.type === "attempt_dispatch_failed" || line.event.type === "attempt_interrupted")
        && line.event.runId === runId);
      if (!settled) out.push({ taskId: task.id, runId });
    }
    return out;
  }, [bundle]);
  const { gates, answerPermission, answerDiff, answerQuestion } = useMissionGates(running);

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
        caption: row?.block?.reason,
        worker: <RouteMark
          route={approved ? task.dispatch : routes[task.id] ?? receipt.route}
          size={20}
          onOpen={row?.lastAttempt && onOpenRun ? () => onOpenRun(row.lastAttempt!.runId) : undefined}
        />,
        status: gates.some((gate) => gate.taskId === task.id) ? "waiting" : row?.status ?? "queued",
      };
    }
    const done = rows.filter((row) => row.status === "done").length;
    return { approved, terminal, rows, rowById, tasks, meta, done };
  }, [bundle, gates, routes, receipt.route, onOpenRun]);

  async function approveAndRun() {
    if (!workspaceRoot || !bundle || !receipt.route || busy || dirty) return;
    setBusy(true);
    try {
      setBundle(await approveDurableMission(workspaceRoot, bundle.mission.id, {
        tasks: bundle.tasks.map((task) => ({ taskId: task.id, ...(routes[task.id] ?? receipt.route!), ...(policy === "full" ? { requireDiffReview: false, autoApproveCommands: true } : policy === "auto" ? { requireDiffReview: false, autoApproveCommands: false } : { autoApproveCommands: false }) })),
        autoStart: true,
      }));
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
      setBundle(await reviewDurableMissionAttempt(workspaceRoot, bundle.mission.id, { taskId: row.taskId, runId: row.lastAttempt.runId, accepted }));
    } catch (error) {
      notify(`Couldn't record the review — ${errMessage(error)}`, { tone: "warn" });
    } finally {
      setBusy(false);
    }
  }

  if (missing && !bundle) {
    return <Frame title={receipt.title} variant={variant}><Line dim>This Mission is no longer on disk.</Line></Frame>;
  }
  if (!view || !bundle) {
    return <Frame title={receipt.title} variant={variant}><Line dim>Reading the plan…</Line></Frame>;
  }

  const selectedTask = selected ? bundle.tasks.find((task) => task.id === selected) ?? null : null;
  const selectedRow = selected ? view.rowById.get(selected) ?? null : null;
  const total = bundle.tasks.length;
  const currentPolicy = view.approved
    ? bundle.tasks.every((task) => task.dispatch?.autoApproveCommands && !task.dispatch.requireDiffReview) ? "full" : bundle.tasks.every((task) => !task.dispatch?.requireDiffReview) ? "auto" : "review"
    : policy;
  const policyChoice = GOAL_POLICIES.find((choice) => choice.key === currentPolicy)!;
  const nextPolicy = nextGoalPolicy(currentPolicy);

  const completed = view.terminal?.event.type === "mission_completed";
  const compact = variant === "sidebar" && gates.length === 0 && (!completed || !expanded);
  const detailsToggle = variant === "sidebar" && completed && gates.length === 0 ? <button type="button" aria-label={compact ? "Expand Mission details" : "Compact Mission"} aria-expanded={!compact} title={compact ? "Expand Mission details" : "Compact Mission"} onClick={() => setExpanded(!expanded)} style={{ marginLeft: "auto", flexShrink: 0, display: "grid", placeItems: "center", width: 24, height: 24, padding: 0, border: 0, background: "transparent", color: "var(--fg-dim)", cursor: "pointer" }}><ChevronIcon size={14} open={!compact} /></button> : undefined;
  if (compact) return <Frame title={bundle.mission.title} variant={variant} action={detailsToggle}>
    <div style={{ padding: "0 14px 12px", display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <Line dim>{view.terminal?.event.type === "mission_parked" ? "Parked" : completed ? "Completed" : view.approved ? "Running" : "Draft"}</Line>
        <Line dim>{view.done}/{total}</Line>
      </div>
      {view.terminal?.event.type === "mission_parked" && <Line dim>{view.terminal.event.reason}</Line>}
      <div role="progressbar" aria-label="Mission progress" aria-valuenow={view.done} aria-valuemin={0} aria-valuemax={Math.max(total, 1)} style={{ height: 2, borderRadius: 2, overflow: "hidden", background: "var(--border)" }}>
        <div style={{ width: `${view.done / Math.max(total, 1) * 100}%`, height: "100%", borderRadius: 2, background: "var(--accent)", opacity: 0.5, transition: "width var(--motion-med) var(--ease-out)" }} />
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
          {bundle.tasks.map(task => { const attempt = view.rowById.get(task.id)?.lastAttempt; return task.dispatch ? <RouteMark key={task.id} route={task.dispatch} size={14} onOpen={attempt && onOpenRun ? () => onOpenRun(attempt.runId) : undefined} /> : null; })}
        </div>
        {completed ? <button className="github-observer-action" style={{ fontSize: 11, flexShrink: 0 }} onClick={() => setExpanded(true)}>View report</button> : !view.approved ? <Line dim>Awaiting approval in chat</Line> : null}
      </div>
    </div>
  </Frame>;

  return (
    <Frame title={bundle.mission.title} variant={variant} action={detailsToggle}>
      <MissionFlow tasks={view.tasks} meta={view.meta} selected={selected} onSelect={(id) => { if (dirty) notify("Save the task before selecting another", { tone: "warn" }); else setSelected(id); }} />

      {selectedTask && !view.approved && (
        <MissionTaskEditor key={`${selectedTask.id}:${selectedTask.updatedMs}`} task={selectedTask} tasks={bundle.tasks} route={routes[selectedTask.id] ?? receipt.route} busy={busy} onDirty={setDirty} onRoute={(route) => setRoutes((current) => ({ ...current, [selectedTask.id]: route }))} onSave={async (input) => {
          if (!workspaceRoot || busy) return;
          setBusy(true);
          try { setBundle(await saveDurableMissionTask(workspaceRoot, bundle.mission.id, input)); }
          catch (error) { notify(`Couldn't save task — ${errMessage(error)}`, { tone: "warn" }); }
          finally { setBusy(false); }
        }} />
      )}
      {selectedTask && view.approved && (
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
          {selectedRow?.lastAttempt && onOpenRun && <button className="klide-button" onClick={() => onOpenRun(selectedRow.lastAttempt!.runId)}>Open worker</button>}
          {selectedRow && view.terminal?.event.type === "mission_parked" && selectedRow.status !== "done" && selectedRow.status !== "review" && selectedRow.ready && (
            <button className="klide-button" disabled={busy} onClick={async () => {
              if (!workspaceRoot || busy) return;
              setBusy(true);
              try { setBundle(await requestDurableMissionTask(workspaceRoot, bundle.mission.id, selectedRow.taskId)); }
              catch (error) { notify(`Couldn't retry task — ${errMessage(error)}`, { tone: "warn" }); }
              finally { setBusy(false); }
            }}>{selectedRow.lastAttempt ? "Retry task" : "Run task"}</button>
          )}
          {selectedRow?.status === "review" && selectedRow.lastAttempt && (
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <button className="klide-button klide-button-primary" disabled={busy} onClick={() => void review(selectedRow, true)}>Accept</button>
              <button className="klide-button" disabled={busy} onClick={() => void review(selectedRow, false)}>Reject</button>
            </div>
          )}
        </div>
      )}

      {gates.map((gate) => (
        <GateRow
          key={gate.kind === "permission" ? gate.request.id : gate.kind === "diff" ? gate.proposal.id : gate.question.requestId}
          gate={gate}
          title={view.meta[gate.taskId]?.title ?? gate.taskId}
          onPermission={(allow, scope) => { if (gate.kind === "permission") void answerPermission(gate, allow, scope).catch((error) => notify(`Couldn't answer — ${errMessage(error)}`, { tone: "warn" })); }}
          onQuestion={(answer) => { if (gate.kind === "question") void answerQuestion(gate, answer).catch((error) => notify(`Couldn't answer — ${errMessage(error)}`, { tone: "warn" })); }}
          onDiff={(apply) => { if (gate.kind === "diff") void answerDiff(gate, apply).catch((error) => notify(`Couldn't answer — ${errMessage(error)}`, { tone: "warn" })); }}
        />
      ))}

      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px 12px", minHeight: 40 }}>
        {!view.approved ? (
          <>
            <button className="klide-button klide-button-primary" disabled={busy || dirty || !receipt.route || !workspaceRoot || Object.values(routes).some((route) => !route.model)} onClick={() => void approveAndRun()}>
              {busy ? "Starting…" : `Approve and run (${total})`}
            </button>
            {receipt.route ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                {/* Room here for the pair — the runner with the maker tucked in. */}
                {Object.keys(routes).length ? <Line dim>Workers shown on each task</Line> : <RouteMark route={receipt.route} size={22} />}

              </span>
            ) : (
              <Line dim>No route for this Run</Line>
            )}
          </>
        ) : view.terminal?.event.type === "mission_parked" ? (
          <Line tone="var(--warning)">Parked · {view.terminal.event.reason}</Line>
        ) : view.terminal ? (
          <Line>Done · {view.done} of {total}</Line>
        ) : (
          <Line dim>{view.done} of {total} done · running</Line>
        )}
        <button
          type="button"
          className={currentPolicy === "review" ? "klide-ai-mode-note klide-ai-mode-note--muted" : "klide-ai-mode-note"}
          disabled={busy || view.terminal?.event.type === "mission_completed"}
          title={`${policyChoice.description}. Click: ${nextPolicy.label}.`}
          style={{ marginLeft: "auto", flexShrink: 0 }}
          onClick={async () => {
            if (!view.approved) { setPolicy(nextPolicy.key); return; }
            if (!workspaceRoot || busy) return;
            setBusy(true);
            try { setBundle(await setDurableMissionPolicy(workspaceRoot, bundle.mission.id, nextPolicy.review, nextPolicy.commands)); }
            catch (error) { notify(`Couldn't change policy — ${errMessage(error)}`, { tone: "warn" }); }
            finally { setBusy(false); }
          }}
        >
          <span key={currentPolicy} className="klide-ai-mode-note-label">{policyChoice.label}</span>
        </button>
      </div>
      {bundle.report && <section aria-label="Mission report" style={{ padding: "4px 14px 16px", fontSize: 13, lineHeight: 1.6, overflowWrap: "anywhere" }}>{renderMarkdown(bundle.report.markdown)}</section>}
    </Frame>
  );
}

/** A worker's pause, drawn as the panel draws its own: the task it belongs
 *  to on a line above, then the command or the diff with its answers. */
function GateRow({ gate, title, onPermission, onDiff, onQuestion }: {
  gate: MissionGate;
  title: string;
  onPermission: (allow: boolean, scope: "once" | "run" | "project") => void;
  onDiff: (apply: boolean) => void;
  onQuestion: (answer: string) => void;
}) {
  const [answer, setAnswer] = useState("");
  return (
    <div style={{ padding: "6px 14px 2px", borderTop: "1px solid var(--border)", display: "grid", gap: 4 }}>
      <span style={{ fontSize: 11.5, color: "var(--fg-dim)" }}>{title} is waiting on you</span>
      {gate.kind === "question" ? (
        <QuestionCard question={gate.question.question} choices={gate.question.choices} onChoose={onQuestion} answer={answer} onAnswerChange={setAnswer} onSubmit={() => onQuestion(answer)} onSkip={() => onQuestion("")} />
      ) : gate.kind === "permission" ? (
        (() => {
          const input = (gate.request.input ?? {}) as { command?: string; externalPaths?: string[]; interpreter?: CommandInterpreter | null };
          return (
            <InlineCommandReview
              command={input.command ?? gate.request.summary ?? gate.request.toolName}
              kind={input.command ? "command" : "network"}
              detail={gate.request.reason}
              externalPaths={input.externalPaths}
              interpreter={input.interpreter ?? undefined}
              onReject={() => onPermission(false, "once")}
              onApproveOnce={() => onPermission(true, "once")}
              onApproveForRun={() => onPermission(true, "run")}
              onApproveForProject={() => onPermission(true, "project")}
            />
          );
        })()
      ) : (
        <InlineDiffReview
          edit={{ path: gate.proposal.path, oldContent: gate.proposal.oldContent, newContent: gate.proposal.newContent, isCreate: gate.proposal.isCreate, reason: gate.proposal.reason }}
          onApply={() => onDiff(true)}
          onReject={() => onDiff(false)}
        />
      )}
    </div>
  );
}

export function missionRouteHasSameBrand(provider: ProviderId, model: string | null): boolean {
  const maker = modelIdentity(model)?.name;
  const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/ai$/, "");
  return !!maker && normalize(maker) === normalize(providerName(provider));
}

/** One quiet worker mark; identity lives in the shared hover/focus tooltip. */
function RouteMark({ route, size = 16, onOpen }: { route: DurableMissionTaskDispatch | undefined; size?: number; onOpen?: () => void }) {
  if (!route) return null;
  const provider = route.provider as ProviderId;
  const model = route.model === "default" ? null : route.model;
  const sameBrand = missionRouteHasSameBrand(provider, model);
  const modelLogo = sameBrand ? null : makerMark(model, provider, size);
  const mark = (name: string, logo: React.ReactNode) => (
    <Tooltip label={name} description={onOpen ? "Open worker" : undefined} placement="bottom">
      <button
        type="button"
        aria-label={onOpen ? `Open worker: ${name}` : name}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => { event.stopPropagation(); onOpen?.(); }}
        style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: size + 12, height: size + 12, flexShrink: 0, padding: 6, border: 0, borderRadius: "var(--radius-sm)", background: "transparent", color: "inherit", cursor: onOpen ? "pointer" : "default" }}
      >{logo}</button>
    </Tooltip>
  );
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 2, padding: modelLogo ? "1px 2px" : 0, border: modelLogo ? "1px solid var(--border)" : undefined, borderRadius: 999, background: modelLogo ? "var(--bg-elevated)" : "transparent" }}>
    {mark(sameBrand ? `${providerName(provider)} · ${model}` : providerName(provider), <ProviderLogo id={provider} size={size} />)}
    {modelLogo && <>
      <span aria-hidden="true" style={{ width: 12, height: 1, background: "var(--border-strong)", flexShrink: 0 }} />
      {mark(model ?? "CLI default model", modelLogo)}
    </>}
  </span>;
}

function Frame({ title, children, action, variant = "conversation" }: { title: string; children: React.ReactNode; action?: React.ReactNode; variant?: "conversation" | "sidebar" }) {
  return (
    <section
      aria-label="Mission"
      style={{ margin: variant === "sidebar" ? 0 : "10px 0 6px", border: variant === "sidebar" ? "1px solid var(--composer-border)" : "1px solid var(--border)", borderRadius: variant === "sidebar" ? 15 : "var(--radius-lg)", background: variant === "sidebar" ? "var(--composer-glass)" : "var(--bg-elevated)", backdropFilter: variant === "sidebar" ? "var(--composer-blur)" : undefined, WebkitBackdropFilter: variant === "sidebar" ? "var(--composer-blur)" : undefined, overflow: "hidden", minWidth: 0 }}
    >
      <div style={{ display: "flex", alignItems: variant === "sidebar" ? "center" : "baseline", gap: 10, padding: variant === "sidebar" ? "10px 14px" : "10px 14px 8px", borderBottom: variant === "sidebar" ? undefined : "1px solid var(--border)" }}>
        {variant === "sidebar" ? <MissionWorkflowIcon size={18} /> : <span style={{ fontSize: 11, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--fg-dim)" }}>Mission</span>}
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{title}</span>
        {action}
      </div>
      {children}
    </section>
  );
}

function Line({ children, dim, tone }: { children: React.ReactNode; dim?: boolean; tone?: string }) {
  return <span style={{ fontSize: 12, color: tone ?? (dim ? "var(--fg-dim)" : "var(--fg-subtle)"), fontVariantNumeric: "tabular-nums" }}>{children}</span>;
}
