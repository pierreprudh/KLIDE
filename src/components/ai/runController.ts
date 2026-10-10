// The run controller — the AI panel's one owner of the turn queue, the live
// Run attachment and the gate table for a Conversation session.
//
// Everything a conversation does with a Run that is not drawing it lives
// here: a sent turn queues and drains, one at a time, behind whatever Run is
// already working in the thread; a live Run is followed through its channel
// or, after a remount, through the reattach broadcast; and the three things a
// Run can park on — a diff, a permission, a question — sit in one table, so
// leaving a conversation for any reason clears all of them at once.
//
// AiPanel renders the view this module publishes (`subscribe` / `getState`)
// and hands back the decisions it takes on the cards. It builds the request a
// turn dispatches with (system prompt, harness settings) and decides what
// happens after a turn settles (auto-summarize, workspace refresh); the
// controller decides *when* those hooks fire.
//
// Framework-free on purpose. The panel passes its dependencies as a getter
// because its callbacks re-close over props and state on every render: the
// controller reads them at the moment it acts, never at the moment it was
// created — which is also what closes the stale-closure defects this module
// replaced (a resolve reading a render-old card, a compaction reading a
// render-old transcript).
//
// Turn generations are the one retirement mechanism. Every Run this panel
// started keeps its channel open until Rust settles it and the channel cannot
// be closed from here, so a retired generation is how the events of a turn
// the panel walked away from — a new chat, another thread, a Stop — fall out
// of `handleEvent` instead of landing in whatever conversation is showing now.

import type {
  AgentEvent,
  DiffDecision,
  DiffProposal,
  PermissionDecision,
  PermissionRequest,
  ProviderId,
  QuestionChoices,
  StartAgentRunInput,
} from "../../agent/types";
import {
  isActiveRunStatus,
  isRunBusyError,
  type AgentRunState,
  type AgentRunSession,
  type RunReattachment,
} from "../../agent/client";
import { isAutoProvider, isDelegateProvider, providerName } from "../../agent/providers";
import { compactionMsg, interruptedMsg } from "../../agent/foldEvents";
import { pendingGatesFromEvents } from "../../agent/pendingGates";
import { errMessage, RunBusyError } from "../../errors";
import type { ConversationRunActivity } from "./conversationSession";
import { decideOnLeavingRun, type RunLeaveDecision } from "./leavingRun";
import {
  hasOpenTurn,
  isSilentRunError,
  replayForAdoption,
  shouldHealFromTranscript,
  type ViewBehindReason,
} from "./replayConversation";
import { nextBusyWait } from "./runBusyRetry";
import type { Pricing } from "./transcriptReducer";
import { createTurnDriver, type TurnDriverOptions } from "./turnDriver";
import { isDelegateId, type DelegateId } from "../../delegates";

/** A Delegate CLI session `open_cli_session` verified, as the Tool reported it. */
export type CliSessionRef = { provider: DelegateId; session: string; project: string | null; title: string };

/** The `openSession` marker a successful `open_cli_session` result carries
 *  (`agent/tools.rs`), or null for any other result. */
export function cliSessionToOpen(result: { ok: boolean; metadata?: Record<string, unknown> }): CliSessionRef | null {
  if (!result.ok) return null;
  const raw = result.metadata?.openSession;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.provider !== "string" || !isDelegateId(r.provider) || typeof r.session !== "string" || !r.session) return null;
  return {
    provider: r.provider,
    session: r.session,
    project: typeof r.project === "string" && r.project ? r.project : null,
    title: typeof r.title === "string" ? r.title : "",
  };
}
import type { Msg, QueuedTurn } from "./types";

// ── The wire the controller drives ──

/** The slice of `agent/client.ts` a controller needs. Injectable so a test
 *  can drive a whole turn — start, events, gates, settle — without Tauri. */
export type RunClient = {
  startAgentRun(input: StartAgentRunInput, onEvent: (event: AgentEvent) => void): Promise<AgentRunSession>;
  stopAgentRun(runId: string): Promise<void>;
  reattachAgentRun(
    runId: string,
    fromSeq: number,
    onEvent: (event: AgentEvent, seq: number) => void,
  ): Promise<RunReattachment>;
  getAgentRunState(runId: string): Promise<AgentRunState>;
  readAgentRunEvents(runId: string): Promise<AgentEvent[]>;
  resolveDiff(input: { runId: string; proposalId: string; decision: DiffDecision }): Promise<void>;
  resolvePermission(input: { runId: string; requestId: string; decision: PermissionDecision }): Promise<void>;
  resolveUserQuestion(input: { runId: string; requestId: string; answer: string }): Promise<void>;
};

