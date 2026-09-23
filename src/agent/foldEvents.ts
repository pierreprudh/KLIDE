// The one fold of the Agent event stream. `createFold` turns `AgentEvent`s
// into normalized conversation rows and runs at two paces over the same code:
// the AI panel's live run feeds it one event at a time (through the turn
// driver in `components/ai/turnDriver.ts`), and replay drains a whole
// transcript through `foldAgentEvents`. Both renderers sit on the same rows —
// each has its own row shape (Msg vs RunMessage), so the fold owns the pairing
// logic (user↔assistant, tool-call lifecycle by toolCallId, streamed deltas)
// and the mappers do the trivial shape conversion. The wire format lives once,
// in here — everything downstream is a projection of this fold, never a
// second parse of the events.

import type {
  AgentAttachment,
  AgentContentBlock,
  AgentEvent,
  AgentMode,
  AgentTurnTiming,
  AgentUsage,
  ProviderId,
} from "./types";
import type { Msg } from "../components/ai/types";
import type { RunMessage, RunToolCall } from "../runs";
import { estimateTokens } from "../components/ai/utils";
import type { RunCompletion } from "./completion";

export type FoldedToolCall = {
  id: string;
  name: string;
  input: unknown;
  summary?: string;
  result?: { content: string; ok: boolean };
  status: "started" | "finished" | "unknown";
  /** Set when a *delegate CLI* ran this itself (its provider id, e.g.
   *  `claude-code`) rather than Klide dispatching it. Klude applied no
   *  capability, no permission prompt and no diff review to these, so every
   *  surface that renders or counts tool work must be able to tell them apart —
   *  that is the whole reason this field exists rather than a silent reuse of
   *  the dispatched-call shape. */
  observedBy?: string;
  /** For a `spawn_subagent` call: the Run id of the child it started, learned
   *  from the `subagent_requested` event (the harness names it
   *  `sub_<parent>_<toolCallId>`). It is the address a surface watches the
   *  child on — the child broadcasts on `agent-run:{id}` like any other Run —
   *  so it is carried on the call rather than re-derived from a parent id the
   *  renderer does not have. */
  childRunId?: string;
};

/** Per-message footer metrics. One type for both paces — a turn must read the
 *  same after a reload as it did live. */
export type AssistantMeta = {
  /** Wall-clock duration from the previous turn boundary (user or tool).
   *  Includes tool execution and diff-review waiting — see `modelMs` for the
   *  provider's own share of it. Replay derives it from event timestamps; the
   *  live path measures it and passes it in via `FoldLiveTiming`. */
  ms?: number;
  /** Provider request → response, ms, as measured in the harness. Absent on
   *  harness-authored messages and on transcripts written before the harness
   *  recorded turn timing. */
  modelMs?: number;
  /** Provider request → first streamed token, ms. */
  ttftMs?: number;
  /** Completion tokens — exact from `AgentUsage` when present, else a
   *  length-based estimate. The mapper decides whether to expose this. */
  tokens?: number;
  tokensEstimate?: number;
  /** Provider-reported prompt tokens, when the usage block carried them. */
  promptTokens?: number;
  /** Decode speed in tok/s — never derived from wall clock (see computeMeta). */
  tps?: number;
  /** True iff `tokens` came from the provider, not the estimate. */
  exact?: boolean;
  /** Per-turn cost in USD — provider-reported when present, else estimated
   *  from `FoldOptions.pricing`. Absent for local / subscription turns. */
  costUsd?: number;
};

