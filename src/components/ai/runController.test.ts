import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, DiffProposal, PermissionRequest, StartAgentRunInput } from "../../agent/types";
import type { AgentRunSession, RunReattachment } from "../../agent/client";
import {
  createGateTable,
  createRunController,
  type RunClient,
  type RunControllerDeps,
  type RunControllerHooks,
} from "./runController";
import type { Msg, QueuedTurn } from "./types";

// `agent/client.ts` reaches for Tauri at import time; the controller only
// takes its two pure helpers from it, and everything else through the fake.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const CONVO = "convo-1";
const BUSY = "A run is already active for this conversation";

// ── Fixtures ──

function turn(clientId: string, text = clientId, extra: Partial<QueuedTurn> = {}): QueuedTurn {
  return {
    clientId,
    text,
    mode: "chat",
    provider: "ollama",
    model: "m",
    modelSupportsTools: false,
    modelSupportsReflection: false,
    attachments: [],
    ...extra,
  };
}

function permissionRequest(id: string, runId = CONVO): PermissionRequest {
  return {
    id,
    runId,
    toolCallId: `call-${id}`,
    toolName: "run_command",
    input: { command: "git log", cwd: "/w", externalPaths: [], matchedAllowRule: null },
    summary: "$ git log",
    reason: "wants to run a shell command",
    options: [],
  } as unknown as PermissionRequest;
}

function diffProposal(id: string, runId = CONVO): DiffProposal {
  return {
    id,
    runId,
    toolCallId: `call-${id}`,
    path: "src/main.ts",
    oldContent: "a",
    newContent: "b",
    oldHash: "h1",
    newHash: "h2",
    unifiedDiff: "@@",
    isCreate: false,
  };
}

const ts = 0;
const started = (runId = CONVO): AgentEvent =>
  ({ type: "run_started", runId, provider: "ollama", model: "m", mode: "chat", ts }) as unknown as AgentEvent;
const userSaid = (text: string, runId = CONVO): AgentEvent =>
  ({ type: "user_message", runId, messageId: `u-${text}`, text, attachments: [], ts }) as AgentEvent;
const message = (text: string, runId = CONVO): AgentEvent =>
  ({ type: "assistant_message", runId, messageId: `m-${text}`, content: [{ type: "text", text }], ts }) as unknown as AgentEvent;
const finished = (runId = CONVO): AgentEvent => ({ type: "run_result", runId, result: {}, ts }) as unknown as AgentEvent;
const errored = (code: string, runId = CONVO): AgentEvent =>
  ({ type: "run_error", runId, error: { code, message: `failed: ${code}` }, ts }) as unknown as AgentEvent;
const asked = (id: string, runId = CONVO): AgentEvent =>
  ({ type: "permission_requested", runId, request: permissionRequest(id, runId), ts }) as AgentEvent;
const answered = (requestId: string, runId = CONVO): AgentEvent =>
  ({ type: "permission_resolved", runId, requestId, decision: "allow_once", ts }) as unknown as AgentEvent;
const proposed = (id: string, runId = CONVO): AgentEvent =>
  ({ type: "diff_proposed", runId, proposal: diffProposal(id, runId), ts }) as AgentEvent;
const resolved = (proposalId: string, runId = CONVO): AgentEvent =>
  ({ type: "diff_resolved", runId, proposalId, decision: "approve", ts }) as unknown as AgentEvent;
const questioned = (requestId: string, runId = CONVO): AgentEvent =>
  ({ type: "user_question_requested", runId, requestId, question: "Which port?", ts }) as AgentEvent;
const questionAnswered = (requestId: string, runId = CONVO): AgentEvent =>
  ({ type: "user_question_resolved", runId, requestId, ts }) as unknown as AgentEvent;

/** A Run the fake backend started: what it was asked, and a way to speak. */
type FakeRun = { input: StartAgentRunInput; emit: (event: AgentEvent) => void };

/** A follower the fake backend registered for a reattach. */
type FakeFollower = { runId: string; fromSeq: number; emit: (event: AgentEvent, seq: number) => void; detached: boolean };

