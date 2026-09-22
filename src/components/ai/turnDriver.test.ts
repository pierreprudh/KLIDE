import { describe, expect, it } from "vitest";
import { createTurnDriver } from "./turnDriver";
import type { Msg } from "./types";
import type { AgentContentBlock, AgentEvent, AgentUsage } from "../../agent/types";

// A tiny harness standing in for AiPanel: msgsRef + commit + fake clock/timer.
function harness(initial: Msg[], pace = false) {
  const ref = { current: initial };
  const commits: Msg[][] = [];
  let clock = 1000;
  const timers: { fn: () => void; at: number; cancelled: boolean }[] = [];
  const measured: { prompt?: number; usage?: { prompt: number; completion: number } } = {};
  let detachments = 0;
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
    onDetached: () => (detachments += 1),
    pace,
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
    detachments: () => detachments,
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

// No `as AgentEvent`: the union is the contract, and an unchecked cast is how
// a fixture ends up describing a wire shape Rust never emits.
const delta = (text: string, thinking?: string): AgentEvent => ({
  type: "assistant_delta",
  runId: "r",
  messageId: "d",
  text,
  thinking,
  ts: 0,
});

const message = (content: AgentContentBlock[], usage?: AgentUsage): AgentEvent => ({
  type: "assistant_message",
  runId: "r",
  messageId: "m",
  content,
  usage,
  ts: 0,
});

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
    h.driver.handleEvent({ type: "tool_call_started", runId: "r", toolCallId: "c1", name: "grep", input: {}, summary: "grep", ts: 0 });
    h.driver.handleEvent({ type: "tool_call_finished", runId: "r", toolCallId: "c1", result: { ok: true, content: "3 matches" }, ts: 0 });
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

  it("renders a delegate's own tool work live, and counts it as first output", () => {
    // This whitelist is the only thing that decides what appears *during* a
    // turn. `observed_tool_call` was missing from it, so a delegate's Read/Edit
    // rows folded on replay and were invisible while the turn ran — and TTFT
    // measured to the delegate's first word instead, reporting its whole tool
    // phase (15s of file reading) as latency.
    const h = harness([{ role: "assistant", content: "" }]);
    h.setClock(1300);
    const handled = h.driver.handleEvent({
      type: "observed_tool_call",
      runId: "r",
      toolCallId: "toolu_1",
      provider: "claude-code",
      name: "Read",
      input: { file_path: "TODO.md" },
      summary: "Read TODO.md",
      ts: 0,
    });
    expect(handled).toBe(true);
    // Committed immediately — not batched behind the delta timer.
    expect(h.commits).toHaveLength(1);
    const toolRow = h.ref.current.find((m) => m.role === "tool");
    expect(toolRow).toMatchObject({ toolName: "Read", observedBy: "claude-code" });

    h.driver.handleEvent({
      type: "observed_tool_result",
      runId: "r",
      toolCallId: "toolu_1",
      ok: true,
      content: "# TODO",
      ts: 0,
    });
    // The tool call, not the first word, is when this turn started producing.
    h.setClock(9000);
    h.driver.handleEvent(delta("The milestone is"));
    h.setClock(9500);
    h.driver.handleEvent(message([{ type: "text", text: "" }]));
    // A tool row closes the open bubble, so the answer lands in a fresh one
    // below it — same as a dispatched call.
    const assistants = h.ref.current.filter((m) => m.role === "assistant");
    const answer = assistants[assistants.length - 1] as { meta?: { ttftMs?: number } };
    expect(answer.meta?.ttftMs).toBe(300); // 1300 - 1000, not 8000
  });

  it("declines non-transcript events so the panel keeps handling them", () => {
    const h = harness([{ role: "assistant", content: "" }]);
    const handled = h.driver.handleEvent({
      type: "diff_proposed",
      runId: "r",
      proposal: {
        id: "p1",
        runId: "r",
        toolCallId: "c1",
        path: "a.ts",
        oldContent: "",
        newContent: "x",
        oldHash: "0",
        newHash: "1",
        unifiedDiff: "",
        isCreate: false,
      },
      ts: 0,
    });
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

describe("the pacer", () => {
  const text = (h: ReturnType<typeof harness>) => (h.ref.current[0] as { content: string }).content;

  it("releases a burst word by word on the tick, never behind the wire order", () => {
    const h = harness([{ role: "assistant", content: "" }], true);
    h.driver.handleEvent(delta("Pistachio is your fastest-growing flavor "));
    expect(h.commits).toHaveLength(0);
    h.tick(35);
    expect(text(h)).toBe("Pistachio "); // 5 words → ceil(1) per tick
    h.tick(35);
    expect(text(h)).toBe("Pistachio is ");
    h.tick(35);
    h.tick(35);
    h.tick(35);
    expect(text(h)).toBe("Pistachio is your fastest-growing flavor ");
    expect(h.pendingTimers()).toBe(0); // drained, tick stopped
  });

  it("catches up on a long backlog instead of falling behind a fast model", () => {
    const h = harness([{ role: "assistant", content: "" }], true);
    h.driver.handleEvent(delta(Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ") + " "));
    h.tick(35);
    expect(text(h).match(/\S+/g)).toHaveLength(8); // a fifth of 40
  });

  it("holds a half-typed word for its ending, unless it is all that is waiting", () => {
    const h = harness([{ role: "assistant", content: "" }], true);
    h.driver.handleEvent(delta("Sales are u"));
    h.tick(35);
    expect(text(h)).toBe("Sales "); // "are u" → "are " waits behind the count, "u" behind its ending
    h.driver.handleEvent(delta("p 23%"));
    h.tick(35);
    expect(text(h)).toBe("Sales are ");
    h.tick(35);
    expect(text(h)).toBe("Sales are up "); // "23%" alone with no ending goes out next
    h.tick(35);
    expect(text(h)).toBe("Sales are up 23%");
  });

  it("drains everything waiting before a tool row, the final message, or finish()", () => {
    const h = harness([{ role: "assistant", content: "" }], true);
    h.driver.handleEvent(delta("Let me check the file first "));
    h.driver.handleEvent({ type: "tool_call_started", runId: "r", toolCallId: "t1", name: "read_file", input: {}, summary: "read_file", ts: 0 });
    expect(text(h)).toBe("Let me check the file first ");
    expect(h.pendingTimers()).toBe(0);

    const h2 = harness([{ role: "assistant", content: "" }], true);
    h2.driver.handleEvent(delta("all of it"));
    h2.driver.handleEvent(message([{ type: "text", text: "" }]));
    expect(text(h2)).toBe("all of it");

    const h3 = harness([{ role: "assistant", content: "" }], true);
    h3.driver.handleEvent(delta("tail words here"));
    h3.driver.finish();
    expect(text(h3)).toBe("tail words here");
    expect(h3.pendingTimers()).toBe(0);
  });

  it("lets thinking through immediately and keeps the first-word time honest", () => {
    const h = harness([{ role: "assistant", content: "" }], true);
    h.driver.handleEvent({ ...delta("", "hmm"), ts: 100 });
    h.tick(50);
    expect(h.ref.current[0]).toMatchObject({ content: "", thinking: "hmm" });
    h.driver.handleEvent({ ...delta("Right, "), ts: 400 });
    h.driver.handleEvent({ ...delta("so "), ts: 900 });
    h.tick(35);
    // thinkingMs is measured from the first *wire* delta that carried text (400),
    // not from the tick that showed it.
    expect(h.ref.current[0]).toMatchObject({ thinkingStartedAt: 100, thinkingMs: 300 });
  });
});

describe("a turn that stops reaching the screen says so", () => {
  // The driver is the panel's only view of whether the turn it started is still
  // landing. When the region is taken over mid-run, everything the agent says
  // from there on reaches the Transcript and not the screen — so the panel has
  // to be told, or a run that answered looks like a run that said nothing.
  it("reports the detach and stays detached", () => {
    const h = harness([{ role: "user", content: "What this ?" }, { role: "assistant", content: "" }]);
    h.driver.handleEvent(delta("wor"));
    h.tick(60);
    expect(h.driver.isDetached()).toBe(false);
    expect(h.detachments()).toBe(0);

    // Something else rewrote the run's region.
    h.ref.current = [{ role: "user", content: "What this ?" }, { role: "assistant", content: "elsewhere" }];
    h.driver.handleEvent(delta("king on it"));
    h.tick(60);

    expect(h.driver.isDetached()).toBe(true);
    expect(h.detachments()).toBe(1);
    // The answer the user never saw: consumed by the driver, absent from view.
    h.driver.handleEvent(message([{ type: "text", text: "This is the Welcome screen" }]));
    h.driver.finish();
    expect(h.ref.current[1]).toMatchObject({ content: "elsewhere" });
    expect(h.driver.isDetached()).toBe(true);
  });
});

it("projects an observer completion in a live turn without exposing raw log text", () => {
  const h = harness([{ role: "assistant", content: "" }]);
  expect(h.driver.handleEvent({ type: "observer_completed", runId: "r", shellId: "s", text: "raw build output", ts: 1200 })).toBe(true);
  h.driver.handleEvent(message([{ type: "text", text: "Your deployment finished." }]));
  expect(h.ref.current.some((m) => m.role === "system" && m.observer?.shellId === "s")).toBe(true);
  expect(h.ref.current.some((m) => m.role === "assistant" && m.content === "Your deployment finished.")).toBe(true);
  expect(JSON.stringify(h.ref.current)).not.toContain("raw build output");
});
