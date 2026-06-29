// Orchestrator planner — turns a free-text goal into a routed-ready task list.
//
// This replaces the old hardcoded `stubPlan`: it asks the model (the same 1-shot
// `ai_chat` path the summarizer uses) to decompose the goal into tasks shaped
// exactly like `RouteTaskInput`, so the routing layer downstream is unchanged.
// `stubPlan` stays as a graceful fallback when the model is unreachable or
// returns something we can't parse — the board never ends up empty.

import { callModel } from "../components/ai/summarize";
import { DEFAULT_MODELS, isDelegateProvider } from "./providers";
import type { ProviderId } from "./types";
import type { RouteTaskInput } from "./routingPolicy";

export type Phase = "Understand" | "Build" | "Verify";
export type PlannedTask = RouteTaskInput & { phase: Phase; dependsOn?: string[]; description?: string };

// ── Fallback (was the only planner) ──────────────────────────────────────────
export function stubPlan(goal: string): PlannedTask[] {
  const g = goal.trim() || "the feature";
  const short = g.length > 38 ? g.slice(0, 38) + "…" : g;
  return [
    { taskId: "t1", title: `Map modules touched by ${short}`, description: `Trace the files, functions, and call sites that ${g} will affect, so later tasks know the blast radius.`, mode: "plan", risk: "low", writesFiles: false, needsRepoWideContext: true, phase: "Understand" },
    { taskId: "t2", title: "Draft the implementation plan", description: "Turn the findings into an ordered, concrete plan with the key design decisions called out.", mode: "plan", risk: "medium", writesFiles: false, needsStrongReasoning: true, phase: "Understand", dependsOn: ["t1"] },
    { taskId: "t3", title: "Scaffold boilerplate + types", description: "Create the new files, type definitions, and stubs the implementation will fill in.", mode: "goal", risk: "low", writesFiles: true, phase: "Build", dependsOn: ["t2"] },
    { taskId: "t4", title: `Implement core logic for ${short}`, description: `Write the main implementation for ${g}, wiring it into the existing modules.`, mode: "goal", risk: "high", writesFiles: true, needsStrongReasoning: true, phase: "Build", dependsOn: ["t3"] },
    { taskId: "t5", title: "Write unit tests", description: "Cover the new behaviour with unit tests, including the important edge cases.", mode: "goal", risk: "medium", writesFiles: true, phase: "Verify", dependsOn: ["t4"] },
    { taskId: "t6", title: "Tidy comments + inline docs", description: "Add clarifying comments and doc updates so the new code reads cleanly.", mode: "goal", risk: "low", writesFiles: false, phase: "Build", dependsOn: ["t4"] },
    { taskId: "t7", title: "Cross-file rename / refactor", description: "Apply the cross-cutting renames and refactors the change implies across the codebase.", mode: "goal", risk: "medium", writesFiles: true, needsDelegateCli: true, phase: "Build", dependsOn: ["t4"] },
    { taskId: "t8", title: "Visual QA of the new UI", description: "Run the app and eyeball the affected UI for regressions and rough edges.", mode: "goal", risk: "low", writesFiles: false, needsVisualReview: true, phase: "Verify", dependsOn: ["t7"] },
  ];
}

// ── Model selection ──────────────────────────────────────────────────────────
// Mirror the AI panel's default so the planner uses whatever the user already
// has set up (and keyed). No picker on the console itself.
export function resolvePlannerModel(): { provider: ProviderId; model: string } {
  let provider = (localStorage.getItem("klide.provider") as ProviderId) || "ollama";
  // Delegate CLIs (Claude Code / Codex / …) are TUI processes — they don't serve
  // the `ai_chat` endpoint the planner uses. If that's the default, plan on the
  // local model instead (Klide's local-first default), not the delegate.
  if (isDelegateProvider(provider)) provider = "ollama";
  const model = localStorage.getItem(`klide.model.${provider}`) || DEFAULT_MODELS[provider] || "";
  return { provider, model };
}