export type FoldedRow =
  | { kind: "completion"; completion: RunCompletion }
  | {
      kind: "user";
      text: string;
      attachments?: AgentAttachment[];
      /** The `user_message` event's `ts`, epoch ms. */
      ts?: number;
    }
  | {
      kind: "assistant";
      text: string;
      thinking?: string;
      toolCalls: FoldedToolCall[];
      meta?: AssistantMeta;
      /** The `assistant_message` event's `ts`, epoch ms. */
      ts?: number;
      /** The first delta that carried reasoning, epoch ms — the live header's
       *  timer counts from here. Only a streamed row knows it. */
      thinkingStartedAt?: number;
      /** How long the model reasoned before its first visible word (or, with
       *  no text at all, before the turn settled). Derived from event
       *  timestamps, never a stopwatch, so live and replay agree — and absent
       *  when the transcript kept no deltas to measure from. */
      thinkingMs?: number;
      /** What produced THIS turn, from the `run_started` line in effect when
       *  the row opened. Per-row, not per-thread: a conversation continued on
       *  another model has turns from both, and one label over all of them is
       *  wrong for every turn but the last. Absent on rows folded from
       *  transcripts written before the fold read `run_started`. */
      provider?: ProviderId;
      model?: string;
    }
  | {
      kind: "compaction";
      summary: string;
      /** Conversation rows that preceded the marker — i.e. what the model
       *  stopped seeing verbatim from this point on. Derived here rather than
       *  carried on the wire, which has no count. */
      count: number;
    }
  | { kind: "observer"; shellId: string }
  | {
      kind: "steering";
      reason: string;
    }
  | {
      /** The turn above was killed with the process: a later turn began while
       *  it had neither a result nor an error. See `interruptedMsg`. */
      kind: "interrupted";
    };

type AssistantRow = Extract<FoldedRow, { kind: "assistant" }>;

export type FoldPricing = { inputPerMillion: number; outputPerMillion: number } | null;

/** Live-path measurements the fold cannot know from the events alone: the
 *  panel's wall-clock turn duration and its own first-delta TTFT fallback
 *  (for turns the harness recorded no timing for). Purely presentational —
 *  neither may feed the tok/s rule. */
export type FoldLiveTiming = {
  turnMs?: number;
  ttftFallbackMs?: number;
};

/** What one `apply` did: which row indices were created or mutated, and — when
 *  the event closed an assistant turn — that turn's meta. */
export type FoldStep = {
  changed: number[];
  finalizedMeta?: AssistantMeta;
};

export type FoldOptions = {
  /** Per-token list prices for cost estimation when the provider reports no
   *  cost of its own. The replay path passes none: a transcript either carried
   *  the provider's own figure or shows no cost. */
  pricing?: FoldPricing;
  /** Start the fold with one open (still-streaming) empty assistant row. The
   *  live path uses this to adopt the placeholder bubble the panel inserts
   *  before the run's first event arrives. */
  seedOpenAssistant?: boolean;
};

export type FoldHandle = {
  /** Feed one event. Cheap enough for per-token deltas: a delta is a string
   *  append on the open row. Returns which rows it touched. */
  apply(event: AgentEvent, live?: FoldLiveTiming): FoldStep;
  /** The current rows. The array and its row objects are mutated in place by
   *  `apply`; project them (see `foldedRowToMsgs`) before handing to React. */
  rows(): FoldedRow[];
};