function fakeClient() {
  const runs: FakeRun[] = [];
  const followers: FakeFollower[] = [];
  let busyStartsLeft = 0;
  let state: { status: string | null; fromSeq: number | null } = { status: null, fromSeq: null };
  let transcript: AgentEvent[] = [];
  const client: RunClient = {
    startAgentRun: vi.fn(async (input: StartAgentRunInput, onEvent: (event: AgentEvent) => void): Promise<AgentRunSession> => {
      if (busyStartsLeft > 0) {
        busyStartsLeft -= 1;
        throw new Error(BUSY);
      }
      let settle: () => void = () => {};
      const done = new Promise<void>((resolve) => { settle = resolve; });
      const run: FakeRun = {
        input,
        emit: (event) => {
          onEvent(event);
          if (event.type === "run_result" || event.type === "run_error") settle();
        },
      };
      runs.push(run);
      return { runId: input.runId!, done };
    }),
    stopAgentRun: vi.fn(async () => {}),
    reattachAgentRun: vi.fn(async (runId: string, fromSeq: number, onEvent: (event: AgentEvent, seq: number) => void): Promise<RunReattachment> => {
      let settle: () => void = () => {};
      const done = new Promise<void>((resolve) => { settle = resolve; });
      const follower: FakeFollower = {
        runId,
        fromSeq,
        detached: false,
        emit: (event, seq) => {
          if (seq < fromSeq) return;
          onEvent(event, seq);
          if (event.type === "run_result" || event.type === "run_error") settle();
        },
      };
      followers.push(follower);
      return { detach: () => { follower.detached = true; settle(); }, done };
    }),
    getAgentRunState: vi.fn(async () => state),
    readAgentRunEvents: vi.fn(async () => transcript),
    resolveDiff: vi.fn(async () => {}),
    resolvePermission: vi.fn(async () => {}),
    resolveUserQuestion: vi.fn(async () => {}),
  };
  return {
    client,
    runs,
    followers,
    /** The next `n` starts are refused as busy. */
    busyFor(n: number) { busyStartsLeft = n; },
    /** What the backend says about the conversation's Run, and its transcript. */
    backend(next: { status?: string | null; fromSeq?: number | null; transcript?: AgentEvent[] }) {
      state = { status: next.status ?? state.status, fromSeq: next.fromSeq ?? state.fromSeq };
      if (next.transcript) transcript = next.transcript;
    },
    /** The most recent Run the backend started. */
    last(): FakeRun {
      const run = runs[runs.length - 1];
      if (!run) throw new Error("no run started");
      return run;
    },
  };
}

function harness(opts: { delegateStyle?: "console" | "headless"; initial?: Msg[] } = {}) {
  const backend = fakeClient();
  let msgs: Msg[] = opts.initial ?? [];
  let conversationId = CONVO;
  let clock = 0;
  const session = { runStarted: vi.fn(), runSettled: vi.fn() };
  const hooks = {
    onTurnQueued: vi.fn(),
    onTurnStarted: vi.fn(),
    onMeasuredPromptTokens: vi.fn(),
    onMeasuredUsage: vi.fn(),
    onMeasuredContextWindow: vi.fn(),
    onFileChanged: vi.fn(),
    onAdvisorRequested: vi.fn(),
    onTurnFailed: vi.fn(),
    onTurnSettled: vi.fn(),
    onGateFailed: vi.fn(),
  } satisfies RunControllerHooks;
  const sleeps: number[] = [];
  const deps: RunControllerDeps = {
    client: backend.client,
    transcript: { read: () => msgs, commit: (next) => { msgs = next; } },
    conversationId: () => conversationId,
    session,
    delegateStyle: opts.delegateStyle ?? "console",
    pricing: null,
    request: (t) => ({ workspaceRoot: null, mode: t.mode, provider: t.provider, model: t.model, text: t.text, attachments: [] }),
    failureText: (error) => String(error instanceof Error ? error.message : error),
    hooks,
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    // Deterministic driver: no pacing, and a flush timer that never fires —
    // `run_result` and `assistant_message` project synchronously anyway.
    driver: { pace: false, now: () => clock, setTimer: () => 0, clearTimer: () => {} },
  };
  const controller = createRunController(() => deps);
  const views: number[] = [];
  controller.subscribe(() => views.push(1));
  return {
    controller,
    backend,
    session,
    hooks,
    sleeps,
    views,
    msgs: () => msgs,
    /** Move the panel to another conversation, as `transitionConversation` would. */
    moveTo(id: string, messages: Msg[] = []) {
      conversationId = id;
      msgs = messages;
    },
    tick: (ms: number) => { clock += ms; },
  };
}

