// The watcher's surface: one quiet line under a delegation, and the way in.
//
// While `spawn_subagent` holds the parent turn, this is the only thing moving
// on screen for that stretch — so it says what the child is doing right now
// (its current step), how far it has got (steps, turns, tokens) and how long
// it has been at it. Opening it reveals the child's own rows; the caller
// renders those, because the message renderer lives with the messages.
//
// Shape follows the rest of the panel: a hairline spine, machinery in mono one
// token dimmer than prose, no badge and no status dot. The line disappears
// when the child settles and its report takes the space instead.

import { useEffect, useMemo, useRef, useState } from "react";
import { DotGridLoader } from "./icons";
import { useElapsed } from "./WorkingRow";
import { subagentActivity, watchSubagentRun, type SubagentActivity } from "./subagentWatch";
import { permissionCard } from "./permissionCard";
import { InlineCommandReview } from "../InlineCommandReview";
import { resolvePermission } from "../../agent/client";
import { notify } from "../../toast";
import { errMessage } from "../../errors";
import type { AgentEvent, PermissionDecision, PermissionRequest } from "../../agent/types";

export type SubagentWatchState = {
  activity: SubagentActivity;
  events: AgentEvent[];
  /** True once the child's transcript has been read at least once. */
  loaded: boolean;
};

/**
 * Follow a child Run while `live`, and keep following an opened one after it
 * settles so the rows stay readable.
 *
 * A settled call is not fetched until someone opens it: a long conversation
 * can hold a dozen finished delegations, and reading every child's transcript
 * on render would cost a dozen disk reads nobody asked for.
 */
export function useSubagentWatch(childRunId: string | undefined, enabled: boolean): SubagentWatchState {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [active, setActive] = useState<boolean | undefined>();
  const [loaded, setLoaded] = useState(false);
  // The events of the run we are actually showing. A conversation switch can
  // swap the id under us; without this the old child's rows would linger.
  const shownFor = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!childRunId || !enabled) return;
    if (shownFor.current !== childRunId) {
      shownFor.current = childRunId;
      setEvents([]);
      setActive(undefined);
      setLoaded(false);
    }
    let alive = true;
    const detach = watchSubagentRun(childRunId, (next, live) => {
      if (!alive) return;
      setEvents(next);
      setActive(live);
      setLoaded(true);
    });
    return () => {
      alive = false;
      detach();
    };
  }, [childRunId, enabled]);

  const activity = useMemo(() => {
    const folded = subagentActivity(events);
    if (active === false && (folded.status === "starting" || folded.status === "working")) {
      return { ...folded, status: "failed" as const, current: null, error: "Interrupted: run is no longer active." };
    }
    return folded;
  }, [events, active]);
  return { activity, events, loaded };
}

/** The tool name, said the way a person would. Falls back to the raw name so a
 *  workspace-defined tool still reads as something rather than nothing. */
function stepVerb(name: string): string {
  switch (name) {
    case "read_file":
      return "reading";
    case "write_file":
    case "edit_file":
      return "editing";
    case "list_dir":
    case "glob":
      return "looking through";
    case "grep":
    case "search_files":
      return "searching";
    case "run_command":
      return "running";
    case "memory_search":
    case "memory_read":
      return "recalling";
    default:
      return name.replace(/_/g, " ");
  }
}

