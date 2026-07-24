// OrchestratorConsole — the real v0.5 tier-board console, built from the
// prototype's winning "crew board" variant and grounded in Design.md:
//   · bone canvas + charcoal-opacity grays + hairline borders (no drop-shadow)
//   · ONE chromatic moment — sage (--accent) marks LIVE work; amber/brick are
//     the existing status signals. Tiers read by LABEL + a monochrome strength
//     meter, never by an off-brand hue (no teal/blue/purple).
//   · spacing on the Design.md scale (8/12/16/24), --fs ramp, --radius tiers.
//
// The routing + budget math is real (routeTask / budget presets / capacity).
// The model planner authors the task list; approval freezes routing into the
// durable Markdown specs. Rust supervises Harness attempts while this surface
// projects progress and reattaches to operator permission/diff pauses.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GitStatus } from "../gitTypes";
import { listProviderModels } from "../ipc/aiProviders";
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
import {
  approveDurableMission,
  compileDurableMissionBundle,
  createDurableMission,
  dispatchDurableMissionTask,
  listDurableMissions,
  reviewDurableMissionAttempt,
  saveDurableMissionTask,
  type DurableMissionBundle,
  type DurableMissionTaskDispatch,
} from "../agent/durableMissions";
import { wouldCreateCycle, type GraphTask } from "../agent/missionGraph";
import type { AgentEvent, DiffProposal, PermissionRequest, ProviderId } from "../agent/types";
import { readAgentRunEvents, reattachAgentRun, resolveDiff, resolvePermission } from "../agent/client";
import { DiffModal } from "./DiffModal";
import { MissionGraph, type MissionGraphMeta } from "./MissionGraph";
import { planGoal, resolvePlannerModel, stubPlan, type PlannedTask } from "../agent/planner";
import { PROVIDER_GROUPS, providerName, isDelegateProvider, DEFAULT_MODELS } from "../agent/providers";
import { ProviderLogo, DotGridLoader } from "./ai/icons";
import { DelegateTerminalSurface } from "./ai/DelegateTerminal";
import { notify } from "../toast";
import { isFavModel, toggleFavModel, subscribeFavModels } from "../favModels";
import { Z } from "../zLayers";

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

// Routing is synchronous and cheap, so it re-runs on every mode flip over the
// CURRENT plan — keeping the toggle instant and the cascade animation alive.
// Planning (the model call) is separate and explicit; see the Plan action.
function useOrchestratorModel(tasks: PlannedTask[], mode: ModeKey) {
  return useMemo(() => {
    const { policy, preset } = MODES[mode];
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
  }, [tasks, mode]);
}

// ── Real dispatch (slice-1 seam) ─────────────────────────────────────────────
type CardStatus = "idle" | "running" | "review" | "done" | "error" | "interrupted";
type LiveCard = { status: CardStatus; activity: string };

function activityFromEvent(prev: LiveCard, ev: AgentEvent): LiveCard {
  switch (ev.type) {
    case "tool_call_started":
      return { ...prev, activity: ev.summary || ev.name };
    case "assistant_delta":
      return prev.activity === "thinking…" ? prev : { ...prev, activity: "thinking…" };
    case "diff_proposed":
      return { ...prev, activity: `review edit · ${ev.proposal.path.split("/").pop()}` };
    case "permission_requested":
      return { ...prev, activity: `awaiting permission · ${ev.request.toolName}` };
    case "run_result":
      return { status: "done", activity: ev.result.message?.slice(0, 80) || "done" };
    case "run_error":
      return { status: "error", activity: ev.error.message.slice(0, 80) };
    default:
      return prev;
  }
}

// A harness pause that needs the operator: a file-edit diff or a command
// permission. The console surfaces one at a time as a review modal.
type Pending =
  | { kind: "diff"; proposal: DiffProposal }
  | { kind: "permission"; request: PermissionRequest };

function useMissionRunObserver() {
  const [live, setLive] = useState<Record<string, LiveCard>>({});
  const [pending, setPending] = useState<Pending[]>([]);
  const attached = useRef(new Map<string, () => void>());
  const attaching = useRef(new Set<string>());

  useEffect(() => () => {
    attached.current.forEach((detach) => detach());
    attached.current.clear();
  }, []);

  function consume(taskId: string, event: AgentEvent) {
    setLive((current) => {
      const previous = current[taskId] ?? { status: "running", activity: "running…" };
      return { ...current, [taskId]: activityFromEvent(previous, event) };
    });
    if (event.type === "diff_proposed") {
      setPending((queue) => queue.some((item) => item.kind === "diff" && item.proposal.id === event.proposal.id)
        ? queue
        : [...queue, { kind: "diff", proposal: event.proposal }]);
    } else if (event.type === "permission_requested") {
      setPending((queue) => queue.some((item) => item.kind === "permission" && item.request.id === event.request.id)
        ? queue
        : [...queue, { kind: "permission", request: event.request }]);
    } else if (event.type === "diff_resolved") {
      setPending((queue) => queue.filter((item) => item.kind !== "diff" || item.proposal.id !== event.proposalId));
    } else if (event.type === "permission_resolved") {
      setPending((queue) => queue.filter((item) => item.kind !== "permission" || item.request.id !== event.requestId));
    }
  }

  function observe(taskId: string, runId: string) {
    if (attached.current.has(runId) || attaching.current.has(runId)) return;
    attaching.current.add(runId);
    setLive((current) => ({
      ...current,
      [taskId]: current[taskId] ?? { status: "running", activity: "starting…" },
    }));
    void (async () => {
      const buffered: Array<{ event: AgentEvent; seq: number }> = [];
      let snapshotLength: number | null = null;
      try {
        const reattachment = await reattachAgentRun(runId, 0, (event, seq) => {
          if (snapshotLength === null) buffered.push({ event, seq });
          else if (seq >= snapshotLength) consume(taskId, event);
        });
        attached.current.set(runId, reattachment.detach);
        const snapshot = await readAgentRunEvents(runId);
        snapshot.forEach((event) => consume(taskId, event));
        snapshotLength = snapshot.length;
        buffered.filter(({ seq }) => seq >= snapshot.length).forEach(({ event }) => consume(taskId, event));
      } catch (error) {
        setLive((current) => ({
          ...current,
          [taskId]: { status: "error", activity: String(error).slice(0, 80) },
        }));
      } finally {
        attaching.current.delete(runId);
      }
    })();
  }

  // A new plan reuses task ids (t1..tN), so stale card statuses from the last
  // plan must not leak onto the new cards. Pending pauses stay — they belong to
  // live harness runs that still need an answer either way.
  function reset() {
    setLive({});
  }

  const head = pending[0] ?? null;
  const pop = () => setPending((q) => q.slice(1));

  async function applyDiff() {
    if (head?.kind !== "diff") return;
    await resolveDiff({ runId: head.proposal.runId, proposalId: head.proposal.id, decision: { behavior: "apply" } });
    pop();
  }
  async function rejectDiff() {
    if (head?.kind !== "diff") return;
    await resolveDiff({ runId: head.proposal.runId, proposalId: head.proposal.id, decision: { behavior: "reject" } });
    pop();
  }
  async function decidePermission(allow: boolean) {
    if (head?.kind !== "permission") return;
    await resolvePermission({
      runId: head.request.runId,
      requestId: head.request.id,
      decision: allow ? { behavior: "allow", scope: "run" } : { behavior: "deny" },
    });
    pop();
  }

  return { live, observe, reset, head, applyDiff, rejectDiff, decidePermission };
}

// ── Formatters ────────────────────────────────────────────────────────────
const fmtUsd = (n: number) => (n === 0 ? "$0" : `$${n.toFixed(2)}`);
const fmtMin = (ms: number) => `${Math.round(ms / 60_000)}m`;

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

