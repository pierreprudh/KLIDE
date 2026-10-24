import type { AgentEvent, AgentUsage } from "./types";
import { timelineRuns } from "./runTimeline";

export type ContextSource = { kind: "Attachment" | "Project context" | "Memory" | "Omitted"; label: string; detail: string };
export type ContextTraceItem = {
  id: string;
  ts: number;
  kind: "snapshot" | "injection" | "compaction" | "input";
  label: string;
  size?: number;
  estimated?: boolean;
  window?: number;
  sources: ContextSource[];
  detail: string;
};

function recordedNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function runEvents(events: AgentEvent[]) {
  const runs = timelineRuns(events);
  return runs[runs.length - 1]?.events ?? [];
}

export function buildContextTrace(events: AgentEvent[]): ContextTraceItem[] {
  const items: ContextTraceItem[] = [];
  let response = 0;
  for (const [index, event] of runEvents(events).entries()) {
    if (!Number.isFinite(event.ts)) continue;
    const common = { id: `context:${index}`, ts: event.ts };
    switch (event.type) {
      case "context_snapshot": {
        const snapshot = event.snapshot;
        const sources: ContextSource[] = [
          ...snapshot.attachments.map(item => ({ kind: "Attachment" as const, label: item.path, detail: item.mime?.startsWith("image/") ? `Image attachment (${item.mime})` : item.content })),
          ...snapshot.lensItems.map(item => ({ kind: "Project context" as const, label: item.label || item.path, detail: [item.path, item.detail].filter(Boolean).join("\n") })),
          ...(snapshot.memory?.entries.map(item => ({ kind: "Memory" as const, label: item.title, detail: item.relPath })) ?? []),
          ...snapshot.omitted.map(item => ({ kind: "Omitted" as const, label: item.path ?? "Context omitted", detail: `${item.reason}${item.count !== undefined ? ` (${item.count})` : ""}` })),
        ];
        items.push({ ...common, kind: "snapshot", label: "Supplied context", size: recordedNumber(snapshot.estimatedTokens), estimated: true, sources, detail: snapshot.memory?.prompt ?? "" });
        break;
      }
      case "context_injected":
        items.push({ ...common, kind: "injection", label: `Context added · ${event.role}`, sources: [], detail: event.content });
        break;
      case "context_compacted":
        items.push({ ...common, kind: "compaction", label: event.manual ? "Manual compaction" : "Automatic compaction", size: recordedNumber(event.contextTokens), estimated: true, sources: [], detail: `${event.kept !== undefined ? `${event.kept} recent events retained.\n\n` : ""}${event.summary}` });
        break;
      case "assistant_message": {
        response += 1;
        const size = recordedNumber(event.usage?.promptTokens);
        if (size !== undefined) items.push({ ...common, kind: "input", label: `Model input · response ${response}`, size, window: recordedNumber(event.usage?.contextWindow), sources: [], detail: "Input tokens reported for this response, including conversation history and tool results. Recorded when the response completed." });
        break;
      }
    }
  }
  return items;
}

export type UsageTraceRow = {
  id: string;
  ts: number;
  kind: "response" | "compaction" | "vision";
  label: string;
  model?: string;
  provider?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
  cumulativeCost?: number;
};

function sumRecorded(rows: UsageTraceRow[], key: "input" | "output" | "cacheRead" | "cacheWrite" | "cost"): number | undefined {
  let total: number | undefined;
  for (const row of rows) if (row[key] !== undefined) total = (total ?? 0) + row[key]!;
  return total;
}

export function buildUsageTrace(events: AgentEvent[]) {
  const rows: UsageTraceRow[] = [];
  let model: string | undefined;
  let provider: string | undefined;
  let response = 0;
  function add(row: Omit<UsageTraceRow, "input" | "output" | "cacheRead" | "cacheWrite" | "cost">, usage?: AgentUsage) {
    rows.push({ ...row, input: recordedNumber(usage?.promptTokens), output: recordedNumber(usage?.completionTokens), cacheRead: recordedNumber(usage?.cacheReadTokens), cacheWrite: recordedNumber(usage?.cacheWriteTokens), cost: recordedNumber(usage?.costUsd) });
  }
  for (const [index, event] of runEvents(events).entries()) {
    if (!Number.isFinite(event.ts)) continue;
    switch (event.type) {
      case "run_started":
      case "route_locked": model = event.model; provider = event.provider; break;
      case "assistant_message":
        response += 1;
        add({ id: `usage:${index}`, ts: event.ts, kind: "response", label: `Response ${response}`, model, provider }, event.usage);
        break;
      case "context_compacted":
        rows.push({ id: `usage:${index}`, ts: event.ts, kind: "compaction", label: "Compaction", cost: recordedNumber(event.costUsd) });
        break;
      case "sight_resolved":
        for (const [imageIndex, image] of event.described.entries()) add({ id: `usage:${index}:${imageIndex}`, ts: event.ts, kind: "vision", label: `Image · ${image.path}`, model: event.model, provider: event.provider }, image.usage);
        break;
    }
  }
  let cumulative: number | undefined;
  for (const row of rows) {
    if (row.cost !== undefined) cumulative = (cumulative ?? 0) + row.cost;
    row.cumulativeCost = cumulative;
  }
  return {
    rows,
    input: sumRecorded(rows, "input"), output: sumRecorded(rows, "output"),
    cacheRead: sumRecorded(rows, "cacheRead"), cacheWrite: sumRecorded(rows, "cacheWrite"), cost: sumRecorded(rows, "cost"),
    costCoverage: rows.filter(row => row.cost !== undefined).length,
  };
}
