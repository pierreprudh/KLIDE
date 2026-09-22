import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../agent/types";
import { isWatchable, subagentActivity } from "./subagentWatch";

/** Last element — `Array.prototype.at` is outside this project's lib target. */
const last = <T,>(xs: T[]): T | undefined => xs[xs.length - 1];

const CHILD = "sub_run-1_call_7";
let ts = 1_000;
const at = () => (ts += 100);

const started = (): AgentEvent => ({
  type: "run_started",
  runId: CHILD,
  mode: "plan",
  provider: "anthropic",
  model: "claude-sonnet-5",
  cwd: null,
  ts: at(),
});
const toolStarted = (id: string, name: string, summary: string): AgentEvent => ({
  type: "tool_call_started",
  runId: CHILD,
  toolCallId: id,
  name,
  input: {},
  summary,
  ts: at(),
});
const toolFinished = (id: string): AgentEvent => ({
  type: "tool_call_finished",
  runId: CHILD,
  toolCallId: id,
  result: { ok: true, content: "…" },
  ts: at(),
});
const assistant = (text: string, completionTokens?: number): AgentEvent => ({
  type: "assistant_message",
  runId: CHILD,
  messageId: `a-${ts}`,
  content: [{ type: "text", text }],
  usage: completionTokens === undefined ? undefined : { completionTokens },
  ts: at(),
});

describe("subagentActivity", () => {
  it("is 'starting' before the child has said anything", () => {
    expect(subagentActivity([])).toMatchObject({ status: "starting", steps: 0, current: null });
  });

  it("names the step in flight, with the harness's own summary", () => {
    const a = subagentActivity([started(), toolStarted("t1", "read_file", "src/time.ts")]);
    expect(a.status).toBe("working");
    expect(a.current).toEqual({ name: "read_file", detail: "src/time.ts" });
    expect(a.steps).toBe(1);
  });

  it("clears the step when it finishes — between steps is thinking, not reading", () => {
    const a = subagentActivity([
      started(),
      toolStarted("t1", "read_file", "src/time.ts"),
      toolFinished("t1"),
    ]);
    expect(a.current).toBeNull();
    expect(a.steps).toBe(1);
  });

  it("names the most recent open step when several run in parallel", () => {
    const a = subagentActivity([
      started(),
      toolStarted("t1", "read_file", "a.ts"),
      toolStarted("t2", "grep", "slugify"),
      toolFinished("t1"),
    ]);
    expect(a.current).toEqual({ name: "grep", detail: "slugify" });
    expect(a.steps).toBe(2);
  });

  it("counts a delegate CLI's own observed steps too", () => {
    const observed: AgentEvent = {
      type: "observed_tool_call",
      runId: CHILD,
      toolCallId: "o1",
      provider: "claude-code",
      name: "Read",
      input: {},
      summary: "src/App.tsx",
      ts: at(),
    };
    const a = subagentActivity([started(), observed]);
    expect(a.steps).toBe(1);
    expect(a.current).toEqual({ name: "Read", detail: "src/App.tsx" });
  });

  it("sums provider-reported completion tokens and counts turns", () => {
    const a = subagentActivity([started(), assistant("one", 120), assistant("two", 80)]);
    expect(a.turns).toBe(2);
    expect(a.tokens).toBe(200);
  });

  it("anchors its clock to the child's own start", () => {
    const start = started();
    expect(subagentActivity([start]).startedMs).toBe(start.ts);
  });

  it("settles as done only on a done result", () => {
    const a = subagentActivity([
      started(),
      toolStarted("t1", "read_file", "a.ts"),
      { type: "run_result", runId: CHILD, result: { status: "done" }, ts: at() },
    ]);
    expect(a.status).toBe("done");
    // A settled child is not still reading a file.
    expect(a.current).toBeNull();
    expect(isWatchable(a)).toBe(false);
  });

  it("treats cancelled and max_turns as failures, not completions", () => {
    for (const status of ["cancelled", "max_turns"] as const) {
      const a = subagentActivity([
        started(),
        { type: "run_result", runId: CHILD, result: { status }, ts: at() },
      ]);
      expect(a.status).toBe("failed");
      expect(a.error).toBe(status);
    }
  });

  it("carries the error message off run_error", () => {
    const a = subagentActivity([
      started(),
      {
        type: "run_error",
        runId: CHILD,
        error: { code: "provider_unavailable", message: "no key", retryable: false },
        ts: at(),
      },
    ]);
    expect(a).toMatchObject({ status: "failed", error: "no key" });
  });
});

// The live half: the snapshot→subscribe seam is where a watcher would lose or
// double-apply an event, so it is tested against fakes rather than trusted.
const listeners = new Map<string, (payload: { payload: { seq: number; event: AgentEvent } }) => void>();
const readRun = vi.fn<(runId: string) => Promise<AgentEvent[]>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: any) => {
    if (cmd === "agent_read_run") return readRun(args.runId);
    return null;
  }),
  Channel: class {},
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: any) => {
    listeners.set(name, cb);
    return () => listeners.delete(name);
  }),
}));

const emit = (seq: number, event: AgentEvent) =>
  listeners.get(`agent-run:${CHILD}`)?.({ payload: { seq, event } });

describe("watchSubagentRun", () => {
  beforeEach(() => {
    listeners.clear();
    readRun.mockReset();
  });

  it("applies the snapshot, then only events past it", async () => {
    const { watchSubagentRun } = await import("./subagentWatch");
    const base = [started(), toolStarted("t1", "read_file", "a.ts")];
    readRun.mockResolvedValue(base);
    const seen: AgentEvent[][] = [];
    const detach = watchSubagentRun(CHILD, (events) => seen.push(events));
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(last(seen)).toHaveLength(2);

    // seq 1 is already in the snapshot (indices 0 and 1) — it must not repeat.
    emit(1, base[1]);
    emit(2, toolFinished("t1"));
    expect(last(seen)).toHaveLength(3);
    detach();
  });

  it("buffers events that arrive while the snapshot is being read", async () => {
    const { watchSubagentRun } = await import("./subagentWatch");
    let release: (events: AgentEvent[]) => void = () => {};
    readRun.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const seen: AgentEvent[][] = [];
    watchSubagentRun(CHILD, (events) => seen.push(events));
    await vi.waitFor(() => expect(listeners.size).toBe(1));

    const live = toolFinished("t1");
    emit(2, live); // arrives before the snapshot lands
    expect(seen).toHaveLength(0);

    release([started(), toolStarted("t1", "read_file", "a.ts")]);
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(last(seen)).toHaveLength(3);
    expect(last(last(seen) ?? [])).toBe(live);
  });

  it("stops listening on detach without touching the child", async () => {
    const { watchSubagentRun } = await import("./subagentWatch");
    readRun.mockResolvedValue([started()]);
    const seen: AgentEvent[][] = [];
    const detach = watchSubagentRun(CHILD, (events) => seen.push(events));
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    const before = seen.length;
    detach();
    emit(1, toolStarted("t1", "read_file", "a.ts"));
    expect(seen).toHaveLength(before);
  });
});

it("still reads the transcript when live listener registration fails", async () => {
  const { listen } = await import("@tauri-apps/api/event");
  vi.mocked(listen).mockRejectedValueOnce(new Error("listener unavailable"));
  readRun.mockResolvedValue([started()]);
  const seen: AgentEvent[][] = [];
  const { watchSubagentRun } = await import("./subagentWatch");
  const detach = watchSubagentRun(CHILD, (events) => seen.push(events));
  await vi.waitFor(() => expect(seen).toHaveLength(1));
  expect(seen[0]).toHaveLength(1);
  detach();
});
