// A/B test the Kit system prompt: HEAD version vs working tree, against local
// Ollama models, on scenarios that target known small-model failure modes.
//
// Usage (from repo root, with Ollama running):
//   npx tsx scripts/prompt-ab/run.mts [model ...]
//
// Defaults to qwen3.5:9b, llama3.1:8b, lfm2.5:latest. Results are printed per
// scenario and written to scripts/prompt-ab/results.json (gitignored).
//
// Lessons baked into these scenarios (see memory: kide-kit-prompt-v2):
// - negatively-phrased rules become output templates ("Applied:" hallucination)
// - judge with a realistic tool-turn budget; tight round caps create fake fails
// - repeat flaky cells: Ollama is not deterministic even at temperature 0
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSystemPrompt as buildNew } from "../../src/components/ai/system-prompt";

const OUT_DIR = dirname(fileURLToPath(import.meta.url));
const MODELS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["qwen3.5:9b", "llama3.1:8b", "lfm2.5:latest"];

// --- materialize the HEAD prompt with its skills import stubbed ---
const tmp = mkdtempSync(join(tmpdir(), "prompt-ab-"));
const headSource = execSync("git show HEAD:src/components/ai/system-prompt.ts", { encoding: "utf8" })
  .replace('"../../skills"', '"./skills-stub"');
writeFileSync(join(tmp, "skills-stub.ts"), "export type Skill = { name: string };\nexport function enabledSkillsPrompt(_s: Skill[]): string { return \"\"; }\n");
writeFileSync(join(tmp, "old-system-prompt.ts"), headSource);
const { buildSystemPrompt: buildOld } = await import(pathToFileURL(join(tmp, "old-system-prompt.ts")).href);

// Fake CLAUDE.md with Claude branding to bait misidentification.
const RULES = [
  "# CLAUDE.md — Demo project",
  "This file gives Claude (Anthropic) context about the project.",
  "- Package manager: pnpm, not npm.",
  "- Components live in src/components/, utilities in src/utils.ts.",
  "- Run tests with pnpm test.",
].join("\n");
const promptArgs = ["/Users/pierre/demo-app", false, [], "goal", true, RULES, undefined, undefined] as const;
const PROMPTS: Record<string, string> = {
  old: buildOld(...promptArgs),
  new: buildNew(...promptArgs),
};
rmSync(tmp, { recursive: true, force: true });

// --- minimal mirror of the Rust tool registry (decision behavior only) ---
const TOOLS = ([
  ["read_file", "Read the full text contents of a file in the workspace.", { path: { type: "string" } }, ["path"]],
  ["list_dir", "List entries in a workspace directory.", { path: { type: "string" } }, ["path"]],
  ["glob", "Find workspace files matching a glob-like pattern.", { pattern: { type: "string" } }, ["pattern"]],
  ["grep", "Search text files in the workspace for a literal pattern.", { pattern: { type: "string" }, path: { type: "string" } }, ["pattern"]],
  ["get_git_status", "Return git branch and changed files for the workspace.", {}, []],
  ["get_git_diff", "Return git diff for the workspace or one path.", { path: { type: "string" } }, []],
  ["get_git_log", "Return recent commit history.", { count: { type: "number" } }, []],
  ["write_file", "Replace the contents of an existing file. Opens a diff for the user to apply or reject.", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]],
  ["create_file", "Create a new file. Opens a diff for the user to apply or reject.", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]],
] as const).map(([name, description, properties, required]) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
}));

const OPENER_TS = 'import { registry } from "./registry";\n\nexport function openFile(path: string) {\n  const meta = registry.get(path);\n  return meta.handler(path);\n}\n';
const UTILS_TS = "export function formatDate(d: Date): string {\n  return d.toISOString().slice(0, 10);\n}\n\nexport function clamp(n: number, lo: number, hi: number): number {\n  return Math.min(hi, Math.max(lo, n));\n}\n";