/** Let every pending microtask settle — the drain loop and the fake start. */
const flush = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await Promise.resolve(); };

// ── The queue ──

describe("createRunController — the turn queue", () => {
  it("runs turns one at a time, in send order, and settles each", async () => {
    const h = harness();
    h.controller.send(turn("a"));
    h.controller.send(turn("b"));
    await flush();
    // Both are on screen, the first running with its placeholder, the second queued.
    expect(h.msgs().map((m) => [m.role, m.role === "user" ? m.queueState : undefined])).toEqual([
      ["user", "running"], ["assistant", undefined], ["user", "queued"],
    ]);
    expect(h.controller.getState()).toMatchObject({ queued: 1, processing: true, activeRunId: CONVO });
    expect(h.backend.runs).toHaveLength(1);
    expect(h.backend.runs[0].input.text).toBe("a");
    expect(h.session.runStarted).toHaveBeenCalledWith("thinking", { provider: "ollama", model: "m" });
    // The placeholder already wears this turn's pair: `run_started` is a
    // second out, and an unstamped row would draw the thread's origin mark.
    expect(h.msgs()[1]).toMatchObject({ role: "assistant", content: "", provider: "ollama", model: "m" });

    h.backend.last().emit(started());
    h.backend.last().emit(message("first answer"));
    h.backend.last().emit(finished());
    await flush();
    expect(h.hooks.onTurnSettled).toHaveBeenCalledWith(expect.objectContaining({ clientId: "a" }), "done");
    // The second turn started only after the first settled.
    expect(h.backend.runs).toHaveLength(2);
    expect(h.backend.runs[1].input.text).toBe("b");
    expect(h.controller.getState()).toMatchObject({ queued: 0, processing: true });
    expect(h.msgs()[1]).toMatchObject({ role: "assistant", content: "first answer" });
    expect(h.msgs()[2]).toMatchObject({ role: "user", queueState: "running" });

    h.backend.last().emit(started());
    h.backend.last().emit(finished());
    await flush();
    expect(h.controller.getState()).toMatchObject({ queued: 0, processing: false, activeRunId: null });
    expect(h.session.runSettled).toHaveBeenCalled();
  });

  it("carries the conversation id and a subagent turn's child identity into the request", async () => {
    const h = harness();
    h.controller.send(turn("s", "review this", { subagent: "reviewer" }));
    await flush();
    expect(h.backend.last().input).toMatchObject({ runId: `${CONVO}-at-s`, parentId: CONVO, text: "review this" });
  });

  it("waits for a followed Run to settle before starting a queued turn", async () => {
    const h = harness();
    h.backend.backend({ status: "running", fromSeq: 0, transcript: [started()] });
    h.controller.attach({ conversationId: CONVO, provider: "ollama" });
    await flush(10);
    expect(h.controller.getState()).toMatchObject({ following: true, activeRunId: CONVO });
    h.controller.send(turn("later"));
    await flush(10);
    // Queued behind the follower, not dispatched over it.
    expect(h.backend.runs).toHaveLength(0);
    expect(h.controller.getState().queued).toBe(1);
    h.backend.backend({ transcript: [started(), message("done elsewhere"), finished()] });
    h.backend.followers[0].emit(finished(), 5);
    await flush(10);
    expect(h.controller.getState().following).toBe(false);
    expect(h.backend.runs).toHaveLength(1);
    expect(h.backend.last().input.text).toBe("later");
  });
});

// ── Generations ──

