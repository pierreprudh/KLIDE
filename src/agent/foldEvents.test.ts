import { describe, expect, it } from "vitest";
import {
  compactionMsg,
  createFold,
  extractAssistantText,
  foldAgentEvents,
  foldedRowToMsgs,
  foldedToMsgs,
  foldedToRunMessages,
} from "./foldEvents";
import type {
  AgentAttachment,
  AgentContentBlock,
  AgentEvent,
  AgentTurnTiming,
  AgentUsage,
  ProviderId,
} from "./types";
import type { Msg } from "../components/ai/types";

// `foldAgentEvents` is the one place the AgentEvent wire format is turned into a
// conversation, and both renderers sit on it: the AI panel through
// `foldedToMsgs` (replay + fork) and Mission Control through
// `foldedToRunMessages` (every Klide run row). It had no tests.

const RUN = "run-1";
let ts = 1_000;
const at = () => (ts += 100);

function userMessage(text: string, attachments: AgentAttachment[] = []): AgentEvent {
  return {
    type: "user_message",
    runId: RUN,
    messageId: `u-${ts}`,
    text,
    attachments,
    ts: at(),
  };
}

function assistantMessage(
  text: string,
  opts: {
    thinking?: string;
    toolCalls?: { toolCallId: string; name: string; input?: unknown }[];
    usage?: AgentUsage;
    timing?: AgentTurnTiming;
  } = {},
): AgentEvent {
  const content: AgentContentBlock[] = [];
  if (opts.thinking) content.push({ type: "thinking", text: opts.thinking });
  if (text) content.push({ type: "text", text });
  for (const call of opts.toolCalls ?? []) {
    content.push({
      type: "tool_call",
      toolCallId: call.toolCallId,
      name: call.name,
      input: call.input,
    });
  }
  return {
    type: "assistant_message",
    runId: RUN,
    messageId: `a-${ts}`,
    content,
    usage: opts.usage,
    timing: opts.timing,
    ts: at(),
  };
}

function runStarted(provider: ProviderId, model: string): AgentEvent {
  return { type: "run_started", runId: RUN, cwd: null, mode: "goal", provider, model, ts: at() };
}

function toolStarted(toolCallId: string, name: string, input?: unknown): AgentEvent {
  return {
    type: "tool_call_started",
    runId: RUN,
    toolCallId,
    name,
    input,
    summary: `${name} …`,
    ts: at(),
  };
}

function toolFinished(toolCallId: string, content: string, ok = true): AgentEvent {
  return {
    type: "tool_call_finished",
    runId: RUN,
    toolCallId,
    result: { ok, content },
    ts: at(),
  };
}

function compacted(summary: string): AgentEvent {
  return { type: "context_compacted", runId: RUN, summary, ts: at() };
}

function delta(text: string, thinking?: string): AgentEvent {
  return { type: "assistant_delta", runId: RUN, messageId: `d-${ts}`, text, thinking, ts: at() };
}

function steered(reason: string): AgentEvent {
  return { type: "steering_injected", runId: RUN, reason, ts: at() };
}

