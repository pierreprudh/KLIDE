import { describe, expect, it } from "vitest";
import type { KlideConvo } from "./klideConvos";
import type { RunLedgerEntry } from "./runLedger";
import { resolveRunInspection } from "./runInspection";
import type { TaskSession } from "./tasks";

function entry(
  id: string,
  origin: RunLedgerEntry["origin"],
  updatedMs = 1,
  forkedFrom: RunLedgerEntry["forkedFrom"] = null,
): RunLedgerEntry {
  return {
    id,
    path: "",
    source: "klide",
    kind: "run",
    title: id,
    status: "done",
    lifecycle: "done",
    model: null,
    project: "KIDE",
    cwd: "/workspace/KIDE",
    branch: null,
    forkedFrom,
    messageCount: 1,
    updatedMs,
    createdMs: updatedMs,
    origin,
    archived: false,
    originalTitle: id,
    capabilities: {
      canRename: true,
      canResume: true,
      canOpenTerminal: false,
      canOpenInOtherAgent: true,
      canReviewDiff: true,
      canSaveMemory: true,
      canFork: true,
      canArchive: true,
      canExportTranscript: true,
      canExportEvidence: true,
    },
  };
}

function conversation(id: string, cwd = "/workspace/KIDE"): KlideConvo {
  return {
    id,
    title: id,
    status: "running",
    model: "test-model",
    cwd,
    branch: null,
    messages: [{ role: "user", text: "test" }],
    updatedMs: 1,
  };
}

const baseInput = {
  selectedId: "run-1",
  tasks: [] as TaskSession[],
  conversations: [] as KlideConvo[],
  entries: [] as RunLedgerEntry[],
  workspaceRoot: "/workspace/KIDE",
};

describe("resolveRunInspection", () => {
  it("prefers a task when stores temporarily share an id", () => {
    const task: TaskSession = {
      id: "run-1",
      title: "Task",
      source: null,
      model: null,
      status: "queued",
      cwd: "/workspace/KIDE",
      startedMs: 1,
    };

    expect(
      resolveRunInspection({
        ...baseInput,
        tasks: [task],
        entries: [entry("run-1", "transcript")],
      }),
    ).toEqual({ kind: "task", task });
  });

  it("uses the durable transcript once it lands instead of stale live messages", () => {
    const durable = entry("run-1", "transcript");
    const inspection = resolveRunInspection({
      ...baseInput,
      conversations: [conversation("run-1")],
      entries: [durable],
    });

    expect(inspection).toMatchObject({
      kind: "run",
      run: durable,
      liveConversation: null,
    });
  });

  it("uses the live conversation before a transcript exists", () => {
    const live = conversation("run-1");
    const liveEntry = entry("run-1", "klide-convo");
    const inspection = resolveRunInspection({
      ...baseInput,
      conversations: [live],
      entries: [liveEntry],
    });

    expect(inspection).toMatchObject({
      kind: "run",
      run: liveEntry,
      liveConversation: live,
    });
  });

  it("does not inspect a live conversation from another workspace", () => {
    expect(
      resolveRunInspection({
        ...baseInput,
        conversations: [conversation("run-1", "/workspace/Other")],
        entries: [entry("run-1", "klide-convo")],
      }),
    ).toBeNull();
  });

  it("resolves and orders fork lineage around the selected run", () => {
    const parent = entry("parent", "transcript");
    const selected = entry("run-1", "transcript", 5, {
      conversationId: "parent",
      title: "Parent",
      messageIndex: 1,
      createdAt: 1,
      mode: "chat",
    });
    const olderChild = entry("child-a", "transcript", 10, {
      conversationId: "run-1",
      title: "Selected",
      messageIndex: 1,
      createdAt: 2,
      mode: "chat",
    });
    const newerChild = entry("child-b", "transcript", 20, {
      conversationId: "run-1",
      title: "Selected",
      messageIndex: 2,
      createdAt: 3,
      mode: "worktree",
    });

    const inspection = resolveRunInspection({
      ...baseInput,
      entries: [olderChild, selected, parent, newerChild],
    });

    expect(inspection?.kind).toBe("run");
    if (!inspection || inspection.kind !== "run") return;
    expect(inspection.lineage.parent?.id).toBe("parent");
    expect(inspection.lineage.children.map((child) => child.id)).toEqual([
      "child-b",
      "child-a",
    ]);
  });
});