export function createFold(opts: FoldOptions = {}): FoldHandle {
  const rows: FoldedRow[] = [];
  const pricing = opts.pricing ?? null;
  let turnStartTs: number | undefined;
  /** A `user_message` opened a turn that nothing has answered or settled yet —
   *  no `assistant_message`, no `run_result`, no `run_error`. The next turn
   *  starting while this is set means the process died before the reply
   *  landed: the Harness writes one of those three on every exit it controls. */
  let turnOpen = false;
  // The still-streaming assistant row deltas accumulate into. Closed by the
  // turn's `assistant_message`, and by any event that means "the next text
  // belongs below me" (tool card, steering marker, user turn) — mirroring how
  // the live view splits a turn's text around its tool cards.
  let open: { row: AssistantRow; idx: number } | null = null;
  // Text this turn has already committed to rows *above* the one still open.
  //
  // A turn's text is split into several rows when work interrupts it — a tool
  // card, a steering marker. The closing `assistant_message` then carries the
  // turn's text *whole*, which is right for one row and wrong for several: it
  // would repeat, in the last row, everything the earlier rows already show.
  // A delegate CLI makes this the normal case rather than an edge one, since
  // its own tool calls interleave with its prose inside a single turn.
  let turnRendered = "";
  // Bank an interrupted row's text and start a new bubble below the card.
  const splitRow = () => {
    if (open) turnRendered += open.row.text;
    open = null;
  };
  // The pair the harness last said it was dispatching with. Every assistant row
  // is stamped with whatever this holds when the row opens, so the stamp is a
  // fact about that turn rather than about the conversation.
  let dispatch: { provider: ProviderId; model: string } | null = null;
  let completionMode: AgentMode | undefined;
  let completed = false;
  let attemptStart = 0;
  const changedFiles = new Set<string>();
  // Keyed by path: a command may rewrite the same deck twice in a run, and the
  // last size is the one on disk. `created` stays true once true — the run did
  // make the file, whatever it did to it afterwards.
  const producedFiles = new Map<string, { path: string; bytes: number; created: boolean }>();
  const commands = new Map<string, RunCompletion["commands"][number]>();
  const completionWarnings = new Set<string>();

  // A path that also came through a write tool belongs to Changes, not here:
  // that one has a checkpoint behind it, so it can be diffed and reverted.
  const producedArtifacts = () =>
    [...producedFiles.values()].filter((artifact) => !changedFiles.has(artifact.path));

  const newAssistant = (): AssistantRow => ({
    kind: "assistant",
    text: "",
    toolCalls: [],
    provider: dispatch?.provider,
    model: dispatch?.model,
  });

  if (opts.seedOpenAssistant) {
    const seeded = newAssistant();
    rows.push(seeded);
    open = { row: seeded, idx: 0 };
  }

  const lastAssistant = (): { row: AssistantRow; idx: number } | null => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row.kind === "assistant") return { row, idx: i };
    }
    return null;
  };

  // Walk every assistant row, most-recent first. A tool call can be attached
  // to a non-final assistant (e.g. streamed tool calls interleaved with
  // follow-up text), so we don't just look at the last row.
  const findTool = (
    toolCallId: string,
  ): { call: FoldedToolCall; idx: number } | null => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row.kind !== "assistant") continue;
      const found = row.toolCalls.find((t) => t.id === toolCallId);
      if (found) return { call: found, idx: i };
    }
    return null;
  };

  const upsertTool = (
    toolCallId: string,
    patch: (t: FoldedToolCall) => void,
  ): number => {
    const existing = findTool(toolCallId);
    if (existing) {
      patch(existing.call);
      return existing.idx;
    }
    let host = lastAssistant();
    if (!host) {
      const created = newAssistant();
      rows.push(created);
      host = { row: created, idx: rows.length - 1 };
    }
    const created: FoldedToolCall = {
      id: toolCallId,
      name: "tool",
      input: undefined,
      status: "unknown",
    };
    host.row.toolCalls.push(created);
    patch(created);
    return host.idx;
  };

  const apply = (event: AgentEvent, live?: FoldLiveTiming): FoldStep => {
    if (event.type === "run_result" || event.type === "run_error" || event.type === "assistant_message") turnOpen = false;
    // A turn that never settled before the next one began was killed with the
    // app. Its rows stay as they were; one marker in their place says why the
    // answer is missing, and the new turn opens below it.
    const interrupted: number[] = [];
    if ((event.type === "run_started" || event.type === "user_message") && turnOpen) {
      turnOpen = false;
      open = null;
      rows.push({ kind: "interrupted" });
      interrupted.push(rows.length - 1);
    }

    if (event.type === "run_started") {
      completionMode = event.mode;
      completed = false;
      attemptStart = open && !open.row.text && !open.row.toolCalls.length ? open.idx : rows.length;
      changedFiles.clear();
      producedFiles.clear();
      commands.clear();
      completionWarnings.clear();
      dispatch = { provider: event.provider, model: event.model };
      // The live path seeds an open placeholder *before* the run starts, so the
      // row that will carry this turn already exists and has to be stamped
      // here. A row that already carries a pair keeps it: a continuation opens
      // its own row, and restamping would rewrite the turn above it.
      if (open && open.row.model === undefined && open.row.provider === undefined) {
        open.row.provider = dispatch.provider;
        open.row.model = dispatch.model;
        return { changed: [...interrupted, open.idx] };
      }
      return { changed: interrupted };
    }

    if (event.type === "user_message") {
      turnOpen = true;
      turnStartTs = event.ts;
      open = null;
      turnRendered = "";
      rows.push({
        kind: "user",
        text: event.text,
        attachments: event.attachments?.length ? event.attachments : undefined,
        ts: event.ts,
      });
      return { changed: [...interrupted, rows.length - 1] };
    }

    if (event.type === "assistant_delta") {
      if (!open) {
        const created = newAssistant();
        rows.push(created);
        open = { row: created, idx: rows.length - 1 };
      }
      open.row.text += event.text;
      if (event.thinking) {
        open.row.thinking = (open.row.thinking ?? "") + event.thinking;
        open.row.thinkingStartedAt ??= event.ts;
      }
      // The first visible word closes the thinking span.
      if (event.text && open.row.thinkingStartedAt !== undefined && open.row.thinkingMs === undefined) {
        open.row.thinkingMs = Math.max(0, event.ts - open.row.thinkingStartedAt);
      }
      return { changed: [open.idx] };
    }

    if (event.type === "assistant_message") {
      const text = remainingText(extractAssistantText(event.content), turnRendered);
      const eventThinking = event.content
        .filter(isThinkingBlock)
        .map((b) => b.text)
        .join("")
        .trim();
      const toolBlocks = event.content.filter(isToolCallBlock);

      const ms =
        live?.turnMs ??
        (turnStartTs !== undefined && event.ts >= turnStartTs
          ? event.ts - turnStartTs
          : undefined);
      turnStartTs = event.ts;

      // Finalize the streaming row when one is open, else start a fresh one —
      // each `assistant_message` is one turn, live and on replay alike.
      let target: { row: AssistantRow; idx: number };
      if (open) {
        target = open;
        open = null;
      } else {
        const created = newAssistant();
        rows.push(created);
        target = { row: created, idx: rows.length - 1 };
      }
      const { row, idx } = target;
      // Empty final text with streamed deltas → keep the streamed content.
      row.text = text || row.text;
      row.thinking = eventThinking || row.thinking || undefined;
      // A turn that thought and then went straight to tools (or said nothing)
      // never had a first word — the settle is the span's end.
      if (row.thinking && row.thinkingStartedAt !== undefined && row.thinkingMs === undefined) {
        row.thinkingMs = Math.max(0, event.ts - row.thinkingStartedAt);
      }
      for (const b of toolBlocks) {
        if (row.toolCalls.some((t) => t.id === b.toolCallId)) continue;
        row.toolCalls.push({
          id: b.toolCallId,
          name: b.name,
          input: b.input,
          status: "unknown",
        });
      }
      const meta = computeMeta(row.text, row.thinking, ms, event.usage, event.timing, {
        ttftFallbackMs: live?.ttftFallbackMs,
        pricing,
      });
      row.meta = meta ?? undefined;
      row.ts = event.ts;
      turnRendered = "";
      return { changed: [idx], finalizedMeta: meta ?? undefined };
    }

    if (event.type === "tool_call_started") {
      if (event.capability === "run_command" || (!event.capability && event.name === "run_command")) {
        const input = event.input as { command?: unknown } | null;
        commands.set(event.toolCallId, {
          id: event.toolCallId,
          label: typeof input?.command === "string" ? input.command : event.summary || event.name,
          status: "unknown",
        });
      }
      const idx = upsertTool(event.toolCallId, (t) => {
        t.name = event.name;
        t.input = event.input;
        t.summary = event.summary;
        t.status = "started";
      });
      // A tool card sits below the turn's text; whatever streams next belongs
      // in a new bubble under the card, not merged above it.
      splitRow();
      return { changed: [idx] };
    }

    if (event.type === "tool_call_finished") {
      const command = commands.get(event.toolCallId);
      if (command) {
        command.status = event.result.ok ? "passed" : "failed";
        command.output = event.result.content.length > 2000
          ? `Last 2,000 characters of output:\n${event.result.content.slice(-2000)}`
          : event.result.content;
      }
      const idx = upsertTool(event.toolCallId, (t) => {
        t.result = { content: event.result.content, ok: event.result.ok };
        t.status = "finished";
      });
      return { changed: [idx] };
    }

    // The worker a dispatch actually went to is decided on the card, not in
    // the call: Kit may name Claude Code and the user pick OpenRouter. The
    // event carries what was decided — worker, branch, model — so it is
    // written onto the call's own input, and every row that reads the call
    // (the delegated-to line, the participants strip) says who really took it.
    if (event.type === "subagent_requested") {
      const prefix = `sub_${event.runId}_`;
      if (!event.requestId.startsWith(prefix)) return { changed: [] };
      const idx = upsertTool(event.requestId.slice(prefix.length), (t) => {
        // The child's address, whether or not a worker took the task: a
        // subagent on our own model is watchable too.
        t.childRunId = event.requestId;
        if (!event.worker) return;
        const input = t.input && typeof t.input === "object" && !Array.isArray(t.input)
          ? { ...(t.input as Record<string, unknown>) }
          : {};
        input.worker = event.worker;
        if (event.branch) input.branch = event.branch;
        if (event.model) input.model = event.model;
        t.input = input;
      });
      return { changed: [idx] };
    }

    // Work a delegate CLI did on its own. Same row shape as a dispatched call
    // so the conversation reads consistently, tagged with who ran it so nothing
    // downstream can claim Klide gated it.
    if (event.type === "observed_tool_call") {
      const idx = upsertTool(event.toolCallId, (t) => {
        t.name = event.name;
        t.input = event.input;
        t.summary = event.summary;
        t.status = "started";
        t.observedBy = event.provider;
      });
      splitRow();
      return { changed: [idx] };
    }

    if (event.type === "observed_tool_result") {
      const idx = upsertTool(event.toolCallId, (t) => {
        t.result = { content: event.content, ok: event.ok };
        t.status = "finished";
      });
      return { changed: [idx] };
    }

    if (event.type === "file_changed") {
      changedFiles.add(event.path);
      return { changed: [] };
    }

    if (event.type === "artifact_produced") {
      const seen = producedFiles.get(event.path);
      producedFiles.set(event.path, {
        path: event.path,
        bytes: event.bytes,
        created: seen?.created || event.created,
      });
      return { changed: [] };
    }

    if (event.type === "permission_resolved" && event.decision.behavior === "deny") {
      completionWarnings.add("A permission was denied. Review the conversation for work that may have been skipped.");
      return { changed: [] };
    }

    if (event.type === "run_result" && event.result.status === "done" && completionMode === "goal" && !completed) {
      completed = true;
      splitRow();
      const answer = rows.slice(attemptStart).reverse().find((row) => row.kind === "assistant" && row.text.trim());
      const outcome = event.result.message?.trim() || (answer?.kind === "assistant" ? answer.text.trim().split(/\n\s*\n/)[0] : "") || "Run completed. Review the recorded evidence below.";
      rows.push({ kind: "completion", completion: {
        runId: event.runId,
        completedAt: event.ts,
        outcome: outcome.slice(0, 280) + (outcome.length > 280 ? "…" : ""),
        files: [...changedFiles],
        artifacts: producedArtifacts(),
        commands: [...commands.values()].map((command) => ({ ...command })),
        warnings: [...completionWarnings],
      } });
      return { changed: [rows.length - 1] };
    }

    // An attempt that stopped early still left work on disk — the edits it
    // applied before it died are real, unreviewed files, and inline diff rows
    // are the only trace of them. So a stop earns the same entry point, with
    // `stopped` set so nothing about it reads as a finished result. Gated on
    // evidence: a failure that changed nothing already says everything in its
    // "Run failed" line, and a second row there would be noise.
    if (
      (event.type === "run_error" ||
        (event.type === "run_result" && event.result.status !== "done")) &&
      completionMode === "goal" &&
      !completed &&
      (changedFiles.size > 0 || commands.size > 0)
    ) {
      completed = true;
      splitRow();
      const reason =
        event.type === "run_error"
          ? event.error.message.trim()
          : event.result.message?.trim() ||
            (event.result.status === "max_turns"
              ? "The run hit its turn cap."
              : "The run was stopped.");
      rows.push({
        kind: "completion",
        completion: {
          runId: event.runId,
          completedAt: event.ts,
          outcome: reason.slice(0, 280) + (reason.length > 280 ? "…" : ""),
          files: [...changedFiles],
          artifacts: producedArtifacts(),
          commands: [...commands.values()].map((command) => ({ ...command })),
          warnings: [
            "The run stopped before finishing — this work is partial.",
            ...completionWarnings,
          ],
          stopped: true,
        },
      });
      return { changed: [rows.length - 1] };
    }

    if (event.type === "context_compacted") {
      // The auto-compactor collapsed the older turns for the *model*. The
      // transcript still holds them all, so replay renders everything — but it
      // has to render the marker too, or a reloaded conversation looks like an
      // unbroken thread that mysteriously forgot its early turns.
      rows.push({
        kind: "compaction",
        summary: event.summary,
        count: rows.length,
      });
      return { changed: [rows.length - 1] };
    }

    if (event.type === "observer_completed") {
      // An observer starts a fresh response without inventing a user message.
      splitRow();
      turnOpen = true;
      turnStartTs = event.ts;
      turnRendered = "";
      completed = false;
      attemptStart = rows.length;
      changedFiles.clear();
      producedFiles.clear();
      commands.clear();
      completionWarnings.clear();
      rows.push({ kind: "observer", shellId: event.shellId });
      return { changed: [rows.length - 1] };
    }

    if (event.type === "steering_injected") {
      // A marker that lands before the turn has said anything — an agent
      // message delivered at the turn boundary is the usual case — goes
      // *above* the still-empty open row, which then receives the turn's
      // text. Splitting here would strand an empty assistant row above the
      // marker, and the panel would draw a second model mark for it.
      if (open && open.idx === rows.length - 1 && !open.row.text && !open.row.thinking && open.row.toolCalls.length === 0) {
        rows.splice(open.idx, 0, { kind: "steering", reason: event.reason });
        open.idx += 1;
        return { changed: [open.idx - 1, open.idx] };
      }
      splitRow();
      rows.push({ kind: "steering", reason: event.reason });
      return { changed: [rows.length - 1] };
    }

    return { changed: [] };
  };

  return { apply, rows: () => rows };
}

