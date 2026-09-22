import type {
  AgentAttachment as Attachment,
  AgentContextPayload as ProjectContextPayload,
  AgentMode,
  ProviderId,
} from "../../agent/types";
import type { AgentToolCall as ToolCall } from "../../agent/tools";
import type { RunCompletion } from "../../agent/completion";

export type Msg =
  | {
      role: "user";
      content: string;
      attachments?: Attachment[];
      projectContext?: ProjectContextPayload;
      queueState?: "queued" | "running";
      queueId?: string;
      /** Set when this turn was dispatched to a named subagent via `@<id>`. */
      subagent?: string;
      /** A turn with no words from the user: the panel started it so the Run
       *  reads a message another agent left, once the user let it in. Drawn
       *  as nothing — the received line on the response says why it spoke. */
      wake?: true;
      /** Exact token count for this message's text under the active model's own
       *  tokenizer (Ollama / Anthropic). `exact` is false when the provider has
       *  no tokenizer endpoint and the number is a length-based estimate. */
      tokenInfo?: { count: number; exact: boolean };
      /** When this turn was sent, epoch ms. Persisted with the conversation, so
       *  a reopened thread can still place its messages in time. Absent on
       *  messages written before timestamps were recorded. */
      ts?: number;
    }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ToolCall[];
      thinking?: string;
      /** When reasoning began streaming, epoch ms — anchors the live
       *  "Thinking" timer so it survives a re-render. */
      thinkingStartedAt?: number;
      /** How long the model reasoned before its first visible word, from
       *  event timestamps (see foldEvents). Absent when nothing measured it;
       *  the header then says "Thought process" instead of a duration. */
      thinkingMs?: number;
      delegateConsole?: boolean;
      delegateProvider?: string;
      /** A Delegate CLI answering through the Harness in one piece (the Focus
       *  headless path) — no token arrives before the whole reply does, so the
       *  panel shows a status word and a clock instead of the streaming loader. */
      delegateHeadless?: true;
      /** What produced THIS turn — the pair the harness dispatched it with, as
       *  recorded by the `run_started` line in effect at the time. The
       *  discussion draws each response's mark from it, so a thread continued
       *  on another model shows both. Absent on turns stored before the fold
       *  read `run_started`; readers fall back to the thread's origin. */
      provider?: ProviderId;
      model?: string;
      /** Set when this message is a background subagent's report (dispatched
       *  via an embedded `@role` mention that ran concurrently with the main
       *  answer). `subagentPending` is true while it's still working. */
      subagent?: string;
      subagentRunId?: string;
      subagentPending?: boolean;
      /** Quiet per-message footer: duration, tokens, time to first token,
       *  and decode speed. `exact` is true when token/speed numbers come
       *  from the provider's own usage block rather than a length estimate.
       *  `modelMs` is the harness-measured provider time; `ms` is wall clock
       *  since the previous turn boundary and therefore also counts tool runs
       *  and diff-review waiting. */
      meta?: { ms?: number; modelMs?: number; tokens?: number; promptTokens?: number; ttftMs?: number; tps?: number; exact?: boolean; costUsd?: number };
      /** When this turn landed, epoch ms — the `assistant_message` event's own
       *  `ts`, so live and replayed transcripts agree. */
      ts?: number;
    }
  | {
      role: "system";
      content: string;
      completion?: RunCompletion;
      /** A command completed and opened a new reply, without a user message. */
      observer?: { shellId: string };
      /** Set when this system message is a context-compaction marker, so the
       *  chat renders it as a compaction card instead of a text blob.
       *  `content` is kept as a plain-text fallback (serialization, search).
       *  `source` picks the layout: "manual" (user ran /compact) → a deliberate
       *  full-width divider row; "agent" (inline/automatic) → a slim tool-style
       *  row that nests in the run's tool flow. */
      compaction?: {
        count: number;
        summary: string;
        source?: "manual" | "agent";
        /** Breakdown shown in the marker: conversation messages + tool calls
         *  folded. Optional for back-compat with markers written before this. */
        messages?: number;
        toolCalls?: number;
      };
      /** Set when this system message is a loop-monitor steering marker, so the
       *  chat renders it as a slim intervention line instead of a text blob.
       *  `content` keeps a plain-text fallback (serialization, search). */
      steering?: {
        reason: string;
      };
      /** Set when this system message reports the run's terminal failure, so
       *  the chat renders it as a centered hairline row (the same family as
       *  the "Starting {provider} local server…" line) instead of a text blob.
       *  `content` keeps a plain-text fallback (serialization, search). */
      runError?: {
        message: string;
      };
      /** Set when the turn above never settled — no result, no error — because
       *  the app was closed while it ran. Drawn as a quiet centered line with a
       *  Retry; not a failure, so not the Run-failed red. */
      runInterrupted?: true;
    }
  | {
      role: "tool";
      content: string;
      toolName: string;
      toolCallId?: string;
      /** Provider id of the *delegate CLI* that ran this itself (e.g.
       *  `claude-code`). Absent for tools Klide dispatched. The row says so,
       *  because Klide applied no capability, permission prompt or diff review
       *  to an observed call and must not look as though it did. */
      observedBy?: string;
      /** Legacy duplicate of `toolCallId`, written by the pre-2026-08 live
       *  path only so it could match its own rows. Nothing writes or reads it
       *  anymore; the field stays so stored conversations that carry it keep
       *  round-tripping through this type. */
      tool_call_id?: string;
    };

export type QueuedTurn = {
  clientId: string;
  text: string;
  mode: AgentMode;
  provider: ProviderId;
  model: string;
  modelSupportsTools: boolean;
  modelSupportsReflection: boolean;
  reflectionLevel?: string;
  attachments: Attachment[];
  projectContext?: ProjectContextPayload;
  /** Set when the user dispatched this turn to a named subagent via `@<id>`. */
  subagent?: string;
  /** See `Msg.wake`. Sent with empty text; the harness records no user message. */
  wake?: true;
};

export type Conversation = {
  id: string;
  title: string;
  /** Set once the person named this thread themselves. A derived title is
   *  recomputed from the first user message on every save; a given one is
   *  kept by `upsertConversation` no matter what the next snapshot says. */
  renamed?: boolean;
  msgs: Msg[];
  updatedAt: number;
  /** When the conversation began, epoch ms. Set from the first message's own
   *  `ts` and then preserved across every save — `updatedAt` is overwritten on
   *  each token, so without this a thread has no start and no duration.
   *  Optional: conversations stored before this field existed fall back to
   *  `conversationStartedAt()`. */
  createdAt?: number;
  provider?: ProviderId;
  model?: string | null;
  cwd?: string | null;
  branch?: string | null;
  worktree?: string | null;
  forkedFrom?: {
    conversationId: string;
    title: string;
    messageIndex: number;
    createdAt: number;
    mode: "chat" | "worktree";
  } | null;
};

export type PendingEditRequest = {
  path: string;
  fullPath: string;
  oldContent: string;
  newContent: string;
  isCreate: boolean;
  resolve: (result: string) => void;
};

export const MAX_TOOL_CALLS = 10;
