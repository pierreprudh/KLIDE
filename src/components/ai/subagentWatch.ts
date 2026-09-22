// SUBAGENT WATCHER — what the child Run is doing, while it does it.
//
// `spawn_subagent` parks the parent turn until the child settles, and until
// now that stretch showed one static "Delegated to …" line: the child could
// read forty files and nothing on screen moved. The child is a Run like any
// other, though — Rust persists its events and broadcasts each one on
// `agent-run:{id}` — so watching it is a subscription, not a new mechanism.
//
// The address comes off the call itself (`FoldedToolCall.childRunId`, written
// by the fold from `subagent_requested`), so a reloaded transcript can pick a
// still-running child back up exactly like a fresh one.
//
// Two halves, deliberately: `subagentActivity` is a pure fold over events
// (unit-tested, no Tauri), and `watchSubagentRun` is the IPC shell that keeps
// an event array current. The expanded view folds those same events through
// `foldAgentEvents` — the ONE fold — so a child's rows read like the parent's.

import { readAgentRunEvents, reattachAgentRun } from "../../agent/client";
import type { AgentEvent } from "../../agent/types";

/** What the child is doing right now: the tool name, and its own summary of
 *  the argument ("src/time.ts"). Null between steps. */
export type SubagentStep = { name: string; detail: string };

export type SubagentActivity = {
  /** `starting` — registered, nothing streamed yet. `working` — mid-run.
   *  `done` / `failed` — the child settled. */
  status: "starting" | "working" | "done" | "failed";
  /** The child's `run_started` ts, so the watcher's clock counts from the
   *  child's own start rather than from when this row mounted. */
  startedMs?: number;
  /** Tool calls the child started — dispatched by the Harness or observed
   *  from a Delegate CLI's own stream. Its steps either way. */
  steps: number;
  /** Assistant turns the child has completed. */
  turns: number;
  /** Completion tokens the provider reported, summed over the child's turns.
   *  0 when no turn carried usage (local models often don't). */
  tokens: number;
  /** The step in flight, or null when the child is between steps. */
  current: SubagentStep | null;
  /** Why it failed, when it did. */
  error?: string;
};

const EMPTY: SubagentActivity = { status: "starting", steps: 0, turns: 0, tokens: 0, current: null };

/**
 * Fold a child Run's events into the one line the parent conversation shows.
 *
 * Open steps are tracked in insertion order so the "current" step is the most
 * recent one still running — a run with parallel tool calls names the latest,
 * not a stale one that happens to sort first.
 */
export function subagentActivity(events: AgentEvent[]): SubagentActivity {
  if (events.length === 0) return EMPTY;
  const open = new Map<string, SubagentStep>();
  let status: SubagentActivity["status"] = "starting";
  let startedMs: number | undefined;
  let steps = 0;
  let turns = 0;
  let tokens = 0;
  let error: string | undefined;

  for (const event of events) {
    switch (event.type) {
      case "run_started":
        startedMs = event.ts;
        status = "working";
        break;
      case "tool_call_started":
      case "observed_tool_call":
        steps += 1;
        status = "working";
        open.set(event.toolCallId, { name: event.name, detail: event.summary ?? "" });
        break;
      case "tool_call_finished":
      case "observed_tool_result":
        open.delete(event.toolCallId);
        break;
      case "assistant_message":
        turns += 1;
        tokens += event.usage?.completionTokens ?? 0;
        status = "working";
        break;
      case "run_result":
        // `cancelled` and `max_turns` are settlements, not successes: the
        // parent gets a failed tool result from them, so the watcher must not
        // claim the child is done.
        status = event.result.status === "done" ? "done" : "failed";
        if (event.result.status !== "done") error = event.result.message ?? event.result.status;
        open.clear();
        break;
      case "run_error":
        status = "failed";
        error = event.error.message;
        open.clear();
        break;
      default:
        break;
    }
  }

  let current: SubagentStep | null = null;
  for (const step of open.values()) current = step;
  return { status, startedMs, steps, turns, tokens, current, error };
}

/** True while the child is still worth listening to. */
export function isWatchable(activity: SubagentActivity): boolean {
  return activity.status === "starting" || activity.status === "working";
}

/**
 * Follow one child Run: snapshot its transcript, then apply every broadcast
 * event after it.
 *
 * The listener is registered *before* the snapshot is read and events that
 * arrive meanwhile are buffered, so the snapshot→subscribe seam can neither
 * drop an event nor apply one twice: `seq` is the event's absolute transcript
 * index, and anything below the snapshot's length is already in hand.
 *
 * `onChange` receives the whole event array each time it grows — the caller
 * folds it (cheaply for the one-line view, lazily for the expanded one).
 * Returns a detach function; calling it stops the listening, never the child.
 */
export function watchSubagentRun(
  runId: string,
  onChange: (events: AgentEvent[]) => void
): () => void {
  let stopped = false;
  let events: AgentEvent[] | null = null;
  let applied = 0;
  const buffered: { seq: number; event: AgentEvent }[] = [];
  let detachLive: (() => void) | null = null;

  const push = (seq: number, event: AgentEvent) => {
    if (!events || seq < applied) return;
    // A gap (seq > applied) would mean a lost broadcast; keep the event rather
    // than stalling on it — the transcript is still the durable record.
    events = [...events, event];
    applied = seq + 1;
  };

  void (async () => {
    let reattachment: Awaited<ReturnType<typeof reattachAgentRun>> | null = null;
    try {
      reattachment = await reattachAgentRun(runId, 0, (event, seq) => {
        if (stopped) return;
        if (!events) {
          buffered.push({ seq, event });
          return;
        }
        push(seq, event);
        onChange(events);
      });
    } catch {
      // Still read the durable transcript if live registration failed.
    }
    if (stopped) {
      reattachment?.detach();
      return;
    }
    detachLive = reattachment?.detach ?? null;

    try {
      events = await readAgentRunEvents(runId);
    } catch {
      // The child hasn't written a transcript yet (it is registering). An
      // empty base is correct: the live stream fills it from its first event.
      events = [];
    }
    applied = events.length;
    if (stopped) return;
    for (const { seq, event } of buffered.splice(0)) push(seq, event);
    onChange(events);
  })();

  return () => {
    stopped = true;
    detachLive?.();
    detachLive = null;
  };
}