// Count-up number: tweens between the previous and next value with easeOutCubic
// so cost/time/counts roll when the mode changes, instead of snapping. The ref
// tracks the live displayed value, so an interrupted tween resumes from where
// it is rather than jumping.
function AnimatedNumber({ value, format }: { value: number; format: (n: number) => string }) {
  const [display, setDisplay] = useState(value);
  const current = useRef(value);
  useEffect(() => {
    const from = current.current;
    const to = value;
    if (from === to) return;
    if (prefersReducedMotion()) { current.current = to; setDisplay(to); return; }
    let raf = 0;
    let start = 0;
    const step = (t: number) => {
      if (!start) start = t;
      const p = Math.min(1, (t - start) / 460);
      const eased = 1 - Math.pow(1 - p, 3);
      const v = from + (to - from) * eased;
      current.current = v;
      setDisplay(v);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{format(display)}</>;
}

// Segmented control with a single pill that slides AND resizes between segments
// (the "magic move" Linear/Stripe use). The pill is an absolutely-positioned
// layer measured from each segment's box; segment labels ride above it.
function SegmentedModes({ mode, setMode }: { mode: ModeKey; setMode: (m: ModeKey) => void }) {
  const keys = Object.keys(MODES) as ModeKey[];
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const el = refs.current[mode];
    if (el) setPill({ left: el.offsetLeft, width: el.offsetWidth });
  }, [mode]);
  return (
    <div style={{ position: "relative", display: "inline-flex", padding: 3, gap: 2, background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)" }}>
      {pill && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: 3,
            bottom: 3,
            left: pill.left,
            width: pill.width,
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)",
            transition: "left var(--motion-med) var(--ease-spring), width var(--motion-med) var(--ease-spring)",
          }}
        />
      )}
      {keys.map((k) => {
        const active = mode === k;
        return (
          <button
            key={k}
            ref={(el) => { refs.current[k] = el; }}
            onClick={() => setMode(k)}
            aria-pressed={active}
            style={{
              position: "relative",
              zIndex: 1,
              padding: "7px 13px",
              fontSize: 12,
              fontWeight: active ? 600 : 500,
              borderRadius: "var(--radius-md)",
              background: "transparent",
              color: active ? "var(--fg-strong)" : "var(--fg-subtle)",
              transition: "color var(--motion-med) var(--ease-out)",
            }}
          >
            {MODES[k].label}
          </button>
        );
      })}
    </div>
  );
}

// ── Atoms ───────────────────────────────────────────────────────────────────
// Status: sage = live, brick = failed, muted = idle/done — plain status words
// (the running card also carries a sage left spine), no dots or halos.
// "done" recedes to a quiet muted check so the live work stays the focus.
function StatusBadge({ status }: { status: CardStatus }) {
  if (status === "done") return <span style={{ display: "inline-flex", color: "var(--fg-subtle)" }}><IconCheck size={11} /></span>;
  const color = status === "error" ? "var(--danger)" : status === "interrupted" || status === "review" ? "var(--warning)" : status === "running" ? "var(--accent)" : "var(--fg-dim)";
  return (
    <span
      style={{
        fontSize: 10,
        fontFamily: "var(--font-mono)",
        letterSpacing: "0.04em",
        color,
        lineHeight: 1,
      }}
    >
      {status === "error" ? "error" : status === "interrupted" ? "interrupted" : status === "review" ? "review" : status === "running" ? "working" : "idle"}
    </span>
  );
}

// Monochrome 4-segment tier-strength meter — more filled bars = stronger tier.
function TierMeter({ level }: { level: 1 | 2 | 3 | 4 }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "flex-end", gap: 1.5, height: 11 }} aria-label={`tier ${level} of 4`}>
      {[1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className="klide-tier-bar"
          style={{
            width: 3,
            height: 3 + i * 2,
            borderRadius: 1,
            background: i <= level ? "var(--fg-strong)" : "var(--border-strong)",
            opacity: i <= level ? 0.78 : 0.34,
            animationDelay: `${i * 70}ms`,
          }}
        />
      ))}
    </span>
  );
}

// Crisp inline icons (inherit currentColor) — replace unicode glyphs so the
// marks render identically across platforms and align to the type baseline.
function IconPlay({ size = 8 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 12 12" fill="currentColor" aria-hidden style={{ display: "block" }}><path d="M3 2.1v7.8l6-3.9z" /></svg>;
}
function IconCheck({ size = 11 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: "block" }}><path d="M11.5 4l-5.5 6L2.5 7" /></svg>;
}
function IconX({ size = 9 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden style={{ display: "block" }}><path d="M3 3l6 6M9 3l-6 6" /></svg>;
}
function IconDep({ size = 11 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: "block", flexShrink: 0 }}><path d="M4 2.5v4.5a1.5 1.5 0 0 0 1.5 1.5H11" /><path d="M8.5 6L11 8.5 8.5 11" /></svg>;
}
function IconChevron({ size = 9 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: "block", flexShrink: 0 }}><path d="M4.5 3l4 3-4 3" /></svg>;
}
function IconStar({ filled, size = 12 }: { filled: boolean; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden style={{ display: "block" }}><path d="M12 3.4l2.65 5.37 5.93.86-4.29 4.18 1.01 5.9L12 17.8l-5.3 2.79 1.01-5.9L3.42 9.63l5.93-.86z" /></svg>;
}

// A model row in the chooser's model dropdown: pick on click, plus a star toggle
// to favourite it. The star stops propagation so it never selects.
function ModelOption({ model, active, fav, onPick, onToggleFav }: { model: string; active: boolean; fav: boolean; onPick: () => void; onToggleFav: () => void }) {
  return (
    <div
      style={{ display: "flex", alignItems: "center", borderRadius: "var(--radius-sm)", background: active ? "var(--accent-soft)" : "transparent" }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
    >
      <button role="menuitem" onClick={onPick} style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8, padding: "6px 4px 6px 9px", background: "transparent", color: active ? "var(--fg-strong)" : "var(--fg)", fontSize: 11.5, fontFamily: "var(--font-mono)", textAlign: "left" }}>
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{model}</span>
        {active && <IconCheck size={11} />}
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onToggleFav(); }}
        title={fav ? "Unfavorite" : "Favorite"}
        aria-label={fav ? "Unfavorite" : "Favorite"}
        aria-pressed={fav}
        style={{ flexShrink: 0, width: 26, height: 26, display: "grid", placeItems: "center", borderRadius: "var(--radius-sm)", background: "transparent", color: fav ? "var(--accent)" : "var(--fg-subtle)" }}
        onMouseEnter={(e) => { if (!fav) e.currentTarget.style.color = "var(--accent)"; }}
        onMouseLeave={(e) => { if (!fav) e.currentTarget.style.color = "var(--fg-subtle)"; }}
      >
        <IconStar filled={fav} size={12} />
      </button>
    </div>
  );
}

const eyebrow: React.CSSProperties = {
  fontSize: 11,
  fontFamily: "var(--font-mono)",
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--fg-dim)",
};

// ── Model chooser ─────────────────────────────────────────────────────────
export type ModelSel = { provider: ProviderId; model: string };

// The model a provider runs by default — the one the user pinned in the AI
// panel, else the built-in default. Provider-level selection; per-model picking
// stays in the AI panel for now.
export function resolvedModelFor(id: ProviderId): string {
  return localStorage.getItem(`klide.model.${id}`) || DEFAULT_MODELS[id] || "";
}

type ModelListState = { state: "loading" | "ok" | "error"; models: string[] };

const CHOOSER_MENU: React.CSSProperties = {
  position: "absolute", top: "calc(100% + 5px)", left: 0, zIndex: Z.popover,
  minWidth: 200, maxHeight: "min(56vh, 420px)", overflowY: "auto",
  background: "var(--bg-elevated)", border: "1px solid var(--border-strong)",
  borderRadius: "var(--radius-md)", boxShadow: "var(--panel-shadow)", padding: 4,
};

function chooserTrigger(open: boolean, disabled: boolean): React.CSSProperties {
  return {
    display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, height: 28, padding: "0 8px",
    borderRadius: "var(--radius-sm)", border: "1px solid var(--border)",
    background: open ? "var(--bg-hover)" : "var(--bg-elevated)",
    color: disabled ? "var(--fg-dim)" : "var(--fg)", fontSize: 11,
    opacity: disabled ? 0.6 : 1, cursor: disabled ? "default" : "pointer",
    transition: "background var(--motion-fast) var(--ease-out)",
  };
}

const ChooserChevron = () => (
  <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0, opacity: 0.55, marginLeft: "auto" }}><path d="M3 4.5l3 3 3-3" /></svg>
);

