// "Summarize and hand off" — takes the current AI panel conversation,
// asks the model for a short structured note, and persists it to
// `<workspace>/.klide/memory/`. Future agents read these notes to pick up
// where the last session stopped, so the note is the artifact that
// survives — not the transcript.

import { Channel, invoke } from "@tauri-apps/api/core";
import { writeMemory, type MemoryEntry } from "../../memory";
import type { Msg } from "./types";

// StreamChunk is the wire shape `ai_chat` emits via Channel. We don't
// import it from anywhere because the harness owns it — keep the
// dependency local to this file.
type StreamChunk = {
  delta?: string;
  text?: string;
  done?: boolean;
  error?: string;
};

type SummarizeInput = {
  workspaceRoot: string;
  provider: string;
  model: string;
  mode: string;
  msgs: Msg[];
  runId?: string | null;
  status?: string | null;
};

type ParsedSummary = {
  notes: string;
  decisions: string[];
  goal: string;
  filesTouched: string[];
};

const FORMAT_PROMPT = `You are summarizing a coding session as a short project memory note. Read the conversation below and produce exactly THREE blocks, in this order, with no extra text or preamble:

NOTES:
<2-3 sentences that capture what was done, where things stand, and any open questions>

DECISIONS:
- <one short decision per bullet, 2-5 bullets>

GOAL:
<one sentence: the user's original goal for this session, written in present tense>

Conversation:
`;

// Strip role prefixes and tool markers so the model sees a clean transcript.
function serializeConversation(msgs: Msg[]): string {
  const lines: string[] = [];
  for (const m of msgs) {
    const role =
      m.role === "user" ? "User" :
      m.role === "assistant" ? "Assistant" :
      m.role === "tool" ? `Tool (${(m as any).toolName ?? "tool"})` :
      "System";
    let body = m.content ?? "";
    // Append any tool calls the assistant made so the model sees them
    // when deciding what was decided/changed.
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const toolLines = m.toolCalls
        .map((tc) => `[tool: ${tc.name ?? "tool"}${tc.args ? ` ${summarizeInput(tc.args)}` : ""}]`)
        .join("\n");
      body = body ? `${body}\n${toolLines}` : toolLines;
    }
    if (!body.trim()) continue;
    // Trim long assistant outputs so the summarize prompt stays small.
    if (role === "Assistant" && body.length > 4000) {
      body = body.slice(0, 4000) + "\n…(truncated)";
    }
    lines.push(`${role}: ${body}`);
  }
  return lines.join("\n\n");
}

function summarizeInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    const s = JSON.stringify(input);
    return s && s.length > 200 ? s.slice(0, 200) + "…" : s;
  } catch {
    return "";
  }
}

function parseSummaryResponse(text: string): ParsedSummary {
  const result: ParsedSummary = {
    notes: "",
    decisions: [],
    goal: "",
    filesTouched: [],
  };
  const blocks: Record<string, string> = {};
  const re = /^(NOTES|DECISIONS|GOAL):\s*$/gm;
  let m: RegExpExecArray | null;
  const indices: Array<{ key: string; start: number }> = [];
  while ((m = re.exec(text)) !== null) {
    indices.push({ key: m[1], start: m.index + m[0].length });
  }
  for (let i = 0; i < indices.length; i++) {
    const cur = indices[i];
    const next = indices[i + 1];
    const raw = text.slice(cur.start, next ? next.start - ("\n" + next.key + ":\n").length : text.length);
    blocks[cur.key] = raw.trim();
  }
  if (blocks.NOTES) result.notes = blocks.NOTES;
  if (blocks.GOAL) result.goal = blocks.GOAL;
  if (blocks.DECISIONS) {
    result.decisions = blocks.DECISIONS
      .split("\n")
      .map((l) => l.replace(/^[-*]\s+/, "").trim())
      .filter(Boolean);
  }
  return result;
}

// Pick out file paths mentioned in the conversation. We look for things
// that look like `src/foo.ts`, `src/components/AiPanel.tsx`, or absolute
// paths inside the workspace. Best-effort — the summary still works if
// we miss a few.
const PATH_RE = /(?:^|\s|`)(`?)([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8})\1(?=$|\s|`|[),.;:])/g;
function extractFilePaths(msgs: Msg[]): string[] {
  const seen = new Set<string>();
  const all = msgs
    .map((m) => {
      let text = m.content ?? "";
      if (m.role === "assistant" && m.toolCalls) {
        text += "\n" + m.toolCalls.map((tc) => JSON.stringify(tc.args ?? "")).join("\n");
      }
      return text;
    })
    .join("\n");
  let m: RegExpExecArray | null;
  while ((m = PATH_RE.exec(all)) !== null) {
    const path = m[2];
    if (/^https?:/.test(path)) continue;
    seen.add(path);
  }
  return Array.from(seen).slice(0, 24);
}

function deriveTitle(msgs: Msg[]): string {
  const first = msgs.find((m) => m.role === "user");
  const text = first ? first.content ?? "" : "";
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return "Untitled session";
  return trimmed.length > 80 ? trimmed.slice(0, 77) + "…" : trimmed;
}

// Run a 1-shot ai_chat, return the concatenated response text. The
// stream is for visibility only — we don't pipe it anywhere. If the
// model errors out we surface the error to the caller.
async function callModel(
  provider: string,
  model: string,
  messages: Array<{ role: string; content: string }>
): Promise<string> {
  const channel = new Channel<StreamChunk>();
  let buffer = "";
  channel.onmessage = (chunk) => {
    if (chunk.error) throw new Error(chunk.error);
    if (chunk.done) return;
    const piece = chunk.delta ?? chunk.text ?? "";
    buffer += piece;
  };
  await invoke<unknown>("ai_chat", {
    provider,
    model,
    messages,
    tools: null,
    workspaceRoot: null,
    onChunk: channel,
  });
  return buffer;
}

// Top-level entry point. Returns the saved MemoryEntry; throws if the
// workspace isn't open, the model is unavailable, or the response is
// empty. The caller (AiPanel) handles the success notice + the
// memoryRefreshKey bump.
export async function summarizeAndHandoff(
  input: SummarizeInput
): Promise<MemoryEntry> {
  if (input.msgs.length === 0) {
    throw new Error("Nothing to summarize — start a conversation first.");
  }
  const transcript = serializeConversation(input.msgs);
  const prompt = FORMAT_PROMPT + transcript;

  const text = await callModel(input.provider, input.model, [
    { role: "user", content: prompt },
  ]).catch((err) => {
    throw new Error(
      err instanceof Error ? err.message : "Model call failed during summarize."
    );
  });
  if (!text.trim()) {
    throw new Error("Model returned an empty summary.");
  }
  const parsed = parseSummaryResponse(text);
  const filesTouched = extractFilePaths(input.msgs);
  const title = deriveTitle(input.msgs);

  return writeMemory(input.workspaceRoot, {
    title,
    goal: parsed.goal,
    plan: [],
    decisions: parsed.decisions,
    filesTouched,
    nextSteps: [],
    notes: parsed.notes,
    runId: input.runId ?? null,
    provider: input.provider,
    model: input.model,
    mode: input.mode,
    status: input.status ?? null,
  });
}