describe("foldAgentEvents", () => {
  it("pairs user and assistant turns in order", () => {
    const rows = foldAgentEvents([
      userMessage("hello"),
      assistantMessage("hi there"),
      userMessage("again"),
      assistantMessage("still here"),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(rows[0]).toMatchObject({ kind: "user", text: "hello" });
    expect(rows[1]).toMatchObject({ kind: "assistant", text: "hi there" });
  });

  it("gives run_started and context_snapshot no row of their own", () => {
    const rows = foldAgentEvents([
      runStarted("ollama", "m"),
      userMessage("go"),
      assistantMessage("done"),
    ]);
    expect(rows).toHaveLength(2);
  });

  describe("what produced each turn", () => {
    it("stamps a turn with the pair that was dispatching when it opened", () => {
      const rows = foldAgentEvents([
        runStarted("openrouter", "deepseek/deepseek-v4-flash"),
        userMessage("go"),
        assistantMessage("done"),
      ]);
      expect(rows[1]).toMatchObject({
        kind: "assistant",
        provider: "openrouter",
        model: "deepseek/deepseek-v4-flash",
      });
    });

    it("leaves an earlier turn alone when the thread continues on another model", () => {
      const rows = foldAgentEvents([
        runStarted("openrouter", "deepseek/deepseek-v4-flash"),
        userMessage("first"),
        assistantMessage("on deepseek"),
        // Same conversation, next run, different model.
        runStarted("anthropic", "claude-sonnet-5"),
        userMessage("second"),
        assistantMessage("on sonnet"),
      ]);
      expect(rows[1]).toMatchObject({ model: "deepseek/deepseek-v4-flash" });
      expect(rows[3]).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5" });
    });

    it("stamps the placeholder the live path seeds before the run starts", () => {
      const fold = createFold({ seedOpenAssistant: true });
      const step = fold.apply(runStarted("mlx", "mlx-community/gemma-4-E4B-it-qat-4bit"));
      // The seeded row already exists, so the stamp has to reach it — and the
      // caller has to know to re-project it.
      expect(step.changed).toEqual([0]);
      expect(fold.rows()[0]).toMatchObject({
        kind: "assistant",
        provider: "mlx",
        model: "mlx-community/gemma-4-E4B-it-qat-4bit",
      });
    });

    it("carries the stamp through to the rendered message", () => {
      const rows = foldAgentEvents([
        runStarted("openrouter", "sakana/fugu-ultra"),
        userMessage("go"),
        assistantMessage("done"),
      ]);
      const msgs = foldedRowToMsgs(rows[1]);
      expect(msgs[0]).toMatchObject({
        role: "assistant",
        provider: "openrouter",
        model: "sakana/fugu-ultra",
      });
    });

    it("leaves a turn from a transcript written before the stamp unmarked", () => {
      const rows = foldAgentEvents([userMessage("go"), assistantMessage("done")]);
      expect(rows[1]).toMatchObject({ kind: "assistant", provider: undefined, model: undefined });
    });
  });

  it("joins multiple text blocks and lifts thinking out of the content array", () => {
    const rows = foldAgentEvents([
      assistantMessage("", { thinking: "let me think" }),
    ]);
    expect(rows[0]).toMatchObject({ kind: "assistant", text: "", thinking: "let me think" });
  });

  describe("thinking span", () => {
    // The header says "Thought for 4.2s" from event timestamps, never a
    // stopwatch — so a live thread and its replayed transcript agree.
    it("measures from the first reasoning delta to the first visible word", () => {
      const events = [
        userMessage("hi"),
        delta("", "hmm"),
        delta("", " more"),
        delta("Hel"),
        delta("lo"),
        assistantMessage("Hello", { thinking: "hmm more" }),
      ];
      const rows = foldAgentEvents(events);
      const first = events[1];
      const firstWord = events[3];
      if (first.type !== "assistant_delta" || firstWord.type !== "assistant_delta") throw new Error("shape");
      expect(rows[1]).toMatchObject({
        kind: "assistant",
        thinkingStartedAt: first.ts,
        thinkingMs: firstWord.ts - first.ts,
      });
    });

    it("ends at the settle when the turn thought and then said nothing", () => {
      const events = [
        delta("", "plan"),
        assistantMessage("", { thinking: "plan", toolCalls: [{ toolCallId: "t1", name: "read_file" }] }),
      ];
      const rows = foldAgentEvents(events);
      const first = events[0];
      const settled = events[1];
      if (first.type !== "assistant_delta" || settled.type !== "assistant_message") throw new Error("shape");
      expect(rows[0]).toMatchObject({ kind: "assistant", thinkingMs: settled.ts - first.ts });
    });

    it("leaves the span unknown when the transcript kept no deltas", () => {
      const rows = foldAgentEvents([assistantMessage("done", { thinking: "reasoning" })]);
      if (rows[0].kind !== "assistant") throw new Error("expected assistant");
      expect(rows[0].thinkingStartedAt).toBeUndefined();
      expect(rows[0].thinkingMs).toBeUndefined();
    });

    it("carries the span onto the AI panel message", () => {
      const rows = foldAgentEvents([delta("", "t"), delta("x"), assistantMessage("x", { thinking: "t" })]);
      const msgs = foldedToMsgs(rows);
      expect(msgs[0]).toMatchObject({ role: "assistant", thinkingMs: 100 });
    });
  });

  describe("tool-call lifecycle correlation", () => {
    it("correlates a started/finished pair onto the assistant that declared it", () => {
      const rows = foldAgentEvents([
        userMessage("read it"),
        assistantMessage("reading", { toolCalls: [{ toolCallId: "t1", name: "read_file", input: { path: "a.ts" } }] }),
        toolStarted("t1", "read_file", { path: "a.ts" }),
        toolFinished("t1", "file body"),
      ]);
      const assistant = rows[1];
      if (assistant.kind !== "assistant") throw new Error("expected assistant");
      expect(assistant.toolCalls).toHaveLength(1);
      expect(assistant.toolCalls[0]).toMatchObject({
        id: "t1",
        name: "read_file",
        status: "finished",
        result: { content: "file body", ok: true },
      });
    });

    it("attaches a result to a NON-final assistant row", () => {
      // The reason findTool walks every assistant row rather than just the last:
      // a tool result can land after the model has already produced more text.
      const rows = foldAgentEvents([
        assistantMessage("first, a tool", { toolCalls: [{ toolCallId: "t1", name: "grep" }] }),
        assistantMessage("and some follow-up prose"),
        toolFinished("t1", "3 matches"),
      ]);
      const first = rows[0];
      if (first.kind !== "assistant") throw new Error("expected assistant");
      expect(first.toolCalls[0]).toMatchObject({ id: "t1", status: "finished" });
      const second = rows[1];
      if (second.kind !== "assistant") throw new Error("expected assistant");
      expect(second.toolCalls).toHaveLength(0);
    });

    it("synthesises an assistant row for a tool that no assistant declared", () => {
      // Small models sometimes emit tool_call_started with no preceding
      // assistant_message; the fold must not drop the call on the floor.
      const rows = foldAgentEvents([toolStarted("orphan", "list_dir"), toolFinished("orphan", "a\nb")]);
      expect(rows).toHaveLength(1);
      const only = rows[0];
      if (only.kind !== "assistant") throw new Error("expected a synthesised assistant");
      expect(only.text).toBe("");
      expect(only.toolCalls[0]).toMatchObject({ id: "orphan", name: "list_dir", status: "finished" });
    });

    it("folds a delegate's own tool work, tagged with who ran it", () => {
      // Claude Code in Focus reports the tools *it* ran. They belong in the
      // conversation, but tagged: Klide dispatched none of them, so nothing
      // downstream may treat them as calls it gated.
      const rows = foldAgentEvents([
        {
          type: "observed_tool_call",
          runId: RUN,
          toolCallId: "toolu_1",
          provider: "claude-code",
          name: "Edit",
          input: { file_path: "src/auth.ts" },
          summary: "Edit src/auth.ts",
          ts: at(),
        },
        {
          type: "observed_tool_result",
          runId: RUN,
          toolCallId: "toolu_1",
          ok: true,
          content: "applied",
          ts: at(),
        },
      ]);
      const row = rows[0];
      if (row.kind !== "assistant") throw new Error("expected a synthesised assistant");
      expect(row.toolCalls[0]).toMatchObject({
        id: "toolu_1",
        name: "Edit",
        summary: "Edit src/auth.ts",
        status: "finished",
        observedBy: "claude-code",
        result: { content: "applied", ok: true },
      });

      // …and the attribution survives into the rendered rows, which is what
      // keeps the UI from implying Klide reviewed the edit.
      const msgs = foldedRowToMsgs(row);
      const toolMsg = msgs.find((m) => m.role === "tool");
      expect(toolMsg).toMatchObject({ toolName: "Edit", observedBy: "claude-code" });
    });

    it("does not repeat text the rows above a delegate's tool card already show", () => {
      // Reproduces a duplicated preamble seen in Focus with Claude Code. A
      // delegate interleaves its own tool calls with its prose inside ONE turn,
      // so the closing assistant_message carries the whole turn's text — while
      // the pre-tool sentence is already sitting in the row above the card.
      const rows = foldAgentEvents([
        delta("I'll check the actual state rather than guess."),
        {
          type: "observed_tool_call",
          runId: RUN,
          toolCallId: "toolu_1",
          provider: "claude-code",
          name: "Bash",
          input: { command: "git status --short" },
          summary: "Bash git status --short",
          ts: at(),
        },
        {
          type: "observed_tool_result",
          runId: RUN,
          toolCallId: "toolu_1",
          ok: true,
          content: "M src/App.tsx",
          ts: at(),
        },
        delta("You're on fix/attachment-guardrails."),
        assistantMessage(
          "I'll check the actual state rather than guess.You're on fix/attachment-guardrails.",
        ),
      ]);

      expect(rows).toHaveLength(2);
      const [before, after] = rows;
      if (before.kind !== "assistant" || after.kind !== "assistant") {
        throw new Error("expected two assistant rows");
      }
      expect(before.text).toBe("I'll check the actual state rather than guess.");
      expect(before.toolCalls[0]).toMatchObject({ id: "toolu_1", observedBy: "claude-code" });
      // The tail only — not the whole turn pasted under its own tool card.
      expect(after.text).toBe("You're on fix/attachment-guardrails.");
    });

    it("keeps the whole final text when it is not what was streamed", () => {
      // A provider that returns cleaned-up text rather than its own stream must
      // not have a chunk sliced off it: showing a line twice is a blemish,
      // dropping one is a lie.
      const rows = foldAgentEvents([
        delta("thinking out loud"),
        {
          type: "observed_tool_call",
          runId: RUN,
          toolCallId: "t",
          provider: "claude-code",
          name: "Read",
          input: {},
          summary: "Read",
          ts: at(),
        },
        assistantMessage("A completely rewritten answer."),
      ]);
      const last = rows[rows.length - 1];
      if (last.kind !== "assistant") throw new Error("expected an assistant row");
      expect(last.text).toBe("A completely rewritten answer.");
    });

    it("keeps observed calls distinguishable from dispatched ones", () => {
      // The whole point of the separate event: a dispatched call carries no
      // `observedBy`, so a reader can tell "Klide ran this under a capability"
      // from "the delegate did this under its own permissions".
      const rows = foldAgentEvents([
        assistantMessage("both kinds", { toolCalls: [{ toolCallId: "t1", name: "read_file" }] }),
        toolStarted("t1", "read_file"),
        toolFinished("t1", "body"),
        {
          type: "observed_tool_call",
          runId: RUN,
          toolCallId: "obs",
          provider: "claude-code",
          name: "Bash",
          input: { command: "npm test" },
          summary: "Bash npm test",
          ts: at(),
        },
      ]);
      const row = rows[0];
      if (row.kind !== "assistant") throw new Error("expected assistant");
      const dispatched = row.toolCalls.find((t) => t.id === "t1");
      const observed = row.toolCalls.find((t) => t.id === "obs");
      expect(dispatched?.observedBy).toBeUndefined();
      expect(observed?.observedBy).toBe("claude-code");
    });

    it("records a still-running call as started and an undeclared finish as finished", () => {
      const rows = foldAgentEvents([
        assistantMessage("working", { toolCalls: [{ toolCallId: "t1", name: "bash" }] }),
        toolStarted("t1", "bash"),
      ]);
      const row = rows[0];
      if (row.kind !== "assistant") throw new Error("expected assistant");
      expect(row.toolCalls[0].status).toBe("started");
      expect(row.toolCalls[0].result).toBeUndefined();
    });

    it("keeps a declared-but-never-started call as unknown", () => {
      const rows = foldAgentEvents([
        assistantMessage("planning", { toolCalls: [{ toolCallId: "t9", name: "write_file" }] }),
      ]);
      const row = rows[0];
      if (row.kind !== "assistant") throw new Error("expected assistant");
      expect(row.toolCalls[0].status).toBe("unknown");
    });

    it("carries a failed result's ok flag through", () => {
      const rows = foldAgentEvents([
        assistantMessage("try", { toolCalls: [{ toolCallId: "t1", name: "bash" }] }),
        toolFinished("t1", "command not found", false),
      ]);
      const row = rows[0];
      if (row.kind !== "assistant") throw new Error("expected assistant");
      expect(row.toolCalls[0].result).toEqual({ content: "command not found", ok: false });
    });
  });

  describe("meta: exact provider usage vs estimate", () => {
    it("prefers provider-reported completion tokens and marks them exact", () => {
      const rows = foldAgentEvents([
        userMessage("hi"),
        assistantMessage("a fairly short answer", {
          usage: { completionTokens: 7, evalDurationMs: 1_000, costUsd: 0.0012 },
        }),
      ]);
      const row = rows[1];
      if (row.kind !== "assistant") throw new Error("expected assistant");
      expect(row.meta).toMatchObject({ tokens: 7, exact: true, tps: 7, costUsd: 0.0012 });
      // With real usage there is no estimate to expose.
      expect(row.meta?.tokensEstimate).toBeUndefined();
    });

    it("falls back to a length estimate and marks it inexact", () => {
      // The estimate is `estimateTokens` (chars / 3.7), the app-wide
      // estimator — the same constant the live path and the context gauge
      // use, so an estimated count reads identically live and after reload.
      const text = "x".repeat(37);
      const rows = foldAgentEvents([userMessage("hi"), assistantMessage(text)]);
      const row = rows[1];
      if (row.kind !== "assistant") throw new Error("expected assistant");
      expect(row.meta).toMatchObject({ tokens: 10, tokensEstimate: 10, exact: false });
      expect(row.meta?.tps).toBeUndefined();
    });

    it("counts thinking text toward the estimate", () => {
      const rows = foldAgentEvents([
        assistantMessage("x".repeat(37), { thinking: "y".repeat(37) }),
      ]);
      const row = rows[0];
      if (row.kind !== "assistant") throw new Error("expected assistant");
      expect(row.meta?.tokens).toBe(20);
    });

    it("omits tps when the provider reports no eval duration", () => {
      const rows = foldAgentEvents([
        assistantMessage("answer", { usage: { completionTokens: 5 } }),
      ]);
      const row = rows[0];
      if (row.kind !== "assistant") throw new Error("expected assistant");
      expect(row.meta?.exact).toBe(true);
      expect(row.meta?.tps).toBeUndefined();
    });

    it("times each turn from its own boundary, not from the run start", () => {
      ts = 0;
      const events: AgentEvent[] = [
        { type: "user_message", runId: RUN, messageId: "u1", text: "one", attachments: [], ts: 1_000 },
        { type: "assistant_message", runId: RUN, messageId: "a1", content: [{ type: "text", text: "first" }], ts: 1_500 },
        { type: "user_message", runId: RUN, messageId: "u2", text: "two", attachments: [], ts: 5_000 },
        { type: "assistant_message", runId: RUN, messageId: "a2", content: [{ type: "text", text: "second" }], ts: 5_250 },
      ];
      const rows = foldAgentEvents(events);
      const first = rows[1];
      const second = rows[3];
      if (first.kind !== "assistant" || second.kind !== "assistant") throw new Error("expected assistants");
      expect(first.meta?.ms).toBe(500);
      // 250, not 4250 — the second turn is timed from the second user message.
      expect(second.meta?.ms).toBe(250);
    });

    it("separates the harness-measured model time from the turn's wall clock", () => {
      // The turn took 30s end to end, but 26s of that was a tool run and the
      // diff review that followed it. Only `ms` may carry the waiting.
      const events: AgentEvent[] = [
        { type: "user_message", runId: RUN, messageId: "u1", text: "edit it", attachments: [], ts: 1_000 },
        {
          type: "assistant_message",
          runId: RUN,
          messageId: "a1",
          content: [{ type: "text", text: "done" }],
          timing: { modelMs: 4_000, ttftMs: 400 },
          ts: 31_000,
        },
      ];
      const row = foldAgentEvents(events)[1];
      if (row.kind !== "assistant") throw new Error("expected assistant");
      expect(row.meta?.ms).toBe(30_000);
      expect(row.meta?.modelMs).toBe(4_000);
      expect(row.meta?.ttftMs).toBe(400);
    });

    it("derives tok/s from measured decode time when the provider reports no eval duration", () => {
      const rows = foldAgentEvents([
        assistantMessage("answer", {
          usage: { completionTokens: 40 },
          timing: { modelMs: 2_400, ttftMs: 400 },
        }),
      ]);
      const row = rows[0];
      if (row.kind !== "assistant") throw new Error("expected assistant");
      // 40 tokens over the 2s that followed the first token.
      expect(row.meta?.tps).toBe(20);
    });

    it("carries each row's event timestamp through to the messages", () => {
      const events: AgentEvent[] = [
        { type: "user_message", runId: RUN, messageId: "u1", text: "hi", attachments: [], ts: 7_000 },
        { type: "assistant_message", runId: RUN, messageId: "a1", content: [{ type: "text", text: "yo" }], ts: 7_900 },
      ];
      const msgs = foldedToMsgs(foldAgentEvents(events));
      expect(msgs[0]).toMatchObject({ role: "user", ts: 7_000 });
      expect(msgs[1]).toMatchObject({ role: "assistant", ts: 7_900 });
    });
  });

  describe("context_compacted", () => {
    // Regression: this variant existed in Rust (emitted, persisted to the
    // Transcript, honoured on replay) but had no TypeScript counterpart, so the
    // fold silently dropped it and a reloaded conversation looked like an
    // unbroken thread that had mysteriously forgotten its early turns.
    it("becomes a compaction row carrying the summary and the collapsed count", () => {
      const rows = foldAgentEvents([
        userMessage("one"),
        assistantMessage("first"),
        compacted("Earlier: the user asked about one."),
        userMessage("two"),
        assistantMessage("second"),
      ]);
      expect(rows.map((r) => r.kind)).toEqual([
        "user",
        "assistant",
        "compaction",
        "user",
        "assistant",
      ]);
      expect(rows[2]).toEqual({
        kind: "compaction",
        summary: "Earlier: the user asked about one.",
        count: 2,
      });
    });

    it("does not break tool correlation across the marker", () => {
      const rows = foldAgentEvents([
        assistantMessage("start", { toolCalls: [{ toolCallId: "t1", name: "read_file" }] }),
        compacted("summary"),
        toolFinished("t1", "body"),
      ]);
      const assistant = rows[0];
      if (assistant.kind !== "assistant") throw new Error("expected assistant");
      expect(assistant.toolCalls[0]).toMatchObject({ id: "t1", status: "finished" });
    });

    it("does not reset the turn clock", () => {
      const rows = foldAgentEvents([
        { type: "user_message", runId: RUN, messageId: "u1", text: "one", attachments: [], ts: 1_000 },
        { type: "context_compacted", runId: RUN, summary: "s", ts: 1_200 },
        { type: "assistant_message", runId: RUN, messageId: "a1", content: [{ type: "text", text: "answer" }], ts: 1_800 },
      ]);
      const assistant = rows[2];
      if (assistant.kind !== "assistant") throw new Error("expected assistant");
      expect(assistant.meta?.ms).toBe(800);
    });
  });

  it("puts a steering marker above an open row that has not said anything yet", () => {
    // The turn boundary delivers a peer's message before the first delta: the
    // marker sits above the row the turn then streams into, not above an
    // empty row of its own.
    const fold = createFold({ seedOpenAssistant: true });
    fold.apply(steered("Agent message delivered: question from @run_a (env_1)"));
    fold.apply(delta("pong"));
    const rows = fold.rows();
    expect(rows.map((r) => r.kind)).toEqual(["steering", "assistant"]);
    expect(rows[1]).toMatchObject({ kind: "assistant", text: "pong" });
  });

  it("preserves compaction and steering as independent transcript annotations", () => {
    const rows = foldAgentEvents([
      userMessage("one"),
      compacted("earlier context"),
      steered("try a different tool"),
      assistantMessage("recovered"),
    ]);
    expect(rows.map((row) => row.kind)).toEqual([
      "user",
      "compaction",
      "steering",
      "assistant",
    ]);
    expect(rows[1]).toMatchObject({ kind: "compaction", summary: "earlier context" });
    expect(rows[2]).toEqual({ kind: "steering", reason: "try a different tool" });
  });
});

describe("a turn the app was closed on", () => {
  // The transcript of a run killed mid-turn ends on the user message: no
  // assistant_message, no run_result, no run_error — the Harness writes one
  // of those on every exit it controls. When the thread continues, the fold
  // has to say why that answer is missing, or the message reads as ignored.
  it("marks a turn that the next one began over without an answer", () => {
    const rows = foldAgentEvents([
      userMessage("I need something more detailed"),
      userMessage("so"),
      assistantMessage("Here are four deeper schemas."),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["user", "interrupted", "user", "assistant"]);
  });

  it("marks it when the continuation opens with run_started as well", () => {
    const rows = foldAgentEvents([
      runStarted("opencode", "glm"),
      userMessage("first"),
      runStarted("opencode", "glm"),
      userMessage("second"),
      assistantMessage("answer"),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["user", "interrupted", "user", "assistant"]);
  });

  it("leaves an answered turn alone whether or not its run_result was written", () => {
    const rows = foldAgentEvents([
      userMessage("one"),
      assistantMessage("first"),
      userMessage("two"),
      assistantMessage("second"),
      { type: "run_result", runId: RUN, result: { status: "done" }, ts: at() },
      userMessage("three"),
      assistantMessage("third"),
    ]);
    expect(rows.every((r) => r.kind !== "interrupted")).toBe(true);
  });

  it("never marks the tail — only the panel knows whether Rust still holds the run", () => {
    const rows = foldAgentEvents([userMessage("one"), assistantMessage("first"), userMessage("two")]);
    expect(rows.map((r) => r.kind)).toEqual(["user", "assistant", "user"]);
  });

  it("becomes a system line the panel draws as the Interrupted row", () => {
    const msgs = foldedToMsgs(foldAgentEvents([userMessage("a"), userMessage("b"), assistantMessage("c")]));
    expect(msgs[1]).toEqual({ role: "system", content: "Interrupted", runInterrupted: true });
  });
});

describe("foldedToMsgs — the AI panel shape", () => {
  it("emits an assistant row plus one tool row per finished call", () => {
    const msgs = foldedToMsgs(
      foldAgentEvents([
        userMessage("read it"),
        assistantMessage("reading", { toolCalls: [{ toolCallId: "t1", name: "read_file", input: { path: "a.ts" } }] }),
        toolFinished("t1", "file body"),
      ]),
    );
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    const assistant = msgs[1] as Extract<Msg, { role: "assistant" }>;
    // Raw input, not a JSON string — the structured tool rows and the memory
    // summarizer's path extraction read fields off it, live and on replay.
    expect(assistant.toolCalls).toEqual([
      { id: "t1", name: "read_file", args: { path: "a.ts" } },
    ]);
    expect(msgs[2]).toMatchObject({ role: "tool", content: "file body", toolName: "read_file", toolCallId: "t1" });
  });

  it("omits a tool row for a call that never finished", () => {
    const msgs = foldedToMsgs(
      foldAgentEvents([
        assistantMessage("working", { toolCalls: [{ toolCallId: "t1", name: "bash" }] }),
        toolStarted("t1", "bash"),
      ]),
    );
    expect(msgs.map((m) => m.role)).toEqual(["assistant"]);
  });

  it("renders a compaction marker as a system message with the compaction card", () => {
    const msgs = foldedToMsgs(
      foldAgentEvents([userMessage("one"), assistantMessage("first"), compacted("the gist")]),
    );
    const marker = msgs[2] as Extract<Msg, { role: "system" }>;
    expect(marker.role).toBe("system");
    expect(marker.compaction).toEqual({ count: 2, summary: "the gist", source: "agent" });
    // `content` stays a readable fallback for serialization and search.
    expect(marker.content).toContain("2 earlier messages");
  });

  it("singularises the fallback text for a single collapsed message", () => {
    const msgs = foldedToMsgs(foldAgentEvents([userMessage("one"), compacted("gist")]));
    const marker = msgs[1] as Extract<Msg, { role: "system" }>;
    expect(marker.content).toContain("1 earlier message");
    expect(marker.content).not.toContain("messages");
  });

  it("renders a steering marker as a system message with steering metadata", () => {
    const msgs = foldedToMsgs(foldAgentEvents([userMessage("one"), steered("change course")]));
    const marker = msgs[1] as Extract<Msg, { role: "system" }>;
    expect(marker).toMatchObject({
      role: "system",
      content: "change course",
      steering: { reason: "change course" },
    });
  });

  it("drops undefined toolCalls rather than emitting an empty array", () => {
    const msgs = foldedToMsgs(foldAgentEvents([assistantMessage("plain answer")]));
    const assistant = msgs[0] as Extract<Msg, { role: "assistant" }>;
    expect(assistant.toolCalls).toBeUndefined();
  });
});

describe("createFold — one walk, two paces", () => {
  it("applied one event at a time equals the batch fold, meta included", () => {
    const events: AgentEvent[] = [
      userMessage("read it"),
      delta("rea"),
      delta("ding", "hm"),
      assistantMessage("reading", {
        thinking: "hmm",
        toolCalls: [{ toolCallId: "t1", name: "read_file", input: { path: "a.ts" } }],
        usage: { completionTokens: 12, promptTokens: 300 },
        timing: { modelMs: 900, ttftMs: 100 },
      }),
      toolStarted("t1", "read_file", { path: "a.ts" }),
      toolFinished("t1", "file body"),
      delta("do"),
      delta("ne"),
      assistantMessage("all done"),
      compacted("gist"),
      steered("nudge"),
    ];
    const incremental = createFold();
    for (const event of events) incremental.apply(event);
    expect(incremental.rows()).toEqual(foldAgentEvents(events));
  });

  it("accumulates deltas into an open row, then finalizes that same row", () => {
    const fold = createFold();
    fold.apply(delta("Hel"));
    const step = fold.apply(delta("lo", "thinking…"));
    expect(step.changed).toEqual([0]);
    expect(fold.rows()).toHaveLength(1);
    expect(fold.rows()[0]).toMatchObject({ kind: "assistant", text: "Hello", thinking: "thinking…" });
    fold.apply(assistantMessage("Hello there"));
    expect(fold.rows()).toHaveLength(1);
    expect(fold.rows()[0]).toMatchObject({ kind: "assistant", text: "Hello there" });
  });

  it("keeps streamed content when the final message text is empty", () => {
    const fold = createFold();
    fold.apply(delta("streamed so far"));
    fold.apply(assistantMessage(""));
    expect(fold.rows()[0]).toMatchObject({ kind: "assistant", text: "streamed so far" });
  });

  it("opens a fresh row for text that streams after a tool card", () => {
    // A tool card splits the turn's text: whatever streams after it belongs in
    // a new bubble under the card — same as the live view always rendered it.
    const fold = createFold();
    fold.apply(assistantMessage("calling", { toolCalls: [{ toolCallId: "t1", name: "grep" }] }));
    fold.apply(toolStarted("t1", "grep"));
    fold.apply(delta("final answer"));
    expect(fold.rows().map((r) => r.kind)).toEqual(["assistant", "assistant"]);
    expect(fold.rows()[1]).toMatchObject({ kind: "assistant", text: "final answer" });
  });

  it("seeds an open assistant row for the live placeholder and finalizes into it", () => {
    const fold = createFold({ seedOpenAssistant: true });
    expect(fold.rows()).toEqual([{ kind: "assistant", text: "", toolCalls: [] }]);
    fold.apply(assistantMessage("hi"));
    expect(fold.rows()).toHaveLength(1);
    expect(fold.rows()[0]).toMatchObject({ kind: "assistant", text: "hi" });
  });

  it("reports which row a late tool result touched", () => {
    const fold = createFold();
    fold.apply(assistantMessage("first, a tool", { toolCalls: [{ toolCallId: "t1", name: "grep" }] }));
    fold.apply(assistantMessage("follow-up prose"));
    const step = fold.apply(toolFinished("t1", "3 matches"));
    expect(step.changed).toEqual([0]);
  });
});

describe("the tok/s rule — never wall clock", () => {
  // Project memory: Rust measures model time (AgentTurnTiming); duration is
  // never re-derived from Date.now(). The live path used to fall back to its
  // wall clock here, so the same turn showed a different tok/s live than
  // after a reload. Both paces now share this rule.
  it("does not derive tok/s from the live turn clock", () => {
    const fold = createFold();
    const step = fold.apply(
      assistantMessage("answer", { usage: { completionTokens: 100 } }),
      { turnMs: 2_000 },
    );
    expect(step.finalizedMeta?.ms).toBe(2_000); // wall clock still shown as duration
    expect(step.finalizedMeta?.tps).toBeUndefined(); // …but never as decode speed
  });

  it("live overrides feed ms and the TTFT fallback, not the decode window", () => {
    const fold = createFold();
    const step = fold.apply(
      assistantMessage("answer", {
        usage: { completionTokens: 40 },
        timing: { modelMs: 2_400, ttftMs: 400 },
      }),
      { turnMs: 99_999, ttftFallbackMs: 5 },
    );
    expect(step.finalizedMeta?.tps).toBe(20); // 40 tokens over the harness's 2s decode
    expect(step.finalizedMeta?.ms).toBe(99_999);
    expect(step.finalizedMeta?.ttftMs).toBe(400); // harness TTFT wins over the fallback
  });

  it("uses the panel-measured TTFT only when the harness recorded none", () => {
    const fold = createFold();
    const step = fold.apply(assistantMessage("answer"), { turnMs: 1_000, ttftFallbackMs: 200 });
    expect(step.finalizedMeta?.ttftMs).toBe(200);
  });

  it("estimates cost from pricing when the provider reports none, and only then", () => {
    const priced = createFold({ pricing: { inputPerMillion: 3, outputPerMillion: 15 } });
    const step = priced.apply(
      assistantMessage("x", { usage: { promptTokens: 1_000_000, completionTokens: 1_000_000 } }),
    );
    expect(step.finalizedMeta?.costUsd).toBeCloseTo(18);
    // The replay pace passes no pricing: local/subscription turns stay uncosted.
    const unpriced = createFold();
    const bare = unpriced.apply(assistantMessage("x"), { turnMs: 50 });
    expect(bare.finalizedMeta?.costUsd).toBeUndefined();
  });

  it("carries provider prompt tokens through to the message meta", () => {
    const msgs = foldedToMsgs(
      foldAgentEvents([
        userMessage("hi"),
        assistantMessage("reply", { usage: { promptTokens: 500, completionTokens: 42 } }),
      ]),
    );
    const assistant = msgs[1] as Extract<Msg, { role: "assistant" }>;
    expect(assistant.meta).toMatchObject({ tokens: 42, promptTokens: 500, exact: true });
  });
});

describe("shared row builders", () => {
  it("compactionMsg builds the one compaction marker, pluralized", () => {
    expect(compactionMsg(2, "the gist")).toEqual({
      role: "system",
      content: "Compacted 2 earlier messages to free context.",
      compaction: { count: 2, summary: "the gist", source: "agent" },
    });
    expect(compactionMsg(1, "s").content).toBe("Compacted 1 earlier message to free context.");
  });

  it("extractAssistantText joins text blocks and ignores the rest", () => {
    expect(
      extractAssistantText([
        { type: "thinking", text: "mull" },
        { type: "text", text: "Hello " },
        { type: "tool_call", toolCallId: "t1", name: "grep", input: {} },
        { type: "text", text: "world" },
      ]),
    ).toBe("Hello world");
    expect(extractAssistantText([])).toBe("");
  });

  it("foldedRowToMsgs shows a Running placeholder only for the live view", () => {
    const rows = foldAgentEvents([
      assistantMessage("working", { toolCalls: [{ toolCallId: "t1", name: "bash" }] }),
      toolStarted("t1", "bash"),
    ]);
    const live = foldedRowToMsgs(rows[0], { runningPlaceholders: true });
    expect(live.map((m) => m.role)).toEqual(["assistant", "tool"]);
    expect(live[1]).toMatchObject({ role: "tool", content: "Running bash...", toolCallId: "t1" });
    // Replay keeps its quieter shape: no row for a call that never finished.
    expect(foldedRowToMsgs(rows[0]).map((m) => m.role)).toEqual(["assistant"]);
  });

  it("foldedRowToMsgs tags assistant rows with the delegate flags", () => {
    const rows = foldAgentEvents([assistantMessage("hi")]);
    const [msg] = foldedRowToMsgs(rows[0], {
      delegate: { delegateConsole: true, delegateProvider: "Codex" },
    });
    expect(msg).toMatchObject({ role: "assistant", delegateConsole: true, delegateProvider: "Codex" });
  });
});

describe("foldedToRunMessages — the Mission Control shape", () => {
  it("folds tool calls into the assistant row with full lifecycle", () => {
    const out = foldedToRunMessages(
      foldAgentEvents([
        userMessage("read it"),
        assistantMessage("reading", { toolCalls: [{ toolCallId: "t1", name: "read_file", input: { path: "a.ts" } }] }),
        toolStarted("t1", "read_file", { path: "a.ts" }),
        toolFinished("t1", "file body"),
      ]),
    );
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(out[1].tools).toEqual([
      {
        id: "t1",
        name: "read_file",
        input: { path: "a.ts" },
        summary: "read_file …",
        result: "file body",
        ok: true,
        status: "finished",
      },
    ]);
  });

  it("drops an assistant turn that produced neither text nor tools", () => {
    const out = foldedToRunMessages(foldAgentEvents([userMessage("hi"), assistantMessage("   ")]));
    expect(out.map((m) => m.role)).toEqual(["user"]);
  });

  it("keeps a text-free turn that did call a tool", () => {
    const out = foldedToRunMessages(
      foldAgentEvents([assistantMessage("", { toolCalls: [{ toolCallId: "t1", name: "grep" }] })]),
    );
    expect(out).toHaveLength(1);
    expect(out[0].tools).toHaveLength(1);
  });

  it("skips compaction and steering markers — RunMessage has no role for them", () => {
    // The wire contract is "user" | "assistant" (the Rust struct and every
    // Delegate adapter agree), so AI-panel transcript annotations stay out of
    // Mission Control's Conversation.
    const out = foldedToRunMessages(
      foldAgentEvents([
        userMessage("one"),
        assistantMessage("first"),
        compacted("gist"),
        steered("change course"),
        userMessage("two"),
      ]),
    );
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
});