// ONE dropdown that cascades to the RIGHT: providers on the left, the chosen
// provider's ACTUAL models develop in the right pane (lazy-fetched via
// ai_provider_models + cached). Star a model to favourite it — favourites are a
// shared store (src/favModels.ts), so the stars stay in sync everywhere they're
// shown. `auto` adds a "let routing decide" entry that clears the choice.
function ModelChooser({
  value,
  onChange,
  excludeDelegate = false,
  auto = false,
}: {
  value: ModelSel | null;
  onChange: (v: ModelSel | null) => void;
  excludeDelegate?: boolean;
  auto?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [cache, setCache] = useState<Record<string, ModelListState>>({});
  const [active, setActive] = useState<ProviderId | null>(value?.provider ?? null);
  const [, bumpFav] = useState(0);
  useEffect(() => subscribeFavModels(() => bumpFav((n) => n + 1)), []);
  const ref = useRef<HTMLDivElement>(null);

  const loadModels = (id: ProviderId) => {
    setCache((c) => (c[id] ? c : { ...c, [id]: { state: "loading", models: [] } }));
    listProviderModels(id)
      .then((models) => setCache((c) => ({ ...c, [id]: { state: "ok", models } })))
      .catch(() => setCache((c) => ({ ...c, [id]: { state: "error", models: [] } })));
  };

  const groups = PROVIDER_GROUPS
    .map((g) => ({ label: g.label, items: g.items.filter((it) => it.available && (!excludeDelegate || !isDelegateProvider(it.id))) }))
    .filter((g) => g.items.length > 0);
  const firstProvider = groups[0]?.items[0]?.id ?? null;

  useEffect(() => {
    if (!open) return;
    const initial = value?.provider ?? firstProvider;
    setActive(initial);
    if (initial) loadModels(initial);
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const showProvider = (id: ProviderId) => { setActive(id); if (!cache[id]) loadModels(id); };

  const entry = active ? cache[active] : null;
  const fallback = active ? resolvedModelFor(active) : "";
  const modelList: string[] = entry?.state === "ok" && entry.models.length ? entry.models : fallback ? [fallback] : [];
  const favs = active ? modelList.filter((m) => isFavModel(active, m)) : [];
  const rest = active ? modelList.filter((m) => !isFavModel(active, m)) : [];
  const colScroll: React.CSSProperties = { overflowY: "auto", maxHeight: "min(56vh, 420px)", padding: 4 };
  const leftItem = (on: boolean): React.CSSProperties => ({ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "7px 9px", borderRadius: "var(--radius-sm)", background: on ? "var(--bg-hover)" : "transparent", color: "var(--fg-strong)", fontSize: 12, textAlign: "left" });

  const opt = (m: string) => active && (
    <ModelOption
      key={m}
      model={m}
      active={value?.provider === active && value?.model === m}
      fav={isFavModel(active, m)}
      onPick={() => { onChange({ provider: active, model: m }); setOpen(false); }}
      onToggleFav={() => toggleFavModel(active, m)}
    />
  );

  return (
    <div ref={ref} onClick={(e) => e.stopPropagation()} style={{ position: "relative", minWidth: 0 }}>
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} style={chooserTrigger(open, false)}>
        {value && <span style={{ display: "inline-flex", flexShrink: 0 }}><ProviderLogo id={value.provider} size={13} /></span>}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value ? providerName(value.provider) : "Auto"}</span>
        {value && <span style={{ color: "var(--fg-dim)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value.model}</span>}
        <ChooserChevron />
      </button>
      {open && (
        <>
          {/* Panel 1 — providers. */}
          <div role="menu" style={{ ...CHOOSER_MENU, ...colScroll, top: "calc(100% + 5px)", left: 0, width: 200, minWidth: 200 }}>
            {auto && (
              <button onClick={() => { onChange(null); setOpen(false); }} onMouseEnter={() => setActive(null)} style={leftItem(!value)}>
                <span style={{ flex: 1, minWidth: 0 }}>Auto</span>
                {!value && <IconCheck size={12} />}
              </button>
            )}
            {groups.map((g) => (
              <div key={g.label} style={{ marginBottom: 2 }}>
                <div style={{ ...eyebrow, fontSize: 9.5, padding: "6px 9px 4px" }}>{g.label}</div>
                {g.items.map((it) => {
                  const on = active === it.id;
                  const chosen = value?.provider === it.id;
                  return (
                    <button key={it.id} role="menuitem" onMouseEnter={() => showProvider(it.id)} onClick={() => showProvider(it.id)} style={leftItem(on)}>
                      <span style={{ display: "inline-flex", flexShrink: 0 }}><ProviderLogo id={it.id} size={14} /></span>
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</span>
                      {chosen && <span style={{ display: "inline-flex", color: "var(--accent)", flexShrink: 0 }}><IconCheck size={10} /></span>}
                      <span style={{ display: "inline-flex", color: "var(--fg-dim)", flexShrink: 0 }}><IconChevron size={8} /></span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          {/* Panel 2 — the chosen provider's models. Sits flush beside panel 1,
              tops aligned, with a small gap — two clean cards, no overlap. */}
          {active && (
            <div role="menu" className="popover-enter" style={{ ...CHOOSER_MENU, ...colScroll, top: "calc(100% + 5px)", left: 208, width: 252, minWidth: 252, zIndex: Z.popover + 1 }}>
              {!entry || entry.state === "loading" ? (
                <div style={{ padding: "12px 11px", display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--fg-dim)" }}>
                  <DotGridLoader size={14} label="Loading models" />
                  Loading models…
                </div>
              ) : (
                <>
                  {entry.state === "error" && <div style={{ padding: "6px 9px 2px", fontSize: 10.5, color: "var(--warning)" }}>Couldn't list models — showing default.</div>}
                  {favs.length > 0 && (
                    <div style={{ marginBottom: 2 }}>
                      <div style={{ ...eyebrow, fontSize: 9.5, padding: "6px 9px 4px", display: "flex", alignItems: "center", gap: 5, color: "var(--accent)" }}><IconStar filled size={9} /> Favorites</div>
                      {favs.map(opt)}
                    </div>
                  )}
                  {favs.length > 0 && rest.length > 0 && <div style={{ ...eyebrow, fontSize: 9.5, padding: "6px 9px 4px" }}>Models</div>}
                  {rest.map(opt)}
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function GoalBar({ goal, setGoal, mode, setMode, onPlan, planning }: { goal: string; setGoal: (v: string) => void; mode: ModeKey; setMode: (m: ModeKey) => void; onPlan: () => void; planning: boolean }) {
  const canPlan = !!goal.trim() && !planning;
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <input
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && canPlan) onPlan(); }}
        placeholder="Describe the goal — e.g. add rate limiting to the API"
        className="klide-field"
        style={{ flex: 1, minWidth: 220, height: 38, padding: "0 14px", fontSize: "var(--fs-base)" }}
      />
      <button
        onClick={onPlan}
        disabled={!canPlan}
        className="klide-button klide-button-primary"
        style={{ height: 38, opacity: canPlan ? 1 : 0.55 }}
      >
        {planning ? "Planning…" : "Plan"}
      </button>
      {/* Segmented control — a single pill slides + resizes between segments. */}
      <SegmentedModes mode={mode} setMode={setMode} />
    </div>
  );
}

// Dashboard metric: a count-up number stacked over a quiet label.
function CrewStat({ value, format, label }: { value: number; format: (n: number) => string; label: string }) {
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 16, fontWeight: 600, color: "var(--fg-strong)", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", lineHeight: 1.1 }}>
        <AnimatedNumber value={value} format={format} />
      </span>
      <span style={{ fontSize: 11, color: "var(--fg-subtle)", letterSpacing: "0.01em" }}>{label}</span>
    </span>
  );
}

// Thin vertical hairline separating metrics in the summary row.
function StatDivider() {
  return <span aria-hidden style={{ alignSelf: "stretch", width: 1, background: "var(--border)", margin: "0 20px" }} />;
}

function BudgetMeter({ spent, max }: { spent: number; max: number | null }) {
  const pct = max ? Math.min(100, (spent / max) * 100) : 0;
  const over = max != null && spent > max;
  const headroom = max != null ? max - spent : null;
  const tone = over ? "var(--danger)" : "var(--accent)";
  return (
    <div>
      {/* Estimated spend as the hero number, the cap as a quiet denominator. */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 9 }}>
        <span style={{ fontSize: 22, fontWeight: 600, fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em", color: over ? "var(--danger)" : "var(--fg-strong)" }}>{fmtUsd(spent)}</span>
        {max != null && <span style={{ fontSize: 12, color: "var(--fg-dim)", fontFamily: "var(--font-mono)" }}>/ {fmtUsd(max)}</span>}
      </div>
      <div style={{ height: 6, borderRadius: 999, background: "var(--bg-hover)", overflow: "hidden", border: "1px solid var(--border)" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: tone, transition: "width 360ms var(--ease-out)" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 7, fontSize: 10.5, color: "var(--fg-dim)" }}>
        <span>{max != null ? `${Math.round(pct)}% of budget` : "no cap"}</span>
        {headroom != null && (
          <span style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", color: over ? "var(--danger)" : "var(--fg-subtle)" }}>
            {over ? `over by ${fmtUsd(-headroom)}` : `${fmtUsd(headroom)} left`}
          </span>
        )}
      </div>
    </div>
  );
}

// Compact permission prompt — a goal-mode run wants to use a gated tool (e.g.
// run a command). Mirrors the DiffModal's scrim/surface idiom so the two review
// surfaces feel like one family.
function PermissionPrompt({ request, onAllow, onDeny }: { request: PermissionRequest; onAllow: () => void; onDeny: () => void }) {
  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: Z.modal, display: "grid", placeItems: "center", background: "var(--modal-scrim, rgba(20,20,18,0.32))", backdropFilter: "blur(2px)" }}
      onClick={onDeny}
    >
      <div className="klide-surface" style={{ width: "min(440px, 92vw)", padding: 22 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ ...eyebrow, marginBottom: 10 }}>Permission</div>
        <div style={{ fontSize: "var(--fs-md)", fontWeight: 600, color: "var(--fg-strong)", marginBottom: 6, letterSpacing: "-0.01em" }}>{request.summary || request.toolName}</div>
        {request.reason && <div style={{ fontSize: "var(--fs-base)", color: "var(--fg-subtle)", lineHeight: 1.55, marginBottom: 16 }}>{request.reason}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="klide-button klide-button-ghost" onClick={onDeny}>Deny</button>
          <button className="klide-button klide-button-primary" onClick={onAllow}>Allow for this run</button>
        </div>
      </div>
    </div>
  );
}

type ChangedFile = { path: string; status: string; additions: number; deletions: number };

// The working-tree changes a one-shot Delegate left behind. Process exit is
// only settlement evidence — this is the actual work the operator accepts or
// rejects, read straight from `git status` (full diffs still live in Git Review).
function DelegateReviewChanges({ workspaceRoot }: { workspaceRoot: string | null }) {
  const [files, setFiles] = useState<ChangedFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceRoot) return;
    let cancelled = false;
    (async () => {
      try {
        const status = await invoke<GitStatus>("git_status", { workspaceRoot });
        // Cap the per-file diff fan-out so a pathological changeset can't stall
        // the review — the rest still show as touched, just without counts.
        const rows = await Promise.all(
          status.files.slice(0, 60).map(async (file) => {
            try {
              const diff = await invoke<{ additions: number; deletions: number }>("git_diff", {
                workspaceRoot,
                path: file.path,
                staged: file.staged,
              });
              return { path: file.path, status: file.status, additions: diff.additions, deletions: diff.deletions };
            } catch {
              return { path: file.path, status: file.status, additions: 0, deletions: 0 };
            }
          })
        );
        if (!cancelled) setFiles(rows);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceRoot]);

  return (
    <div style={{ width: 248, flexShrink: 0, borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ ...eyebrow, padding: "12px 14px 8px" }}>
        Changed files{files ? ` · ${files.length}` : ""}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 6px 10px" }}>
        {error ? (
          <div style={{ padding: "6px 8px", fontSize: 11, color: "var(--warning)", lineHeight: 1.4 }}>Couldn't read working tree — {error}</div>
        ) : !files ? (
          <div style={{ padding: "6px 8px", fontSize: 11, color: "var(--fg-subtle)" }}>Reading working tree…</div>
        ) : files.length === 0 ? (
          <div style={{ padding: "6px 8px", fontSize: 11, color: "var(--fg-subtle)", lineHeight: 1.4 }}>No working-tree changes. The Delegate may have committed its work or made none.</div>
        ) : (
          files.map((file) => (
            <div key={file.path} style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "4px 8px", fontSize: 11, fontFamily: "var(--font-mono)", minWidth: 0 }}>
              <span style={{ color: "var(--fg-subtle)", width: 12, flexShrink: 0 }}>{file.status.trim().charAt(0) || "M"}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: "rtl", textAlign: "left", color: "var(--fg)" }}>{file.path}</span>
              {(file.additions > 0 || file.deletions > 0) && (
                <span style={{ flexShrink: 0, color: "var(--fg-subtle)" }}>
                  {file.additions > 0 && <span style={{ color: "var(--diff-add)" }}>+{file.additions}</span>}
                  {file.additions > 0 && file.deletions > 0 && " "}
                  {file.deletions > 0 && <span style={{ color: "var(--diff-remove)" }}>−{file.deletions}</span>}
                </span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

type DelegateReviewTarget = {
  taskId: string;
  taskTitle: string;
  runId: string;
  providerId: ProviderId;
  provider: string;
  model: string;
  exitCode: number;
  signal?: string;
};

function DelegateReviewModal({
  target,
  workspaceRoot,
  busy,
  onClose,
  onDecision,
}: {
  target: DelegateReviewTarget;
  workspaceRoot: string | null;
  busy: boolean;
  onClose: () => void;
  onDecision: (accepted: boolean) => void;
}) {
  const exit = target.signal
    ? `signal ${target.signal}`
    : `exit ${target.exitCode}`;
  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: Z.modal, display: "grid", placeItems: "center", padding: 24, background: "var(--modal-scrim, rgba(20,20,18,0.32))", backdropFilter: "blur(2px)" }}
      onClick={() => { if (!busy) onClose(); }}
    >
      <div
        className="klide-surface"
        style={{ width: "min(820px, 94vw)", height: "min(640px, 88vh)", minHeight: 420, display: "flex", flexDirection: "column", overflow: "hidden" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={{ padding: "16px 18px 14px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "flex-start", gap: 14 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ ...eyebrow, marginBottom: 5 }}>Delegate review</div>
            <div style={{ fontSize: "var(--fs-md)", fontWeight: 600, color: "var(--fg-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{target.taskTitle}</div>
            <div style={{ marginTop: 4, fontSize: 11, color: target.exitCode === 0 && !target.signal ? "var(--fg-subtle)" : "var(--warning)", fontFamily: "var(--font-mono)" }}>
              {target.provider} · {target.model} · {exit}
            </div>
          </div>
          <button className="klide-button klide-button-ghost" onClick={onClose} disabled={busy} style={{ marginLeft: "auto" }}>Close</button>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          <DelegateReviewChanges workspaceRoot={workspaceRoot} />
          <div style={{ flex: 1, minWidth: 0, display: "flex" }}>
            <DelegateTerminalSurface
              sessionId={target.runId}
              providerId={target.providerId}
              provider={target.provider}
              workspaceRoot={workspaceRoot}
              model={target.model}
              attachOnly
              readOnly
            />
          </div>
        </div>
        <div style={{ padding: 14, borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, color: "var(--fg-subtle)", lineHeight: 1.4 }}>
            Process exit is evidence only. Check the changed files and output before accepting.
          </span>
          <button className="klide-button klide-button-ghost" onClick={() => onDecision(false)} disabled={busy} style={{ marginLeft: "auto" }}>
            {busy ? "Recording…" : "Reject"}
          </button>
          <button className="klide-button klide-button-primary" onClick={() => onDecision(true)} disabled={busy}>
            {busy ? "Recording…" : "Accept & continue"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Console ───────────────────────────────────────────────────────────────
export function OrchestratorConsole({ workspaceRoot = null }: { workspaceRoot?: string | null }) {
  const [goal, setGoal] = useState("add rate limiting to the API");
  const [mode, setMode] = useState<ModeKey>("balanced");
  // The current plan (model-produced). Empty until the user plans — the board
  // shows an inviting empty state rather than a fake default plan.
  const [tasks, setTasks] = useState<PlannedTask[]>([]);
  // Rust-authored Mission Markdown + append-only runtime events. This is the
  // durable authority; the board's React state is only its current projection.
  const [durableBundle, setDurableBundle] = useState<DurableMissionBundle | null>(null);
  const [planning, setPlanning] = useState(false);
  // Review every edit (default) vs auto-apply. Permission prompts still surface
  // either way, so command-running tasks never run silently.
  const [reviewEdits, setReviewEdits] = useState(true);
  // Which model decomposes the goal (the orchestrator brain) — chosen separately
  // from the per-task models. Defaults to the AI-panel default (delegate→local).
  const [plannerSel, setPlannerSel] = useState<ModelSel>(() => resolvePlannerModel());
  // Per-task model overrides (taskId → provider+model). Absent = use routing.
  const [overrides, setOverrides] = useState<Record<string, ModelSel>>({});
  // Which card is expanded to show its full description + model + cost.
  const [expanded, setExpanded] = useState<string | null>(null);
  const [savingTaskId, setSavingTaskId] = useState<string | null>(null);
  const [delegateReview, setDelegateReview] = useState<DelegateReviewTarget | null>(null);
  const [reviewingRunId, setReviewingRunId] = useState<string | null>(null);
  // Board = model-routing lanes; Graph = the dependency DAG. Both project the
  // same tasks — the graph is a view, not a second state model.
  const [viewMode, setViewMode] = useState<"board" | "graph">("board");
  // Bumped on every (re)plan so the board remounts and replays the build-in.
  const [planSeq, setPlanSeq] = useState(0);
  const { routed, byTier, totalCost, totalMs, envelope, readyCount } = useOrchestratorModel(tasks, mode);
  const durableState = useMemo(
    () => durableBundle ? compileDurableMissionBundle(durableBundle) : null,
    [durableBundle]
  );
  const planApproved = durableBundle
    ? durableState?.missions[durableBundle.mission.id]?.approvedAtMs != null
    : false;

  // Global build order, row-major across the lanes — so cards lay in as one
  // continuous left-to-right wave across the full width ("brick by brick"),
  // not four independent per-lane cascades.
  const buildOrder = useMemo(() => {
    const order: Record<string, number> = {};
    const maxLen = Math.max(0, ...TIER_ORDER.map((t) => byTier[t].length));
    let n = 0;
    for (let row = 0; row < maxLen; row++) {
      for (const tier of TIER_ORDER) {
        const r = byTier[tier][row];
        if (r) order[r.task.taskId] = n++;
      }
    }
    return order;
  }, [byTier]);
  const real = useMissionRunObserver();
  const titleById = useMemo(() => Object.fromEntries(routed.map((r) => [r.task.taskId, r.task.title])), [routed]);

  // ── Mission supervision ───────────────────────────────────────────────────
  // Rust owns selection, attempt attachment, Harness launch, validation, and
  // accept-gated continuation. React only observes the durable projection and
  // answers explicit permission/diff pauses after reattaching to a Run.
  const [missionOn, setMissionOn] = useState(false);

  // Reconstruct the latest Mission after this surface remounts. The authored
  // task Markdown restores the list; events restore attempts and acceptance.
  useEffect(() => {
    let cancelled = false;
    if (!workspaceRoot) return;
    void listDurableMissions(workspaceRoot).then((bundles) => {
      if (cancelled || bundles.length === 0) return;
      const latest = bundles[0];
      const projection = compileDurableMissionBundle(latest);
      setDurableBundle(latest);
      setGoal(latest.mission.intent);
      setTasks(latest.tasks.map((task) => ({
        taskId: task.id,
        title: task.title,
        description: task.bodyMarkdown || undefined,
        acceptanceCriteria: task.acceptanceCriteria,
        phase: task.phase,
        mode: task.mode,
        risk: task.risk,
        writesFiles: task.writesFiles,
        dependsOn: task.dependencies.length ? task.dependencies : undefined,
        needsRepoWideContext: task.needsRepoWideContext || undefined,
        needsStrongReasoning: task.needsStrongReasoning || undefined,
        needsDelegateCli: task.needsDelegateCli || undefined,
        needsVisualReview: task.needsVisualReview || undefined,
      })));
      setOverrides(Object.fromEntries(latest.tasks.flatMap((task) => task.dispatch
        ? [[task.id, { provider: task.dispatch.provider as ProviderId, model: task.dispatch.model }]]
        : [])));
      setPlanSeq((seq) => seq + 1);
      const mission = projection.missions[latest.mission.id];
      const lastLifecycle = [...latest.events].reverse().find((line) =>
        line.event.type === "mission_completed" || line.event.type === "mission_parked"
      );
      const hasAttemptAfterLifecycle = lastLifecycle
        ? latest.events.some((line) => line.seq > lastLifecycle.seq && line.event.type === "attempt_attached")
        : false;
      if (mission?.approvedAtMs != null && (!lastLifecycle || hasAttemptAfterLifecycle)) {
        setMissionOn(true);
      }
    }).catch((error) => {
      if (!cancelled) notify(`Couldn't reopen Missions — ${String(error)}`, { tone: "warn" });
    });
    return () => { cancelled = true; };
  }, [workspaceRoot]);

  // A mounted console observes Rust-owned background progress. Polling reads
  // events only; the Harness itself appends validation even if this view is
  // closed, so reopening loses no acceptance decision.
  useEffect(() => {
    if (!missionOn || !workspaceRoot || !durableBundle) return;
    let cancelled = false;
    const missionId = durableBundle.mission.id;
    const timer = window.setInterval(() => {
      void listDurableMissions(workspaceRoot).then((bundles) => {
        if (cancelled) return;
        const latest = bundles.find((bundle) => bundle.mission.id === missionId);
        if (!latest) return;
        setDurableBundle((current) => {
          const currentSeq = current?.events[current.events.length - 1]?.seq ?? -1;
          const latestSeq = latest.events[latest.events.length - 1]?.seq ?? -1;
          return latestSeq > currentSeq ? latest : current;
        });
      });
    }, 750);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [missionOn, workspaceRoot, durableBundle?.mission.id]);

  // Reattach the control surface to attempts Rust started headlessly. The
  // transcript snapshot closes the remount gap; the global stream supplies
  // subsequent permission/diff requests and activity.
  useEffect(() => {
    if (!durableState || !durableBundle) return;
    for (const taskId of durableBundle.mission.taskIds) {
      const task = durableState.tasks[taskId];
      const spec = durableBundle.tasks.find((candidate) => candidate.id === taskId);
      if (spec?.dispatch?.workerKind === "delegate") continue;
      for (const attempt of task?.attempts ?? []) {
        if (attempt.status === "running") real.observe(taskId, attempt.runId);
      }
    }
  }, [durableState, durableBundle, real]);

  useEffect(() => {
    if (!durableBundle) return;
    const terminal = [...durableBundle.events].reverse().find((line) =>
      line.event.type === "mission_completed" || line.event.type === "mission_parked"
    );
    if (!terminal) return;
    const continued = durableBundle.events.some((line) =>
      line.seq > terminal.seq && line.event.type === "attempt_attached"
    );
    if (continued) return;
    setMissionOn(false);
    if (terminal.event.type === "mission_completed") {
      notify("Mission complete — every task has an accepted Run", { tone: "success" });
    } else if (terminal.event.type === "mission_parked") {
      notify(`Mission parked — ${terminal.event.reason}`, { tone: "warn" });
    }
  }, [durableBundle]);

  function approvalTasks(): Array<DurableMissionTaskDispatch & { taskId: string }> {
    return routed.map(({ task, assignment }) => {
      const override = overrides[task.taskId];
      const provider = override?.provider ?? assignment.provider;
      if (!provider) throw new Error(`Task “${task.title}” has no runnable provider.`);
      const model = override?.model || assignment.model || resolvedModelFor(provider);
      if (!model) throw new Error(`Task “${task.title}” has no runnable model.`);
      const delegate = override ? isDelegateProvider(override.provider) : assignment.workerKind === "delegate";
      return {
        taskId: task.taskId,
        workerKind: delegate ? "delegate" : "harness",
        provider,
        model,
        requireDiffReview: reviewEdits,
      };
    });
  }

  async function runMission() {
    if (!workspaceRoot || !durableBundle) return;
    try {
      const approved = await approveDurableMission(workspaceRoot, durableBundle.mission.id, {
        tasks: approvalTasks(),
        autoStart: true,
      });
      setDurableBundle(approved);
      setMissionOn(true);
    } catch (error) {
      notify(`Couldn't approve Mission — ${error instanceof Error ? error.message : String(error)}`, { tone: "warn" });
    }
  }

  function patchPlannedTask(taskId: string, patch: Partial<PlannedTask>) {
    setTasks((current) => current.map((task) => task.taskId === taskId ? { ...task, ...patch } : task));
  }

  async function saveTaskEdit(task: PlannedTask) {
    if (!workspaceRoot || !durableBundle || savingTaskId) return;
    setSavingTaskId(task.taskId);
    try {
      const saved = await saveDurableMissionTask(workspaceRoot, durableBundle.mission.id, {
        id: task.taskId,
        title: task.title,
        bodyMarkdown: task.description ?? "",
        phase: task.phase,
        mode: task.mode,
        risk: task.risk,
        writesFiles: task.writesFiles,
        dependencies: task.dependsOn ?? [],
        acceptanceCriteria: task.acceptanceCriteria?.length
          ? task.acceptanceCriteria
          : [task.description ?? `The task outcome satisfies: ${task.title}`],
        needsRepoWideContext: task.needsRepoWideContext === true,
        needsStrongReasoning: task.needsStrongReasoning === true,
        needsDelegateCli: task.needsDelegateCli === true,
        needsVisualReview: task.needsVisualReview === true,
      });
      setDurableBundle(saved);
      notify("Task saved to Mission Markdown", { tone: "success" });
    } catch (error) {
      notify(`Couldn't save task — ${error instanceof Error ? error.message : String(error)}`, { tone: "warn" });
    } finally {
      setSavingTaskId(null);
    }
  }

  // The graph's source of truth is the same task list the board routes; edges
  // are the tasks' own dependencies. Editing an edge writes the dependent
  // task's Markdown back through the durable store (blocked once approved).
  const graphTasks: GraphTask[] = useMemo(
    () => tasks.map((task) => ({ id: task.taskId, dependencies: task.dependsOn ?? [] })),
    [tasks]
  );
  const graphMeta: Record<string, MissionGraphMeta> = useMemo(() => {
    const out: Record<string, MissionGraphMeta> = {};
    for (const task of tasks) {
      out[task.taskId] = {
        title: task.title,
        phase: task.phase,
        status: durableState?.tasks[task.taskId]?.status ?? "queued",
      };
    }
    return out;
  }, [tasks, durableState]);

  async function toggleDependency(dependentId: string, prerequisiteId: string) {
    const task = tasks.find((candidate) => candidate.taskId === dependentId);
    if (!task || savingTaskId) return;
    const current = task.dependsOn ?? [];
    const linked = current.includes(prerequisiteId);
    if (!linked && wouldCreateCycle(graphTasks, dependentId, prerequisiteId)) {
      notify("That link would create a dependency cycle.", { tone: "warn" });
      return;
    }
    const nextDeps = linked
      ? current.filter((id) => id !== prerequisiteId)
      : [...current, prerequisiteId];
    const updated: PlannedTask = { ...task, dependsOn: nextDeps.length ? nextDeps : undefined };
    patchPlannedTask(dependentId, { dependsOn: updated.dependsOn });
    await saveTaskEdit(updated);
  }

  async function runSingleTask(taskId: string) {
    if (!workspaceRoot || !durableBundle) return;
    try {
      if (durableState?.missions[durableBundle.mission.id]?.approvedAtMs == null) {
        const approved = await approveDurableMission(workspaceRoot, durableBundle.mission.id, {
          tasks: approvalTasks(),
          autoStart: false,
        });
        setDurableBundle(approved);
      }
      const dispatched = await dispatchDurableMissionTask(
        workspaceRoot,
        durableBundle.mission.id,
        taskId
      );
      setDurableBundle(dispatched);
      setMissionOn(true);
    } catch (error) {
      notify(`Couldn't run task — ${error instanceof Error ? error.message : String(error)}`, { tone: "warn" });
    }
  }

  async function reviewDelegateAttempt(accepted: boolean) {
    if (!workspaceRoot || !durableBundle || !delegateReview || reviewingRunId) return;
    setReviewingRunId(delegateReview.runId);
    try {
      const reviewed = await reviewDurableMissionAttempt(
        workspaceRoot,
        durableBundle.mission.id,
        {
          taskId: delegateReview.taskId,
          runId: delegateReview.runId,
          accepted,
        }
      );
      setDurableBundle(reviewed);
      setDelegateReview(null);
      setMissionOn(accepted);
      notify(
        accepted
          ? "Delegate attempt accepted — the Mission can continue"
          : "Delegate attempt rejected — the Mission is parked for retry",
        { tone: accepted ? "success" : "warn" }
      );
    } catch (error) {
      notify(`Couldn't record Delegate review — ${error instanceof Error ? error.message : String(error)}`, { tone: "warn" });
    } finally {
      setReviewingRunId(null);
    }
  }

  async function plan() {
    if (!goal.trim() || planning) return;
    setPlanning(true);
    // Task ids restart at t1 on every plan — drop the old plan's statuses and
    // any in-flight mission so the new board starts clean.
    setMissionOn(false);
    real.reset();
    setDurableBundle(null);
    let result: PlannedTask[];
    let usedFallback = false;
    try {
      result = await planGoal(goal, plannerSel);
    } catch (e) {
      // Model unreachable / unparseable → keep the board usable with a template.
      result = stubPlan(goal);
      usedFallback = true;
      notify(`Couldn't plan with the model — showing a generic template. (${e instanceof Error ? e.message : String(e)})`, { tone: "warn" });
    }
    setTasks(result);
    setOverrides({});
    try {
      if (!workspaceRoot) throw new Error("Open a workspace to persist this Mission.");
      const bundle = await createDurableMission(workspaceRoot, {
        title: goal.trim().slice(0, 120),
        intent: goal.trim(),
        mode: "goal",
        tasks: result.map((task) => ({
          id: task.taskId,
          title: task.title,
          bodyMarkdown: task.description ?? "",
          phase: task.phase,
          mode: task.mode,
          risk: task.risk,
          writesFiles: task.writesFiles,
          dependencies: task.dependsOn ?? [],
          acceptanceCriteria: task.acceptanceCriteria?.length
            ? task.acceptanceCriteria
            : [task.description ?? `The task outcome satisfies: ${task.title}`],
          needsRepoWideContext: task.needsRepoWideContext === true,
          needsStrongReasoning: task.needsStrongReasoning === true,
          needsDelegateCli: task.needsDelegateCli === true,
          needsVisualReview: task.needsVisualReview === true,
        })),
      });
      setDurableBundle(bundle);
      if (!usedFallback) notify(`Planned and saved ${result.length} task${result.length === 1 ? "" : "s"}`, { tone: "success" });
    } catch (error) {
      notify(`Plan is visible but not durable — ${error instanceof Error ? error.message : String(error)}`, { tone: "warn" });
    } finally {
      setPlanSeq((n) => n + 1);
      setPlanning(false);
    }
  }

  return (
    <div style={{ flex: 1, minWidth: 0, height: "100%", overflow: "auto", background: "var(--bg)", color: "var(--fg)" }} className="shell-enter">
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
        /* Hover firms the hairline to charcoal and lifts a hair — depth stays
           shallow (Design.md: borders do the work, not ambient shadow). */
        .klide-orch-card:hover {
          transform: translateY(-1px);
          border-color: var(--border-strong) !important;
        }
        /* Live card: a static sage left-rail + faint wash so running work is
           the one thing the eye lands on. */
        .klide-orch-card[data-live="running"] {
          border-color: color-mix(in srgb, var(--accent) 42%, var(--border)) !important;
          box-shadow: inset 2px 0 0 var(--accent) !important;
        }
        /* Tier-strength bars grow up from their baseline on mount. */
        .klide-tier-bar {
          transform-origin: bottom;
          animation: klide-tier-grow 420ms var(--ease-spring) backwards;
        }
        @keyframes klide-tier-grow {
          from { transform: scaleY(0.2); opacity: 0; }
          to   { transform: scaleY(1);   opacity: inherit; }
        }
        .klide-orch-card[data-live="error"] {
          box-shadow: inset 2px 0 0 var(--danger) !important;
        }
        /* Interrupted by a restart — an amber rail says "retry", not "failed". */
        .klide-orch-card[data-live="interrupted"] {
          box-shadow: inset 2px 0 0 var(--warning) !important;
        }
        .klide-orch-card[data-live="review"] {
          box-shadow: inset 2px 0 0 var(--warning) !important;
          border-color: color-mix(in srgb, var(--warning) 35%, var(--border)) !important;
        }
        /* Lanes + summary build in with the SAME spring rise as the cards, just
           sequenced earlier — so on create the structure assembles, then the
           bricks lay into it. */
        .klide-orch-lane { animation: klide-orch-in 420ms var(--ease-spring) backwards; }
        .klide-orch-activity { animation: klide-orch-fade var(--motion-med) var(--ease-soft) backwards; }
        .klide-orch-run {
          transition: border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
        }
        .klide-orch-run:hover { border-color: color-mix(in srgb, var(--accent) 55%, var(--border-strong)) !important; color: var(--accent) !important; background: var(--accent-soft) !important; }
        @media (prefers-reduced-motion: reduce) {
          .klide-orch-card, .klide-orch-activity, .klide-tier-bar, .klide-orch-lane { animation: none; }
          .klide-orch-card:hover { transform: none; }
        }
      `}</style>
      <div style={{ padding: "28px 32px 64px", display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        {/* Page header — title + one-line orientation, then a hairline rule. */}
        <div style={{ marginBottom: 18 }}>
          <h2 style={{ fontSize: "var(--fs-xl)", fontWeight: 600, color: "var(--fg-strong)", margin: 0, letterSpacing: "-0.02em" }}>
            Orchestrator
          </h2>
          <p style={{ margin: "5px 0 0", fontSize: "var(--fs-base)", color: "var(--fg-subtle)", lineHeight: 1.5 }}>
            Plan a goal into tasks, then route each to the cheapest capable model.
          </p>
        </div>
        <div style={{ height: 1, background: "var(--border)", marginBottom: 20 }} />

        <div style={{ marginBottom: 12 }}>
          <GoalBar goal={goal} setGoal={setGoal} mode={mode} setMode={setMode} onPlan={plan} planning={planning} />
        </div>
        {/* Planner model — the orchestrator brain, chosen separately from the
            per-task models. */}
        <div style={{ marginBottom: 20, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={eyebrow}>Planner</span>
          <ModelChooser value={plannerSel} onChange={(v) => v && setPlannerSel(v)} excludeDelegate />
          <span style={{ fontSize: 11, color: "var(--fg-dim)" }}>decomposes the goal into tasks</span>
        </div>

        {/* Summary metric row — neutral surface, hairline-separated stats. Colour
            stays out so sage reads only on live work / budget / the CTA. */}
        {tasks.length > 0 && (
        <div
          key={`summary-${planSeq}`}
          className="klide-orch-lane"
          style={{
            display: "flex",
            alignItems: "center",
            padding: "14px 20px",
            marginBottom: 20,
            borderRadius: "var(--radius-lg)",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            flexWrap: "wrap",
            gap: "12px 0",
          }}
        >
          <CrewStat value={routed.length} format={(n) => String(Math.round(n))} label="tasks planned" />
          <StatDivider />
          <CrewStat value={readyCount} format={(n) => String(Math.round(n))} label="ready" />
          <StatDivider />
          <CrewStat value={totalCost} format={fmtUsd} label="est. cost" />
          <StatDivider />
          <CrewStat value={totalMs} format={fmtMin} label="est. time" />
          <span style={{ fontSize: 12, color: "var(--fg-subtle)", marginLeft: "auto", paddingLeft: 20, lineHeight: 1.5 }}>{MODES[mode].blurb}</span>
        </div>
        )}

        {/* Empty / planning states — before a plan exists, the board would be
            four empty lanes; show one focused state instead. */}
        {tasks.length === 0 && (
          <div style={{ display: "grid", placeItems: "center", padding: "clamp(40px, 11vh, 110px) 0" }}>
            <div className="klide-surface" style={{ textAlign: "center", maxWidth: 380, padding: "30px 34px" }}>
              {planning ? (
                <>
                  <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}><DotGridLoader size={22} label="Planning" /></div>
                  <div style={{ fontSize: "var(--fs-base)", color: "var(--fg-subtle)" }}>Breaking the goal into tasks…</div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: "var(--fs-md)", fontWeight: 600, color: "var(--fg-strong)", marginBottom: 6, letterSpacing: "-0.01em" }}>Plan a goal</div>
                  <div style={{ fontSize: "var(--fs-base)", color: "var(--fg-subtle)", lineHeight: 1.55, marginBottom: 14 }}>
                    Describe what you want to build above, then press <b style={{ fontWeight: 600, color: "var(--fg)" }}>Plan</b>.
                  </div>
                  <div style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--fg-dim)", letterSpacing: "0.02em" }}>
                    <span>1 Describe</span><IconChevron size={8} /><span>2 Plan</span><IconChevron size={8} /><span>3 Run</span>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* View switch — Board routes by model tier, Graph shows the dependency
            DAG. Both are projections of the same tasks. */}
        {tasks.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 14 }}>
            {(["board", "graph"] as const).map((view) => (
              <button
                key={view}
                onClick={() => setViewMode(view)}
                style={{
                  appearance: "none",
                  border: "none",
                  background: "transparent",
                  padding: "3px 4px",
                  marginRight: 8,
                  fontSize: 12.5,
                  fontWeight: viewMode === view ? 600 : 500,
                  color: viewMode === view ? "var(--fg-strong)" : "var(--fg-dim)",
                  borderBottom: viewMode === view ? "1.5px solid var(--accent)" : "1.5px solid transparent",
                  cursor: "pointer",
                  transition: "color var(--motion-fast) var(--ease-out)",
                }}
              >
                {view === "board" ? "Board" : "Graph"}
              </button>
            ))}
          </div>
        )}

        {tasks.length > 0 && viewMode === "graph" && (
          <MissionGraph
            tasks={graphTasks}
            meta={graphMeta}
            editable={!planApproved}
            savingTaskId={savingTaskId}
            onToggleDependency={toggleDependency}
          />
        )}

        {tasks.length > 0 && viewMode === "board" && (
        <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
          {/* tier columns — content-height + top-aligned, so lanes never become
              giant empty wells. */}
          <div style={{ display: "flex", gap: 16, flex: 1, minWidth: 0, alignItems: "flex-start" }}>
            {TIER_ORDER.map((tier, tierIdx) => {
              const m = TIER_META[tier];
              const items = byTier[tier];
              const colCost = items.reduce((s, r) => s + (r.assignment.estimatedCostUsd ?? 0), 0);
              return (
                // Keyed on planSeq so a new plan remounts the lane and replays
                // its build-in; left-to-right via tierIdx so the structure
                // assembles across the full width before the cards lay in.
                <div key={`${tier}-${planSeq}`} className="klide-orch-lane" style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, animationDelay: `${tierIdx * 70}ms` }}>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <TierMeter level={m.level} />
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--fg-strong)", letterSpacing: "-0.005em" }}>{m.label}</span>
                      <span style={{ fontSize: 10.5, fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", color: "var(--fg-subtle)", lineHeight: 1.6 }}>{items.length}</span>
                      <span style={{ marginLeft: "auto", fontSize: 11, fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", color: "var(--fg-subtle)" }}>
                        {fmtUsd(colCost)}
                      </span>
                    </div>
                    <div style={{ fontSize: 10.5, color: "var(--fg-dim)", marginLeft: 22, marginTop: 3, lineHeight: 1.4 }}>{m.role}</div>
                  </div>
                  {/* No heavy well box — just a card stack. Cards carry the
                      elevation; the column reads by its header + the cards. */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {items.map((r, i) => {
                      const t = r.task;
                      const dep = t.dependsOn?.[0];
                      const liveCard = real.live[t.taskId];
                      const durableTask = durableState?.tasks[t.taskId];
                      const durableSpec = durableBundle?.tasks.find((task) => task.id === t.taskId);
                      const lastAttempt = durableTask?.attempts[durableTask.attempts.length - 1];
                      const projectedStatus: CardStatus = durableTask?.acceptedRunId
                        ? "done"
                        : lastAttempt?.status === "review"
                          ? "review"
                          : lastAttempt?.status === "running"
                            ? "running"
                            : lastAttempt?.status === "interrupted"
                              ? "interrupted"
                              : lastAttempt
                                ? "error"
                                : "idle";
                      const status: CardStatus = projectedStatus === "done" || projectedStatus === "review" || projectedStatus === "error" || projectedStatus === "interrupted"
                        ? projectedStatus
                        : liveCard?.status ?? projectedStatus;
                      const canRunReal = !!workspaceRoot && !!durableBundle && status !== "running" && status !== "review" && !missionOn;
                      const ov = overrides[t.taskId] ?? null;
                      const isOpen = expanded === t.taskId;
                      const effWorker = ov ? providerName(ov.provider) : WORKER_LABEL[r.assignment.workerKind];
                      const estCost = r.assignment.estimatedCostUsd ?? 0;
                      const estMs = r.assignment.estimatedDurationMs ?? 0;
                      return (
                        <div
                          // key carries `mode` + `planSeq` so flipping the budget
                          // mode OR re-planning remounts the cards and replays the
                          // build. Delay is GLOBAL (row-major across all lanes) and
                          // offset past the lane build, so cards lay in as one
                          // continuous full-width wave, brick by brick.
                          key={`${t.taskId}-${mode}-${planSeq}`}
                          className="klide-orch-card"
                          data-live={status === "running" ? "running" : status === "review" ? "review" : status === "error" ? "error" : status === "interrupted" ? "interrupted" : undefined}
                          onClick={() => setExpanded((e) => (e === t.taskId ? null : t.taskId))}
                          style={{
                            padding: 16,
                            borderRadius: "var(--radius-lg)",
                            background: status === "running" ? "color-mix(in srgb, var(--accent-soft) 45%, var(--bg-elevated))" : "var(--bg-elevated)",
                            // Soft hairline at rest (Design.md card spec); hover/live
                            // firm it to charcoal so the strong border earns its weight.
                            border: "1px solid var(--border)",
                            cursor: "pointer",
                            animationDelay: `${220 + (buildOrder[t.taskId] ?? i) * 60}ms`,
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                            <span style={eyebrow}>{t.phase}</span>
                            <span style={{ ...eyebrow, color: t.risk === "high" ? "var(--danger)" : t.risk === "medium" ? "var(--warning)" : "var(--fg-dim)" }}>
                              ·{RISK_LABEL[t.risk]}
                            </span>
                            <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center" }}>
                              <StatusBadge status={status} />
                            </span>
                          </div>
                          {isOpen ? (
                            <div onClick={(event) => event.stopPropagation()} style={{ display: "grid", gap: 7, marginBottom: 9 }}>
                              <input
                                value={t.title}
                                disabled={planApproved}
                                onChange={(event) => patchPlannedTask(t.taskId, { title: event.target.value })}
                                aria-label="Task title"
                                style={{ width: "100%", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", background: "var(--bg)", color: "var(--fg-strong)", padding: "6px 8px", font: "inherit", fontSize: "var(--fs-base)", fontWeight: 500 }}
                              />
                              <textarea
                                value={t.description ?? ""}
                                disabled={planApproved}
                                onChange={(event) => patchPlannedTask(t.taskId, { description: event.target.value })}
                                aria-label="Task Markdown"
                                rows={4}
                                placeholder="Task context in Markdown"
                                style={{ width: "100%", resize: "vertical", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", background: "var(--bg)", color: "var(--fg-subtle)", padding: "7px 8px", font: "inherit", fontSize: 12, lineHeight: 1.5 }}
                              />
                              <button
                                className="klide-button klide-button-ghost"
                                disabled={planApproved || !durableBundle || savingTaskId !== null || !t.title.trim()}
                                onClick={() => void saveTaskEdit(t)}
                                style={{ justifySelf: "end", minHeight: 26, padding: "3px 9px", fontSize: 10.5 }}
                              >
                                {planApproved ? "Plan approved" : savingTaskId === t.taskId ? "Saving…" : "Save task"}
                              </button>
                            </div>
                          ) : (
                            <div style={{ fontSize: "var(--fs-base)", color: "var(--fg-strong)", lineHeight: 1.4, marginBottom: 8, letterSpacing: "-0.003em" }}>{t.title}</div>
                          )}
                          {dep && (() => {
                            // Mission-aware dep line: parked upstream failure →
                            // blocked; an interrupted upstream → retry (amber, not
                            // a failure); waiting its turn in a live mission → queued.
                            const depFailed = (t.dependsOn ?? []).some((d) => durableState?.tasks[d]?.status === "failed");
                            const depInterrupted = !depFailed && (t.dependsOn ?? []).some((d) => durableState?.tasks[d]?.status === "interrupted");
                            const queued = missionOn && !liveCard && !depFailed && !depInterrupted;
                            const depTitle = (titleById[dep] ?? dep).slice(0, 24);
                            return (
                              <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10.5, color: depFailed ? "var(--danger)" : depInterrupted ? "var(--warning)" : "var(--fg-dim)", marginBottom: 8 }}>
                                <IconDep size={11} />
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {depFailed ? `blocked · ${depTitle} failed` : depInterrupted ? `blocked · ${depTitle} interrupted` : queued ? `queued · after ${depTitle}` : `after ${depTitle}`}
                                </span>
                              </div>
                            );
                          })()}
                          {liveCard && (
                            <div
                              className="klide-orch-activity"
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 5,
                                fontSize: 11,
                                fontFamily: "var(--font-mono)",
                                color: liveCard.status === "error" ? "var(--danger)" : liveCard.status === "done" ? "var(--fg-subtle)" : "var(--accent)",
                                marginBottom: 8,
                              }}
                            >
                              <span style={{ display: "inline-flex", flexShrink: 0 }}>
                                {liveCard.status === "running" ? <IconChevron size={9} /> : liveCard.status === "done" ? <IconCheck size={10} /> : <IconX size={9} />}
                              </span>
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{liveCard.activity}</span>
                            </div>
                          )}
                          {/* Expanded detail — the cost/time estimate spelled out. */}
                          {isOpen && (
                            <div className="klide-orch-activity" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 11, marginBottom: 4 }}>
                              <span style={{ color: "var(--fg-dim)" }}>Estimated</span>
                              <span style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", color: "var(--fg-subtle)" }}>
                                <span style={{ color: estCost > 0 ? "var(--fg-strong)" : "var(--fg-subtle)" }}>{fmtUsd(estCost)}</span> · ~{fmtMin(estMs)}
                              </span>
                            </div>
                          )}
                          {/* Footer — worker/model on a hairline shelf. Expanded:
                              the worker becomes a chooser so you can reroute it. */}
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 10, paddingTop: 10, borderTop: "1px solid color-mix(in srgb, var(--border) 70%, transparent)" }}>
                            {isOpen && !planApproved ? (
                              <ModelChooser
                                value={ov}
                                onChange={(v) => setOverrides((m) => { const n = { ...m }; if (v) n[t.taskId] = v; else delete n[t.taskId]; return n; })}
                                auto
                              />
                            ) : (
                              <span style={{ fontSize: 11, color: ov ? "var(--accent)" : "var(--fg-subtle)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{effWorker}</span>
                            )}
                            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                              {status === "review" && lastAttempt && durableSpec?.dispatch && (
                                <button
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setDelegateReview({
                                      taskId: t.taskId,
                                      taskTitle: t.title,
                                      runId: lastAttempt.runId,
                                      providerId: durableSpec.dispatch!.provider as ProviderId,
                                      provider: providerName(durableSpec.dispatch!.provider as ProviderId),
                                      model: durableSpec.dispatch!.model,
                                      exitCode: lastAttempt.exitCode ?? 1,
                                      signal: lastAttempt.signal,
                                    });
                                  }}
                                  className="klide-button klide-button-primary"
                                  style={{ minHeight: 24, padding: "3px 9px", fontSize: 10.5 }}
                                >
                                  Review
                                </button>
                              )}
                              {canRunReal && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); void runSingleTask(t.taskId); }}
                                  title="Dispatch this task as a real run — edits surface for review"
                                  className="klide-orch-run"
                                  style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: 5,
                                    fontSize: 10.5,
                                    fontWeight: 500,
                                    padding: "3px 10px 3px 9px",
                                    borderRadius: "var(--radius-sm)",
                                    border: "1px solid var(--border-strong)",
                                    color: "var(--fg-subtle)",
                                  }}
                                >
                                  <IconPlay size={8} /> run
                                </button>
                              )}
                              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontVariantNumeric: "tabular-nums", color: "var(--fg-subtle)" }}>
                                {fmtUsd(estCost)}
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {items.length === 0 && (
                      <div
                        style={{
                          flex: 1,
                          minHeight: 72,
                          display: "grid",
                          placeItems: "center",
                          border: "1px dashed color-mix(in srgb, var(--border-strong) 45%, transparent)",
                          borderRadius: "var(--radius-md)",
                          color: "var(--fg-dim)",
                          fontSize: 11,
                          fontFamily: "var(--font-mono)",
                          letterSpacing: "0.04em",
                        }}
                      >
                        no tasks
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* right rail */}
          <div style={{ width: 240, display: "flex", flexDirection: "column", gap: 14, flex: "0 0 240px" }}>
            <div className="klide-surface" style={{ padding: 18 }}>
              <div style={{ ...eyebrow, marginBottom: 12 }}>Budget</div>
              <BudgetMeter spent={totalCost} max={envelope.maxCostUsd} />
              <div style={{ fontSize: 11, color: "var(--fg-subtle)", marginTop: 12 }}>
                Est. time <span style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", color: "var(--fg)" }}>{fmtMin(totalMs)}</span>
              </div>
            </div>
            <button className="klide-button klide-button-primary" onClick={() => void runMission()} disabled={!workspaceRoot || !durableBundle || readyCount === 0 || missionOn}>
              {!workspaceRoot ? "Open a workspace" : !durableBundle ? "Mission not saved" : missionOn ? "Mission running…" : `Run mission · ${routed.length} task${routed.length === 1 ? "" : "s"}`}
            </button>
            {/* Review toggle — review every edit, or auto-apply (still checkpointed). */}
            <button
              onClick={() => setReviewEdits((v) => !v)}
              className="klide-surface"
              style={{ padding: "12px 14px", display: "flex", alignItems: "center", gap: 10, cursor: "pointer", textAlign: "left" }}
            >
              <span className="klide-switch" data-checked={reviewEdits} aria-hidden style={{ flexShrink: 0 }}><span className="klide-switch-knob" /></span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: "var(--fg-strong)" }}>Review Harness edits</span>
                <span style={{ display: "block", fontSize: 11, color: "var(--fg-subtle)", lineHeight: 1.4 }}>{reviewEdits ? "Harness edits pause before applying. Delegates review after their turn." : "Harness edits auto-apply; Delegate acceptance still stays explicit."}</span>
              </span>
            </button>
            <div className="klide-surface" style={{ padding: 18, fontSize: 12, color: "var(--fg-subtle)", lineHeight: 1.55 }}>
              <div style={{ ...eyebrow, marginBottom: 8 }}>How it works</div>
              Approval freezes each task’s worker, provider, model, and review policy into Mission Markdown. Harness Runs continue after validation. Delegate Runs execute one bounded turn, then wait for explicit operator acceptance. Rejected work parks for an explicit retry.
            </div>
          </div>
        </div>
        )}

        {/* Operator review surface — one pause at a time (diff or permission). */}
        {real.head?.kind === "diff" && (
          <DiffModal
            edit={{
              path: real.head.proposal.path,
              oldContent: real.head.proposal.oldContent,
              newContent: real.head.proposal.newContent,
              isCreate: real.head.proposal.isCreate,
              reason: real.head.proposal.reason,
            }}
            onApply={() => void real.applyDiff()}
            onReject={() => void real.rejectDiff()}
          />
        )}
        {real.head?.kind === "permission" && (
          <PermissionPrompt
            request={real.head.request}
            onAllow={() => void real.decidePermission(true)}
            onDeny={() => void real.decidePermission(false)}
          />
        )}
        {delegateReview && (
          <DelegateReviewModal
            target={delegateReview}
            workspaceRoot={workspaceRoot}
            busy={reviewingRunId === delegateReview.runId}
            onClose={() => setDelegateReview(null)}
            onDecision={(accepted) => void reviewDelegateAttempt(accepted)}
          />
        )}
      </div>
    </div>
  );
}