/** Replay pace: drain a whole transcript through the same fold. */
export function foldAgentEvents(events: AgentEvent[]): FoldedRow[] {
  const fold = createFold();
  for (const event of events) fold.apply(event);
  return fold.rows();
}

/** What is left of a turn's whole text once the rows above have had their say.
 *
 *  `already` is the text banked from rows this turn split off. When the whole
 *  text still begins with it — the normal case, since both are built from the
 *  same stream — only the remainder belongs in the last row. When it does not
 *  (a provider that returns cleaned-up text rather than what it streamed), the
 *  whole text is kept: showing a line twice is a blemish, dropping one is a
 *  lie.
 */
function remainingText(text: string, already: string): string {
  if (!already) return text;
  for (const prefix of [already, already.trimStart(), already.trim()]) {
    if (prefix && text.startsWith(prefix)) return text.slice(prefix.length);
  }
  return text;
}

/** The one "text of an assistant message" rule: concatenated text blocks.
 *  Shared by the fold, AiPanel's subagent/advisor report accumulation, and
 *  the advisor consult — they must agree on what the model "said". */
export function extractAssistantText(content: AgentContentBlock[]): string {
  return content.filter(isTextBlock).map((b) => b.text).join("");
}

function computeMeta(
  text: string,
  thinking: string | undefined,
  ms: number | undefined,
  usage: AgentUsage | undefined,
  timing: AgentTurnTiming | undefined,
  extra: { ttftFallbackMs?: number; pricing: FoldPricing },
): AssistantMeta | null {
  const hasUsage = usage?.completionTokens !== undefined;
  const estimated = estimateTokens(text) + estimateTokens(thinking ?? "");
  const tokens = hasUsage ? usage!.completionTokens! : estimated;
  // Decode window, best source first: the provider's own eval duration, then
  // the harness-measured provider time minus TTFT. Wall clock is never used —
  // it includes every tool call and diff-review pause of the turn, so a
  // wall-clock tok/s is a lie both live and on replay.
  const decodeMs =
    usage?.evalDurationMs !== undefined && usage.evalDurationMs > 0
      ? usage.evalDurationMs
      : timing !== undefined
        ? timing.modelMs - (timing.ttftMs ?? 0)
        : undefined;
  const tps =
    tokens > 0 && decodeMs !== undefined && decodeMs > 100
      ? Math.round(tokens / (decodeMs / 1000))
      : undefined;
  if (ms === undefined && !tokens && tps === undefined && timing === undefined) return null;
  // Per-turn cost: the provider's own figure wins (OpenRouter reports the real
  // charged amount); otherwise token counts × list price when the caller
  // supplied pricing. Local / subscription turns leave costUsd undefined.
  const costUsd =
    usage?.costUsd !== undefined
      ? usage.costUsd
      : extra.pricing && usage?.promptTokens !== undefined && usage?.completionTokens !== undefined
        ? (usage.promptTokens * extra.pricing.inputPerMillion +
            usage.completionTokens * extra.pricing.outputPerMillion) /
          1_000_000
        : undefined;
  return {
    ms,
    modelMs: timing?.modelMs,
    ttftMs: timing?.ttftMs ?? extra.ttftFallbackMs,
    tokens: tokens || undefined,
    tokensEstimate: hasUsage ? undefined : estimated || undefined,
    promptTokens: usage?.promptTokens,
    tps,
    exact: hasUsage,
    costUsd,
  };
}

