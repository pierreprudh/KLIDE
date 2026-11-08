import { mockIPC } from "@tauri-apps/api/mocks";
import { MODEL, FIXED_TIME } from "./fixtures";
import { emit } from "@tauri-apps/api/event";
import type { AgentEvent, PermissionDecision, DiffDecision } from "../../src/agent/types";
import type { ScenarioId } from "./scenarios";
import { RUN_ID, resultCheckpoints, scenarioEvents } from "./events";
export const MODELS = [MODEL, "fixture-fast", "fixture-reasoning"];

/** Every native boundary is explicit. Unknown calls fail capture, even when
 * the production component catches their rejection as a recoverable error. */
export function installNativeFixture(scenario: ScenarioId) {
  let events = scenarioEvents(scenario);
  let selectedState = "initial";
  const actions: { command: string; payload: Record<string, unknown> }[] = [];
  let generation = 0;
  let selectedAnswer = "SQLite — local file";
  const active = () => events.length > 0 && !["run_result", "run_error"].includes(events[events.length - 1].type);
  const append = async (extra: AgentEvent[]) => {
    const offset = events.length;
    events.push(...extra);
    for (let index = 0; index < extra.length; index++) await emit(`agent-run:${RUN_ID}`, { seq: offset + index, event: extra[index] });
  };
  const transition = async (state: string) => {
    const next = scenarioEvents(scenario, state);
    const extra = next.slice(events.length).map(event => event.type === "user_question_resolved" ? { ...event, answer: selectedAnswer } : event);
    selectedState = state;
    await append(extra);
  };
  const calls: string[] = [];
  const unexpected: string[] = [];
  mockIPC((command, args) => {
    calls.push(command);
    const payload = (args ?? {}) as Record<string, unknown>;
    switch (command) {
      case "ai_provider_models": return payload.provider === "claude-code" ? ["default"] : MODELS;
      case "ai_provider_model_meta": case "delegate_slash_commands": return [];
      case "ai_provider_key_status": return { hasKey: true, source: "env" };
      case "ai_model_capabilities": return { contextWindow: 128000, maxOutputTokens: 4096, supportsTools: true, supportsVision: true, reasoningLevels: [], priceClass: { kind: "unknown" }, maker: "open-ai" };
      case "ai_model_pricing": case "ai_sight_eyes": return null;
      case "shared_notes_read": return { revision: 0, sets: [] };
      case "read_text_file": return "";
      case "path_exists": return false;
      case "custom_provider_list": case "custom_cli_list": case "ai_list_tools":
      case "list_agent_runs": case "agent_list_runs": return [];
      case "agent_read_run": return structuredClone(events);
      case "coordination_snapshot": return { schemaVersion: 1, nextSeq: 0, runs: [], envelopes: [], results: [] };
      case "github_current_user": return { login: "fixture", avatarUrl: "" };
      case "ai_count_tokens": return { tokens: Math.ceil(String((args as Record<string, unknown> | undefined)?.text ?? "").length / 4), exact: false };
      case "agent_run_status": return { status: active() ? "running" : null, fromSeq: active() ? 0 : null };
      case "agent_resolve_permission": {
        const answer = payload.decision as { requestId: string; decision: PermissionDecision };
        if (scenario !== "tools-and-review" || selectedState !== "initial" || answer.requestId !== "fixture-permission") throw new Error("No matching fixture permission");
        actions.push({ command, payload: structuredClone(payload) });
        if (answer.decision.behavior === "allow") return transition("diff");
        return append([{ type: "permission_resolved", runId: RUN_ID, requestId: answer.requestId, decision: answer.decision, ts: FIXED_TIME }, { type: "run_result", runId: RUN_ID, result: { status: "cancelled" }, ts: FIXED_TIME }]);
      }
      case "agent_resolve_diff": {
        const answer = payload.decision as { proposalId: string; decision: DiffDecision };
        if (scenario !== "tools-and-review" || selectedState !== "diff" || answer.proposalId !== "fixture-diff") throw new Error("No matching fixture diff");
        actions.push({ command, payload: structuredClone(payload) });
        if (answer.decision.behavior === "reject") return transition("rejected");
        throw new Error("This fixture exercises rejected edits only");
      }
      case "agent_resolve_question": {
        const answer = payload.decision as { requestId: string; answer: string };
        if (scenario !== "waiting-and-error" || selectedState !== "initial" || answer.requestId !== "fixture-question") throw new Error("No matching fixture question");
        actions.push({ command, payload: structuredClone(payload) });
        selectedAnswer = answer.answer;
        return transition("error");
      }
      case "agent_abort_run": {
        actions.push({ command, payload: structuredClone(payload) });
        return append([{ type: "run_result", runId: RUN_ID, result: { status: "cancelled", message: "Synthetic Run cancelled." }, ts: FIXED_TIME }]);
      }
      case "agent_start_run": {
        const request = payload.request as { runId: string; retry?: boolean };
        if (scenario !== "waiting-and-error" || selectedState !== "error" || !request.retry) throw new Error("Only the explicit fixture retry may start a Run");
        actions.push({ command, payload: structuredClone({ request }) });
        const channel = payload.onEvent as { onmessage: (event: AgentEvent) => void };
        const extra = scenarioEvents(scenario, "recovered").slice(events.length).map(event => event.type === "assistant_message" ? { ...event, content: [{ type: "text" as const, text: `Recovered successfully. The selected storage is ${selectedAnswer}.` }] } : event);
        const epoch = generation;
        setTimeout(() => {
          if (epoch !== generation) return;
          events.push(...extra); selectedState = "recovered";
          extra.forEach(event => channel.onmessage(event));
        }, 0);
        return { runId: request.runId };
      }
      case "agent_list_checkpoints": return scenario === "result-and-diff" ? resultCheckpoints() : [];
      case "mission_list": case "agent_list_observers": case "agent_worker_statuses":
      case "agent_run_document_references":
      case "list_files": case "memory_list": return [];
      case "git_status": return { branch: "fixture/design-feedback", files: [] };
      case "app_user_info": return { username: "fixture", hostname: "design-fixture" };
      default:
        unexpected.push(command);
        throw new Error(`Unmocked native boundary: ${command}`);
    }
  }, { shouldMockEvents: true });
  return { calls, unexpected, actions,
    reset(state = "initial") { generation++; selectedAnswer = "SQLite — local file"; selectedState = state; events = scenarioEvents(scenario, state); actions.length = 0; unexpected.length = 0; calls.length = 0; },
    async settleChildren() {
      if (scenario !== "subagent-activity" || selectedState !== "initial") throw new Error("No active fixture children");
      selectedState = "settled";
      await append([{ type: "observed_subagent", runId: RUN_ID, toolCallId: "explorer-transcript", status: "completed", steps: 1, ts: FIXED_TIME - 200 }, ...scenarioEvents(scenario, "settled").slice(-2).map((event, i) => ({ ...event, ts: FIXED_TIME - 100 + i * 100 }))]);
    },
  };
}
