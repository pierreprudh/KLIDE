import type {
  AgentEvent,
  AgentMessageView,
  AgentRunView,
  AgentState,
  AgentTimelineItem,
} from "./types";

export const initialAgentState: AgentState = {
  runs: {},
  activeRunId: null,
};

function runOrCreate(state: AgentState, event: AgentEvent): AgentRunView | null {
  const existing = state.runs[event.runId];
  if (existing) return existing;
  if (event.type !== "run_started") return null;
  return {
    id: event.runId,
    status: "running",
    mode: event.mode,
    provider: event.provider,
    model: event.model,
    messages: [],
    timeline: [],
  };
}

function textFromContent(content: AgentEvent extends infer _ ? any : never): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" || block?.type === "thinking")
    .map((block) => String(block.text ?? ""))
    .join("");
}

function upsertAssistantDelta(messages: AgentMessageView[], messageId: string, text: string, thinking?: string) {
  const index = messages.findIndex((m) => m.id === messageId);
  if (index === -1) {
    return [
      ...messages,
      { id: messageId, role: "assistant" as const, text, thinking },
    ];
  }
  return messages.map((m, i) =>
    i === index
      ? { ...m, text: `${m.text}${text}`, thinking: [m.thinking, thinking].filter(Boolean).join("\n") || undefined }
      : m
  );
}

export function agentReducer(state: AgentState, event: AgentEvent): AgentState {
  const current = runOrCreate(state, event);
  if (!current) return state;
  let run = current;

  switch (event.type) {
    case "run_started":
      run = {
        ...current,
        status: "running",
        mode: event.mode,
        provider: event.provider,
        model: event.model,
      };
      break;
    case "context_snapshot":
      run = { ...current, context: event.snapshot };
      break;
    case "user_message":
      run = {
        ...current,
        messages: [
          ...current.messages,
          {
            id: event.messageId,
            role: "user",
            text: event.text,
            attachments: event.attachments,
          },
        ],
      };
      break;
    case "assistant_delta":
      run = {
        ...current,
        messages: upsertAssistantDelta(
          current.messages,
          event.messageId,
          event.text,
          event.thinking
        ),
      };
      break;
    case "assistant_message":
      run = {
        ...current,
        messages: current.messages.some((m) => m.id === event.messageId)
          ? current.messages.map((m) =>
              m.id === event.messageId
                ? { ...m, text: textFromContent(event.content) }
                : m
            )
          : [
              ...current.messages,
              { id: event.messageId, role: "assistant", text: textFromContent(event.content) },
            ],
      };
      break;
    case "tool_call_started":
      run = {
        ...current,
        timeline: [
          ...current.timeline,
          {
            type: "tool",
            toolCallId: event.toolCallId,
            name: event.name,
            summary: event.summary,
            status: "running",
          },
        ],
      };
      break;
    case "tool_call_finished":
      run = {
        ...current,
        timeline: current.timeline.map((item): AgentTimelineItem =>
          item.type === "tool" && item.toolCallId === event.toolCallId
            ? { ...item, status: "done", result: event.result }
            : item
        ),
      };
      break;
    case "permission_requested":
      run = {
        ...current,
        status: "waiting_for_permission",
        pendingPermission: event.request,
        timeline: [...current.timeline, { type: "permission", request: event.request, status: "pending" }],
      };
      break;
    case "permission_resolved":
      run = {
        ...current,
        status: "running",
        pendingPermission: undefined,
        timeline: current.timeline.map((item) =>
          item.type === "permission" && item.request.id === event.requestId
            ? { ...item, status: "resolved" }
            : item
        ),
      };
      break;
    case "diff_proposed":
      run = {
        ...current,
        status: "waiting_for_diff",
        pendingDiff: event.proposal,
        timeline: [...current.timeline, { type: "diff", proposal: event.proposal, status: "pending" }],
      };
      break;
    case "diff_resolved":
      run = {
        ...current,
        status: "running",
        pendingDiff: undefined,
        timeline: current.timeline.map((item) =>
          item.type === "diff" && item.proposal.id === event.proposalId
            ? { ...item, status: "resolved" }
            : item
        ),
      };
      break;
    case "run_result":
      run = { ...current, status: event.result.status === "cancelled" ? "cancelled" : "done" };
      break;
    case "run_error":
      run = {
        ...current,
        status: "error",
        error: event.error,
        timeline: [...current.timeline, { type: "error", error: event.error }],
      };
      break;
    default:
      break;
  }

  return {
    activeRunId: state.activeRunId ?? run.id,
    runs: { ...state.runs, [run.id]: run },
  };
}

export function reduceAgentEvents(events: AgentEvent[]): AgentState {
  return events.reduce(agentReducer, initialAgentState);
}