function isTextBlock(
  b: AgentContentBlock,
): b is { type: "text"; text: string } {
  return b.type === "text";
}
function isThinkingBlock(
  b: AgentContentBlock,
): b is { type: "thinking"; text: string } {
  return b.type === "thinking";
}
function isToolCallBlock(
  b: AgentContentBlock,
): b is {
  type: "tool_call";
  toolCallId: string;
  name: string;
  input: unknown;
} {
  return b.type === "tool_call";
}

// ── Mappers ──────────────────────────────────────────────────────────────
// Each consumer picks the field it cares about. The AI panel keeps separate
// `role: "tool"` rows for tool results (so the renderer can show the call
// info and the result on distinct rows). Mission Control folds tool calls
// into the assistant's `tools` field with full lifecycle.

/** Presentation options for the Msg projection. Replay passes none; the live
 *  view tags rows with its delegate flags and shows "Running…" placeholders
 *  for calls that have started but not finished. */
export type FoldedMsgView = {
  delegate?: { delegateConsole?: boolean; delegateProvider?: string; delegateHeadless?: true };
  runningPlaceholders?: boolean;
};

/** The one compaction-marker Msg. Shared by the replay mapper below and the
 *  live `context_compacted` handler in AiPanel — the marker must read the
 *  same in both; only `count` differs by what each side could see. */
