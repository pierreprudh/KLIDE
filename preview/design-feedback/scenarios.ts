export const SCENARIOS = ["conversation-long", "compose-empty", "tools-and-review", "waiting-and-error", "subagent-activity", "composer-menu", "result-and-diff"] as const;
export type ScenarioId = typeof SCENARIOS[number];
export const THEMES = ["klide-light", "sage-garden-dark"] as const;
export type CaptureTheme = typeof THEMES[number];
export function parseScenario(params: URLSearchParams): { scenarioId: ScenarioId; theme: CaptureTheme } {
  const scenarioId = params.get("scenario") ?? "conversation-long";
  const theme = params.get("theme") ?? "klide-light";
  if (!SCENARIOS.includes(scenarioId as ScenarioId)) throw new Error(`Unknown scenario: ${scenarioId}`);
  if (!THEMES.includes(theme as CaptureTheme)) throw new Error(`Unknown theme: ${theme}`);
  return { scenarioId: scenarioId as ScenarioId, theme: theme as CaptureTheme };
}
