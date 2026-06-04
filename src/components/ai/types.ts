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
    }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ToolCall[];
      thinking?: string;
      delegateConsole?: boolean;
      delegateProvider?: string;
    }
  | { role: "system"; content: string }
  | { role: "tool"; content: string; toolName: string; toolCallId?: string; tool_call_id?: string };

export type QueuedTurn = {
  clientId: string;
  text: string;
  mode: AgentMode;
  provider: ProviderId;
  model: string;
  modelSupportsTools: boolean;
  attachments: Attachment[];
  projectContext?: ProjectContextPayload;
};

export type Conversation = {
  id: string;
  title: string;
  msgs: Msg[];
  updatedAt: number;
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
