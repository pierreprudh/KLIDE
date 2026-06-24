import type {
  AgentAttachment as Attachment,
  AgentContextPayload as ProjectContextPayload,
  AgentMode,
  ProviderId,
} from "../../agent/types";
import type { AgentToolCall as ToolCall } from "../../agent/tools";

export type Msg =
  | {
      role: "user";
      content: string;
      attachments?: Attachment[];
      projectContext?: ProjectContextPayload;
      queueState?: "queued" | "running";
      queueId?: string;
      /** Exact token count for this message's text under the active model's own
       *  tokenizer (Ollama / Anthropic). `exact` is false when the provider has
       *  no tokenizer endpoint and the number is a length-based estimate. */
      tokenInfo?: { count: number; exact: boolean };
    }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ToolCall[];
      thinking?: string;
      delegateConsole?: boolean;
      delegateProvider?: string;
      /** Quiet per-message footer: duration, tokens, time to first token,
       *  and decode speed. `exact` is true when token/speed numbers come
       *  from the provider's own usage block rather than a length estimate. */
      meta?: { ms?: number; tokens?: number; promptTokens?: number; ttftMs?: number; tps?: number; exact?: boolean; costUsd?: number };
    }
  | {
      role: "system";
      content: string;
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
    }
  | { role: "tool"; content: string; toolName: string; toolCallId?: string; tool_call_id?: string };

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
};

export type Conversation = {
  id: string;
  title: string;
  msgs: Msg[];
  updatedAt: number;
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
