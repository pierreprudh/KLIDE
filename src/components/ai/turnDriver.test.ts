import { describe, expect, it } from "vitest";
import { createTurnDriver } from "./turnDriver";
import type { Msg } from "./types";
import type { AgentContentBlock, AgentEvent } from "../../agent/types";

// A tiny harness standing in for AiPanel: msgsRef + commit + fake clock/timer.
function harness(initial: Msg[]) {
  const ref = { current: initial };
  const commits: Msg[][] = [];
  let clock = 1000;
  const timers: { fn: () => void; at: number; cancelled: boolean }[] = [];
  const measured: { prompt?: number; usage?: { prompt: number; completion: number } } = {};
  const driver = createTurnDriver({
    assistantIndex: initial.length - 1,
    delegate: {},
    pricing: null,
    read: () => ref.current,
    commit: (next) => {
      ref.current = next;
      commits.push(next);
    },
    onMeasuredPromptTokens: (n) => (measured.prompt = n),
    onMeasuredUsage: (u) => (measured.usage = u),
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { fn, at: clock + ms, cancelled: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { cancelled: boolean }).cancelled = true;
    },
  });
  return {
    driver,
    ref,
    commits,
    measured,
    tick(ms: number) {
      clock += ms;
      for (const t of timers.splice(0)) if (!t.cancelled && t.at <= clock) t.fn();
    },
    setClock(v: number) {
      clock = v;
    },
    pendingTimers: () => timers.filter((t) => !t.cancelled).length,
  };
}

const delta = (text: string, thinking?: string): AgentEvent =>
  ({ type: "assistant_delta", runId: "r", text, thinking, ts: 0 }) as AgentEvent;

const message = (content: AgentContentBlock[], usage?: unknown): AgentEvent =>
  ({ type: "assistant_message", runId: "r", messageId: "m", content, usage, ts: 0 }) as AgentEvent;

describe("createTurnDriver", () => {
  it("batches deltas: many events, one commit per flush window", () => {
    const h = harness([{ role: "assistant", content: "" }]);
    h.driver.handleEvent(delta("Hel"));
    h.driver.handleEvent(delta("lo "));
    h.driver.handleEvent(delta("there", "hmm"));
    expect(h.commits).toHaveLength(0); // nothing rendered yet
    h.tick(50);
    expect(h.commits).toHaveLength(1); // one commit for three tokens
    expect(h.ref.current[0]).toMatchObject({ role: "assistant", content: "Hello there", thinking: "hmm" });
  });

  it("flushes pending deltas before finalizing, and times the turn", () => {
    const h = harness([{ role: "assistant", content: "" }]);
    h.setClock(1200);
    h.driver.handleEvent(delta("partial")); // firstTokenAt = 1200
    h.setClock(2000);
    h.driver.handleEvent(message([{ type: "text", text: "" }]));
    // The pending delta was rendered (not lost) even though its timer never fired.
    const a = h.ref.current[0] as { content: string; meta?: { ms: number; ttftMs?: number } };
    expect(a.content).toBe("partial");
    expect(a.meta?.ms).toBe(1000); // 2000 - turnStartedAt(1000)
    expect(a.meta?.ttftMs).toBe(200); // 1200 - 1000
    expect(h.pendingTimers()).toBe(0); // batch timer cancelled
  });

  it("walks the cursor past tool cards so the next turn's answer lands in a fresh bubble", () => {
    const h = harness([{ role: "user", content: "q" }, { role: "assistant", content: "" }]);
    h.driver.handleEvent(message([{ type: "text", text: "calling tools" }]));
    h.driver.handleEvent({ type: "tool_call_started", runId: "r", toolCallId: "c1", name: "grep", input: {}, summary: "grep", ts: 0 } as AgentEvent);
    h.driver.handleEvent({ type: "tool_call_finished", runId: "r", toolCallId: "c1", result: { content: "3 matches" }, ts: 0 } as unknown as AgentEvent);
    h.driver.handleEvent(delta("final answer"));
    h.tick(50);
    const msgs = h.ref.current;
    expect(msgs[2]).toMatchObject({ role: "tool", content: "3 matches" });
    // The regression this pins: the post-tool delta must NOT be dropped.
    expect(msgs[3]).toMatchObject({ role: "assistant", content: "final answer" });
  });

  it("resets per-turn timing after each assistant message (multi-turn runs)", () => {
    const h = harness([{ role: "assistant", content: "" }]);
    h.setClock(1500);
    h.driver.handleEvent(message([{ type: "text", text: "turn one" }]));
    h.setClock(1900);
    h.driver.handleEvent(delta("x")); // firstTokenAt of turn two = 1900
    h.setClock(2100);
    h.driver.handleEvent(message([{ type: "text", text: "turn two" }]));
    const msgs = h.ref.current as { meta?: { ms: number; ttftMs?: number } }[];
    const second = msgs[msgs.length - 1];
    expect(second.meta?.ms).toBe(600); // 2100 - 1500, not since run start
    expect(second.meta?.ttftMs).toBe(400); // 1900 - 1500
  });

  it("forwards measured token callbacks from provider usage", () => {
    const h = harness([{ role: "assistant", content: "" }]);
    h.driver.handleEvent(message([{ type: "text", text: "r" }], { promptTokens: 500, completionTokens: 42 }));
    expect(h.measured.prompt).toBe(542);
    expect(h.measured.usage).toEqual({ prompt: 500, completion: 42 });
  });

  it("declines non-transcript events so the panel keeps handling them", () => {
    const h = harness([{ role: "assistant", content: "" }]);
    const handled = h.driver.handleEvent({ type: "diff_proposed", runId: "r", proposal: {}, ts: 0 } as unknown as AgentEvent);
    expect(handled).toBe(false);
    expect(h.commits).toHaveLength(0);
  });

  it("finish() renders any pending delta and cancels the timer (idempotent)", () => {
    const h = harness([{ role: "assistant", content: "" }]);
    h.driver.handleEvent(delta("tail"));
    h.driver.finish();
    expect(h.ref.current[0]).toMatchObject({ content: "tail" });
    expect(h.pendingTimers()).toBe(0);
    h.driver.finish(); // second call is a no-op
    expect(h.commits).toHaveLength(1);
  });
});
