import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStorage } from "./testStorage";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

/** Emitters for the global `agent-run:{id}` stream, keyed by event name. */
let emitters: Map<string, (payload: unknown) => void>;

beforeEach(() => {
  vi.resetModules();
  invokeMock.mockReset();
  listenMock.mockReset();
  emitters = new Map();
  listenMock.mockImplementation(async (event: string, handler: (p: unknown) => void) => {
    emitters.set(event, handler);
    return () => emitters.delete(event);
  });
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** One Mission Control row, as AiPanel publishes it while it streams.
 *
 *  Rows are published rather than written into localStorage on purpose: the
 *  store's decoder rehydrates every persisted row as "done", because a Klide
 *  Harness Run dies with the app process. "Running" only ever exists in a live
 *  session, which is the only session this indicator has to be right in. */
function storeRow(id: string, status: string) {
  return {
    id,
    title: id,
    status,
    provider: "ollama",
    model: "llama3.1:8b",
    cwd: "/workspace",
    branch: null,
    messages: [{ role: "user", text: "go" }],
    updatedMs: 1,
  };
}

async function publish(id: string, status: string) {
  const { publishKlideConvo } = await import("./klideConvos");
  publishKlideConvo(storeRow(id, status) as never);
}

/** Lets the module's confirm-then-follow chain of awaits run to completion. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

async function load() {
  return import("./runningConversations");
}

describe("running conversations", () => {
  it("confirms a published row against Rust before calling it live", async () => {
    invokeMock.mockResolvedValue({ status: "running", fromSeq: null });

    const { subscribeRunningConversations, getRunningConversationIds } = await load();
    subscribeRunningConversations(() => {});
    await publish("run-live", "running");
    await settled();

    expect(invokeMock).toHaveBeenCalledWith("agent_run_status", { runId: "run-live" });
    expect([...getRunningConversationIds()]).toEqual(["run-live"]);
  });

  it("confirms a run whose Rust registration lags the panel's first publish", async () => {
    // The panel publishes "running" the moment its send begins — before
    // `agent_start_run` has round-tripped — so the first status ask races the
    // registration and answers null while the run is real. The confirmation
    // retries instead of writing the run off for the whole turn.
    invokeMock.mockResolvedValueOnce({ status: null, fromSeq: null }).mockResolvedValue({ status: "running", fromSeq: null });

    const { subscribeRunningConversations, getRunningConversationIds } = await load();
    subscribeRunningConversations(() => {});
    await publish("run-late", "running");
    await settled();
    expect([...getRunningConversationIds()]).toEqual([]);

    await vi.waitFor(
      () => {
        expect([...getRunningConversationIds()]).toEqual(["run-late"]);
      },
      { timeout: 1500 },
    );
  });

  it("does not trust a 'running' row the harness has already finished", async () => {
    // The exact shape a panel unmounted mid-run leaves behind: the last
    // snapshot it wrote says running, the run settled afterwards, and nothing
    // was mounted to correct the record.
    invokeMock.mockResolvedValue({ status: null, fromSeq: null }); // supervisor no longer tracks it

    const { subscribeRunningConversations, getRunningConversationIds } = await load();
    subscribeRunningConversations(() => {});
    await publish("run-stale", "running");
    await settled();

    expect([...getRunningConversationIds()]).toEqual([]);
  });

  it("drops the row when the run it is following emits a terminal event", async () => {
    invokeMock.mockResolvedValue({ status: "running", fromSeq: null });

    const { subscribeRunningConversations, getRunningConversationIds } = await load();
    const notified = vi.fn();
    subscribeRunningConversations(notified);
    await publish("run-live", "running");
    await settled();
    expect([...getRunningConversationIds()]).toEqual(["run-live"]);

    emitters.get("agent-run:run-live")?.({
      payload: { seq: 7, event: { type: "run_result" } },
    });
    await settled();

    expect([...getRunningConversationIds()]).toEqual([]);
    expect(notified).toHaveBeenCalled();
  });

  it("ignores a conversation with no Harness Run — a Delegate PTY is not one", async () => {
    invokeMock.mockResolvedValue({ status: null, fromSeq: null });

    const { subscribeRunningConversations, getRunningConversationIds } = await load();
    subscribeRunningConversations(() => {});
    await publish("delegate-convo", "running");
    await settled();

    expect([...getRunningConversationIds()]).toEqual([]);
  });

  it("follows each live run once, however often the store republishes", async () => {
    invokeMock.mockResolvedValue({ status: "running", fromSeq: null });

    const { subscribeRunningConversations, getRunningConversationIds } = await load();
    subscribeRunningConversations(() => {});

    // AiPanel republishes on every message delta; each one re-runs reconcile.
    for (let i = 0; i < 5; i += 1) {
      await publish("run-live", "running");
      await settled();
    }

    expect(listenMock).toHaveBeenCalledTimes(1);
    expect([...getRunningConversationIds()]).toEqual(["run-live"]);
  });

  it("holds two concurrent runs at once, each followed on its own stream", async () => {
    // Two panels, two live runs — both rail rows have to animate. Nothing here
    // is single-flight across ids: the guards, the watchers and the event
    // streams are all per conversation.
    invokeMock.mockResolvedValue({ status: "running", fromSeq: null });

    const { subscribeRunningConversations, getRunningConversationIds } = await load();
    subscribeRunningConversations(() => {});
    await publish("run-a", "running");
    await publish("run-b", "running");
    await settled();

    expect([...getRunningConversationIds()].sort()).toEqual(["run-a", "run-b"]);
    expect(emitters.has("agent-run:run-a")).toBe(true);
    expect(emitters.has("agent-run:run-b")).toBe(true);
  });

  it("retires one of two concurrent runs without disturbing the other", async () => {
    invokeMock.mockResolvedValue({ status: "running", fromSeq: null });

    const { subscribeRunningConversations, getRunningConversationIds } = await load();
    subscribeRunningConversations(() => {});
    await publish("run-a", "running");
    await publish("run-b", "running");
    await settled();

    emitters.get("agent-run:run-a")?.({
      payload: { seq: 3, event: { type: "run_error" } },
    });
    await settled();

    expect([...getRunningConversationIds()]).toEqual(["run-b"]);
    expect(emitters.has("agent-run:run-b")).toBe(true);
  });

  it("stops following a run whose panel came back and settled it", async () => {
    invokeMock.mockResolvedValue({ status: "running", fromSeq: null });

    const { subscribeRunningConversations, getRunningConversationIds } = await load();
    const { settleKlideConvo } = await import("./klideConvos");
    subscribeRunningConversations(() => {});
    await publish("run-live", "running");
    await settled();
    expect([...getRunningConversationIds()]).toEqual(["run-live"]);

    settleKlideConvo("run-live");
    await settled();

    expect([...getRunningConversationIds()]).toEqual([]);
    expect(emitters.has("agent-run:run-live")).toBe(false);
  });
});
