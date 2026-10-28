// TURN SUB-AGENTS — the Delegate's own sub-agents of the turn in hand, as rows.
//
// A skill that fans out (improve-codebase-architecture, three explorers at
// once) used to draw each sub-agent as a card in the conversation, and three
// cards pushed the answer off the screen. The conversation is the answer; the
// sub-agents are what it is waiting on, so they sit above the composer, the
// way a question or an approval does, and the conversation keeps one line of
// work for them like any other call.
//
// Pure: which calls, what each one's state reads as. The component draws it.

import type { AgentEvent, ObservedSubagentState } from "../../agent/types";
import { isObservedSubagent, liveWorkLine } from "./toolRuns";
import type { Msg } from "./types";

export type TrayStatus = ObservedSubagentState["status"] | "ended";

export type TraySubagent = {
  id: string;
  /** The Delegate that started it, e.g. `claude-code`. */
  provider: string;
  /** The sub-agent's type as the CLI named it (`Explore`). */
  kind: string;
  /** Its brief, one line. */
  task: string;
  status: TrayStatus;
  state?: ObservedSubagentState;
  /** The step in hand: the CLI's own words when it reports them (Claude
   *  Code's "Reading a.txt"), else the newest of its nested calls still open. */
  activity?: string;
  /** Its own steps, folded when a row is opened. */
  nested?: AgentEvent[];
};

/**
 * The sub-agents started since the person last sent something, oldest first.
 *
 * Where each one is comes from the CLI's own reports (`call.subagent`). A
 * conversation recorded before those were read has only the call's result,
 * which for a background sub-agent says it *launched*, not that it finished —
 * so with no live Run behind it, a sub-agent no report settled has `ended`,
 * and no word claims how.
 */
export function turnSubagents(msgs: Msg[], live: boolean): TraySubagent[] {
  let from = msgs.length;
  while (from > 0 && msgs[from - 1].role !== "user") from--;
  const results = new Map<string, string>();
  for (let i = from; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === "tool" && m.toolCallId) results.set(m.toolCallId, m.content);
  }
  const out: TraySubagent[] = [];
  for (let i = from; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== "assistant") continue;
    for (const call of m.toolCalls ?? []) {
      if (!call.id || !call.observedBy || !isObservedSubagent(call)) continue;
      const args = (call.args ?? {}) as Record<string, unknown>;
      // Claude Code names the type `subagent_type`, OpenCode `agent`,
      // Copilot `agent_type`.
      const named = [args.subagent_type, args.agent, args.agent_type].find((v): v is string => typeof v === "string" && !!v.trim());
      const kind = named?.trim() ?? "sub-agent";
      const brief = typeof args.description === "string" && args.description.trim() ? args.description : typeof args.prompt === "string" ? args.prompt : "";
      out.push({
        id: call.id,
        provider: call.observedBy,
        kind,
        task: brief.replace(/\s+/g, " ").trim(),
        status: statusOf(call.subagent, results.get(call.id), call.failed, live),
        state: call.subagent,
        activity: call.subagent?.activity ?? openStep(call.nested),
        nested: call.nested,
      });
    }
  }
  return out;
}

function openStep(nested: AgentEvent[] | undefined): string | undefined {
  const open = new Map<string, { name: string; args: unknown }>();
  for (const event of nested ?? []) {
    if (event.type === "observed_tool_call") open.set(event.toolCallId, { name: event.name, args: event.input });
    else if (event.type === "observed_tool_result") open.delete(event.toolCallId);
  }
  const last = [...open.values()].pop();
  return last ? liveWorkLine(last) : undefined;
}

/** What a background sub-agent's call returns the moment it launches —
 *  Claude Code's and Copilot's words. Not the sub-agent's report. */
const LAUNCH_RECEIPT = /^(Async agent launched|Agent started in background)/;

function statusOf(state: ObservedSubagentState | undefined, result: string | undefined, failed: boolean | undefined, live: boolean): TrayStatus {
  const settled = state && state.status !== "running" ? state.status : undefined;
  if (settled) return settled;
  // A CLI that reports no sub-agent lifecycle: its call returning with the
  // sub-agent's report is the finish (a background launch receipt is not).
  const reported = result !== undefined && !/^Running /.test(result) && !LAUNCH_RECEIPT.test(result);
  if (!state && reported) return failed ? "failed" : "completed";
  return live ? "running" : "ended";
}

/** "2 running · 1 done" — the tray's header, in the order a reader cares. */
export function traySummary(subagents: TraySubagent[]): string {
  const count = (pick: (s: TraySubagent) => boolean) => subagents.filter(pick).length;
  const parts: string[] = [];
  const running = count((s) => s.status === "running");
  const done = count((s) => s.status === "completed");
  const failed = count((s) => s.status === "failed");
  const stopped = count((s) => s.status === "stopped" || s.status === "ended");
  if (running) parts.push(`${running} running`);
  if (done) parts.push(`${done} done`);
  if (failed) parts.push(`${failed} failed`);
  if (stopped) parts.push(`${stopped} ended`);
  return parts.join(" · ");
}
