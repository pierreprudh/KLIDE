// The turn driver — the streaming state machine for one agent turn.
//
// It owns everything the transcript needs while a run streams: the ~20 fps
// delta batch (one setState per token froze the list), the per-turn timing
// that feeds TTFT / tok·s meta, the mutable assistant-index cursor that
// walks past tool cards, and the flush-before-finalize ordering. AiPanel's
// handleEvent forwards the four transcript events here and keeps everything
// that is genuinely panel behaviour (diffs, permissions, questions,
// subagents, run settle) to itself.
//
// Framework-free on purpose: reads through `read`, writes through `commit`,
// and takes an injectable clock + timer so fixture tests can drive a whole
// streamed turn without React, Tauri, or real time.

import type { AgentEvent } from "../../agent/types";
import {
  appendDelta,
  finalizeAssistantMessage,
  finishToolCall,
  insertSteering,
  locateAssistant,
  startToolCall,
  type Pricing,
  type TranscriptDelegate,
} from "./transcriptReducer";
import type { Msg } from "./types";

type AssistantMessageEvent = Extract<AgentEvent, { type: "assistant_message" }>;

export type TurnDriverOptions = {
  /** Index of the assistant bubble this turn streams into. */
  assistantIndex: number;
  delegate: TranscriptDelegate;
  pricing: Pricing;
  /** Single source of truth for the transcript (the panel's msgsRef). */
  read: () => Msg[];
  /** Publish a new transcript array (the panel's ref-write + setState). */
  commit: (next: Msg[]) => void;
  /** Context-gauge feedback from a finalized assistant message. */
  onMeasuredPromptTokens?: (tokens: number) => void;
  onMeasuredUsage?: (usage: { prompt: number; completion: number }) => void;
  /** Injectable clock/timer — tests pass fakes; the panel omits them. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Delta batching interval; ~20 fps by default. */
  flushDelayMs?: number;
};

export type TurnDriver = {
  /** Feed one AgentEvent. Returns true when it was a transcript event the
   *  driver consumed; the caller handles everything else. */
  handleEvent(event: AgentEvent): boolean;
  /** Locate (or insert) the turn's assistant bubble — the error path uses
   *  this to replace the bubble with a failure message. */
  ensureAssistant(): { msgs: Msg[]; index: number };
  /** Run settled (done or errored): cancel the batch timer and render any
   *  delta that was still pending. Idempotent. */
  finish(): void;
};

export function createTurnDriver(opts: TurnDriverOptions): TurnDriver {
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const flushDelayMs = opts.flushDelayMs ?? 50;

  // The mutable turn cursor: where the current assistant bubble lives. Tool
  // cards splice in above it; locateAssistant walks the cursor past them.
  let nextAssistantIdx = opts.assistantIndex;
  // Wall-clock start of the current turn, for the per-message meta footer.
  // Reset after each assistant_message so multi-turn runs time each turn.
  let turnStartedAt = now();
  // First streamed token of the current turn → TTFT.
  let firstTokenAt: number | null = null;
  // Throttled delta buffer — one commit per interval, not per token.
  let pendingDelta = { content: "", thinking: "" };
  let flushTimer: unknown = null;

  const ensureAssistant = () => {
    const located = locateAssistant(opts.read(), nextAssistantIdx, opts.delegate);
    nextAssistantIdx = located.index;
    return located;
  };

  const appendPendingDelta = (c: string, t: string) => {
    const { msgs: next, index } = appendDelta(opts.read(), nextAssistantIdx, c, t, opts.delegate);
    nextAssistantIdx = index;
    opts.commit(next);
  };

  const flushNow = () => {
    const c = pendingDelta.content;
    const t = pendingDelta.thinking;
    pendingDelta = { content: "", thinking: "" };
    if (c || t) appendPendingDelta(c, t);
  };

  const scheduleFlush = () => {
    if (flushTimer !== null) return;
    flushTimer = setTimer(() => {
      flushTimer = null;
      flushNow();
    }, flushDelayMs);
  };

  const cancelFlush = () => {
    if (flushTimer !== null) {
      clearTimer(flushTimer);
      flushTimer = null;
    }
  };

  const handleEvent = (event: AgentEvent): boolean => {
    switch (event.type) {
      case "assistant_delta": {
        if (firstTokenAt === null) firstTokenAt = now();
        pendingDelta.content += event.text;
        pendingDelta.thinking += event.thinking ?? "";
        scheduleFlush();
        return true;
      }
      case "assistant_message": {
        // Flush any pending delta before finalising, in order.
        cancelFlush();
        flushNow();
        const at = now();
        const result = finalizeAssistantMessage({
          msgs: opts.read(),
          nextAssistantIdx,
          event: event as AssistantMessageEvent,
          timing: { turnStartedAt, firstTokenAt },
          now: at,
          pricing: opts.pricing,
          delegate: opts.delegate,
        });
        // Reset per-turn timing so multi-turn runs time each turn.
        turnStartedAt = at;
        firstTokenAt = null;
        nextAssistantIdx = result.index;
        if (result.measuredPromptTokens !== undefined) opts.onMeasuredPromptTokens?.(result.measuredPromptTokens);
        if (result.measuredUsage !== undefined) opts.onMeasuredUsage?.(result.measuredUsage);
        opts.commit(result.msgs);
        return true;
      }
      case "tool_call_started": {
        const { msgs: next, index } = startToolCall(opts.read(), nextAssistantIdx, event.name, event.toolCallId);
        nextAssistantIdx = index;
        opts.commit(next);
        return true;
      }
      case "tool_call_finished": {
        opts.commit(finishToolCall(opts.read(), event.toolCallId, event.result.content));
        return true;
      }
      case "steering_injected": {
        // The loop monitor nudged the run. Splice a slim marker after this
        // turn's tool cards and advance the cursor past it so the next
        // assistant bubble lands below.
        const { msgs: next, index } = insertSteering(opts.read(), nextAssistantIdx, event.reason);
        nextAssistantIdx = index;
        opts.commit(next);
        return true;
      }
      default:
        return false;
    }
  };

  return {
    handleEvent,
    ensureAssistant,
    finish() {
      cancelFlush();
      flushNow();
    },
  };
}
