import { describe, expect, it } from "vitest";
import type { Msg } from "./types";
import type { CoordinationEnvelopeSnapshot, CoordinationSnapshot } from "../../agent/coordination";
import {
  coordinationPeersOf,
  inboxSenders,
  latestCoordinationPeer,
  parseDeliveryReason,
  peerName,
  pendingInboxFor,
  shortRunId,
  workerChildrenOf,
} from "./coordinationPeers";

describe("workerChildrenOf", () => {
  it("maps each worker child's Run id to the Delegate the spawn call named", () => {
    const msgs: Msg[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_1", name: "spawn_subagent", args: { subagent: "implementer", worker: "claude-code", task: "Add slugify" } },
          { id: "call_2", name: "spawn_subagent", args: { subagent: "explorer", task: "Map the repo" } },
          { id: "call_3", name: "run_command", args: { command: "claude -p hi" } },
        ],
      } as Msg,
      { role: "assistant", content: "", toolCalls: [{ id: "call_4", name: "spawn_subagent", args: { subagent: "tester", worker: "codex", task: "Test it" } }] } as Msg,
    ];
    const workers = workerChildrenOf(msgs, "run_kit");
    expect([...workers.entries()]).toEqual([
      ["sub_run_kit_call_1", { provider: "claude-code", model: null }],
      ["sub_run_kit_call_4", { provider: "codex", model: null }],
    ]);
  });

  it("carries the model the card decided, and treats a CLI's default as none", () => {
    const msgs: Msg[] = [
      { role: "assistant", content: "", toolCalls: [
        { id: "c1", name: "spawn_subagent", args: { subagent: "tester", worker: "anthropic", model: "claude-sonnet-5" } },
        { id: "c2", name: "spawn_subagent", args: { subagent: "tester", worker: "codex", model: "default" } },
      ] } as Msg,
    ];
    const workers = workerChildrenOf(msgs, "run_kit");
    expect(workers.get("sub_run_kit_c1")).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
    expect(workers.get("sub_run_kit_c2")).toEqual({ provider: "codex", model: null });
  });

  it("knows nothing about a conversation that never dispatched a worker", () => {
    expect(workerChildrenOf([{ role: "user", content: "hi" } as Msg], "run_kit").size).toBe(0);
  });
});

describe("parseDeliveryReason", () => {
  it("reads the harness's one-line delivery record, singular and plural", () => {
    expect(parseDeliveryReason("Agent message delivered: question from @run_parent (env_1)")).toEqual([
      { kind: "question", from: "run_parent", envelopeId: "env_1" },
    ]);
    expect(
      parseDeliveryReason(
        "Agent messages delivered: instruction from operator (env_2); answer from @run_child (env_3)",
      ),
    ).toEqual([
      { kind: "instruction", from: "operator", envelopeId: "env_2" },
      { kind: "answer", from: "run_child", envelopeId: "env_3" },
    ]);
  });

  it("leaves every other steering line alone", () => {
    expect(parseDeliveryReason("Loop detected — `read_file` called 3×")).toBeNull();
    expect(parseDeliveryReason("Agent message delivered: garbage")).toBeNull();
  });
});

describe("peer names", () => {
  it("uses the thread title when the Run is a stored conversation", () => {
    const titles = new Map([["run_parent", { title: "Fix the parser before the release", provider: null, model: null }]]);
    expect(peerName("run_parent", titles)).toBe("Fix the parser before the release");
    expect(peerName("operator", titles)).toBe("operator");
  });

  it("falls back to a shortened id for Runs without a thread", () => {
    const id = "c3f2a9d0-1234-4567-89ab-0123456789ab";
    expect(peerName(id, new Map())).toBe(shortRunId(id));
    expect(shortRunId(id)).toBe("c3f2a9d0…6789ab");
    expect(shortRunId("run_child")).toBe("run_child");
  });
});

describe("coordinationPeersOf", () => {
  it("collects who this conversation spoke with, on both sides, once each", () => {
    const msgs: Msg[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { name: "agent_list", args: {} },
          { name: "agent_send", args: { toRunId: "run_b", body: "Hi" } },
          { name: "read_file", args: { path: "x" } },
        ],
      },
      { role: "system", content: "", steering: { reason: "Agent message delivered: answer from @run_b (env_9)" } },
      { role: "system", content: "", steering: { reason: "Agent message delivered: instruction from operator (env_10)" } },
      { role: "assistant", content: "", toolCalls: [{ name: "agent_wait", args: { fromRunId: "run_c" } }] },
    ];
    expect(coordinationPeersOf(msgs)).toEqual(["run_b", "run_c"]);
  });
});

describe("pendingInboxFor", () => {
  const entry = (
    id: string,
    from: string,
    to: string,
    deliveryState: CoordinationEnvelopeSnapshot["deliveryState"],
    createdAtMs: number,
  ): CoordinationEnvelopeSnapshot => ({
    envelope: { id, from: { type: "run", runId: from }, toRunId: to, kind: "question", body: "ping", sourceRefs: [], createdAtMs },
    deliveryState,
  });
  const snapshot = {
    envelopes: [
      entry("env_3", "run_a", "run_b", "queued", 30),
      entry("env_1", "run_c", "run_b", "delivered", 10),
      entry("env_2", "run_a", "run_b", "acknowledged", 20),
      entry("env_4", "run_b", "run_a", "queued", 40),
    ],
  } as unknown as CoordinationSnapshot;

  it("keeps what this Run has not taken in yet, oldest first, and nothing addressed elsewhere", () => {
    expect(pendingInboxFor(snapshot, "run_b").map((e) => e.envelope.id)).toEqual(["env_1", "env_3"]);
  });

  it("names the senders once each, in first-seen order", () => {
    expect(inboxSenders(pendingInboxFor(snapshot, "run_b"))).toEqual(["run_c", "run_a"]);
  });
});

describe("latestCoordinationPeer", () => {
  it("names the peer dealt with last, not first", () => {
    const msgs: Msg[] = [
      { role: "assistant", content: "", toolCalls: [{ name: "agent_send", args: { toRunId: "run_self", body: "ping" } }] },
      { role: "system", content: "", steering: { reason: "Agent message delivered: answer from @run_b (env_9)" } },
      { role: "assistant", content: "", toolCalls: [{ name: "agent_send", args: { toRunId: "run_b", body: "thanks" } }] },
    ];
    expect(latestCoordinationPeer(msgs)).toBe("run_b");
    expect(latestCoordinationPeer([])).toBeNull();
  });
});
