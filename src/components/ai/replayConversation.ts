// Rebuild an AI-panel Conversation from a Transcript on disk.
//
// The file used to be named `eventsToMsgs`, after its most trivial export — a
// three-line composition of `foldAgentEvents` + `foldedToMsgs`. The load-bearing
// part is `eventsToConversation`, which is not a parser at all: `foldEvents.ts`
// owns the wire format, and this is the *replay decoration* on top of it —
// which system lines a resumed panel needs in order to explain itself.
//
// That decoration has to agree with the live run path in AiPanel, and the rule
// they share is `IS_SILENT_RUN_ERROR`.

import type { AgentEvent } from "../../agent/types";
import { foldAgentEvents, foldedToMsgs } from "../../agent/foldEvents";
import type { RunMessage } from "../../runs";
import type { Conversation, Msg } from "./types";

/**
 * A user-initiated Stop is not a failure, so it gets no error line — the
 * partial output is the answer.
 *
 * Exported because the live path in AiPanel makes the same judgement, and the
 * two must agree: if replay surfaced an abort that the live view swallowed, the
 * same run would read as failed after a reload and fine before it.
 */
export const SILENT_RUN_ERROR_CODE = "aborted";

export function isSilentRunError(code: string): boolean {
  return code === SILENT_RUN_ERROR_CODE;
}

/**
 * The trailing "Run failed" line a replayed view needs to explain itself.
 *
 * A run that died (provider 500, proxy timeout, crash-loop quarantine) folds
 * to nothing — `foldEvents` renders work, and a failure produced none — so a
 * replay would end mid-thought and read as hung. Tail-only on purpose: an
 * error the conversation already moved past (a later turn was sent and
 * appended after it) is history, not the state of the thread, and pinning it
 * to the bottom would report a recovered conversation as failed.
 */
/**
 * True when the transcript's last turn was never answered: a `user_message`
 * with no `assistant_message`, `run_result` or `run_error` after it. The
 * Harness writes one of those on every exit it controls, so with no live run
 * in Rust this is a turn the app was closed on — the panel then appends
 * `interruptedMsg` where the answer would have been. Same rule as the fold's
 * `turnOpen`, which draws the line once a later turn exists.
 */
export function hasOpenTurn(events: AgentEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const type = events[i].type;
    if (type === "run_result" || type === "run_error" || type === "assistant_message") return false;
    if (type === "user_message" || type === "observer_completed") return true;
  }
  return false;
}

export function runErrorLine(events: AgentEvent[]): Msg | null {
  const last = events[events.length - 1];
  if (last?.type !== "run_error" || isSilentRunError(last.error.code)) return null;
  return {
    role: "system",
    content: `Run failed: ${last.error.message}`,
    runError: { message: last.error.message },
  };
}

type RunMeta = {
  mode: "chat" | "plan" | "goal";
  provider: string;
  model: string;
};

/** Run metadata from the `run_started` event, which is always first. */
function extractRunMeta(events: AgentEvent[]): RunMeta | null {
  const first = events[0];
  if (first?.type === "run_started") {
    return { mode: first.mode, provider: first.provider, model: first.model };
  }
  return null;
}

/** Convert a full Klide agent transcript into AiPanel-compatible messages. */
export function eventsToMsgs(events: AgentEvent[]): Msg[] {
  return foldedToMsgs(foldAgentEvents(events));
}

/**
 * The replay a live panel should adopt over what it currently shows.
 *
 * Two paths need this and must agree: the mount reconnect (`followConversationRun`)
 * and the post-turn heal that runs when a turn stopped reaching the screen.
 * Both add back the turns queued locally — a queued turn was typed ahead and
 * has not been sent, so the Transcript cannot know about it — and both refuse a
 * replay carrying *less conversation* than what is on screen, which is how a
 * half-written or truncated read is kept from eating live rows.
 *
 * Returns null when the replay has nothing to add.
 */
/**
 * How much conversation a view actually carries: the characters of what the
 * user and the model said.
 *
 * Deliberately not a row count, and deliberately blind to tool rows. A delegate
 * CLI reports the work it did on its own as `observed_tool_call` events that
 * stream on the live channel and are never written to the Transcript (see
 * `agent/mod.rs`), so a live delegate view always holds rows no replay of it can
 * ever contain. Counting rows therefore made that view permanently "longer" than
 * its own Transcript, and the guard below refused the one replay that held the
 * turn's answer: a reload mid-generation left the panel showing the sentence
 * fragments it had streamed, with the finished reply sitting on disk forever.
 *
 * Text still protects what the row count was there to protect. A truncated or
 * half-written read carries less of the exchange than the screen does and is
 * refused, and a turn still streaming is refused too — nothing is persisted
 * until it lands, so the partial on screen outweighs the replay until it does.
 */
function conversationWeight(msgs: Msg[]): number {
  return msgs.reduce(
    (total, msg) =>
      msg.role === "user" || msg.role === "assistant"
        ? total + msg.content.length
        : total,
    0,
  );
}

