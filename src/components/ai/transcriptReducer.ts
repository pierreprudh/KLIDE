// The live Msg[] view of one run's fold.
//
// The AiPanel streams a run's `AgentEvent`s into a `Msg[]` (the Conversation).
// The event → row logic itself lives in `src/agent/foldEvents.ts` — the ONE
// fold, shared with replay — and this module is the React-facing shell around
// it: it owns the run's *region* of the panel's message array and keeps that
// region in sync with the fold's rows.
//
// What the shell adds on top of the fold:
// - a per-row projection cache, so an event only rebuilds the Msg objects of
//   the rows it touched — every other Msg keeps its reference across renders
//   (per-token deltas re-project exactly one assistant bubble);
// - the region splice: the panel array holds restored history before the run
//   and panel-appended rows after it (queued turns, compaction markers), and
//   `project` replaces only `[regionStart, regionStart + projected.length)`;
// - adoption of the placeholder bubble the panel inserts before the first
//   event, so that Msg keeps its identity until the stream first writes to it;
// - a foreign-edit guard: if something else rewrote the region (the panel's
//   error path, or a conversation switch mid-flush), the shell detaches
//   instead of clobbering what it no longer owns.
//
// Framework-free and unit-tested in transcriptReducer.test.ts; the timing,
// delta batching, and event routing live in the turn driver.

import type { AgentEvent } from "../../agent/types";
import {
  createFold,
  foldedRowToMsgs,
  type FoldLiveTiming,
  type FoldStep,
} from "../../agent/foldEvents";
import type { Msg } from "./types";

/** Delegate-console tagging carried on every assistant row of a turn. */
export type TranscriptDelegate = { delegateConsole?: boolean; delegateProvider?: string; delegateHeadless?: true };

export type Pricing = { inputPerMillion: number; outputPerMillion: number } | null;

export type RunTranscript = {
  /** Feed one event into the fold. Cheap (per-token safe); nothing is
   *  projected until `project` runs. Returns the fold's step so the caller
   *  can read the finalized turn meta. */
  apply(event: AgentEvent, live?: FoldLiveTiming): FoldStep;
  /** Re-project the rows touched since the last call and splice the run's
   *  region into `current`. Returns the next array, or null when nothing
   *  changed — or when the region was edited from outside, after which the
   *  transcript stays detached for good. */
  project(current: Msg[]): Msg[] | null;
  /** Index (in the last projected array) of the run's current assistant
   *  bubble — the row the error path replaces with a failure message. */
  assistantIndex(): number;
  /** True once the region was edited from outside and this transcript stopped
   *  writing. Everything the run streams from that moment on is on disk but not
   *  on screen, so the caller must heal from the Transcript rather than trust
   *  what it last projected. */
  isDetached(): boolean;
};

export function createRunTranscript(opts: {
  /** Where the run's rows start in the panel's message array. */
  regionStart: number;
  /** The pre-inserted empty assistant bubble this run streams into, adopted
   *  as the fold's open row so its Msg identity survives until first write. */
  seed: Msg | null;
  delegate: TranscriptDelegate;
  pricing: Pricing;
  /** Called once, the moment the region is found edited from outside. Detaching
   *  is correct — the shell no longer owns those rows — but it is also silent,
   *  and a silent stop mid-run reads as an agent that answered nothing. The
   *  panel uses this to heal from the Transcript when the run settles. */
  onDetached?: () => void;
}): RunTranscript {
  const fold = createFold({
    pricing: opts.pricing,
    seedOpenAssistant: opts.seed !== null,
  });
  const view = { delegate: opts.delegate, runningPlaceholders: true };
  // Projection cache: rowMsgs[i] is fold row i's Msg objects; flat is their
  // concatenation — exactly what occupies the region right now.
  const rowMsgs: Msg[][] = [];
  let flat: Msg[] = [];
  const dirty = new Set<number>();
  let detached = false;
  if (opts.seed) {
    rowMsgs.push([opts.seed]);
    flat = [opts.seed];
  }

  return {
    apply(event, live) {
      const step = fold.apply(event, live);
      for (const i of step.changed) dirty.add(i);
      return step;
    },

    project(current) {
      if (detached) return null;
      const rows = fold.rows();
      if (dirty.size === 0 && rowMsgs.length === rows.length) return null;
      // Foreign-edit guard: everything we projected last time must still be
      // there, by reference. If not, someone else owns the region now.
      for (let i = 0; i < flat.length; i++) {
        if (current[opts.regionStart + i] !== flat[i]) {
          detached = true;
          opts.onDetached?.();
          return null;
        }
      }
      for (const i of dirty) rowMsgs[i] = foldedRowToMsgs(rows[i], view);
      // Safety net for rows the step reporting ever misses. Written as a scan
      // over every row rather than an append past `rowMsgs.length`: a dirty set
      // that skips an index leaves a hole behind it, and the append form walks
      // straight past that hole into a `push(...undefined)` on the flatten
      // below. Filling by emptiness covers both the append and the hole.
      for (let i = 0; i < rows.length; i++) {
        if (!rowMsgs[i]) rowMsgs[i] = foldedRowToMsgs(rows[i], view);
      }
      dirty.clear();
      const nextFlat: Msg[] = [];
      // Walk `rows`, not `rowMsgs`: the cache is only ever grown, so if the
      // fold ever hands back fewer rows than last time, iterating the cache
      // would flatten rows that no longer exist — and a `for…of` over a sparse
      // cache yields `undefined` into `push(...)`. `rows` is the authority on
      // what the region contains; the loop above guarantees an entry for each.
      for (let i = 0; i < rows.length; i++) nextFlat.push(...rowMsgs[i]);
      const next = [
        ...current.slice(0, opts.regionStart),
        ...nextFlat,
        ...current.slice(opts.regionStart + flat.length),
      ];
      flat = nextFlat;
      return next;
    },

    isDetached() {
      return detached;
    },

    assistantIndex() {
      const rows = fold.rows();
      let offset = 0;
      let found = opts.regionStart;
      for (let i = 0; i < rowMsgs.length && i < rows.length; i++) {
        if (rows[i].kind === "assistant") found = opts.regionStart + offset;
        offset += rowMsgs[i].length;
      }
      return found;
    },
  };
}
