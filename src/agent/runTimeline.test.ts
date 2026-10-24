import { describe, expect, it } from "vitest";
import type { AgentEvent } from "./types";
import { buildRunTimeline, timelineRuns } from "./runTimeline";

const started = (ts: number): AgentEvent => ({ type: "run_started", runId: "r", cwd: null, mode: "goal", provider: "ollama", model: "test", ts });
const tool = (id: string, ts: number): AgentEvent => ({ type: "tool_call_started", runId: "r", toolCallId: id, name: "read_file", summary: "Read file", input: { path: "a.ts" }, ts });
const done = (id: string, ts: number, ok = true): AgentEvent => ({ type: "tool_call_finished", runId: "r", toolCallId: id, result: { ok, content: "result" }, ts });

describe("run timeline projection", () => {
  it("preserves concurrent tools and matches outcomes by id", () => {
    const trace = buildRunTimeline([started(1000), tool("a", 1100), tool("b", 1200), done("b", 1400, false), done("a", 1800)], false, 9000);
    expect(trace.spans.map(s => [s.start, s.end, s.status])).toEqual([[1100, 1800, "done"], [1200, 1400, "error"]]);
    expect(trace.end).toBe(1800);
  });
  it("keeps approval waits separate from enclosing tools", () => {
    const trace = buildRunTimeline([started(1000), tool("a", 1100), {
      type: "permission_requested", runId: "r", ts: 1200,
      request: { id: "p", runId: "r", toolCallId: "a", toolName: "run_command", input: {}, summary: "Run", reason: "Approval", options: [] },
    }, { type: "permission_resolved", runId: "r", requestId: "p", decision: { behavior: "deny" }, ts: 1500 }, done("a", 1600, false)], false, 9000);
    expect(trace.spans.map(s => [s.kind, s.start, s.end])).toEqual([["tool", 1100, 1600], ["wait", 1200, 1500]]);
    expect(trace.spans[1].parentId).toBe(trace.spans[0].id);
  });
  it("uses measured model time, never the time between messages", () => {
    const trace = buildRunTimeline([started(1000), {
      type: "assistant_message", runId: "r", messageId: "m", ts: 10000,
      content: [{ type: "text", text: "Answer" }], timing: { modelMs: 200 }, usage: { completionTokens: 8, costUsd: 0.02 },
    }, { type: "assistant_message", runId: "r", messageId: "old", ts: 11000, content: [] }], false, 90000);
    expect(trace.spans).toHaveLength(1);
    expect(trace.spans[0]).toMatchObject({ start: 9800, end: 10000, model: "test", provider: "ollama" });
    expect(trace.tokens).toBe(8);
    expect(trace.cost).toBe(0.02);
  });
  it("extends open spans only while active and never invents a successful finish", () => {
    const events = [started(1000), tool("a", 1100)];
    expect(buildRunTimeline(events, true, 5000)).toMatchObject({ end: 5000, spans: [{ status: "running" }] });
    expect(buildRunTimeline(events, false, 5000).spans[0]).toMatchObject({ end: 1100, status: "incomplete" });
  });
  it("keeps interrupted runs inspectable without extending them to the next dispatch", () => {
    const runs = timelineRuns([started(1000), tool("a", 1100), started(90_000_000), tool("a", 90_000_100), done("a", 90_000_400)]);
    expect(runs).toHaveLength(2);
    const earlier = buildRunTimeline(runs[0].events, false, 90_000_000);
    expect(earlier.spans[0]).toMatchObject({ end: 1100, status: "incomplete" });
    expect(earlier.end - earlier.start).toBe(100);
    expect(buildRunTimeline(runs[1].events, true, 90_001_000).spans[0]).toMatchObject({ end: 90_000_400, status: "done" });
  });
  it("distinguishes observed delegate activity and subagent report timing", () => {
    const trace = buildRunTimeline([started(1000), {
      type: "observed_tool_call", runId: "r", provider: "claude-code", toolCallId: "o", name: "Bash", summary: "Test", input: {}, ts: 1100,
    }, { type: "observed_tool_result", runId: "r", toolCallId: "o", ok: true, content: "passed", ts: 1200 }, {
      type: "subagent_requested", runId: "r", requestId: "w", subagent: "reviewer", task: "Review", ts: 1300,
    }, { type: "subagent_resolved", runId: "r", requestId: "w", result: "Failed", ok: false, ts: 1600 }], false, 9000);
    expect(trace.spans[0]).toMatchObject({ observed: true, status: "done" });
    expect(trace.spans[1]).toMatchObject({ kind: "worker", status: "error", end: 1600 });
  });
  it("shows the latest run rather than a conversation's overnight idle gap", () => {
    const resumed = 1000 + 1500 * 60_000;
    const trace = buildRunTimeline([started(1000), tool("old", 1100), done("old", 1800),
      started(resumed), tool("new", resumed + 100), done("new", resumed + 2000)], false, resumed + 9000);
    expect(trace.end - trace.start).toBe(2000);
    expect(trace.spans).toHaveLength(1);
    expect(trace.spans[0].detail).toContain("a.ts");
  });
  it("does not extend a settled run with later conversation metadata", () => {
    const trace = buildRunTimeline([started(1000), tool("a", 1100), done("a", 1800),
      { type: "run_error", runId: "r", error: { code: "aborted", message: "Stopped", retryable: false }, ts: 2000 },
      { type: "conversation_titled", runId: "r", title: "Renamed next day", ts: 86_400_000 }], true, 90_000_000);
    expect(trace.end - trace.start).toBe(1000);
  });
  it("handles empty transcripts without invalid bounds or invented cost", () => {
    expect(buildRunTimeline([], true, 9000)).toEqual({ spans: [], start: 0, end: 0, tokens: 0, cost: undefined });
  });
});