// ── The gate table ──

export type PendingQuestionGate = {
  runId: string;
  requestId: string;
  question: string;
  /** Short answers to draw as rows, and a provider whose models the card
   *  may also offer — a "which model" question carries both. */
  choices?: QuestionChoices;
};

export type PendingPermissionGate = { runId: string; request: PermissionRequest };

/** What the conversation's Run is parked on right now. At most one of each;
 *  the harness holds one oneshot at a time, so in practice one at a time. */
export type GateTable = {
  diff: DiffProposal | null;
  permission: PendingPermissionGate | null;
  question: PendingQuestionGate | null;
};

export const NO_GATES: GateTable = { diff: null, permission: null, question: null };

export type GateKind = keyof GateTable;

export type GateArrival =
  | { kind: "diff"; proposal: DiffProposal }
  | { kind: "permission"; runId: string; request: PermissionRequest }
  | { kind: "question"; question: PendingQuestionGate };

/** One answer to one card. Read against the table at resolve time. */
export type GateDecision =
  | { gate: "diff"; decision: DiffDecision }
  | { gate: "permission"; decision: PermissionDecision }
  | { gate: "question"; answer: string };

/**
 * The gate table on its own: arrive, settle-by-id, restore from a transcript,
 * reset. Pure state; `onChange` is how the controller republishes its view.
 */
export function createGateTable(onChange: (gates: GateTable) => void) {
  let gates: GateTable = NO_GATES;
  const set = (next: GateTable) => {
    if (next === gates) return;
    gates = next;
    onChange(gates);
  };
  return {
    read: () => gates,
    arrive(arrival: GateArrival) {
      switch (arrival.kind) {
        case "diff":
          set({ ...gates, diff: arrival.proposal });
          break;
        case "permission":
          set({ ...gates, permission: { runId: arrival.runId, request: arrival.request } });
          break;
        case "question":
          set({ ...gates, question: arrival.question });
          break;
      }
    },
    /** A resolution arrived. Matched by id rather than "the last one wins":
     *  the harness can resolve a request the panel has already moved past
     *  (a subagent's, or one abandoned by a retry), and clearing on any
     *  resolution would drop the card the run is actually waiting on. */
    settle(kind: GateKind, id: string) {
      switch (kind) {
        case "diff":
          if (gates.diff?.id === id) set({ ...gates, diff: null });
          break;
        case "permission":
          if (gates.permission?.request.id === id) set({ ...gates, permission: null });
          break;
        case "question":
          if (gates.question?.requestId === id) set({ ...gates, question: null });
          break;
      }
    },
    /** Take one card down without waiting for the harness to say so. */
    clear(...kinds: GateKind[]) {
      let next = gates;
      for (const kind of kinds) if (next[kind] !== null) next = { ...next, [kind]: null };
      set(next);
    },
    /**
     * Put back whatever a Run is parked on, from its transcript. A card the
     * table already holds for the same request is kept (it may carry more
     * than the transcript does — a question's choices); a card for `runId`
     * that the transcript no longer shows pending is dropped; a card for
     * another Run is left alone. See `agent/pendingGates.ts`.
     */
    restore(events: readonly AgentEvent[], runId: string) {
      const pending = pendingGatesFromEvents(events);
      const permission = pending.permission
        ? gates.permission?.request.id === pending.permission.id
          ? gates.permission
          : { runId, request: pending.permission }
        : gates.permission?.runId === runId
          ? null
          : gates.permission;
      const diff = pending.diff
        ? gates.diff?.id === pending.diff.id
          ? gates.diff
          : pending.diff
        : gates.diff?.runId === runId
          ? null
          : gates.diff;
      const question = pending.question
        ? gates.question?.requestId === pending.question.requestId
          ? gates.question
          : pending.question
        : gates.question?.runId === runId
          ? null
          : gates.question;
      if (permission === gates.permission && diff === gates.diff && question === gates.question) return;
      set({ diff, permission, question });
    },
    reset() {
      set(NO_GATES);
    },
  };
}

// ── The controller ──

export type LeaveReason = "new" | "load" | "deleted" | "unmount";

/** How one turn ended, for the panel's post-turn decisions. `retired` is a
 *  turn the panel stopped watching (Stop, or leaving the thread) — its Run
 *  may have finished cleanly, but nothing about it is this conversation's
 *  to summarize. */
export type TurnOutcome = "done" | "failed" | "aborted" | "retired";

/** What the panel renders. A new object on every change, so it can be a
 *  `useSyncExternalStore` snapshot. */
