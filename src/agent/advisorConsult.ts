// Service one `advisor_requested` event — shared by every run-owner that can
// receive it. When an executor calls `consult_advisor`, the Rust harness parks
// the run and emits `advisor_requested`; whoever owns that run's event stream
// must answer it, or the executor hangs forever. Originally only AiPanel did.
// Extracting it here lets the orchestrator console and goal fan-out service the
// consult too — identically — so consult_advisor works under the orchestrator,
// not just in a hand-driven AI panel.
//
// The caller decides WHICH advisor to use (the global harness setting, or a
// per-tier override); this module only executes the consult: a one-shot chat
// run (no tools), nested by parentId so it surfaces in Mission Control, whose
// answer resolves the parent's paused tool call.

import type { AgentEvent, ProviderId } from "./types";
import { startAgentRun, resolveUserQuestion } from "./client";
import { buildAdvisorSystemPrompt, ADVISOR_ERROR_PREFIX, type AdvisorConfig } from "./advisor";

export async function serviceAdvisorConsult(opts: {
  event: Extract<AgentEvent, { type: "advisor_requested" }>;
  advisor: AdvisorConfig;
  workspaceRoot: string | null;
}): Promise<void> {
  const { event, advisor, workspaceRoot } = opts;
  const systemPrompt = buildAdvisorSystemPrompt(workspaceRoot);
  let advice = "";
  try {
    const session = await startAgentRun(
      {
        runId: event.requestId,
        workspaceRoot,
        mode: "chat",
        provider: advisor.provider as ProviderId,
        model: advisor.model,
        text: event.question,
        attachments: [],
        context: { workspaceRoot, attachments: [], lensItems: [], estimatedTokens: 0, omitted: [] },
        systemPrompt,
        parentId: event.runId,
        maxTurns: 1,
      },
      (ev) => {
        if (ev.type === "assistant_message") {
          const text = ev.content.filter((b) => b.type === "text").map((b) => b.text).join("");
          if (text.trim()) advice = text;
        } else if (ev.type === "run_error") {
          advice = `${ADVISOR_ERROR_PREFIX}Advisor unavailable (${advisor.provider}/${advisor.model}): ${ev.error.message}`;
        }
      }
    );
    await session.done;
  } catch (e) {
    advice = `${ADVISOR_ERROR_PREFIX}Advisor consult failed: ${(e as Error).message}`;
  }
  // A blank reply is also a failure — flag it so the executor sees a not-ok tool
  // result, not an empty "guidance" string it might act on.
  const answer = advice.trim() || `${ADVISOR_ERROR_PREFIX}advisor produced no output`;
  await resolveUserQuestion({ runId: event.runId, requestId: event.requestId, answer });
}