describe("createRunController — generation retirement", () => {
  it("drops a retired turn's events instead of landing them in the next conversation", async () => {
    const h = harness();
    h.controller.send(turn("a"));
    await flush();
    const run = h.backend.last();
    run.emit(started());
    h.controller.leave("load");
    h.moveTo("convo-2", [{ role: "user", content: "other thread" }]);
    // The old Run keeps talking; nothing reaches the new conversation.
    run.emit(message("late answer"));
    run.emit(proposed("d1"));
    run.emit(finished());
    await flush();
    expect(h.msgs()).toEqual([{ role: "user", content: "other thread" }]);
    expect(h.controller.getState().gates).toEqual({ diff: null, permission: null, question: null });
    expect(h.hooks.onTurnSettled).toHaveBeenCalledWith(expect.objectContaining({ clientId: "a" }), "retired");
    // And the walked-away-from turn's settle does not settle the new thread.
    expect(h.session.runSettled).toHaveBeenCalledTimes(1); // the leave itself
  });

  it("does not let a retired drain loop free the flag a new drain owns", async () => {
    const h = harness();
    h.controller.send(turn("a"));
    await flush();
    const first = h.backend.last();
    h.controller.leave("new");
    h.moveTo("convo-2");
    h.controller.send(turn("b"));
    await flush();
    expect(h.controller.getState().processing).toBe(true);
    // The old Run finishing releases the old loop, which must not clear
    // `processing` for the loop now running `b`.
    first.emit(finished());
    await flush();
    expect(h.controller.getState().processing).toBe(true);
    expect(h.backend.runs).toHaveLength(2);
  });

  it("a Run finishing late does not unhook the follower of the thread the panel moved to", async () => {
    const h = harness();
    h.controller.send(turn("a"));
    await flush();
    const first = h.backend.last();
    h.controller.leave("load");
    h.moveTo("convo-2");
    h.backend.backend({ status: "running", fromSeq: 0, transcript: [started("convo-2")] });
    h.controller.attach({ conversationId: "convo-2", provider: "ollama" });
    await flush(10);
    expect(h.controller.getState().activeRunId).toBe("convo-2");
    first.emit(finished());
    await flush();
    expect(h.controller.getState().activeRunId).toBe("convo-2");
  });
});

// ── Busy retry ──

describe("createRunController — busy retry", () => {
  it("keeps the turn while the previous Run lets go, then dispatches it", async () => {
    const h = harness();
    h.backend.busyFor(2);
    h.controller.send(turn("a"));
    await flush(12);
    expect(h.sleeps).toEqual([250, 500]);
    expect(h.backend.client.startAgentRun).toHaveBeenCalledTimes(3);
    expect(h.msgs()[0]).toMatchObject({ role: "user", queueState: "running" });
  });

  it("gives up past the deadline and says so where the answer would be", async () => {
    const h = harness();
    h.backend.busyFor(1000);
    h.controller.send(turn("a"));
    await flush(200);
    expect(h.backend.runs).toHaveLength(0);
    expect(h.sleeps.reduce((a, b) => a + b, 0)).toBe(20_000);
    expect(h.msgs()[1]).toMatchObject({ role: "assistant", content: expect.stringContaining("still busy") });
    expect(h.msgs()[0]).toMatchObject({ role: "user", queueState: undefined });
    expect(h.hooks.onTurnSettled).toHaveBeenCalledWith(expect.anything(), "failed");
  });

  it("rethrows a failure that is not the busy guard as the turn's failure", async () => {
    const h = harness();
    (h.backend.client.startAgentRun as ReturnType<typeof vi.fn>).mockRejectedValueOnce("Ollama is not running");
    h.controller.send(turn("a"));
    await flush();
    expect(h.msgs()[1]).toMatchObject({ role: "assistant", content: "⚠ Ollama is not running" });
    expect(h.hooks.onTurnFailed).toHaveBeenCalledWith(expect.objectContaining({ clientId: "a" }), "Ollama is not running");
    expect(h.controller.getState()).toMatchObject({ processing: false, activeRunId: null });
  });
});

// ── The gate table ──