export function compactionMsg(count: number, summary: string): Msg {
  return {
    role: "system",
    // Plain-text fallback for serialization and search.
    content: `Compacted ${count} earlier message${count === 1 ? "" : "s"} to free context.`,
    // "agent" layout (the slim tool-style row): the wire event carries no
    // manual/automatic distinction, and the unobtrusive row is the safe
    // default for a harness-emitted marker.
    compaction: { count, summary, source: "agent" },
  };
}

/** Project one row into the AI panel's Msg shape. Rows are independent, so
 *  the live path can re-project only the rows an event touched and keep every
 *  other Msg reference stable across renders. */
export function foldedRowToMsgs(row: FoldedRow, view: FoldedMsgView = {}): Msg[] {
  if (row.kind === "completion") {
    return [{ role: "system", content: row.completion.outcome, completion: row.completion }];
  }
  if (row.kind === "user") {
    return [
      {
        role: "user",
        content: row.text,
        attachments: row.attachments,
        ts: row.ts,
      },
    ];
  }
  if (row.kind === "compaction") {
    return [compactionMsg(row.count, row.summary)];
  }
  if (row.kind === "observer") {
    return [{ role: "system", content: "Background observer finished", observer: { shellId: row.shellId } }];
  }
  if (row.kind === "steering") {
    return [
      {
        role: "system",
        content: row.reason,
        steering: { reason: row.reason },
      },
    ];
  }
  if (row.kind === "interrupted") {
    return [interruptedMsg()];
  }
  const msgs: Msg[] = [
    {
      role: "assistant",
      content: row.text,
      // What ran this turn — `run_started` already types its provider as a
      // `ProviderId`, so this travels the whole fold without a cast.
      provider: row.provider,
      model: row.model,
      thinking: row.thinking,
      thinkingStartedAt: row.thinkingStartedAt,
      thinkingMs: row.thinkingMs,
      toolCalls: row.toolCalls.length
        ? row.toolCalls.map((t) => ({
            id: t.id,
            name: t.name,
            // The raw input object, not a JSON string — the renderer's
            // structured rows (spawn_subagent, path summaries) read fields
            // off it, and the memory summarizer extracts file paths from it.
            args: t.input,
            childRunId: t.childRunId,
          }))
        : undefined,
      meta: row.meta
        ? {
            ms: row.meta.ms,
            modelMs: row.meta.modelMs,
            ttftMs: row.meta.ttftMs,
            tokens: row.meta.tokens,
            promptTokens: row.meta.promptTokens,
            tps: row.meta.tps,
            exact: row.meta.exact,
            costUsd: row.meta.costUsd,
          }
        : undefined,
      ts: row.ts,
      ...view.delegate,
    },
  ];
  for (const t of row.toolCalls) {
    if (t.result) {
      msgs.push({
        role: "tool",
        content: t.result.content,
        toolName: t.name,
        toolCallId: t.id,
        observedBy: t.observedBy,
      });
    } else if (view.runningPlaceholders && t.status === "started") {
      msgs.push({
        role: "tool",
        // Same "Running …" convention for both, so the row renders as pending
        // either way. For an observed call it names the delegate's own step.
        content: `Running ${t.observedBy ? (t.summary ?? t.name) : t.name}...`,
        toolName: t.name,
        toolCallId: t.id,
        observedBy: t.observedBy,
      });
    }
  }
  return msgs;
}

