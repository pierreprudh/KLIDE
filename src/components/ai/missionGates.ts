// missionGates — what a Mission's running attempts are waiting on, answered
// from the conversation that planned them.
//
// A Mission worker is a headless Rust Run: its diff reviews and command
// approvals are raised as events on `agent-run:{id}` with nobody attached.
// This hook attaches to every running attempt the bundle names (transcript
// first, then the live stream — the same two-phase reattach the console
// does), folds the gates with `pendingGatesFromEvents` so an answer given
// elsewhere clears the card here too, and answers through the same Rust
// commands the panel uses. Nothing here decides anything on its own.
import { useEffect, useRef, useState } from "react";
import { readAgentRunEvents, reattachAgentRun, resolveDiff, resolvePermission, resolveUserQuestion } from "../../agent/client";
import { pendingGatesFromEvents } from "../../agent/pendingGates";
import type { AgentEvent, DiffProposal, PermissionRequest } from "../../agent/types";

export type MissionGate =
  | { kind: "question"; taskId: string; question: NonNullable<ReturnType<typeof pendingGatesFromEvents>["question"]> }
  | { kind: "permission"; taskId: string; request: PermissionRequest }
  | { kind: "diff"; taskId: string; proposal: DiffProposal };

/** `attempts` is the running attempts to follow: task id → run id. */
export function useMissionGates(attempts: ReadonlyArray<{ taskId: string; runId: string }>) {
  const [gates, setGates] = useState<Record<string, MissionGate | null>>({});
  const events = useRef(new Map<string, AgentEvent[]>());
  const attached = useRef(new Map<string, () => void>());
  const key = attempts.map((a) => `${a.taskId}:${a.runId}`).join("|");

  useEffect(() => {
    const wanted = new Map(attempts.map((a) => [a.runId, a.taskId]));
    // Drop what is no longer running.
    for (const [runId, detach] of attached.current) {
      if (!wanted.has(runId)) {
        detach();
        attached.current.delete(runId);
        events.current.delete(runId);
        setGates((current) => {
          const next = { ...current };
          delete next[runId];
          return next;
        });
      }
    }
    for (const [runId, taskId] of wanted) {
      if (attached.current.has(runId)) continue;
      let ownDetach = () => {};
      attached.current.set(runId, ownDetach); // claimed; replaced once attached
      const fold = () => {
        if (attached.current.get(runId) !== ownDetach) return;
        const pending = pendingGatesFromEvents(events.current.get(runId) ?? []);
        const gate: MissionGate | null = pending.permission
          ? { kind: "permission", taskId, request: pending.permission }
          : pending.diff
            ? { kind: "diff", taskId, proposal: pending.diff }
            : pending.question
              ? { kind: "question", taskId, question: pending.question }
              : null;
        setGates((current) => ({ ...current, [runId]: gate }));
      };
      void (async () => {
        const buffered: Array<{ event: AgentEvent; seq: number }> = [];
        let snapshotLength: number | null = null;
        try {
          const reattachment = await reattachAgentRun(runId, 0, (event, seq) => {
            if (snapshotLength === null) buffered.push({ event, seq });
            else if (seq >= snapshotLength) {
              events.current.get(runId)?.push(event);
              fold();
            }
          });
          if (attached.current.get(runId) !== ownDetach) {
            reattachment.detach();
            return;
          }
          ownDetach = reattachment.detach;
          attached.current.set(runId, ownDetach);
          const snapshot = await readAgentRunEvents(runId);
          if (attached.current.get(runId) !== ownDetach) return;
          snapshotLength = snapshot.length;
          events.current.set(runId, [...snapshot, ...buffered.filter(({ seq }) => seq >= snapshot.length).map(({ event }) => event)]);
          fold();
        } catch {
          if (attached.current.get(runId) === ownDetach) { ownDetach(); attached.current.delete(runId); }
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => () => {
    attached.current.forEach((detach) => detach());
    attached.current.clear();
  }, []);

  const open = Object.values(gates).filter((gate): gate is MissionGate => gate !== null);

  async function answerPermission(gate: Extract<MissionGate, { kind: "permission" }>, allow: boolean, scope: "once" | "run" | "project" = "once") {
    await resolvePermission({
      runId: gate.request.runId,
      requestId: gate.request.id,
      decision: allow ? { behavior: "allow", scope } : { behavior: "deny" },
    });
  }
  async function answerDiff(gate: Extract<MissionGate, { kind: "diff" }>, apply: boolean) {
    await resolveDiff({
      runId: gate.proposal.runId,
      proposalId: gate.proposal.id,
      decision: apply ? { behavior: "apply" } : { behavior: "reject" },
    });
  }

  return { gates: open, answerPermission, answerDiff, answerQuestion: async (gate: Extract<MissionGate, { kind: "question" }>, answer: string) => {
    await resolveUserQuestion({ runId: gate.question.runId, requestId: gate.question.requestId, answer });
  } };
}
