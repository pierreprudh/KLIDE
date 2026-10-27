import { beforeEach, describe, expect, it, vi } from "vitest";

// The handshake is the one thing in this module worth testing, and it only
// touches Tauri through `invoke` and `listen` — so stub those and drive it with
// a recording terminal. `docs/delegate-session-replay.md` calls this ordering
// the load-bearing invariant of delegate replay; before the module existed it
// was a convention honoured by one of three consumers and tested by none.

const invoke = vi.fn();
const listen = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: (...args: unknown[]) => listen(...args) }));

const { attachDelegatePty, delegateSessionId, spawnDelegatePty } = await import("./delegatePty");

type Chunk = { sessionId: string; data: string; seq: number };

/** A terminal that records what it was told to write. */
function recorder() {
  const written: string[] = [];
  return {
    written,
    write(data: string, callback?: () => void) {
      if (data) written.push(data);
      // xterm parses FIFO and only then invokes the callback.
      callback?.();
    },
    text: () => written.join(""),
  };
}

/** Captures the `delegate-pty:data` handler so tests can deliver chunks. */
function wireListen() {
  let handler: ((e: { payload: Chunk }) => void) | null = null;
  const unlisten = vi.fn();
  listen.mockImplementation((_event: string, cb: (e: { payload: Chunk }) => void) => {
    handler = cb;
    return Promise.resolve(unlisten);
  });
  return {
    unlisten,
    emit(chunk: Chunk) {
      if (!handler) throw new Error("listener not registered");
      handler({ payload: chunk });
    },
    registered: () => handler !== null,
  };
}

/** Let the handshake's pending promises settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
});

describe("delegateSessionId", () => {
  it("composes the id Rust takes apart", () => {
    expect(delegateSessionId("run-7", "claude-code")).toBe("run-7:claude-code");
  });
});

describe("spawnDelegatePty parent identity", () => {
  it("does not register the panel's own conversation as its parent Run", async () => {
    for (const provider of ["opencode", "codex", "claude-code"]) {
      await spawnDelegatePty(delegateSessionId("conversation-1", provider), {
        provider, workspaceRoot: "/workspace", parentRunId: "conversation-1",
      });
      expect(invoke).toHaveBeenLastCalledWith("delegate_pty_spawn", expect.objectContaining({ parentRunId: null }));
    }
  });

  it("preserves a distinct parent for a real child Run", async () => {
    await spawnDelegatePty(delegateSessionId("child-1", "opencode"), {
      provider: "opencode", workspaceRoot: "/workspace", parentRunId: "parent-1",
    });
    expect(invoke).toHaveBeenLastCalledWith("delegate_pty_spawn", expect.objectContaining({ parentRunId: "parent-1" }));
  });
});

describe("attachDelegatePty", () => {
  it("paints the snapshot, then flushes only chunks past its seq", async () => {
    const bus = wireListen();
    const term = recorder();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "delegate_pty_snapshot") {
        return Promise.resolve({ data: "history\n", seq: 5, live: true });
      }
      return Promise.resolve(undefined);
    });

    const attachment = attachDelegatePty({ sessionId: "s:codex", term });

    // The listener must be registered before anything is requested — a chunk
    // arriving in that window is the one this ordering exists to save.
    expect(bus.registered()).toBe(true);
    bus.emit({ sessionId: "s:codex", data: "during\n", seq: 6 });
    // Already covered by the snapshot's high-water mark; must be dropped.
    bus.emit({ sessionId: "s:codex", data: "stale\n", seq: 3 });

    await settle();
    expect(term.text()).toBe("history\nduring\n");

    // Live chunks flow straight through once applied.
    bus.emit({ sessionId: "s:codex", data: "live\n", seq: 7 });
    expect(term.text()).toBe("history\nduring\nlive\n");
    attachment.dispose();
  });

  it("ignores chunks for other sessions", async () => {
    const bus = wireListen();
    const term = recorder();
    invoke.mockResolvedValue({ data: "", seq: 0, live: true });

    attachDelegatePty({ sessionId: "mine:codex", term });
    bus.emit({ sessionId: "theirs:codex", data: "not mine", seq: 1 });
    await settle();
    bus.emit({ sessionId: "theirs:codex", data: "still not", seq: 2 });

    expect(term.text()).toBe("");
  });

  it("gates input until the whole replay is parsed", async () => {
    const bus = wireListen();
    const term = recorder();
    invoke.mockResolvedValue({ data: "history", seq: 1, live: true });

    const attachment = attachDelegatePty({ sessionId: "s:codex", term });
    // Replayed history contains terminal queries the TUI sent on a previous
    // attach; xterm answers them while parsing, and forwarding those answers
    // types junk like "3R" into the agent's input.
    expect(attachment.isReplaying()).toBe(true);
    await settle();
    expect(attachment.isReplaying()).toBe(false);
    void bus;
  });

  it("spawns before snapshotting, and only when asked to", async () => {
    wireListen();
    const term = recorder();
    const calls: string[] = [];
    invoke.mockImplementation((cmd: string) => {
      calls.push(cmd);
      return Promise.resolve({ data: "", seq: 0, live: true });
    });

    attachDelegatePty({
      sessionId: "s:codex",
      term,
      spawn: { provider: "codex", workspaceRoot: "/repo" },
    });
    await settle();
    expect(calls).toEqual(["delegate_pty_spawn", "delegate_pty_snapshot"]);

    // Attach-only: looking at a session must never start a CLI as a side effect.
    calls.length = 0;
    attachDelegatePty({ sessionId: "s:codex", term });
    await settle();
    expect(calls).toEqual(["delegate_pty_snapshot"]);
  });

  it("reports failure and ungates input, so the terminal isn't dead to typing", async () => {
    wireListen();
    const term = recorder();
    invoke.mockRejectedValue(new Error("codex not on PATH"));
    const onError = vi.fn();

    const attachment = attachDelegatePty({ sessionId: "s:codex", term, onError });
    await settle();

    expect(onError).toHaveBeenCalledOnce();
    expect(attachment.isReplaying()).toBe(false);
  });

  it("drops a late snapshot after dispose instead of writing to a dead terminal", async () => {
    const bus = wireListen();
    const term = recorder();
    const deferred: { release: (v: unknown) => void } = { release: () => {} };
    invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          deferred.release = resolve;
        }),
    );

    const attachment = attachDelegatePty({ sessionId: "s:codex", term });
    await settle();
    // Unmount mid-flight — a panel switch during a slow snapshot.
    attachment.dispose();
    deferred.release({ data: "history", seq: 4, live: true });
    await settle();

    expect(term.text()).toBe("");
    expect(bus.unlisten).toHaveBeenCalled();
  });
});
