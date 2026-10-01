// "Summarize and hand off" — takes the current AI panel conversation,
// asks the model for a short structured note, and persists it to
// `<workspace>/.klide/memory/`. Future agents read these notes to pick up
// where the last session stopped, so the note is the artifact that
// survives — not the transcript.
//
// The pure parts (prompt text, transcript serialization, response parsing)
// live in `summarizePrompts.ts`; this module owns the model calls and the
// filesystem writes.

import { Channel, invoke } from "@tauri-apps/api/core";
import { writeMemory, type MemoryEntry, type MemoryInput } from "../../memory";
import { writeWorkspaceTextFile } from "../../workspaceFs";
import type { Msg } from "./types";
import {
  CLASSIFY_PROMPT,
  COMPACT_PARTIAL_PROMPT,
  COMPACT_PROMPT,
  FORMAT_PROMPT,
  SKILL_BODY_PROMPT,
  extractFilePaths,
  fallbackSummary,
  parseClassify,
  parseSummaryResponse,
  serializeConversation,
  splitIntoChunks,
} from "./summarizePrompts";
import { deriveTitle } from "./storedConversations";

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
/** The chunking assumption when the model's window is unknown (Rust
 *  answered `null`, or nothing has been detected yet): the smallest window
 *  any model Klide serves, so a chunk fits wherever it lands. A conservative
 *  policy with a name, not a guess at the model. */
export const SMALLEST_SERVED_WINDOW = 8_192;

export async function summarizeForCompaction(
  provider: string,
  model: string,
  older: Msg[],
  contextWindow?: number | null
): Promise<string> {
  // ~4 chars/token; spend ~45% of the window on input, leaving room for the
  // prompt scaffold and the model's reply. Floor keeps tiny windows workable.
  const windowTokens = contextWindow && contextWindow > 0 ? contextWindow : SMALLEST_SERVED_WINDOW;
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
    kind: "handoff",
    tags: [],
    sourceRefs: input.runId
      ? [{ sourceType: "run", id: input.runId, label: "Source Run" }]
      : [],
    supersedes: null,
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
