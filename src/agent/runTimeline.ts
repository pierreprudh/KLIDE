import type { AgentEvent } from "./types";

export type TimelineSpan = {
  id: string;
  label: string;
  kind: "model" | "tool" | "wait" | "worker";
  start: number;
  end?: number;
  status: "running" | "done" | "error" | "incomplete";
  detail: string;
  observed?: boolean;
  parentId?: string;
  cost?: number;
  tokensIn?: number;
  tokensOut?: number;
  model?: string;
  provider?: string;
};

export type TimelineRun = { id: number; startedAt: number; events: AgentEvent[] };

/** RunStarted is emitted at every dispatch, including resumed conversations.
 * Keep that boundary: a Transcript is a conversation, not one elapsed Run. */
export function timelineRuns(events: AgentEvent[]): TimelineRun[] {
  const runs: TimelineRun[] = [];
  let current: TimelineRun | undefined;
  let settled = false;
  for (const [index, event] of events.entries()) {
    if (event.type === "run_started" || !current) {
      current = { id: index, startedAt: event.ts, events: [] };
      runs.push(current);
      settled = false;
    }
    if (settled) continue;
    current.events.push(event);
    if (event.type === "run_result" || event.type === "run_error") settled = true;
  }
  return runs;
}

/** A timing projection of the transcript. Never infer provider latency from gaps. */
export function buildRunTimeline(events: AgentEvent[], active: boolean, now: number) {
  const runs = timelineRuns(events);
  const runEvents = runs[runs.length - 1]?.events ?? [];
  const identity = runEvents.find(event => event.type === "run_started");
  const spans: TimelineSpan[] = [];
  const pending = new Map<string, TimelineSpan>();
  let lastTs = 0;
  let firstTs = Infinity;
  let tokens = 0;
  let cost: number | undefined;
  const add = (key: string, span: TimelineSpan) => {
    spans.push(span);
    pending.set(key, span);
  };
  const finish = (key: string, ts: number, detail?: string, ok = true) => {
    const span = pending.get(key);
    if (!span) return;
    span.end = Math.max(span.start, ts);
    span.status = ok ? "done" : "error";
    if (detail !== undefined) span.detail += `\n\n${detail}`;
    pending.delete(key);
  };
  const closePending = (ts: number) => {
    for (const span of pending.values()) {
      span.end = Math.max(span.start, ts);
      span.status = "incomplete";
    }
    pending.clear();
  };
  for (const [index, event] of runEvents.entries()) {
    if (!Number.isFinite(event.ts)) continue;
    firstTs = Math.min(firstTs, event.ts);
    lastTs = Math.max(lastTs, event.ts);
    switch (event.type) {
      case "run_started": closePending(event.ts); break;
      case "tool_call_started":
      case "observed_tool_call":
        add(`tool:${event.toolCallId}`, {
          id: `tool:${index}`, label: event.name, kind: "tool", start: event.ts,
          status: "running", observed: event.type === "observed_tool_call",
          detail: `${event.summary}\n${JSON.stringify(event.input, null, 2) ?? ""}`,
        });
        break;
      case "tool_call_finished": finish(`tool:${event.toolCallId}`, event.ts, event.result.content, event.result.ok); break;
      case "observed_tool_result": finish(`tool:${event.toolCallId}`, event.ts, event.content, event.ok); break;
      case "assistant_message": {
        tokens += (event.usage?.promptTokens ?? 0) + (event.usage?.completionTokens ?? 0);
        if (event.usage?.costUsd !== undefined) cost = (cost ?? 0) + event.usage.costUsd;
        if (event.timing && Number.isFinite(event.timing.modelMs) && event.timing.modelMs >= 0) {
          const start = event.ts - event.timing.modelMs;
          firstTs = Math.min(firstTs, start);
          spans.push({ id: `model:${index}`, label: "Model response", kind: "model", model: identity?.model, provider: identity?.provider, start,
            end: event.ts, status: "done", cost: event.usage?.costUsd, tokensIn: event.usage?.promptTokens, tokensOut: event.usage?.completionTokens, detail: event.content.filter(b => b.type === "text").map(b => b.text).join("\n") });
        }
        break;
      }
      case "permission_requested":
        add(`permission:${event.request.id}`, { id: `permission:${index}`, label: "Permission approval", parentId: pending.get(`tool:${event.request.toolCallId}`)?.id, kind: "wait", start: event.ts, status: "running", detail: JSON.stringify(event.request, null, 2) }); break;
      case "permission_resolved": finish(`permission:${event.requestId}`, event.ts, JSON.stringify(event.decision)); break;
      case "diff_proposed":
        add(`diff:${event.proposal.id}`, { id: `diff:${index}`, label: "Diff review", parentId: pending.get(`tool:${event.proposal.toolCallId}`)?.id, kind: "wait", start: event.ts, status: "running", detail: event.proposal.path }); break;
      case "diff_resolved": finish(`diff:${event.proposalId}`, event.ts, JSON.stringify(event.decision)); break;
      case "user_question_requested":
        add(`question:${event.requestId}`, { id: `question:${index}`, label: "Waiting for answer", kind: "wait", start: event.ts, status: "running", detail: event.question }); break;
      case "user_question_resolved": finish(`question:${event.requestId}`, event.ts, event.answer); break;
      case "subagent_requested":
        add(`worker:${event.requestId}`, { id: `worker:${index}`, label: event.worker ?? event.subagent, model: event.model, provider: event.worker, kind: "worker", start: event.ts, status: "running", detail: event.task }); break;
      case "subagent_resolved": finish(`worker:${event.requestId}`, event.ts, event.result, event.ok !== false); break;
      case "run_result":
      case "run_error": closePending(event.ts); active = false; break;
    }
  }
  if (!active) closePending(lastTs);
  spans.sort((a, b) => a.start - b.start);
  const start = Number.isFinite(firstTs) ? firstTs : 0;
  const end = runEvents.length && active ? Math.max(lastTs, now) : lastTs;
  return { spans, start, end: Math.max(start, end), tokens, cost };
}
