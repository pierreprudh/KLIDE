// The Run a saved trigger starts from — what a conversation in that
// Workspace would send: system prompt, skills, project rules and harness
// settings. Shared by Scheduled and the CI watch so both start the same Run.

import type { AgentMode, ProviderId, StartAgentRunInput } from "./types";
import type { HarnessSettings } from "../settingsStore";
import { isAutoProvider } from "./providers";
import { buildSystemPrompt } from "../components/ai/system-prompt";
import { allFavModels } from "../favModels";
import { enabledRunSkills, loadFilesystemSkills, loadSkills, mergeFilesystemSkills } from "../skills";
import { readWorkspaceTextFile } from "../workspaceFs";

export async function scheduledRunInput({ root, provider, model, mode, text, settings }: { root: string; provider: ProviderId; model: string; mode: AgentMode; text: string; settings: HarnessSettings }): Promise<StartAgentRunInput> {
  const [skills, rules] = await Promise.all([
    loadFilesystemSkills(root).then(scanned => mergeFilesystemSkills(loadSkills(), scanned)),
    (async () => {
      for (const name of ["AGENTS.md", "CLAUDE.md"]) {
        try { return (await readWorkspaceTextFile(root, name)).slice(0, 6000).trim(); } catch { /* Try the next convention. */ }
      }
      return "";
    })(),
  ]);
  return {
    workspaceRoot: root, provider, model, mode, text, attachments: [],
    systemPrompt: buildSystemPrompt(root, true, skills, mode, mode !== "chat", rules, settings, model, provider),
    skills: enabledRunSkills(skills), maxParallelTools: settings.maxParallelTools,
    requireDiffReview: true, maxTurns: settings.maxTurns, commandTimeoutSecs: settings.commandTimeoutSecs,
    testAfterEditCommand: settings.testAfterEditCommand,
    numCtx: settings.contextWindows?.[model], reflectionLevel: settings.reflectionLevels?.[model],
    preferredModels: isAutoProvider(provider) ? allFavModels() : undefined,
  };
}