describe("createGateTable", () => {
  it("arrives, settles by id, and resets", () => {
    const changes: unknown[] = [];
    const table = createGateTable((g) => changes.push(g));
    table.arrive({ kind: "diff", proposal: diffProposal("d1") });
    table.arrive({ kind: "permission", runId: CONVO, request: permissionRequest("p1") });
    table.arrive({ kind: "question", question: { runId: CONVO, requestId: "q1", question: "?" } });
    expect(table.read()).toMatchObject({ diff: { id: "d1" }, permission: { request: { id: "p1" } }, question: { requestId: "q1" } });
    // A resolution for another request leaves the card up.
    table.settle("diff", "d0");
    table.settle("permission", "p0");
    table.settle("question", "q0");
    expect(table.read()).toMatchObject({ diff: { id: "d1" }, permission: { request: { id: "p1" } }, question: { requestId: "q1" } });
    table.settle("diff", "d1");
    table.settle("permission", "p1");
    table.settle("question", "q1");
    expect(table.read()).toEqual({ diff: null, permission: null, question: null });
    table.arrive({ kind: "diff", proposal: diffProposal("d2") });
    table.reset();
    expect(table.read()).toEqual({ diff: null, permission: null, question: null });
    // Eight publishes: the three no-op settles said nothing.
    expect(changes).toHaveLength(8);
  });

  it("restores from a transcript: keeps a richer card it already holds, drops this Run's stale cards, leaves another Run's alone", () => {
    const table = createGateTable(() => {});
    const richer = { runId: CONVO, requestId: "q1", question: "Which?", choices: { options: ["a", "b"] } };
    table.arrive({ kind: "question", question: richer });
    table.arrive({ kind: "diff", proposal: diffProposal("d-other", "other-run") });
    table.arrive({ kind: "permission", runId: CONVO, request: permissionRequest("p-stale") });
    table.restore([started(), questioned("q1"), asked("p2")], CONVO);
    const gates = table.read();
    expect(gates.question).toBe(richer); // same request → kept, with its choices
    expect(gates.permission).toMatchObject({ runId: CONVO, request: { id: "p2" } }); // the transcript's
    expect(gates.diff).toMatchObject({ id: "d-other", runId: "other-run" }); // not this Run's to drop
    // A finished transcript is waiting on nothing of this Run's.
    table.restore([started(), questioned("q1"), asked("p2"), finished()], CONVO);
    expect(table.read()).toMatchObject({ question: null, permission: null, diff: { id: "d-other" } });
  });
});

describe("createRunController — gates on the live channel", () => {
  async function liveRun() {
    const h = harness();
    h.controller.send(turn("a"));
    await flush();
    h.backend.last().emit(started());
    return h;
  }

  it("draws each kind as it arrives and takes it down on its own resolution only", async () => {
    const h = await liveRun();
    const run = h.backend.last();
    run.emit(proposed("d1"));
    run.emit(asked("p1"));
    run.emit(questioned("q1"));
    expect(h.controller.getState().gates).toMatchObject({ diff: { id: "d1" }, permission: { request: { id: "p1" } }, question: { requestId: "q1" } });
    run.emit(resolved("d0"));
    run.emit(answered("p0"));
    run.emit(questionAnswered("q0"));
    expect(h.controller.getState().gates).toMatchObject({ diff: { id: "d1" }, permission: { request: { id: "p1" } }, question: { requestId: "q1" } });
    run.emit(resolved("d1"));
    run.emit(answered("p1"));
    run.emit(questionAnswered("q1"));
    expect(h.controller.getState().gates).toEqual({ diff: null, permission: null, question: null });
  });

  it("clears every card when the Run settles", async () => {
    const h = await liveRun();
    h.backend.last().emit(proposed("d1"));
    h.backend.last().emit(finished());
    await flush();
    expect(h.controller.getState().gates).toEqual({ diff: null, permission: null, question: null });
  });

  it("answers the card on screen at resolve time, not the one a handler was rendered with", async () => {
    const h = await liveRun();
    const run = h.backend.last();
    run.emit(questioned("q1"));
    // A handler closed over the first question…
    const answer = () => h.controller.resolve({ gate: "question", answer: "8080" });
    // …but the Run moved on to a second before the click landed.
    run.emit(questionAnswered("q1"));
    run.emit(questioned("q2"));
    await answer();
    expect(h.backend.client.resolveUserQuestion).toHaveBeenCalledWith({ runId: CONVO, requestId: "q2", answer: "8080" });
    expect(h.controller.getState().gates.question).toBeNull();
  });

  it("clears a permission or question optimistically, keeps a diff until the harness says so", async () => {
    const h = await liveRun();
    const run = h.backend.last();
    run.emit(proposed("d1"));
    run.emit(asked("p1"));
    expect(await h.controller.resolve({ gate: "permission", decision: { behavior: "allow", scope: "once" } })).toBe(true);
    expect(h.backend.client.resolvePermission).toHaveBeenCalledWith({ runId: CONVO, requestId: "p1", decision: { behavior: "allow", scope: "once" } });
    expect(h.controller.getState().gates.permission).toBeNull();
    expect(await h.controller.resolve({ gate: "diff", decision: { behavior: "apply" } })).toBe(true);
    expect(h.backend.client.resolveDiff).toHaveBeenCalledWith({ runId: CONVO, proposalId: "d1", decision: { behavior: "apply" } });
    expect(h.controller.getState().gates.diff).toMatchObject({ id: "d1" });
    run.emit(resolved("d1"));
    expect(h.controller.getState().gates.diff).toBeNull();
  });

  it("answering nothing is a no-op, and a refusal is reported once and remembered", async () => {
    const h = await liveRun();
    expect(await h.controller.resolve({ gate: "diff", decision: { behavior: "reject" } })).toBe(false);
    expect(h.backend.client.resolveDiff).not.toHaveBeenCalled();
    h.backend.last().emit(asked("p1"));
    (h.backend.client.resolvePermission as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("no such run"));
    const decision = { gate: "permission" as const, decision: { behavior: "deny" as const } };
    expect(await h.controller.resolve(decision)).toBe(false);
    expect(h.hooks.onGateFailed).toHaveBeenCalledTimes(1);
    expect(h.hooks.onGateFailed).toHaveBeenCalledWith(decision, expect.any(Error));
    expect(h.controller.getState().lastError).toBe("no such run");
  });
});

