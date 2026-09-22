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
import type { AgentEvent } from "../../agent/types";

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
  const [loaded, setLoaded] = useState(false);
  // The events of the run we are actually showing. A conversation switch can
  // swap the id under us; without this the old child's rows would linger.
  const shownFor = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!childRunId || !enabled) return;
    if (shownFor.current !== childRunId) {
      shownFor.current = childRunId;
      setEvents([]);
      setLoaded(false);
    }
    let alive = true;
    const detach = watchSubagentRun(childRunId, (next) => {
      if (!alive) return;
      setEvents(next);
      setLoaded(true);
    });
    return () => {
      alive = false;
      detach();
    };
  }, [childRunId, enabled]);

  const activity = useMemo(() => subagentActivity(events), [events]);
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
  const elapsed = useElapsed(activity.startedMs);
  const working = activity.status === "starting" || activity.status === "working";
  const step = activity.current;
  // Between steps the child is thinking; before its first event it is starting.
  const label = step
    ? stepVerb(step.name)
    : activity.status === "starting"
      ? "starting"
      : activity.status === "done" ? "finished" : activity.status === "failed" ? "stopped" : "thinking";

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
      {working && <DotGridLoader size={10} label={label} />}
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