// ── Prompt ───────────────────────────────────────────────────────────────────
const PLANNER_PROMPT = `You are the planning step of a coding orchestrator. Break the user's GOAL into a small, ordered list of concrete engineering tasks (aim for 4–8). Return ONLY a JSON array — no prose, no markdown fences.

Each task is an object with these fields:
- "title": string — a short imperative task (e.g. "Add a rate-limit middleware"). Max ~60 chars.
- "description": string — one or two sentences on what the task actually involves and why. Concrete, not generic.
- "phase": one of "Understand" | "Build" | "Verify".
- "mode": "plan" for read-only/analysis tasks, "goal" for tasks that change code.
- "risk": "low" | "medium" | "high".
- "writesFiles": boolean — true if the task edits files (usually true when mode is "goal").
- "needsRepoWideContext": boolean (optional) — true if it must reason across many files.
- "needsStrongReasoning": boolean (optional) — true for the hardest design/logic tasks.
- "needsDelegateCli": boolean (optional) — true for large cross-file refactors/renames.
- "needsVisualReview": boolean (optional) — true if it changes UI that needs eyeballing.
- "dependsOn": string[] (optional) — ids of earlier tasks (1-based as strings, e.g. ["1","2"]) that must finish first.

Order matters: Understand before Build before Verify. Keep it realistic and specific to the goal.

GOAL:
`;

// ── Parse + coerce ───────────────────────────────────────────────────────────
const PHASES: Phase[] = ["Understand", "Build", "Verify"];

function coerceTask(raw: unknown, index: number, count: number): PlannedTask {
  const o = (raw ?? {}) as Record<string, unknown>;
  const id = `t${index + 1}`;
  const title = typeof o.title === "string" && o.title.trim() ? o.title.trim().slice(0, 80) : `Task ${index + 1}`;
  const description = typeof o.description === "string" && o.description.trim() ? o.description.trim().slice(0, 280) : undefined;
  const phase: Phase = PHASES.includes(o.phase as Phase) ? (o.phase as Phase) : "Build";
  const mode: "plan" | "goal" = o.mode === "plan" ? "plan" : "goal";
  const risk = o.risk === "high" || o.risk === "medium" || o.risk === "low" ? (o.risk as RouteTaskInput["risk"]) : "low";
  const writesFiles = typeof o.writesFiles === "boolean" ? o.writesFiles : mode === "goal";
  // dependsOn: accept ["1"] or ["t1"]; keep only references to earlier tasks.
  const deps = Array.isArray(o.dependsOn)
    ? o.dependsOn
        .map((d) => {
          const s = String(d).replace(/^t/i, "");
          const n = parseInt(s, 10);
          return Number.isFinite(n) && n >= 1 && n <= count && n < index + 1 ? `t${n}` : null;
        })
        .filter((x): x is string => x !== null)
    : undefined;
  return {
    taskId: id,
    title,
    ...(description ? { description } : {}),
    phase,
    mode,
    risk,
    writesFiles,
    needsRepoWideContext: o.needsRepoWideContext === true || undefined,
    needsStrongReasoning: o.needsStrongReasoning === true || undefined,
    needsDelegateCli: o.needsDelegateCli === true || undefined,
    needsVisualReview: o.needsVisualReview === true || undefined,
    ...(deps && deps.length ? { dependsOn: deps } : {}),
  };
}

function parsePlan(text: string): PlannedTask[] {
  // Models sometimes wrap the array in prose or a ```json fence — slice the
  // outermost [ … ] and parse that.
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) throw new Error("no JSON array in reply");
  const arr = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(arr) || arr.length === 0) throw new Error("empty plan");
  const capped = arr.slice(0, 12);
  return capped.map((t, i) => coerceTask(t, i, capped.length));
}

/** Decompose a goal into tasks via the model. Throws on unreachable model or an
 *  unparseable reply — callers fall back to `stubPlan`. */
export async function planGoal(
  goal: string,
  override?: { provider: ProviderId; model: string },
): Promise<PlannedTask[]> {
  const trimmed = goal.trim();
  if (!trimmed) throw new Error("empty goal");
  const { provider, model } = override ?? resolvePlannerModel();
  const reply = await callModel(provider, model, [{ role: "user", content: PLANNER_PROMPT + trimmed }]);
  return parsePlan(reply);
}
