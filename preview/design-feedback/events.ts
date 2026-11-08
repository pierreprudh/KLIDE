import type { AgentEvent } from "../../src/agent/types";
import type { ScenarioId } from "./scenarios";
import { FIXED_TIME, MODEL, WORKSPACE } from "./fixtures";

export const RUN_ID = "design-fixture-conversation";
export const COMMAND = 'npm run check -- --workspace src/components/conversation/keyboard-navigation-and-accessibility --report artifacts/design-feedback/synthetic-command-result.json';
export const SCENARIO_STATES = {
  "conversation-long": ["initial", "earlier"],
  "compose-empty": ["initial"],
  "tools-and-review": ["initial", "diff", "rejected"],
  "waiting-and-error": ["initial", "error", "recovered"],
  "subagent-activity": ["initial", "settled"],
  "composer-menu": ["initial"],
  "result-and-diff": ["initial"],
} as const;

/** The end-to-end review run: README.md approved in its edit card, then
 *  "Validate all" on notes/a.md's card, so notes/b.md applies by policy
 *  (`via: "auto"`). Long lines exercise the compact diff's wrapping. */
export const RESULT_FILES = ["README.md", "notes/a.md", "notes/b.md"] as const;
const longList = (name: string) => [`# ${name}`, "", ...Array.from({ length: 20 }, (_, i) => `- Item ${i + 1}: a deliberately long sentence that keeps going past the column so the compact diff has to wrap it in view.`)];
// A function, not a constant: fixtures.ts and this module import each other,
// so WORKSPACE is not initialised while this module first evaluates.
export function resultCheckpoints() {
  const readmeBefore = "# Klide acceptance sandbox\n\nThrowaway repo for the real-app acceptance pass. `test.sh` is the check;\nthe punctuation case fails until a worker fixes `slug.sh`.\n";
  const readmeAfter = readmeBefore + "Every run here is disposable: reset with `git checkout .` once the acceptance pass is recorded.\n";
  return [
    { toolCallId: "edit-readme", path: "README.md", oldContent: readmeBefore, newContent: readmeAfter, isCreate: false, workspaceRoot: WORKSPACE, ts: FIXED_TIME - 9000 },
    { toolCallId: "edit-a", path: "notes/a.md", oldContent: "", newContent: longList("Note A").join("\n") + "\n", isCreate: true, workspaceRoot: WORKSPACE, ts: FIXED_TIME - 8000 },
    { toolCallId: "edit-b", path: "notes/b.md", oldContent: "", newContent: longList("Note B").join("\n") + "\n", isCreate: true, workspaceRoot: WORKSPACE, ts: FIXED_TIME - 7000 },
  ];
}

type EventBody<T> = T extends unknown ? Omit<T, "ts" | "runId"> : never;