/**
 * The panel line for a turn the app was closed on. The fold draws it once a
 * later turn is written (an open turn followed by another); for the tail of a
 * transcript only the panel can, because only it knows Rust holds no live run
 * — `followConversationRun` appends this same line there.
 */
export function interruptedMsg(): Msg {
  return { role: "system", content: "Interrupted", runInterrupted: true };
}

export function foldedToMsgs(rows: FoldedRow[]): Msg[] {
  return rows.flatMap((row) => foldedRowToMsgs(row));
}

export function foldedToRunMessages(rows: FoldedRow[]): RunMessage[] {
  const out: RunMessage[] = [];
  for (const row of rows) {
    if (row.kind === "user") {
      out.push({ role: "user", text: row.text });
      continue;
    }
    // `RunMessage.role` is "user" | "assistant" by wire contract (the Rust
    // struct and every Delegate adapter agree), so AI-panel transcript
    // annotations have no row to occupy in Mission Control.
    if (row.kind === "observer" || row.kind === "compaction" || row.kind === "steering" || row.kind === "completion" || row.kind === "interrupted") continue;
    if (!row.text.trim() && row.toolCalls.length === 0) continue;
    out.push({
      role: "assistant",
      text: row.text,
      tools: row.toolCalls.length
        ? row.toolCalls.map(toRunToolCall)
        : undefined,
    });
  }
  return out;
}

function toRunToolCall(t: FoldedToolCall): RunToolCall {
  return {
    id: t.id,
    name: t.name,
    input: t.input,
    summary: t.summary,
    result: t.result?.content,
    ok: t.result?.ok,
    status: t.status,
  };
}