export function SubagentWatchLine({
  activity,
  open,
  onToggle,
  hasRows,
}: {
  activity: SubagentActivity;
  open: boolean;
  onToggle: () => void;
  /** Whether opening would show anything yet. */
  hasRows: boolean;
}) {
  const elapsed = useElapsed(activity.status === "starting" || activity.status === "working" ? activity.startedMs : undefined);
  const working = activity.status === "starting" || activity.status === "working";
  // Blocked on a person, not on the model: no loader, and the line says what
  // it is asking for — the card below is where the answer goes.
  const asking = working ? activity.pendingPermission : null;
  const step = asking ? { name: "", detail: asking.summary } : activity.current;
  // Between steps the child is thinking; before its first event it is starting.
  const label = asking
    ? "asking"
    : step
      ? stepVerb(step.name)
      : activity.status === "starting"
        ? "starting"
        : activity.status === "done" ? "finished" : activity.status === "failed" ? (activity.error?.startsWith("Interrupted:") ? "interrupted" : "stopped") : "thinking";

  const counts: string[] = [];
  if (activity.steps > 0) counts.push(`${activity.steps} ${activity.steps === 1 ? "step" : "steps"}`);
  if (activity.tokens > 0) counts.push(`${activity.tokens.toLocaleString()} tok`);

  return (
    <button
      type="button"
      onClick={hasRows ? onToggle : undefined}
      aria-expanded={hasRows ? open : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        margin: "4px 0 0 13px",
        padding: "2px 0 2px 11px",
        background: "none",
        border: "none",
        borderLeft: "1px solid var(--border)",
        borderRadius: 0,
        textAlign: "left",
        cursor: hasRows ? "pointer" : "default",
        color: "var(--fg-dim)",
        minWidth: 0,
      }}
    >
      {working && !asking && <DotGridLoader size={10} label={label} />}
      <span style={{ fontSize: 12, color: "var(--fg-subtle)", flexShrink: 0 }}>{label}</span>
      {step?.detail && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11.5,
            color: "var(--fg-dim)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {step.detail}
        </span>
      )}
      <span style={{ flex: 1 }} />
      {counts.length > 0 && (
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
          {counts.join(" · ")}
        </span>
      )}
      {working && (
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
          {elapsed}
        </span>
      )}
    </button>
  );
}

/**
 * The permission a child Run is waiting on, answered from the parent's row.
 *
 * The child raised it on `agent-run:{child}` — the relay's words: "a headless
 * turn has no terminal of its own, so the question comes here" — and nothing
 * was listening there. Same card as the panel's own gate, resolved against the
 * child's Run id, so the Harness or the Delegate CLI continues exactly as if
 * the prompt had been its own. The card hides on the click; the child's
 * `permission_resolved` confirms it, and a refused answer brings it back.
 * No hotkeys: the parent's own card, when there is one, owns ⏎ and esc.
 */
export function SubagentPermissionCard({ runId, request }: { runId: string; request: PermissionRequest }) {
  const card = useMemo(() => permissionCard(runId, request), [runId, request]);
  const [answered, setAnswered] = useState<string | null>(null);
  if (answered === request.id) return null;
  const answer = (decision: PermissionDecision) => {
    setAnswered(request.id);
    void resolvePermission({ runId, requestId: request.id, decision }).catch((error) => {
      setAnswered(null);
      notify(`Couldn't answer the worker: ${errMessage(error)}`, { tone: "error" });
    });
  };
  const approve = (scope: "once" | "run" | "project", pattern?: string) =>
    answer(pattern ? { behavior: "allow", scope, pattern } : { behavior: "allow", scope });
  return (
    <div style={{ margin: "6px 0 2px 24px" }}>
      <InlineCommandReview
        command={card.command}
        kind={card.kind}
        detail={card.reason}
        externalPaths={card.externalPaths}
        interpreter={card.interpreter}
        peer={card.peer}
        worker={card.worker}
        connector={card.connector}
        onReject={() => answer({ behavior: "deny" })}
        onApproveOnce={() => approve("once")}
        onApproveForRun={card.kind === "worker" ? undefined : () => approve("run")}
        onApproveForProject={card.kind === "message" || card.kind === "worker" ? undefined : () => approve("project")}
        pattern={card.suggestedPattern}
        onApprovePattern={(pattern) => approve("project", pattern)}
      />
    </div>
  );
}

/** The spine the child's own rows hang off, so they read as one level in. */
export function SubagentWatchBody({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="ai-msg-in"
      style={{
        margin: "2px 0 4px 13px",
        padding: "2px 0 2px 11px",
        borderLeft: "1px solid var(--border)",
      }}
    >
      {children}
    </div>
  );
}