export function replayForAdoption(
  events: AgentEvent[],
  current: Msg[],
): Msg[] | null {
  const queuedLocal = current.filter(
    (m) => m.role === "user" && m.queueState === "queued",
  );
  // A run that ended in failure folds to no row at all, so without the error
  // line an adopted replay ends mid-work and reads as a hang or a crash —
  // which is exactly what a reattached panel showed when the provider timed
  // out while nobody was on the live channel.
  const errorLine = runErrorLine(events);
  const replayed = [
    ...eventsToMsgs(events),
    ...(errorLine ? [errorLine] : []),
    ...queuedLocal,
  ];
  return conversationWeight(replayed) >= conversationWeight(current) ? replayed : null;
}

/** Why a turn's view ended up short of its Run's Transcript. */
export type ViewBehindReason = "region-detached" | "generation-retired";

/**
 * Whether a settled turn should re-read its Transcript and adopt it.
 *
 * The decision is here, not in the panel, because getting it wrong is silent
 * both ways: heal when you shouldn't and a stale replay lands in whatever
 * conversation is on screen; don't heal when you should and the Run's answer
 * stays on disk while the thread looks like it ended on a tool call.
 *
 * Note what is deliberately NOT a condition: the turn generation still being
 * current. Generations are only ever bumped, so a turn whose events were
 * dropped *because* its generation was retired can never be current again — a
 * heal gated on that could not fire for the one case it was written for. The
 * condition that carries the weight is `stillOnConversation`: three of the four
 * generation bumps (leaving the thread, a new chat, resuming another) change
 * the conversation, and the fourth (Stop) does not — precisely because the user
 * is still looking at the turn that went dark.
 */
export function shouldHealFromTranscript(state: {
  behind: ViewBehindReason | null;
  /** The panel is still showing the conversation this turn belongs to. */
  stillOnConversation: boolean;
  /** A subagent turn is its own child Run: its events stream into this panel
   *  but land in the *child's* Transcript, so this conversation's Transcript is
   *  not the record of what was on screen. */
  subagent: boolean;
  /** A Delegate conversation outside Focus has no Transcript of its own. */
  delegateWithoutTranscript: boolean;
}): boolean {
  if (!state.behind || !state.stillOnConversation) return false;
  return !state.subagent && !state.delegateWithoutTranscript;
}

/** Reconstruct a Conversation from events for AiPanel resumption. */
export function eventsToConversation(
  events: AgentEvent[],
  runId: string,
  title: string,
): Conversation {
  const meta = extractRunMeta(events);
  const msgs = eventsToMsgs(events);

  if (meta) {
    msgs.unshift({
      role: "system",
      content: `Run: ${meta.mode} · ${meta.provider}/${meta.model}`,
    });
  }

  // A run that ended in failure (e.g. the provider returned a 500) has no
  // assistant turn to fold, so a resumed panel would otherwise show the user
  // message and nothing else — reading as an empty or hung run. Surface the
  // error as a trailing system line so the resumed view explains itself.
  // A user-initiated Stop is intentionally silent — same rule as the live run
  // path in AiPanel, shared as `isSilentRunError` so they cannot diverge.
  const errorLine = runErrorLine(events);
  if (errorLine) msgs.push(errorLine);

  // A transcript knows exactly when it started and when it last moved — take
  // both from the events rather than stamping "now" on a run that may have
  // finished days ago.
  const first = events[0];
  const last = events[events.length - 1];
  return {
    id: runId,
    title,
    msgs,
    updatedAt: typeof last?.ts === "number" ? last.ts : Date.now(),
    createdAt: typeof first?.ts === "number" ? first.ts : undefined,
  };
}

/**
 * A *delegate* run's transcript → panel messages.
 *
 * The other direction in this file replays Klide's own events; this one
 * replays what another CLI wrote about itself, and the rule is the same: show
 * the work, not a summary of it. A tool call arrives with the arguments it was
 * given, and its result — which the CLI recorded one message later — comes
 * back as its own row underneath, exactly as a live observed call folds. A
 * name on its own renders as a column of identical "Bash" rows.
 *
 * `observedBy` is the honest half. A delegate ran these itself, under its own
 * permission mode: no capability, no prompt, no diff review from Klide. The
 * rows say so, and must, or a reader — human, or a validation counter — takes
 * a delegate's Bash for a command Klide verified.
 */
export function runMessagesToMsgs(messages: RunMessage[], observedBy?: string): Msg[] {
  const out: Msg[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.text });
      continue;
    }
    const tools = (m.tools ?? []).filter((t) => Boolean(t.name));
    out.push({
      role: "assistant",
      content: m.text,
      ...(tools.length > 0
        ? {
            toolCalls: tools.map((t) => ({
              id: t.id,
              name: t.name,
              // The row derives its own one-line label from these. The
              // transcript carries arguments, never a rendered string.
              args: t.input,
            })),
          }
        : {}),
    });
    for (const t of tools) {
      if (!t.result) continue;
      out.push({
        role: "tool",
        content: t.ok === false ? `Error: ${t.result}` : t.result,
        toolName: t.name,
        ...(t.id ? { toolCallId: t.id } : {}),
        ...(observedBy ? { observedBy } : {}),
      });
    }
  }
  return out;
}
