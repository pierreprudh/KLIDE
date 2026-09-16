// The turn driver — the streaming state machine for one agent turn.
//
// It owns everything the transcript needs while a run streams that the fold
// cannot know from the events alone: the ~20 fps delta batch (one setState per
// token froze the list), the per-turn wall clock that feeds the `ms` / TTFT
// footer, and the flush-before-finalize ordering. The event → row logic
// itself is the one fold in `src/agent/foldEvents.ts`, reached through the
// run-transcript shell in `transcriptReducer.ts`; AiPanel's handleEvent
// forwards the transcript events here and keeps everything that is genuinely
// panel behaviour (diffs, permissions, questions, subagents, run settle) to
// itself.
//
// Framework-free on purpose: reads through `read`, writes through `commit`,
// and takes an injectable clock + timer so fixture tests can drive a whole
// streamed turn without React, Tauri, or real time.

import type { AgentEvent } from "../../agent/types";
import {
  createRunTranscript,
  type Pricing,
  type TranscriptDelegate,
} from "./transcriptReducer";
import type { Msg } from "./types";
import { PACE_TICK_MS, paceCount, takeWords } from "./streamPacer";

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
  /** The window the turn actually ran in, when the provider sizes one per
   *  request (Ollama). The gauge divides by it. */
  onMeasuredContextWindow?: (tokens: number) => void;
  /** The run's region was edited from outside and the transcript stopped
   *  writing — see `RunTranscript.isDetached`. Everything after this point
   *  reaches disk and not the screen. */
  onDetached?: () => void;
  /** Injectable clock/timer — tests pass fakes; the panel omits them. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Delta batching interval; ~20 fps by default. */
  flushDelayMs?: number;
  /** Release streamed text word by word on a steady tick (see
   *  `streamPacer.ts`) instead of in the bursts it arrives in. On by default;
   *  tests of the raw batch path turn it off. */
  pace?: boolean;
  paceTickMs?: number;
};

export type TurnDriver = {
  /** Feed one AgentEvent. Returns true when it was a transcript event the
   *  driver consumed; the caller handles everything else. */
  handleEvent(event: AgentEvent): boolean;
  /** Locate the turn's assistant bubble — the error path uses this to
   *  replace the bubble with a failure message. */
  ensureAssistant(): { msgs: Msg[]; index: number };
  /** Run settled (done or errored): cancel the batch timer and render any
   *  delta that was still pending. Idempotent. */
  finish(): void;
  /** True when this turn stopped reaching the screen partway through. The
   *  panel heals from the Transcript instead of leaving the answer on disk. */
  isDetached(): boolean;
};

