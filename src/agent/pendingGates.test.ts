import { describe, expect, it } from "vitest";
import { pendingGatesFromEvents } from "./pendingGates";
import type { AgentEvent, DiffProposal, PermissionRequest } from "./types";

const RUN = "run-1";

function permissionRequest(id: string, command: string): PermissionRequest {
  return {
    id,
    runId: RUN,
    toolCallId: `call-${id}`,
    toolName: "run_command",
    input: { command, cwd: "/workspace", externalPaths: [], matchedAllowRule: null },
    summary: `$ ${command}`,
    reason: "The agent wants to run a shell command in the workspace.",
    options: [],
  } as unknown as PermissionRequest;
}

function diffProposal(id: string): DiffProposal {
  return {
    id,
    runId: RUN,
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
const asked = (id: string, command = "git log") =>
  ({ type: "permission_requested", runId: RUN, request: permissionRequest(id, command), ts }) as AgentEvent;
const answered = (requestId: string) =>
  ({ type: "permission_resolved", runId: RUN, requestId, decision: "allow_once", ts }) as unknown as AgentEvent;
const proposed = (id: string) =>
  ({ type: "diff_proposed", runId: RUN, proposal: diffProposal(id), ts }) as AgentEvent;
const resolved = (proposalId: string) =>
  ({ type: "diff_resolved", runId: RUN, proposalId, decision: "approve", ts }) as unknown as AgentEvent;
const questioned = (requestId: string) =>
  ({ type: "user_question_requested", runId: RUN, requestId, question: "Which port?", ts }) as AgentEvent;
const finished = () =>
  ({ type: "run_result", runId: RUN, result: {}, ts }) as unknown as AgentEvent;

describe("pendingGatesFromEvents", () => {
  it("finds nothing to answer in an empty transcript", () => {
    expect(pendingGatesFromEvents([])).toEqual({
      permission: null,
      diff: null,
      question: null,
    });
  });

  it("recovers the approval a parked run is waiting on", () => {
    // The exact shape of the run that looked stuck: the request is the last
    // line of the transcript and nothing answered it.
    const gates = pendingGatesFromEvents([asked("perm-1", "git log --graph")]);
    expect(gates.permission?.id).toBe("perm-1");
    expect(gates.permission?.summary).toBe("$ git log --graph");
  });

  it("forgets a request once it has been answered", () => {
    expect(pendingGatesFromEvents([asked("perm-1"), answered("perm-1")]).permission).toBeNull();
  });

  it("keeps the live request when an unrelated one is resolved", () => {
    // The harness can resolve a request the panel has already moved past — a
    // subagent's, or one abandoned by a retry. Clearing on any resolution would
    // drop the card the run is actually waiting on.
    const gates = pendingGatesFromEvents([asked("perm-2"), answered("perm-1")]);
    expect(gates.permission?.id).toBe("perm-2");
  });

  it("recovers a diff and a question the same way", () => {
    const gates = pendingGatesFromEvents([proposed("diff-1"), questioned("q-1")]);
    expect(gates.diff?.id).toBe("diff-1");
    expect(gates.question).toEqual({ runId: RUN, requestId: "q-1", question: "Which port?" });
  });

  it("restores a worker's choice question and clears only its matching answer", () => {
    const request: AgentEvent = { type: "user_question_requested", runId: RUN, requestId: "choice-1", question: "Which worker?", choices: { options: ["codex", "claude-code"], kind: "dispatch", preselected: "codex", preselectedModel: "default" }, ts };
    const unrelated: AgentEvent = { type: "user_question_resolved", runId: RUN, requestId: "other", answer: "skip", ts };
    expect(pendingGatesFromEvents([request, unrelated]).question?.choices).toEqual(request.choices);
    expect(pendingGatesFromEvents([request, { ...unrelated, requestId: "choice-1" }]).question).toBeNull();
  });

  it("clears a diff when its own proposal is resolved", () => {
    expect(pendingGatesFromEvents([proposed("diff-1"), resolved("diff-1")]).diff).toBeNull();
    expect(pendingGatesFromEvents([proposed("diff-2"), resolved("diff-1")]).diff?.id).toBe("diff-2");
  });

  it("answers nothing for a run that has finished", () => {
    // A terminal event ends every gate, whatever the last request said —
    // otherwise a settled run would reopen a card nobody can answer.
    expect(pendingGatesFromEvents([asked("perm-1"), proposed("diff-1"), finished()])).toEqual({
      permission: null,
      diff: null,
      question: null,
    });
  });

  it("keeps only the newest request when the run asks twice", () => {
    const gates = pendingGatesFromEvents([asked("perm-1"), asked("perm-2")]);
    expect(gates.permission?.id).toBe("perm-2");
  });
});