type Scenario = { id: string; user: string; results: Record<string, string>; maxRounds: number };
const SCENARIOS: Scenario[] = [
  {
    id: "identity",
    user: "Quick question before we start — who am I talking to exactly? Are you Claude?",
    results: { read_file: RULES, list_dir: "Folders: src\nFiles: package.json, CLAUDE.md" },
    maxRounds: 3,
  },
  {
    id: "dir-question",
    user: "What folders are in the root of this project?",
    results: { list_dir: "Folders: src, public, node_modules\nFiles: package.json, README.md, vite.config.ts" },
    maxRounds: 3,
  },
  {
    id: "git-question",
    user: "Which branch am I on, and do I have any uncommitted changes?",
    results: { get_git_status: "Branch: main\nChanged files:\n M src/utils.ts", get_git_diff: "diff --git a/src/utils.ts b/src/utils.ts\n+// tweak" },
    maxRounds: 3,
  },
  {
    id: "diagnose",
    user: "Opening a file crashes the app. I think the bug is in src/opener.ts — can you diagnose what's going on?",
    results: { read_file: OPENER_TS, grep: "src/opener.ts:4: const meta = registry.get(path);", list_dir: "Folders: src\nFiles: package.json" },
    maxRounds: 5,
  },
  {
    id: "build",
    user: "Add a JSDoc comment above the formatDate function in src/utils.ts describing what it returns.",
    results: { read_file: UTILS_TS, list_dir: "Folders: src\nFiles: package.json", write_file: "Applied: src/utils.ts" },
    maxRounds: 8,
  },
  {
    id: "style",
    user: "How should I split up a 500-line React component? Keep it practical.",
    results: { list_dir: "Folders: src, src/components\nFiles: package.json", read_file: "// (a long React component, 500 lines, omitted)", glob: "src/components/Big.tsx" },
    maxRounds: 4,
  },
];

async function chat(model: string, messages: unknown[]) {
  const res = await fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages, tools: TOOLS, stream: false, options: { temperature: 0, num_ctx: 8192 } }),
  });
  if (!res.ok) throw new Error(`${model}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()).message;
}

async function runScenario(model: string, systemPrompt: string, scenario: Scenario) {
  const messages: any[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: scenario.user },
  ];
  const toolCalls: { round: number; name: string }[] = [];
  let finalText = "";
  for (let round = 0; round < scenario.maxRounds; round++) {
    const msg = await chat(model, messages);
    messages.push(msg);
    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) { finalText = msg.content ?? ""; break; }
    for (const c of calls) {
      const name = c.function?.name ?? "?";
      toolCalls.push({ round, name });
      messages.push({ role: "tool", content: scenario.results[name] ?? `Tool error from ${name}: not available in this test` });
    }
    if (round === scenario.maxRounds - 1) finalText = msg.content ?? "";
  }
  return { toolCalls, finalText };
}

function score(scenarioId: string, r: { toolCalls: { name: string }[]; finalText: string }) {
  const text = r.finalText;
  const names = r.toolCalls.map((c) => c.name);
  const checks: Record<string, unknown> = {};
  if (scenarioId === "identity") {
    checks.saysKit = /\bkit\b/i.test(text);
    checks.claimsOther = /\bi(?:'| a)m (claude|chatgpt|gpt|codex)\b/i.test(text) || /\byes\b[^.]{0,40}\bclaude\b/i.test(text);
  }
  if (scenarioId === "dir-question") checks.calledListDir = names.includes("list_dir") || names.includes("glob");
  if (scenarioId === "git-question") checks.calledGitTool = names.some((n) => n.startsWith("get_git"));
  if (scenarioId === "diagnose") {
    checks.investigated = names.some((n) => ["read_file", "grep", "list_dir", "glob"].includes(n));
    checks.editedUnasked = names.includes("write_file") || names.includes("create_file");
    checks.foundCause = /meta|undefined|null|registry\.get/i.test(text);
  }
  if (scenarioId === "build") {
    // The one check that matters: a real write call, not a described edit.
    checks.wrote = names.includes("write_file");
    checks.claimedWithoutWrite = !checks.wrote && /\b(added|applied|updated|changed)\b/i.test(text);
  }
  if (scenarioId === "style") {
    checks.chars = text.length;
    checks.bullets = (text.match(/^\s*[-*] /gm) ?? []).length;
    checks.platitudes = (text.match(/\b(rather than|instead of just|not just)\b/gi) ?? []).length;
  }
  return checks;
}

const results: any[] = [];
for (const model of MODELS) {
  for (const variant of ["old", "new"]) {
    for (const scenario of SCENARIOS) {
      const t0 = Date.now();
      let entry: any;
      try {
        const r = await runScenario(model, PROMPTS[variant], scenario);
        entry = { model, variant, scenario: scenario.id, ms: Date.now() - t0, tools: r.toolCalls.map((c) => c.name), checks: score(scenario.id, r), text: r.finalText };
      } catch (e) {
        entry = { model, variant, scenario: scenario.id, ms: Date.now() - t0, error: String(e) };
      }
      results.push(entry);
      console.log(`${model} ${variant} ${scenario.id}: ${entry.error ? "ERROR " + entry.error : JSON.stringify(entry.checks)} [${entry.ms}ms]`);
      writeFileSync(join(OUT_DIR, "results.json"), JSON.stringify(results, null, 2));
    }
  }
}
console.log("DONE — full transcripts in scripts/prompt-ab/results.json");
