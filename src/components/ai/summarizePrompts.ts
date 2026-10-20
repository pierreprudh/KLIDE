// The pure half of "summarize and hand off": prompt assembly + model-output
// parsing, with zero IPC. `summarize.ts` owns the callModel plumbing and the
// persistence; everything here is deterministic and unit-testable.

import type { Msg } from "./types";

export type ParsedSummary = {
  notes: string;
  decisions: string[];
  goal: string;
  filesTouched: string[];
};

export const FORMAT_PROMPT = `You are summarizing a coding session as a short project memory note. Read the conversation below and produce exactly THREE blocks, in this order, with no extra text or preamble:

NOTES:
<2-3 sentences that capture what was done, where things stand, and any open questions>

DECISIONS:
- <one short decision per bullet, 2-5 bullets>

GOAL:
<one sentence: the user's original goal for this session, written in present tense>

Conversation:
`;

// Strip role prefixes and tool markers so the model sees a clean transcript.
export function serializeConversation(msgs: Msg[]): string {
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

export function parseSummaryResponse(text: string): ParsedSummary {
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
export function extractFilePaths(msgs: Msg[]): string[] {
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

export const CLASSIFY_PROMPT = `You are reading a coding session transcript. Decide if it contains a REUSABLE PATTERN the assistant should follow next time: a workflow, a code-review checklist, a deploy ritual, a coding-style rule, a way of using a tool, or a debugging playbook. NOT just a one-off fix.

Reply in exactly this shape, with no other text:

REUSABLE: yes
NAME: <short kebab-case id, e.g. review-strict-pr>
TITLE: <human title>
DESCRIPTION: <one-sentence "when to use this">

or

REUSABLE: no
`;

export function parseClassify(text: string): { reusable: boolean; slug: string; title: string; description: string } | null {
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

export const SKILL_BODY_PROMPT = `You are drafting a SKILL.md for a Klide / Claude Code style skill. The skill is based on a coding session you just read. Write instructions a future agent can follow in plain language.

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
