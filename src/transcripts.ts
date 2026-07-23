// Transcript parsing — the pure layer behind Mission Control's conversation view.
//
// These functions turn a run's RunMessage[] (the on-disk/folded transcript) into
// the shapes a reader wants: a compacted conversation, inline tool calls split
// out of message text, and a markdown export. They are deliberately free of React
// and of any presentation-label lookup, so they can be tested with a fixture and
// reused from Memory, Search, or Export — not only from the board component.

import type { Run, RunMessage, RunToolCall } from "./runs";

// One rendered row of a conversation: either a real message (with its structured
// tool calls) or a collapsed stack of process notes — the model's running
// commentary ("I found…", "Build is green") folded away.
export type ConversationItem =
  | { type: "message"; message: RunMessage; text: string; tools: RunToolCall[] }
  | { type: "process"; notes: string[] };

// Heuristic: is this assistant turn running commentary rather than a substantive
// reply? Process notes get collapsed so the conversation reads as a dialogue.
export function isProcessNote(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.length > 900) return false;
  return /^(I('|’)?m|I('|’)?ll|I will|I found|I caught|I noticed|I’m|I’ll|Fresh server|Build|TypeScript|Final compile|Final browser|Okay,|Interesting:|One more|That native|The browser|The auto-theme|Again there|A new|The type mismatch|The local-only|The Tauri|Diff shape|Whitespace|Frontend build|Server is up|Port `?\d+|Done\. I took)/i.test(t);
}

// Collapse a flat RunMessage[] into renderable items: real messages keep their
// hoisted tool calls; consecutive process notes and empty tool-only turns fold
// into process stacks attached to the nearest preceding assistant message.
export function compactConversationMessages(messages: RunMessage[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  let notes: string[] = [];
  const flush = () => {
    if (notes.length === 0) return;
    items.push({ type: "process", notes });
    notes = [];
  };
  const appendToolsToPreviousAssistant = (tools: RunToolCall[]) => {
    if (tools.length === 0) return false;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.type === "process") continue;
      if (item.message.role !== "assistant") return false;
      item.tools.push(...tools);
      return true;
    }
    return false;
  };
  for (const message of messages) {
    const text = message.text.trim();
    const messageTools = message.tools ?? [];
    const hasImages = (message.images?.length ?? 0) > 0;
    if (message.role === "assistant" && text && isProcessNote(text)) {
      if (messageTools.length > 0) appendToolsToPreviousAssistant(messageTools);
      notes.push(text);
      continue;
    }
    if (!text && !hasImages) {
      if (message.role === "assistant" && appendToolsToPreviousAssistant(messageTools)) {
        continue;
      }
      if (messageTools.length > 0) {
        flush();
        items.push({ type: "process", notes: [`Tool activity · ${messageTools.length}`] });
      }
      continue;
    }
    flush();
    items.push({ type: "message", message, text, tools: messageTools });
  }
  flush();
  return items;
}

// Serialize a run's transcript to markdown for copy/export. `agentLabel` is
// passed in (rather than derived) so this module stays free of presentation
// lookups — the caller already knows the run's display label.
export function runMessagesToMarkdown(
  run: Pick<Run, "title" | "id" | "model" | "cwd" | "branch" | "worktree">,
  messages: RunMessage[],
  agentLabel: string,
): string {
  const header = [
    `# ${run.title}`,
    "",
    `- Source: ${agentLabel}`,
    `- Run: \`${run.id}\``,
    run.model ? `- Model: \`${run.model}\`` : null,
    run.cwd ? `- Workspace: \`${run.cwd}\`` : null,
    run.branch ? `- Branch: \`${run.branch}\`` : null,
    run.worktree ? `- Worktree: \`${run.worktree}\`` : null,
  ].filter((line): line is string => line !== null);
  const turns = messages.map((m) => {
    const role = m.role === "user" ? "User" : agentLabel;
    const tools = (m.tools ?? [])
      .map((tool) => {
        const result = tool.result ? `\n\nResult:\n\n\`\`\`text\n${tool.result}\n\`\`\`` : "";
        const input = tool.input === undefined ? "" : `\n\nInput:\n\n\`\`\`json\n${JSON.stringify(tool.input, null, 2)}\n\`\`\``;
        return `\n\nTool: \`${tool.name}\`${input}${result}`;
      })
      .join("");
    return `## ${role}\n\n${m.text}${tools}`;
  });
  return `${header.join("\n")}\n\n---\n\n${turns.join("\n\n---\n\n")}\n`;
}