export function scenarioEvents(scenario: ScenarioId, state = "initial"): AgentEvent[] {
  if (scenario === "conversation-long" || scenario === "compose-empty" || scenario === "composer-menu") return [];
  const events: AgentEvent[] = [];
  let ts = FIXED_TIME - 10000;
  const add = (event: EventBody<AgentEvent>) => events.push({ ...event, runId: RUN_ID, ts: ts += 100 } as AgentEvent);
  add({ type: "run_started", cwd: WORKSPACE, mode: "goal", provider: scenario === "subagent-activity" ? "claude-code" : "openai", model: scenario === "subagent-activity" ? "default" : MODEL });
  add({ type: "user_message", messageId: "fixture-user", text: scenario === "result-and-diff" ? "Add one sentence to the end of README.md. Then create notes/a.md and notes/b.md with a 20-line list of long sentences." : scenario === "tools-and-review" ? "Inspect the keyboard bindings, run the checks, and propose a small edit for review." : scenario === "waiting-and-error" ? "Help me choose a storage option, then continue with the result." : "Inspect the transcript, composer, and accessibility rules with four explorers.", attachments: [] });
  if (scenario === "tools-and-review") {
    add({ type: "assistant_message", messageId: "fixture-intro", content: [{ type: "text", text: "I read the bindings. The check command needs approval before the edit can be reviewed." }] });
    add({ type: "tool_call_started", toolCallId: "read-bindings", name: "read_file", input: { path: "src/shortcuts.ts" }, summary: "Read keyboard bindings", capability: "read_workspace" });
    add({ type: "tool_call_finished", toolCallId: "read-bindings", result: { ok: true, content: "Bindings inspected: Escape dismisses the current menu; Enter sends the focused composer." } });
    add({ type: "tool_call_started", toolCallId: "check-command", name: "run_command", input: { command: COMMAND }, summary: COMMAND, capability: "run_command" });
    add({ type: "permission_requested", request: { id: "fixture-permission", runId: RUN_ID, toolCallId: "check-command", toolName: "run_command", input: { command: COMMAND }, summary: COMMAND, reason: "Run the synthetic workspace checks.", options: [{ optionId: "allow", label: "Allow once", behavior: "allow", scope: "once" }, { optionId: "deny", label: "Deny", behavior: "deny" }] } });
    if (state === "diff" || state === "rejected") {
      add({ type: "permission_resolved", requestId: "fixture-permission", decision: { behavior: "allow", scope: "once" } });
      add({ type: "tool_call_finished", toolCallId: "check-command", result: { ok: true, content: "Synthetic checks: 12 passed, 0 failed. No command was executed." } });
      add({ type: "tool_call_started", toolCallId: "edit-binding", name: "edit_file", input: { path: "src/shortcuts.ts", old: "menuEscape: false", new: "menuEscape: true" }, summary: "Update the Escape binding", capability: "write_workspace" });
      add({ type: "diff_proposed", proposal: { id: "fixture-diff", runId: RUN_ID, toolCallId: "edit-binding", path: "src/shortcuts.ts", oldContent: "export const menuEscape = false;\n", newContent: "export const menuEscape = true;\n", oldHash: "fixture-old", newHash: "fixture-new", unifiedDiff: "@@ -1 +1 @@\n-export const menuEscape = false;\n+export const menuEscape = true;", isCreate: false } });
    }
    if (state === "rejected") {
      add({ type: "diff_resolved", proposalId: "fixture-diff", decision: { behavior: "reject" } });
      add({ type: "tool_call_finished", toolCallId: "edit-binding", result: { ok: false, content: "Edit rejected by operator. No file was changed." } });
      add({ type: "assistant_message", messageId: "fixture-rejected", content: [{ type: "text", text: "The proposed edit was rejected. No workspace files were changed." }] });
      add({ type: "run_result", result: { status: "done" } });
    }
  } else if (scenario === "result-and-diff") {
    const decisions = [{ behavior: "apply" }, { behavior: "apply", scope: "run" }, { behavior: "apply", via: "auto" }] as const;
    RESULT_FILES.forEach((path, i) => {
      const id = `result-edit-${i}`;
      add({ type: "tool_call_started", toolCallId: id, name: i ? "write_file" : "edit_file", input: { path }, summary: `Edit ${path}`, capability: "write_workspace" });
      add({ type: "diff_proposed", proposal: { id: `result-diff-${i}`, runId: RUN_ID, toolCallId: id, path, oldContent: "", newContent: "", oldHash: "old", newHash: "new", unifiedDiff: "", isCreate: i > 0 } });
      add({ type: "diff_resolved", proposalId: `result-diff-${i}`, decision: decisions[i] });
      add({ type: "file_changed", path, oldHash: "old", newHash: "new" });
      add({ type: "tool_call_finished", toolCallId: id, result: { ok: true, content: `Applied ${path}.` } });
    });
    add({ type: "assistant_message", messageId: "fixture-result-answer", content: [{ type: "text", text: "Added the reset note to README.md and created notes/a.md and notes/b.md. Three files changed — the result card on the right shows them." }] });
    add({ type: "run_result", result: { status: "done" } });
  } else if (scenario === "waiting-and-error") {
    add({ type: "assistant_message", messageId: "fixture-question-intro", content: [{ type: "text", text: "Choose the storage option before I continue." }] });
    add({ type: "user_question_requested", requestId: "fixture-question", question: "Which storage should this workspace use?", choices: { options: ["SQLite — local file", "Postgres — shared service"] } });
    if (state === "error" || state === "recovered") {
      add({ type: "user_question_resolved", requestId: "fixture-question", answer: "SQLite — local file" });
      add({ type: "run_error", error: { code: "provider_unavailable", message: "Synthetic provider is temporarily unavailable. No work was lost.", retryable: true } });
    }
    if (state === "recovered") {
      add({ type: "run_started", cwd: WORKSPACE, mode: "goal", provider: "openai", model: MODEL });
      add({ type: "assistant_message", messageId: "fixture-recovered", content: [{ type: "text", text: "Recovered successfully. The selected storage is SQLite — local file." }] });
      add({ type: "run_result", result: { status: "done" } });
    }
  } else {
    add({ type: "assistant_message", messageId: "fixture-child-intro", content: [{ type: "text", text: "The explorers are inspecting independent surfaces. Their steps stay in the activity tray." }] });
    const children = [
      { id: "explorer-transcript", task: "Inspect transcript wrapping", status: "running", activity: "Reading ChatMessage.tsx" },
      { id: "explorer-composer", task: "Inspect composer bindings", status: "completed", activity: undefined },
      { id: "explorer-a11y", task: "Inspect accessibility rules", status: "failed", activity: undefined },
      { id: "explorer-stopped", task: "Inspect legacy menu", status: "stopped", activity: undefined },
    ] as const;
    for (const child of children) {
      add({ type: "observed_tool_call", toolCallId: child.id, provider: "claude-code", name: "Agent", input: { description: child.task, subagent_type: "Explore", run_in_background: true }, summary: child.task });
      add({ type: "observed_tool_result", toolCallId: child.id, ok: true, content: "Async agent launched successfully." });
      add({ type: "observed_tool_call", toolCallId: `${child.id}-read`, provider: "claude-code", name: "Read", input: { file_path: "src/components/ai/ChatMessage.tsx" }, summary: "Read source evidence", parentToolCallId: child.id });
      add({ type: "observed_tool_result", toolCallId: `${child.id}-read`, ok: child.status !== "failed", content: `Synthetic evidence for ${child.task}.`, parentToolCallId: child.id });
      add({ type: "observed_subagent", toolCallId: child.id, status: state === "settled" && child.status === "running" ? "completed" : child.status, activity: state === "settled" ? undefined : child.activity, steps: 1 });
    }
    if (state === "settled") {
      add({ type: "assistant_message", messageId: "fixture-children-settled", content: [{ type: "text", text: "All explorers have settled. Two completed, one failed, and one was stopped; inspect their steps before continuing." }] });
      add({ type: "run_result", result: { status: "done" } });
    }
  }
  return events;
}