export function createTurnDriver(opts: TurnDriverOptions): TurnDriver {
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const flushDelayMs = opts.flushDelayMs ?? 50;
  const pace = opts.pace ?? true;
  const paceTickMs = opts.paceTickMs ?? PACE_TICK_MS;

  // Adopt the placeholder bubble the panel pre-inserted at assistantIndex, so
  // the stream writes into it instead of duplicating it.
  const seedCandidate = opts.read()[opts.assistantIndex];
  const transcript = createRunTranscript({
    regionStart: opts.assistantIndex,
    seed: seedCandidate?.role === "assistant" ? seedCandidate : null,
    delegate: opts.delegate,
    pricing: opts.pricing,
    onDetached: opts.onDetached,
  });

  // Wall-clock start of the current turn, for the per-message meta footer.
  // Reset after each assistant_message so multi-turn runs time each turn.
  let turnStartedAt = now();
  // First streamed token of the current turn → the TTFT fallback for turns
  // the harness recorded no timing on.
  let firstTokenAt: number | null = null;
  let flushTimer: unknown = null;

  // Text that has arrived but not yet been shown, with the wire time of the
  // first delta in it — released chunks keep that `ts` so the fold's "first
  // visible word" timing measures the model, not the pacer.
  let pendingText = "";
  let pendingTs: number | null = null;
  let pendingDelta: Extract<AgentEvent, { type: "assistant_delta" }> | null = null;
  let paceTimer: unknown = null;

  const projectCommit = () => {
    const next = transcript.project(opts.read());
    if (next) opts.commit(next);
  };

  const scheduleFlush = () => {
    if (flushTimer !== null) return;
    flushTimer = setTimer(() => {
      flushTimer = null;
      projectCommit();
    }, flushDelayMs);
  };

  const cancelFlush = () => {
    if (flushTimer !== null) {
      clearTimer(flushTimer);
      flushTimer = null;
    }
  };

  // Hand `text` to the fold as one delta shaped like the last real one.
  const applyText = (text: string) => {
    if (!text || !pendingDelta) return;
    transcript.apply({ ...pendingDelta, text, thinking: undefined, ts: pendingTs ?? pendingDelta.ts });
  };

  const releaseTick = () => {
    paceTimer = null;
    const [release, rest] = takeWords(pendingText, paceCount(pendingText));
    applyText(release);
    pendingText = rest;
    if (!rest) pendingTs = null;
    projectCommit();
    if (rest) paceTimer = setTimer(releaseTick, paceTickMs);
  };

  /** Show everything still waiting, in order, before anything else renders. */
  const drainPending = () => {
    if (paceTimer !== null) {
      clearTimer(paceTimer);
      paceTimer = null;
    }
    if (pendingText) {
      applyText(pendingText);
      pendingText = "";
      pendingTs = null;
    }
  };

  const handleEvent = (event: AgentEvent): boolean => {
    switch (event.type) {
      // Not a row of its own — it tells the fold which pair is dispatching, so
      // the turn about to stream is stamped with what actually produced it.
      // Without this case the stamp would only ever exist after a reload, which
      // is the trap this whitelist's comment warns about.
      //
      // Deliberately does NOT project. The panel pre-inserts the placeholder
      // bubble this run streams into, and the transcript shell adopts that Msg
      // so its identity survives until the stream first writes to it. Projecting
      // here would rebuild the row and hand back a different object while the
      // bubble is still empty — and since the shell's foreign-edit guard
      // compares by reference, the next commit still holding the original would
      // detach the transcript for the rest of the run. The stamp is on the fold
      // row either way, so it reaches the screen with the first delta.
      case "run_started": {
        transcript.apply(event);
        return true;
      }
      // Evidence belongs to the fold, while these events still need the
      // panel's file refresh, permission, and terminal-state handlers.
      case "file_changed":
      case "artifact_produced":
      case "permission_resolved":
      case "run_result": {
        transcript.apply(event);
        if (event.type === "run_result") {
          cancelFlush();
          projectCommit();
        }
        return false;
      }
      case "assistant_delta": {
        if (firstTokenAt === null) firstTokenAt = now();
        if (pace) {
          // Thinking streams straight through (its block has its own cadence);
          // the visible text queues for the pacer, which projects on each tick.
          if (event.thinking) transcript.apply({ ...event, text: "" });
          if (event.text) {
            pendingDelta = event;
            pendingTs ??= event.ts;
            pendingText += event.text;
            if (paceTimer === null) paceTimer = setTimer(releaseTick, paceTickMs);
          } else if (event.thinking) {
            scheduleFlush();
          }
          return true;
        }
        // The fold takes deltas per token (a string append on the open row);
        // only the *projection* is batched behind the flush timer.
        transcript.apply(event);
        scheduleFlush();
        return true;
      }
      case "assistant_message": {
        cancelFlush();
        drainPending();
        const at = now();
        const step = transcript.apply(event, {
          turnMs: at - turnStartedAt,
          ttftFallbackMs: firstTokenAt !== null ? firstTokenAt - turnStartedAt : undefined,
        });
        // Reset per-turn timing so multi-turn runs time each turn.
        turnStartedAt = at;
        firstTokenAt = null;
        const usage = event.usage;
        if (usage?.promptTokens !== undefined) {
          const completion = usage.completionTokens ?? step.finalizedMeta?.tokens ?? 0;
          opts.onMeasuredPromptTokens?.(usage.promptTokens + completion);
          opts.onMeasuredUsage?.({ prompt: usage.promptTokens, completion });
        }
        if (usage?.contextWindow !== undefined && usage.contextWindow > 0) {
          opts.onMeasuredContextWindow?.(usage.contextWindow);
        }
        projectCommit();
        return true;
      }
      // A delegate CLI reporting work it ran itself. These reach the fold the
      // same way a dispatched call does — the whitelist below is the *only*
      // thing that decides what renders live, so an event missing from it folds
      // on replay and is invisible while the turn is actually happening.
      case "observed_tool_call": {
        // First observable output of the turn. A delegate often opens with
        // several file reads before it says anything, and measuring TTFT to its
        // first *word* reported the whole tool phase as latency — 15s of "no
        // response" for a run that started working immediately.
        if (firstTokenAt === null) firstTokenAt = now();
        drainPending();
        transcript.apply(event);
        projectCommit();
        return true;
      }
      case "observed_tool_result":
      case "tool_call_started":
      case "tool_call_finished":
      case "steering_injected": {
        drainPending();
        transcript.apply(event);
        projectCommit();
        return true;
      }
      default:
        return false;
    }
  };

  return {
    handleEvent,
    ensureAssistant() {
      // Render anything pending first, so the returned index points at what
      // is actually on screen.
      cancelFlush();
      drainPending();
      projectCommit();
      return { msgs: opts.read(), index: transcript.assistantIndex() };
    },
    finish() {
      cancelFlush();
      drainPending();
      projectCommit();
    },
    isDetached() {
      return transcript.isDetached();
    },
  };
}
