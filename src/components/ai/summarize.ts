// "Summarize and hand off" — takes the current AI panel conversation,
// asks the model for a short structured note, and persists it to
// `<workspace>/.klide/memory/`. Future agents read these notes to pick up
// where the last session stopped, so the note is the artifact that
// survives — not the transcript.

import { Channel, invoke } from "@tauri-apps/api/core";
import { writeMemory, type MemoryEntry } from "../../memory";
import { writeWorkspaceTextFile } from "../../workspaceFs";
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

// Summarize the older slice of a conversation so it can REPLACE those turns
// as context while recent turns continue verbatim. Different intent from the
// memory note above: this output is fed straight back to the model as a system
// message (via the ContextCompacted transcript marker), so it must preserve
// the working state, not read like a report. Returns the trimmed summary text.
export async function summarizeForCompaction(
  provider: string,
  model: string,
  older: Msg[]
): Promise<string> {
  const convo = serializeConversation(older);
  const prompt = `You are compacting the earlier part of an ongoing coding conversation. Your summary will REPLACE those earlier turns as the assistant's memory, while a few of the most recent turns continue verbatim after it. Preserve everything needed to keep working: the user's goal, decisions made, files/functions touched, facts the assistant established, and any unfinished work. Be concise (a tight paragraph or a few bullets). Do not invent anything, and do not address the user — write it as notes-to-self.

Earlier conversation:
${convo}`;
  const text = await callModel(provider, model, [{ role: "user", content: prompt }]);
  return text.trim();
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

/* ============================================================ auto-skill ===*/

// Detect-and-write a reusable skill from the current conversation.
//
// Flow: ask the model twice.
//   1) CLASSIFY — is there a reusable pattern? If not, return null.
//   2) DRAFT — produce a SKILL.md (frontmatter + body) for that pattern.
// Then write `<workspace>/.klide/skills/<slug>/SKILL.md`. The SkillsModal
// file loader picks it up on the next reload (or the caller triggers one).

export type GeneratedSkill = {
  name: string;
  description: string;
  slug: string;
  relPath: string; // e.g. ".klide/skills/review-pr/SKILL.md"
};

const CLASSIFY_PROMPT = `You are reading a coding session transcript. Decide if it contains a REUSABLE PATTERN the assistant should follow next time: a workflow, a code-review checklist, a deploy ritual, a coding-style rule, a way of using a tool, or a debugging playbook. NOT just a one-off fix.

Reply in exactly this shape, with no other text:

REUSABLE: yes
NAME: <short kebab-case id, e.g. review-strict-pr>
TITLE: <human title>
DESCRIPTION: <one-sentence "when to use this">

or

REUSABLE: no
`;

function parseClassify(text: string): { reusable: boolean; slug: string; title: string; description: string } | null {
  const t = text.trim();
  if (!/^REUSABLE:\s*yes/m.test(t)) return null;
  const get = (key: string) => {
    const m = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(t);
    return m ? m[1].trim() : "";
  };
  const slug = get("NAME").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  if (!slug) return null;
  return {
    reusable: true,
    slug,
    title: get("TITLE") || slug,
    description: get("DESCRIPTION") || `Auto-generated from a session.`,
  };
}

const SKILL_BODY_PROMPT = `You are drafting a SKILL.md for a Klide / Claude Code style skill. The skill is based on a coding session you just read. Write instructions a future agent can follow in plain language.

Strict rules:
- Output the full SKILL.md file contents, no preamble, no code fences around the whole thing.
- Start with a YAML frontmatter block:
---
name: <title>
description: <one sentence>
---
- After the frontmatter, write concise instructions. Use headings + bullets. No fluff. Cite specific commands, file paths, or constraints the session revealed.
- Aim for 12-40 lines of body. If the pattern is genuinely simple, 6-8 lines is fine.
`;

export type GenerateSkillInput = {
  workspaceRoot: string;
  provider: string;
  model: string;
  mode: string;
  msgs: Msg[];
};

export async function detectAndGenerateSkill(
  input: GenerateSkillInput
): Promise<GeneratedSkill | null> {
  if (input.msgs.length < 2) return null;
  const transcript = serializeConversation(input.msgs);
  const classifyText = await callModel(input.provider, input.model, [
    { role: "user", content: CLASSIFY_PROMPT + transcript },
  ]);
  const cls = parseClassify(classifyText);
  if (!cls) return null;

  const bodyText = await callModel(input.provider, input.model, [
    {
      role: "user",
      content:
        `Skill name: ${cls.slug}\nTitle: ${cls.title}\nDescription: ${cls.description}\n\n` +
        SKILL_BODY_PROMPT +
        `\nSource session transcript:\n${transcript}`,
    },
  ]);
  const raw = bodyText.trim();
  // If the model ignored the "no fences" rule, strip a single outer fence pair.
  const stripped = raw.replace(/^```(?:md|markdown)?\s*\n/i, "").replace(/\n```\s*$/, "");
  // If the model forgot the frontmatter, prepend a minimal one from the classify result.
  const withFrontmatter = stripped.startsWith("---")
    ? stripped
    : `---\nname: ${cls.title}\ndescription: ${cls.description}\n---\n\n${stripped}`;

  const relPath = `.klide/skills/${cls.slug}/SKILL.md`;
  await writeWorkspaceTextFile(input.workspaceRoot, relPath, withFrontmatter + "\n");
  return {
    name: cls.title,
    description: cls.description,
    slug: cls.slug,
    relPath,
  };
}