// ── Leaving and stopping ──

describe("createRunController — leaving", () => {
  async function parkedRun() {
    const h = harness();
    h.controller.send(turn("a"));
    h.controller.send(turn("b"));
    await flush();
    const run = h.backend.last();
    run.emit(started());
    run.emit(proposed("d1"));
    run.emit(asked("p1"));
    run.emit(questioned("q1"));
    return { h, run };
  }

  for (const reason of ["new", "load", "deleted", "unmount"] as const) {
    it(`leave("${reason}") clears every card, drops the queue, detaches, settles — and leaves the Run alive`, async () => {
      const { h, run } = await parkedRun();
      const before = h.controller.getState();
      expect(before).toMatchObject({ queued: 1, activeRunId: CONVO });
      expect(before.gates.diff && before.gates.permission && before.gates.question).toBeTruthy();
      const decision = h.controller.leave(reason);
      expect(decision).toEqual({ abort: false, settle: false });
      expect(h.controller.getState()).toMatchObject({
        queued: 0, processing: false, following: false, activeRunId: null,
        gates: { diff: null, permission: null, question: null },
      });
      expect(h.backend.client.stopAgentRun).not.toHaveBeenCalled();
      expect(h.session.runSettled).toHaveBeenCalled();
      // The queued turn never starts.
      run.emit(finished());
      await flush();
      expect(h.backend.runs).toHaveLength(1);
    });
  }

  it("leave with no Run tells the caller to settle the board", () => {
    const h = harness();
    expect(h.controller.leave("new")).toEqual({ abort: false, settle: true });
  });

  it("stop aborts the Run, clears every card — the diff included — and keeps the queue for the next send", async () => {
    const { h, run } = await parkedRun();
    h.controller.stop();
    expect(h.backend.client.stopAgentRun).toHaveBeenCalledWith(CONVO);
    expect(h.controller.getState()).toMatchObject({
      activeRunId: null, processing: false, queued: 1,
      gates: { diff: null, permission: null, question: null },
    });
    expect(h.session.runSettled).toHaveBeenCalled();
    // A stopped Run's end is not a clean turn: no summary for it.
    run.emit(errored("aborted"));
    await flush();
    expect(h.hooks.onTurnSettled).toHaveBeenCalledWith(expect.objectContaining({ clientId: "a" }), "retired");
  });

  it("deleted while live: the old Run's events and cards never reach the fresh conversation", async () => {
    const { h, run } = await parkedRun();
    h.controller.leave("deleted");
    h.moveTo("convo-fresh", []);
    run.emit(message("still talking"));
    run.emit(questioned("q2"));
    run.emit(finished());
    await flush();
    expect(h.msgs()).toEqual([]);
    expect(h.controller.getState().gates).toEqual({ diff: null, permission: null, question: null });
    expect(h.controller.getState().activeRunId).toBeNull();
  });

  it("drops a follower on leave", async () => {
    const h = harness();
    h.backend.backend({ status: "running", fromSeq: 0, transcript: [started()] });
    h.controller.attach({ conversationId: CONVO, provider: "ollama" });
    await flush(10);
    expect(h.backend.followers).toHaveLength(1);
    h.controller.leave("load");
    expect(h.backend.followers[0].detached).toBe(true);
    expect(h.controller.getState()).toMatchObject({ following: false, activeRunId: null });
  });
});