export type RunControllerView = {
  /** Turns waiting behind the one that is running. */
  queued: number;
  /** A drain loop is running this conversation's turns. */
  processing: boolean;
  /** A reattach listener is following a Run this panel did not start here. */
  following: boolean;
  /** The Run this panel is wired to — started here, or followed. */
  activeRunId: string | null;
  gates: GateTable;
  /** The last card answer the harness refused, readable text. */
  lastError: string | null;
};

export type RunControllerHooks = {
  /** A turn was appended to the transcript as a queued user message. */
  onTurnQueued?(turn: QueuedTurn): void;
  /** A turn's Run is being started and its placeholder is on screen. */
  onTurnStarted?(turn: QueuedTurn): void;
  /** Context-gauge feedback from a finalized assistant message. */
  onMeasuredPromptTokens?(tokens: number): void;
  onMeasuredUsage?(usage: { prompt: number; completion: number }): void;
  onMeasuredContextWindow?(tokens: number): void;
  /** The harness wrote a workspace file. */
  onFileChanged?(path: string): void;
  /** The executor parked on `consult_advisor`; the panel services it. */
  onAdvisorRequested?(event: Extract<AgentEvent, { type: "advisor_requested" }>): void;
  /** `open_cli_session` verified a Delegate CLI session; the host opens it
   *  in a new conversation. Fired from the live result only — a replayed
   *  transcript must never reopen it. */
  onOpenCliSession?(session: CliSessionRef): void;
  /** A turn's Run failed to start or to finish; the failure is on screen. */
  onTurnFailed?(turn: QueuedTurn, error: unknown): void;
  /** A turn is over and the conversation is idle again. */
  onTurnSettled?(turn: QueuedTurn, outcome: TurnOutcome): void;
  /** The harness refused a card's answer. */
  onGateFailed?(decision: GateDecision, error: unknown): void;
};

export type RunControllerDeps = {
  client: RunClient;
  /** The conversation's transcript — the panel's `msgsRef` + `setMsgs`. The
   *  single source of truth while a turn streams. */
  transcript: { read(): Msg[]; commit(next: Msg[]): void };
  /** Which conversation the panel is on right now. */
  conversationId(): string;
  /** The Conversation session's Run activity — `streaming` is derived there. */
  session: {
    runStarted(activity: ConversationRunActivity, dispatched?: { provider: ProviderId; model: string }): void;
    runSettled(): void;
  };
  /** How a Delegate's turn reaches this surface: through a PTY console (no
   *  Transcript of its own) or headless through the Harness (Focus). */
  delegateStyle: "console" | "headless";
  pricing: Pricing;
  /** Everything the harness needs to start `turn` — system prompt, harness
   *  settings, the Goal policy as it is *now*. Identity is the controller's. */
  request(
    turn: QueuedTurn,
    ids: { runId: string; parentId?: string; conversationId: string },
  ): Omit<StartAgentRunInput, "runId" | "parentId">;
  /** What a failed turn tells the user. */
  failureText(error: unknown, turn: QueuedTurn): string;
  hooks: RunControllerHooks;
  /** Injectable clock and timers — tests pass fakes; the panel omits them. */
  now?(): number;
  sleep?(ms: number): Promise<void>;
  driver?: Pick<TurnDriverOptions, "now" | "setTimer" | "clearTimer" | "pace" | "flushDelayMs" | "paceTickMs">;
};

export type RunController = {
  /** Queue a turn and start draining. */
  send(turn: QueuedTurn): void;
  /** Stop the Run this panel started, retire the turn, clear every card. */
  stop(): void;
  /** Leave the conversation: retire the turn, drop the queue and any
   *  follower, clear every card, settle the session. The Run itself keeps
   *  going in Rust. One recipe for every reason. */
  leave(reason: LeaveReason): RunLeaveDecision;
  /** Answer the card the table holds *now*. Resolves to whether the harness
   *  took the answer; a refusal is reported through `onGateFailed`. */
  resolve(decision: GateDecision): Promise<boolean>;
  /** Pick up a conversation's Run where it is: adopt the transcript, restore
   *  its cards, and follow it live if Rust still holds it. */
  attach(target: { conversationId: string; provider: ProviderId }): void;
  subscribe(listener: () => void): () => void;
  getState(): RunControllerView;
};

