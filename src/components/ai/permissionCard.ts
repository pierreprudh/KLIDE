// PERMISSION CARD — one permission request → the card a conversation draws.
//
// The Harness pauses and emits a request — a shell command, a network target,
// a message from another agent, a worker dispatch, a connector tool — and the
// user answers before it runs. The request's `input` is the one genuinely
// open field on the wire (the command gate sends {command, cwd, externalPaths,
// matchedAllowRule}, a network capability sends whatever it declared), so
// this is where that shape is read, once. Shared by the panel's own gate, by
// transcript recovery and by a child Run's prompt drawn under its dispatch
// row, so an approval looks the same wherever it is answered.

import type { PermissionRequest, ProviderId } from "../../agent/types";
import type { CommandInterpreter } from "../InlineCommandReview";
import { peerName, type PeerIndex } from "./coordinationPeers";

export type PermissionCardKind = "command" | "network" | "message" | "worker" | "connector";

export type PermissionCard = {
  runId: string;
  requestId: string;
  toolName: string;
  kind: PermissionCardKind;
  connector?: string;
  command: string;
  peer?: string;
  worker?: ProviderId;
  envelopeId?: string;
  summary: string;
  reason: string;
  externalPaths: string[];
  interpreter?: CommandInterpreter;
  suggestedPattern?: string;
};

/** `git log --oneline -5` → `git log *`: the wildcard rule a project approval
 *  may be widened to. Stops at the first shell operator so `a && b` never
 *  suggests a pattern covering `b`. */
export function suggestCommandPattern(command: string): string | undefined {
  const words = (command.match(/"[^"]+"|'[^']+'|\S+/g) ?? [])
    .map((word) => word.replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  const stop = words.findIndex((word) => word === "&&" || word === "||" || word === ";" || word === "|");
  const head = (stop >= 0 ? words.slice(0, stop) : words).filter(Boolean);
  if (head.length < 2) return undefined;
  const keep = head[0] === "npm" && head[1] === "run" && head[2] ? 3 : 2;
  return `${head.slice(0, keep).join(" ")} *`;
}

const NO_PEERS: PeerIndex = new Map();

export function permissionCard(runId: string, req: PermissionRequest, peerIndex: PeerIndex = NO_PEERS): PermissionCard {
  // Everything but `input` is typed, and the Rust
  // `frontend_mirror_matches_agent_wire` test keeps it that way.
  const input = (req.input ?? {}) as { command?: string; externalPaths?: string[]; interpreter?: CommandInterpreter | null; fromRunId?: string; envelopeId?: string; body?: string; worker?: string; workerLabel?: string; subagent?: string; task?: string; branch?: string; connector?: string; connectorLabel?: string; tool?: string };
  const isCommand = !!input.command;
  // An incoming-message gate carries the sender and the text; the card shows
  // the text where the command would be and names the peer as the chat does.
  const isMessage = !isCommand && !!input.fromRunId;
  // A worker dispatch carries the Delegate and the role; the card shows the
  // task where the command would be, with "Claude Code · implementer →" in
  // front of it, and the branch the worker will edit on as its detail.
  const isWorker = !isCommand && !isMessage && !!input.worker;
  // A connector tool shows its mark and the tool it would run — the card's
  // command line is `add_issue_comment`, not a network target.
  const isConnector = !isCommand && !isMessage && !isWorker && !!input.connector && !!input.tool;
  const command = input.command
    ?? (isMessage ? input.body ?? "" : undefined)
    ?? (isWorker ? input.task ?? "" : undefined)
    ?? (isConnector ? input.tool : undefined)
    ?? req.summary ?? req.toolName ?? "permission request";
  return {
    runId,
    requestId: req.id,
    toolName: req.toolName ?? "permission",
    kind: isCommand ? "command" : isMessage ? "message" : isWorker ? "worker" : isConnector ? "connector" : "network",
    connector: isConnector ? input.connector : undefined,
    command,
    peer: isMessage ? peerName(input.fromRunId!, peerIndex)
      : isWorker ? `${input.workerLabel ?? input.worker} ${input.subagent ?? "worker"}`
        : isConnector ? input.connectorLabel ?? input.connector
          : undefined,
    worker: isWorker ? (input.worker as ProviderId) : undefined,
    envelopeId: isMessage ? input.envelopeId : undefined,
    summary: req.summary ?? command,
    reason: req.reason ?? "",
    externalPaths: Array.isArray(input.externalPaths) ? input.externalPaths : [],
    interpreter: isCommand ? input.interpreter ?? undefined : undefined,
    suggestedPattern: isCommand ? suggestCommandPattern(command) : undefined,
  };
}
