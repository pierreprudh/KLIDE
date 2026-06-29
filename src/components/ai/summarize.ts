// "Summarize and hand off" — takes the current AI panel conversation,
// asks the model for a short structured note, and persists it to
// `<workspace>/.klide/memory/`. Future agents read these notes to pick up
// where the last session stopped, so the note is the artifact that
// survives — not the transcript.

import { Channel, invoke } from "@tauri-apps/api/core";
import { writeMemory, type MemoryEntry, type MemoryInput } from "../../memory";
import { writeWorkspaceTextFile } from "../../workspaceFs";
import type { Msg } from "./types";

// StreamChunk is the wire shape `ai_chat` emits via Channel: incremental
// `content`/`thinking` fragments (camelCase from Rust's StreamChunk). The
// legacy `delta`/`text` aliases are kept only as defensive fallbacks.
type StreamChunk = {
  content?: string;
  thinking?: string;
  delta?: string;
  text?: string;
  done?: boolean;
  error?: string;
};

// The authoritative reply `ai_chat` resolves with (Rust's AiChatResponse).
type AiChatResult = {
  content?: string;
  thinking?: string;
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
    // Trim long outputs so the summarize prompt stays small. Tool results
    // (file dumps, command output) are the bulkiest and least essential for a
    // summary, so cap them hardest; assistant prose gets a looser cap.
    if (role.startsWith("Tool") && body.length > 1500) {
      body = body.slice(0, 1500) + "\n…(truncated)";
    } else if (role === "Assistant" && body.length > 4000) {
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
// the files the session actually operated on. Grounded in the assistant's
// tool calls — the `path`/`file_path` argument of any file tool — NOT scraped
// from prose. (Scraping content used to pull every filename mentioned in a doc,
// e.g. a CLAUDE.md repo-layout tree, plus false hits like `llama3.1`.)
const FILE_TOOL_RE = /(file|patch|edit|write|create|delete|move|rename|mkdir)/i;
function extractFilePaths(msgs: Msg[]): string[] {
  const seen = new Set<string>();
  for (const m of msgs) {
    if (m.role !== "assistant" || !m.toolCalls) continue;
    for (const tc of m.toolCalls) {
      if (!FILE_TOOL_RE.test(tc.name ?? "")) continue;
      const args = tc.args;
      if (!args || typeof args !== "object") continue;
      const a = args as Record<string, unknown>;
      const p = a.path ?? a.file_path ?? a.filename ?? a.file ?? a.target ?? a.dest;
      if (typeof p === "string" && p.trim()) seen.add(p.trim());
    }
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

// Run a 1-shot ai_chat and return the reply text. The authoritative source is
// ai_chat's RETURN value (AiChatResponse.content); the stream is only a
// fallback. (A prior version read only the stream and looked for `delta`/`text`
// fields that ai_chat never emits — so every summary came back empty, which is
// what made compaction silently fall back. Use `.content`.) If the reply has no
// visible content (e.g. a reasoning model that emitted only thinking), fall
// back to the streamed buffer, then to thinking.
// Exported so the orchestrator planner can reuse the proven 1-shot call path
// (authoritative reply via ai_chat's return value, stream as fallback).
export async function callModel(
  provider: string,
  model: string,
  messages: Array<{ role: string; content: string }>
): Promise<string> {
  const channel = new Channel<StreamChunk>();
  let buffer = "";
  let streamError: string | null = null;
  channel.onmessage = (chunk) => {
    if (chunk.error) { streamError = chunk.error; return; }
    if (chunk.done) return;
    buffer += chunk.content ?? chunk.delta ?? chunk.text ?? "";
  };
  const res = await invoke<AiChatResult>("ai_chat", {
    provider,
    model,
    messages,
    tools: null,
    workspaceRoot: null,
    onChunk: channel,
  });
  if (streamError) throw new Error(streamError);
  const authoritative = (res?.content ?? "").trim();
  if (authoritative) return authoritative;
  if (buffer.trim()) return buffer;
  return (res?.thinking ?? "").trim();
}

const COMPACT_PROMPT = `You are compacting the earlier part of an ongoing coding conversation. Your summary will REPLACE those earlier turns as the assistant's memory, while a few of the most recent turns continue verbatim after it. Preserve everything needed to keep working: the user's goal, decisions made, files/functions touched, facts the assistant established, and any unfinished work. Be concise (a tight paragraph or a few bullets). Do not invent anything, and do not address the user — write it as notes-to-self.

Earlier conversation:
`;

const COMPACT_PARTIAL_PROMPT = `Summarize this PART of an earlier coding conversation into terse notes-to-self: the goal, decisions, files/functions touched, facts established, and unfinished work. No preamble, no addressing the reader. These notes will be merged with notes from the other parts.

Conversation part:
`;

// Cut text into chunks no larger than maxChars, so each summarize call fits the
// model's window even when the conversation is many times the window.
function splitIntoChunks(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return text ? [text] : [];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) chunks.push(text.slice(i, i + maxChars));
  return chunks;
}

// Deterministic summary used when the model returns nothing — so compaction
// still frees the window instead of hard-failing. Built straight from the
// messages: the user's actual requests (verbatim, so it's accurate) and the
// files the tool calls actually changed. No prose scraping.
function fallbackSummary(older: Msg[]): string {
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const requests = older
    .filter((m) => m.role === "user")
    .map((m) => m.content?.trim())
    .filter((s): s is string => !!s);
  const files = extractFilePaths(older);
  const parts: string[] = [];
  if (requests.length) parts.push(`Goal: ${clip(requests[0], 200)}`);
  if (requests.length > 1) {
    parts.push(`Also asked: ${requests.slice(1, 6).map((r) => clip(r, 80)).join("; ")}`);
  }
  if (files.length) parts.push(`Files changed: ${files.join(", ")}`);
  parts.push(`(${older.length} earlier message${older.length === 1 ? "" : "s"} folded; summary built locally — the model returned no text.)`);
  return parts.join("\n");
}

// Summarize the older slice of a conversation so it can REPLACE those turns as
// context while recent turns continue verbatim. The output is fed straight back
// to the model as a system message (via the ContextCompacted marker), so it
// must preserve the working state, not read like a report.
//
// Crucially, the summarize call must itself fit the model's window — the whole
// point is that the conversation has OUTGROWN it. So we cap the text fed per
// call to a fraction of `contextWindow`; an oversized history is summarized in
// chunks and the chunk-summaries are then combined (map-reduce). Never returns
// empty: if the model produces nothing, a deterministic fallback stands in.
export async function summarizeForCompaction(
  provider: string,
  model: string,
  older: Msg[],
  contextWindow?: number
): Promise<string> {
  // ~4 chars/token; spend ~45% of the window on input, leaving room for the
  // prompt scaffold and the model's reply. Floor keeps tiny windows workable.
  const windowTokens = contextWindow && contextWindow > 0 ? contextWindow : 32_000;
  const perCallChars = Math.max(8_000, Math.floor(windowTokens * 0.45) * 4);

  const convo = serializeConversation(older);
  const chunks = splitIntoChunks(convo, perCallChars);
  if (chunks.length === 0) return fallbackSummary(older);

  // Fits in one call — summarize directly.
  if (chunks.length === 1) {
    const text = (await callModel(provider, model, [{ role: "user", content: COMPACT_PROMPT + chunks[0] }])).trim();
    return text || fallbackSummary(older);
  }

  // Too big — map each chunk to partial notes, then reduce to one summary.
  const partials: string[] = [];
  for (const chunk of chunks) {
    const part = (await callModel(provider, model, [{ role: "user", content: COMPACT_PARTIAL_PROMPT + chunk }])).trim();
    if (part) partials.push(part);
  }
  if (partials.length === 0) return fallbackSummary(older);

  let combined = partials.join("\n\n");
  // The merged notes are usually small; if they still overflow, fold them again.
  while (combined.length > perCallChars) {
    const reChunks = splitIntoChunks(combined, perCallChars);
    const reduced: string[] = [];
    for (const chunk of reChunks) {
      const part = (await callModel(provider, model, [{ role: "user", content: COMPACT_PARTIAL_PROMPT + chunk }])).trim();
      if (part) reduced.push(part);
    }
    if (reduced.length === 0) break;
    const next = reduced.join("\n\n");
    if (next.length >= combined.length) break; // not shrinking — stop
    combined = next;
  }

  const text = (await callModel(provider, model, [{ role: "user", content: COMPACT_PROMPT + combined }])).trim();
  return text || combined || fallbackSummary(older);
}

// Generate the structured note WITHOUT persisting it. Returns a
// `MemoryInput` ready to hand to `writeMemory`. The reviewable-memory flow
// drafts this on run-done and only writes once the user accepts (see
// `src/memoryDrafts.ts`); `summarizeAndHandoff` = generate + write, used by
// the manual "Summarize" action where the write is the explicit intent.
// Throws if there's nothing to summarize, the model is unavailable, or the
// response is empty.
export async function generateMemoryNote(
  input: SummarizeInput
): Promise<MemoryInput> {
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

  return {
    title: deriveTitle(input.msgs),
    goal: parsed.goal,
    plan: [],
    decisions: parsed.decisions,
    filesTouched: extractFilePaths(input.msgs),
    nextSteps: [],
    notes: parsed.notes,
    runId: input.runId ?? null,
    provider: input.provider,
    model: input.model,
    mode: input.mode,
    status: input.status ?? null,
  };
}

// Top-level entry point for the manual action. Generates the note and writes
// it straight to `.klide/memory/`. Returns the saved MemoryEntry; the caller
// (AiPanel) handles the success notice + the memoryRefreshKey bump.
export async function summarizeAndHandoff(
  input: SummarizeInput
): Promise<MemoryEntry> {
  const note = await generateMemoryNote(input);
  return writeMemory(input.workspaceRoot, note);
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