// ── Attaching ──

describe("createRunController — attach", () => {
  it("adopts a finished transcript and does not follow", async () => {
    const h = harness({ initial: [{ role: "user", content: "hi" }] });
    h.backend.backend({ status: null, fromSeq: null, transcript: [started(), userSaid("hi"), message("hello"), finished()] });
    h.controller.attach({ conversationId: CONVO, provider: "ollama" });
    await flush(10);
    expect(h.msgs().map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(h.msgs()[1]).toMatchObject({ content: "hello" });
    expect(h.backend.followers).toHaveLength(0);
    expect(h.session.runStarted).not.toHaveBeenCalled();
  });

  it("marks a turn that died with the app as interrupted", async () => {
    const h = harness();
    h.backend.backend({ status: null, fromSeq: null, transcript: [started(), userSaid("hi")] });
    h.controller.attach({ conversationId: CONVO, provider: "ollama" });
    await flush(10);
    expect(h.msgs().map((m) => m.role)).toEqual(["user", "system"]);
    expect(h.msgs()[1]).toMatchObject({ runInterrupted: true });
  });

  it("follows a live Run, restores its cards, and settles on the terminal event", async () => {
    const h = harness();
    h.backend.backend({ status: "waiting_for_permission", fromSeq: 0, transcript: [started(), asked("p1")] });
    h.controller.attach({ conversationId: CONVO, provider: "ollama" });
    await flush(10);
    expect(h.session.runStarted).toHaveBeenCalledWith(null);
    expect(h.controller.getState()).toMatchObject({ following: true, activeRunId: CONVO, gates: { permission: { request: { id: "p1" } } } });
    h.backend.backend({ transcript: [started(), asked("p1"), answered("p1"), message("ok"), finished()] });
    h.backend.followers[0].emit(finished(), 9);
    await flush(10);
    expect(h.controller.getState()).toMatchObject({ following: false, activeRunId: null, gates: { permission: null } });
    expect(h.session.runSettled).toHaveBeenCalled();
    expect(h.msgs()[h.msgs().length - 1]).toMatchObject({ role: "assistant", content: "ok" });
  });

  it("never follows a Delegate conversation that streams through a PTY", async () => {
    const h = harness({ delegateStyle: "console" });
    h.backend.backend({ status: "running", fromSeq: 0, transcript: [started()] });
    h.controller.attach({ conversationId: CONVO, provider: "claude-code" });
    await flush(10);
    expect(h.backend.client.getAgentRunState).not.toHaveBeenCalled();
    const headless = harness({ delegateStyle: "headless" });
    headless.backend.backend({ status: "running", fromSeq: 0, transcript: [started()] });
    headless.controller.attach({ conversationId: CONVO, provider: "claude-code" });
    await flush(10);
    expect(headless.controller.getState().following).toBe(true);
  });

  it("drops the listener when the panel moved on during the subscribe", async () => {
    const h = harness();
    h.backend.backend({ status: "running", fromSeq: 0, transcript: [started()] });
    (h.backend.client.getAgentRunState as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      h.moveTo("convo-2");
      return { status: "running", fromSeq: 0 };
    });
    h.controller.attach({ conversationId: CONVO, provider: "ollama" });
    await flush(10);
    expect(h.backend.followers).toHaveLength(0);
    expect(h.controller.getState().following).toBe(false);
  });
});

// ── The view ──

describe("createRunController — view", () => {
  it("publishes a new snapshot on every change and a stable one between", async () => {
    const h = harness();
    const first = h.controller.getState();
    expect(h.controller.getState()).toBe(first);
    h.controller.send(turn("a"));
    expect(h.views.length).toBeGreaterThan(0);
    expect(h.controller.getState()).not.toBe(first);
    await flush();
    const settled = h.controller.getState();
    expect(h.controller.getState()).toBe(settled);
  });
});
