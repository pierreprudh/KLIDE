import { describe, expect, it } from "vitest";
import type { AgentEvent } from "./types";
import { buildContextTrace, buildUsageTrace } from "./runTraceDetails";
const started = (ts: number, model = "claude-sonnet-4"): AgentEvent => ({ type: "run_started", runId: "r", cwd: null, mode: "goal", provider: "anthropic", model, ts });
const response = (ts: number, usage?: Extract<AgentEvent, { type: "assistant_message" }>["usage"]): AgentEvent => ({ type: "assistant_message", runId: "r", messageId: `m${ts}`, content: [], ts, usage });

describe("context trace", () => {
  it("separates context estimates, reported input and compaction", () => {
    const trace = buildContextTrace([started(1000), { type: "context_snapshot", runId: "r", ts: 1100, snapshot: { workspaceRoot: null, attachments: [{ path: "chart.png", content: "base64-bytes", mime: "image/png", dataUri: "data:image/png;base64,secret" }], lensItems: [{ id: "a", path: "a.ts", label: "App", detail: "Selected file" }], estimatedTokens: 120, omitted: [{ path: "big.txt", reason: "Too large" }] } }, response(2000, { promptTokens: 900, contextWindow: 4096 }), { type: "context_injected", runId: "r", role: "user", content: "A background check completed", ts: 2200 }, { type: "context_compacted", runId: "r", summary: "Summary", kept: 2, contextTokens: 300, ts: 2300 }]);
    expect(trace.map(item => [item.kind, item.size, item.estimated])).toEqual([["snapshot", 120, true], ["input", 900, undefined], ["injection", undefined, undefined], ["compaction", 300, true]]);
    expect(trace[0].sources.map(item => item.kind)).toEqual(["Attachment", "Project context", "Omitted"]);
    expect(JSON.stringify(trace)).not.toContain("base64");
    expect(trace[1].window).toBe(4096);
    expect(trace[3].detail).toContain("2 recent events retained");
  });
  it("uses only the selected run and leaves absent metrics absent", () => {
    expect(buildContextTrace([started(1000), response(1500, { promptTokens: 900 }), started(90_000_000), response(90_001_000)])).toEqual([]);
    expect(buildContextTrace([response(1000, { promptTokens: 0 })])[0].size).toBe(0);
  });
});

describe("usage trace", () => {
  it("keeps cache reads inside input totals and accumulates known cost", () => {
    const trace = buildUsageTrace([started(1000), response(2000, { promptTokens: 1000, completionTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 200, costUsd: 0.02 }), response(3000), response(4000, { promptTokens: 2000, completionTokens: 0, costUsd: 0 })]);
    expect(trace).toMatchObject({ input: 3000, output: 100, cacheRead: 800, cacheWrite: 200, cost: 0.02, costCoverage: 2 });
    expect(trace.rows.map(row => row.cumulativeCost)).toEqual([0.02, 0.02, 0.02]);
    expect(trace.rows[1].input).toBeUndefined();
    expect(trace.rows[2].output).toBe(0);
  });
  it("includes recorded compaction and vision cost without inventing token counts", () => {
    const trace = buildUsageTrace([started(1000), { type: "context_compacted", runId: "r", summary: "Summary", costUsd: 0.01, ts: 2000 }, { type: "sight_resolved", runId: "r", provider: "openai", model: "gpt-5", described: [{ path: "chart.png", description: "Chart", usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.03 } }], dropped: [], ts: 3000 }]);
    expect(trace).toMatchObject({ input: 10, output: 5, cost: 0.04, costCoverage: 2 });
    expect(trace.rows[0].input).toBeUndefined();
    expect(trace.rows[0].model).toBeUndefined();
    expect(trace.rows[1].model).toBe("gpt-5");
  });
  it("does not infer free cost or zero usage when nothing was reported", () => {
    expect(buildUsageTrace([started(1000), response(2000)])).toMatchObject({ cost: undefined, input: undefined, output: undefined, cacheRead: undefined, costCoverage: 0 });
  });
  it("excludes prior runs and metadata after the terminal event", () => {
    const trace = buildUsageTrace([started(1000), response(2000, { costUsd: 100 }), started(90_000_000), response(90_001_000, { costUsd: 0.01 }), { type: "run_error", runId: "r", error: { code: "aborted", message: "Stopped", retryable: false }, ts: 90_002_000 }, response(90_003_000, { costUsd: 100 })]);
    expect(trace.cost).toBe(0.01);
    expect(trace.rows).toHaveLength(1);
  });
});