export function createRunController(deps: () => RunControllerDeps): RunController {
  let queue: QueuedTurn[] = [];
  let processing = false;
  let generation = 0;
  let activeRunId: string | null = null;
  let follower: RunReattachment | null = null;
  let lastError: string | null = null;

  const listeners = new Set<() => void>();
  const gates = createGateTable(() => publish());
  let view: RunControllerView = snapshot();

  function snapshot(): RunControllerView {
    return {
      queued: queue.length,
      processing,
      following: follower !== null,
      activeRunId,
      gates: gates.read(),
      lastError,
    };
  }
  function publish() {
    view = snapshot();
    for (const listener of listeners) listener();
  }

  const now = () => deps().now?.() ?? Date.now();
  const sleep = (ms: number) => deps().sleep?.(ms) ?? new Promise<void>((resolve) => setTimeout(resolve, ms));

  // ── Attachment ──

  function setActiveRun(runId: string | null) {
    if (activeRunId === runId) return;
    activeRunId = runId;
    publish();
  }

  function dropFollower() {
    if (!follower) return;
    follower.detach();
    follower = null;
    publish();
  }

  function abortActiveRun() {
    const runId = activeRunId;
    if (!runId) return;
    setActiveRun(null);
    void deps().client.stopAgentRun(runId).catch((e) => console.error("Failed to abort harness run:", e));
  }

  /** The one reset. Retire the live turn's generation so its channel's events
   *  fall out of `handleEvent` and any drain loop bails, then take down what
   *  the panel was showing for it. */
  function retire(opts: { abort: boolean; clearQueue: boolean }) {
    generation += 1;
    processing = false;
    if (opts.clearQueue) queue = [];
    if (opts.abort) abortActiveRun();
    else setActiveRun(null);
    dropFollower();
    gates.reset();
    deps().session.runSettled();
    publish();
  }

  // ── The turn ──

  function enqueue(turn: QueuedTurn) {
    queue = [...queue, turn];
    // Stamped at send, not at dispatch: a turn can sit queued behind a running
    // one, and the conversation's start time is when the user actually asked.
    const queued: Msg = {
      role: "user",
      content: turn.text,
      attachments: turn.attachments.length ? turn.attachments : undefined,
      projectContext: turn.projectContext,
      queueState: "queued",
      queueId: turn.clientId,
      subagent: turn.subagent,
      wake: turn.wake,
      ts: now(),
    };
    const d = deps();
    d.transcript.commit([...d.transcript.read(), queued]);
    publish();
    d.hooks.onTurnQueued?.(turn);
  }

  async function drain() {
    if (processing) return;
    processing = true;
    publish();
    const mine = generation;
    try {
      while (queue.length > 0 && generation === mine) {
        // An externally-started run (race watch, resumed live run) is still
        // streaming into this conversation via the reattach follower.
        // Starting a queued turn now would run two harness loops over one
        // transcript — wait for it to settle, then re-check the queue.
        if (follower) {
          await follower.done;
          continue;
        }
        const [turn, ...rest] = queue;
        queue = rest;
        publish();
        await runTurn(turn, mine);
      }
    } finally {
      // A retire() mid-drain already flipped this for the *next* drain; only
      // the loop that still owns the flag lets go of it.
      if (generation === mine) processing = false;
      publish();
    }
  }

  async function runTurn(turn: QueuedTurn, mine: number) {
    if (generation !== mine) return;
    const d = deps();
    const conversationId = d.conversationId();
    const { transcript, client } = d;
    const userIndex = transcript.read().findIndex((m) => m.role === "user" && m.queueId === turn.clientId);
    if (userIndex < 0) return;
    const opening = [...transcript.read()];
    const userMsg = opening[userIndex];
    if (userMsg.role !== "user") return;
    opening[userIndex] = { ...userMsg, queueState: "running" };
    // A console block is how you read a CLI's raw stdout. The headless
    // one-shot path returns the assistant's prose (`--output-format text`), so
    // in Focus it is rendered as an ordinary message instead — same chat, a
    // different engine behind it.
    const isDelegate = isDelegateProvider(turn.provider);
    const delegateConsole = isDelegate && d.delegateStyle === "console";
    const delegateProvider = providerName(turn.provider);
    // The headless path hands back the whole reply at once, so its placeholder
    // shows a status word and a clock instead of the streaming loader.
    const delegateHeadless = isDelegate && d.delegateStyle === "headless" ? (true as const) : undefined;
    // The placeholder wears the pair this turn dispatches with from the moment
    // it appears. The fold restamps it when `run_started` lands, but that line
    // is a second or so out (routing, memory recall, the summary write), and
    // an unstamped row falls back to the thread's origin — so a Mistral thread
    // continued on DeepSeek flashed Mistral's mark before DeepSeek's. `auto`
    // is the one pair that isn't a mark: the origin is its locked answer, and
    // `run_started` brings the resolved one.
    const dispatched = isAutoProvider(turn.provider) ? {} : { provider: turn.provider, model: turn.model };
    opening.splice(userIndex + 1, 0, { role: "assistant", content: "", ...dispatched, delegateConsole, delegateProvider, delegateHeadless });
    const assistantIndex = userIndex + 1;
    transcript.commit(opening);
    // The turn carries the pair it actually dispatches with, which stamps the
    // thread's origin on its first Run.
    d.session.runStarted("thinking", { provider: turn.provider, model: turn.model });
    d.hooks.onTurnStarted?.(turn);

    // Why this turn's view is short of the Run's Transcript, when it is. Two
    // things can stop a turn reaching the screen while the Run keeps working:
    // the region splice detaching, and events dropped for a retired turn
    // generation. Both are silent by construction, and both strand the Run's
    // later turns — its *answer*, usually, since a tool phase comes first — on
    // disk and nowhere else. Set by whichever fires, read once the Run settles.
    //
    // Turn-local on purpose: a Run keeps streaming after its turn is retired,
    // so the handler closures of *older* turns are still firing. Shared, one
    // of them could fabricate a signal for whatever turn is live now.
    const viewBehind: { reason: ViewBehindReason | null } = { reason: null };
    let harnessError: Error | null = null;
    // A user-initiated Stop is delivered as a RunError with code "aborted".
    // Not a harness failure, and not a run worth summarizing.
    let abortedByUser = false;

    // All event handling transforms the transcript (the single source of
    // truth) and pushes plain values through commit(). Never a functional
    // setState updater with side effects: StrictMode double-invokes updaters.
    const commit = (next: Msg[]) => transcript.commit(next);

    // The streaming state machine for this turn — delta batching, TTFT/turn
    // timing, the assistant-index cursor, flush-before-finalize. See
    // ai/turnDriver.ts; fixture-tested there without React or Tauri.
    const driver = createTurnDriver({
      assistantIndex,
      delegate: { delegateConsole, delegateProvider, delegateHeadless },
      pricing: d.pricing,
      read: () => transcript.read(),
      commit,
      onMeasuredPromptTokens: (tokens) => deps().hooks.onMeasuredPromptTokens?.(tokens),
      onMeasuredUsage: (usage) => deps().hooks.onMeasuredUsage?.(usage),
      onMeasuredContextWindow: (tokens) => deps().hooks.onMeasuredContextWindow?.(tokens),
      onDetached: () => {
        viewBehind.reason = "region-detached";
      },
      ...d.driver,
    });

    const handleEvent = (event: AgentEvent) => {
      if (generation !== mine) {
        // This turn's generation was retired mid-Run (the panel left the
        // conversation, or a Stop bumped it). Dropping the event is right — it
        // must not land in whatever conversation is adopted next — but the Run
        // is still working, so what we have on screen is now short of the
        // Transcript. Say so, rather than letting the turn look finished.
        viewBehind.reason = "generation-retired";
        return;
      }
      // The eyes finished reading this turn's photos (Rust `agent::sight`).
      // The user bubble was drawn from what the composer staged, before any
      // model looked; the transcript's copy now says who did and what they
      // read. Bring the bubble up to date here, so the "Described by" caption
      // and the eyes' place in the participants strip appear live rather
      // than on the next reload. The step row itself is the driver's.
      if (event.type === "sight_resolved") {
        const next = [...transcript.read()];
        const user = next[userIndex];
        if (user?.role === "user" && user.attachments?.length) {
          const eyes = `${event.provider}/${event.model}`;
          const described = new Map((event.described ?? []).map((d) => [d.path, d.description]));
          const dropped = new Set((event.dropped ?? []).map((d) => d.path));
          next[userIndex] = {
            ...user,
            attachments: user.attachments
              .filter((a) => !(a.dataUri && dropped.has(a.path)))
              .map((a) => a.dataUri && !a.seenBy && described.has(a.path)
                ? { ...a, seenBy: eyes, content: described.get(a.path) ?? a.content }
                : a),
          };
          commit(next);
        }
      }
      // A Tool result can carry one side effect for the window the Run has
      // none of: `open_cli_session` asks for a new conversation. Read it before
      // the driver folds the row, which consumes the event.
      if (event.type === "tool_call_finished") {
        const open = cliSessionToOpen(event.result);
        if (open) deps().hooks.onOpenCliSession?.(open);
      }
      // Transcript events (deltas, finalized messages, tool cards) belong to
      // the turn driver; everything below is panel behaviour.
      if (driver.handleEvent(event)) return;
      switch (event.type) {
        case "context_compacted": {
          // The Rust auto-compactor collapsed the older turns mid-run. Without
          // this the conversation silently loses its early context and the
          // marker only appears after a reload (via foldEvents).
          const prior = transcript.read();
          commit([...prior, compactionMsg(prior.length, event.summary)]);
          break;
        }
        case "diff_proposed":
          gates.arrive({ kind: "diff", proposal: event.proposal });
          break;
        case "diff_resolved":
          gates.settle("diff", event.proposalId);
          break;
        case "user_question_requested":
          gates.arrive({
            kind: "question",
            question: { runId: event.runId, requestId: event.requestId, question: event.question, choices: event.choices },
          });
          break;
        case "user_question_resolved":
          gates.settle("question", event.requestId);
          break;
        case "permission_requested":
          gates.arrive({ kind: "permission", runId: event.runId, request: event.request });
          break;
        case "permission_resolved":
          gates.settle("permission", event.requestId);
          break;
        // Both halves of a subagent exchange are display-only here: the Rust
        // harness resolves the role, runs the child, and feeds its report back
        // as the tool result. The transcript rows come from the turn driver.
        case "subagent_requested":
        case "subagent_resolved":
        case "advisor_resolved":
          break;
        case "advisor_requested":
          deps().hooks.onAdvisorRequested?.(event);
          break;
        case "file_changed":
          deps().hooks.onFileChanged?.(event.path);
          break;
        case "run_result": {
          const next = [...transcript.read()];
          const user = next[userIndex];
          if (user?.role === "user") {
            next[userIndex] = { ...user, queueState: undefined, queueId: undefined };
            commit(next);
          }
          // Exit the working state as soon as the terminal event is *observed*,
          // not only when `await session.done` resolves — that promise can hang
          // if the channel was disrupted, leaving "Working…" stuck. Safe: this
          // fires once per finished run, never mid-run.
          deps().session.runSettled();
          break;
        }
        case "run_error": {
          if (!isSilentRunError(event.error.code)) harnessError = new Error(event.error.message);
          else abortedByUser = true;
          deps().session.runSettled();
          break;
        }
        default:
          break;
      }
    };

    try {
      // A subagent turn runs as its OWN child run (parentId = the conversation
      // run), so Mission Control nests it under the convo. Events still stream
      // through `handleEvent`, so the delegation + any diffs render inline.
      const runId = turn.subagent ? `${conversationId}-at-${turn.clientId}` : conversationId;
      const parentId = turn.subagent ? conversationId : undefined;
      // Built per attempt, not once: the Goal policy it carries is read at
      // dispatch, and a turn that waited behind a busy Run takes the rung as
      // it is when its Run actually starts.
      const startSession = () =>
        client.startAgentRun({ ...deps().request(turn, { runId, parentId, conversationId }), runId, parentId }, handleEvent);
      // The user message wears `queued` while it waits on a busy Run, and
      // `running` again once its own Run has started.
      const markUser = (queueState: "queued" | "running") => {
        const next = [...transcript.read()];
        const user = next[userIndex];
        if (user?.role !== "user" || user.queueState === queueState) return;
        next[userIndex] = { ...user, queueState };
        commit(next);
      };
      let session: AgentRunSession | undefined;
      const busySince = now();
      for (let attempt = 0; ; attempt++) {
        if (generation !== mine) return;
        try {
          session = await startSession();
          break;
        } catch (error) {
          // A completion-triggered reply may win the atomic backend guard
          // between our queue check and dispatch. Preserve this user's turn —
          // for a while (runBusyRetry.ts), then say so and hand it back.
          if (!isRunBusyError(error)) throw error;
          viewBehind.reason = "region-detached";
          const wait = nextBusyWait(attempt, now() - busySince);
          if (wait === null) throw new RunBusyError();
          markUser("queued");
          await sleep(wait);
        }
      }
      if (generation !== mine) return;
      markUser("running");
      setActiveRun(session.runId);
      try {
        await session.done;
      } finally {
        // Only this Run's handle. The panel may have left and be following
        // another conversation's Run by now; a settle here must not unhook it.
        if (activeRunId === session.runId) setActiveRun(null);
      }
      if (harnessError) throw harnessError;
    } catch (error) {
      if (generation !== mine) return;
      const located = driver.ensureAssistant();
      const next = [...located.msgs];
      const failedUser = next[userIndex];
      if (failedUser?.role === "user") next[userIndex] = { ...failedUser, queueState: undefined, queueId: undefined };
      next[located.index] = { role: "assistant", content: `⚠ ${deps().failureText(error, turn)}` };
      commit(next);
      deps().hooks.onTurnFailed?.(turn, error);
      harnessError = error instanceof Error ? error : new Error(errMessage(error));
    }
    // Cancel the batch timer + render any delta still pending.
    driver.finish();
    // The turn stopped reaching the screen partway through. The Run itself kept
    // going in Rust and wrote every turn to its Transcript, so the answer is not
    // lost — it is simply not here. Re-read the Transcript and adopt it, the
    // same heal a remount gets from `attach`, instead of leaving a conversation
    // that ends on a tool call and looks like a model that said nothing.
    //
    // Two Runs are deliberately not healed this way. A Delegate conversation
    // outside Focus has no Transcript of its own to read. And a subagent turn
    // is its OWN child Run: its events stream into this panel but land in the
    // child's Transcript, so the conversation's own Transcript is not the
    // record of what was on screen.
    if (driver.isDetached()) viewBehind.reason ??= "region-detached";
    const behind = viewBehind.reason;
    const stillOnConversation = deps().conversationId() === conversationId;
    if (
      shouldHealFromTranscript({
        behind,
        stillOnConversation,
        subagent: Boolean(turn.subagent),
        delegateWithoutTranscript: isDelegate && deps().delegateStyle === "console",
      })
    ) {
      // Loud on purpose: the last time a turn went dark, the only evidence was
      // a conversation that looked like it ended on a tool call.
      console.warn(`Klide: turn stopped reaching the view (${behind}) — healing from the transcript.`);
      try {
        const healed = replayForAdoption(await client.readAgentRunEvents(conversationId), transcript.read());
        if (healed) commit(healed);
      } catch {
        // A Transcript that cannot be read leaves the view as it stands.
      }
    }
    // A retired turn is not this conversation's to settle: Stop or leave
    // already did, and whatever the session shows now may be another
    // thread's live Run. Nor is it one to summarize — a Run the user stopped
    // finishes with an error the retirement dropped, and a Run the user
    // walked away from would be written up against the wrong transcript.
    if (generation !== mine) {
      deps().hooks.onTurnSettled?.(turn, "retired");
      return;
    }
    deps().session.runSettled();
    // The Run is over, so nothing it asked can still be answered.
    gates.reset();
    deps().hooks.onTurnSettled?.(turn, harnessError ? "failed" : abortedByUser ? "aborted" : "done");
  }

  // ── Following a Run this panel did not start here ──

  function attach({ conversationId, provider }: { conversationId: string; provider: ProviderId }) {
    // Klide runs only: conversation id == transcript id. A delegate *session*
    // streams through the PTY and has no transcript to re-read; a delegate run
    // on the headless Focus path does, and follows like any other.
    if (isDelegateProvider(provider) && deps().delegateStyle === "console") return;
    const { client, transcript } = deps();
    const baseLen = transcript.read().length;
    void (async () => {
      let latestAdoptedLength = 0;
      // Re-read the transcript and adopt the replay, guarding against a
      // conversation switch mid-await and against clobbering typing. Reports
      // the event count and whether the transcript *tail* is terminal — the
      // harness writes RunResult/RunError to disk before it flips the run's
      // status, so the tail is the authoritative "is this turn done" signal.
      const adopt = async (
        guardBaseLen?: number,
      ): Promise<{ len: number; terminal: boolean; events: AgentEvent[] }> => {
        const events = await client.readAgentRunEvents(conversationId);
        // Turns queued locally (waiting for this external run to settle)
        // aren't in the transcript yet — `replayForAdoption` carries them
        // across, and refuses a replay shorter than what is on screen.
        const replayed = replayForAdoption(
          events,
          transcript.read(),
          isActiveRunStatus(status)
            ? { provider, delegateHeadless: isDelegateProvider(provider) ? true : undefined }
            : undefined,
        );
        const safe =
          replayed !== null &&
          events.length >= latestAdoptedLength &&
          deps().conversationId() === conversationId &&
          (guardBaseLen === undefined || transcript.read().length === guardBaseLen);
        if (safe) {
          latestAdoptedLength = events.length;
          transcript.commit(replayed);
        }
        const tail = events[events.length - 1]?.type;
        return { len: events.length, terminal: tail === "run_result" || tail === "run_error", events };
      };
      // Put back whatever the run is parked on. Only ever for a run Rust still
      // holds: a transcript can end on an unanswered request with no terminal
      // event — what a run killed with the app looks like — and a card for a
      // run that no longer exists would offer an approval nothing listens for.
      const restoreGates = (events: AgentEvent[]) => {
        if (deps().conversationId() !== conversationId) return;
        gates.restore(events, conversationId);
      };

      // Ask the owner before reading disk: completion between these calls
      // is included in the snapshot. A prior turn's terminal event is not
      // evidence that a newly accepted background turn has already finished.
      let status: string | null;
      let fromSeq: number | null;
      try {
        ({ status, fromSeq } = await client.getAgentRunState(conversationId));
      } catch {
        return; // an unreachable owner is not proof of interruption
      }
      if (deps().conversationId() !== conversationId) return;
      let snapshot: { len: number; terminal: boolean; events: AgentEvent[] };
      try {
        snapshot = await adopt(baseLen);
      } catch {
        if (!isActiveRunStatus(status)) return;
        snapshot = { len: 0, terminal: false, events: [] };
      }
      const thisTurnFinished = (value: { len: number; terminal: boolean }) =>
        value.terminal && (fromSeq === null || value.len > fromSeq);
      if (thisTurnFinished(snapshot)) return;

      if (!isActiveRunStatus(status)) {
        // No live run, and a turn that never settled: it died with the app.
        // Say so where the answer would have been, or the user message just
        // sits there and reads as a lost conversation. Tail case only — once
        // a later turn is written the fold draws the same line itself.
        if (hasOpenTurn(snapshot.events)) {
          const current = transcript.read();
          const last = current[current.length - 1];
          if (!(last?.role === "system" && last.runInterrupted)) transcript.commit([...current, interruptedMsg()]);
        }
        return;
      }

      // Follow it live. Every persisted event just signals "re-read the
      // transcript" — disk is the source of truth, so there are no gaps to
      // reconcile and dedup is implicit in the full replay.
      deps().session.runStarted(null);
      setActiveRun(conversationId);
      restoreGates(snapshot.events);
      const settle = () => {
        deps().session.runSettled();
        if (activeRunId === conversationId) setActiveRun(null);
        dropFollower();
      };
      const reattached = await client.reattachAgentRun(conversationId, snapshot.len, (event) => {
        void adopt().then((next) => restoreGates(next.events)).catch(() => {});
        if (event.type === "run_result" || event.type === "run_error") settle();
      });
      // A conversation switch during the listen await would have moved the
      // panel on — drop the fresh listener instead of leaking it.
      if (deps().conversationId() !== conversationId) {
        reattached.detach();
        deps().session.runSettled();
        return;
      }
      // One follower at a time: a second attach to the same thread (a
      // StrictMode remount, a click on the row) replaces the first.
      follower?.detach();
      follower = reattached;
      publish();
      // Close the snapshot→subscribe race: a terminal event emitted while we
      // were registering the listener won't arrive live. Re-read the tail
      // (authoritative) and settle if the run already finished.
      try {
        const post = await adopt();
        restoreGates(post.events);
        if (thisTurnFinished(post)) settle();
      } catch {
        /* ignore transient read error */
      }
    })();
  }

  // ── Answering a card ──

  async function resolve(decision: GateDecision): Promise<boolean> {
    // Read now, not when the handler was rendered: the card on screen is the
    // one being answered, whatever closure the click came through.
    const current = gates.read();
    const { client } = deps();
    if (lastError !== null) {
      lastError = null;
      publish();
    }
    try {
      switch (decision.gate) {
        case "diff": {
          const proposal = current.diff;
          if (!proposal) return false;
          // The diff card stays up until the harness says `diff_resolved`, so
          // its spinner has something to spin over and a refusal keeps the
          // card to retry from.
          await client.resolveDiff({ runId: proposal.runId, proposalId: proposal.id, decision: decision.decision });
          return true;
        }
        case "permission": {
          const permission = current.permission;
          if (!permission) return false;
          gates.clear("permission");
          await client.resolvePermission({
            runId: permission.runId,
            requestId: permission.request.id,
            decision: decision.decision,
          });
          return true;
        }
        case "question": {
          const question = current.question;
          if (!question) return false;
          gates.clear("question", "permission");
          await client.resolveUserQuestion({ runId: question.runId, requestId: question.requestId, answer: decision.answer });
          return true;
        }
      }
    } catch (error) {
      lastError = errMessage(error);
      publish();
      deps().hooks.onGateFailed?.(decision, error);
      return false;
    }
  }

  return {
    send(turn) {
      enqueue(turn);
      void drain();
    },
    stop() {
      // The harness is being aborted; the run loop emits a paused-state exit
      // on its own. Every card comes down — a question whose answer can never
      // arrive, and equally a diff whose apply can never land.
      retire({ abort: true, clearQueue: false });
    },
    // The reason is for the caller's clarity and the tests' — new chat,
    // another thread, a deletion, an unmount all take the one recipe.
    leave(_reason) {
      const decision = decideOnLeavingRun({ hasActiveRun: activeRunId !== null });
      retire({ abort: decision.abort, clearQueue: true });
      return decision;
    },
    resolve,
    attach,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState: () => view,
  };
}
