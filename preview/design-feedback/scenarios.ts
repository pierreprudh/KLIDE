import catalog from "./catalog.json";
import { SCENARIO_STATES } from "./events";
// catalog.json is the one list — shared with the capture scripts and the
// native parity menu. SCENARIO_STATES gives each scenario its states and the
// type; the page refuses to load if the two ever part.
export type ScenarioId = keyof typeof SCENARIO_STATES;
export const SCENARIOS: readonly string[] = catalog.scenarios.map(s => s.id);
export const THEMES: readonly string[] = catalog.themes.map(t => t.id);
export type CaptureTheme = string;
const stated = Object.keys(SCENARIO_STATES);
if (stated.length !== SCENARIOS.length || SCENARIOS.some(id => !stated.includes(id))) {
  throw new Error(`catalog.json scenarios (${SCENARIOS.join(", ")}) differ from SCENARIO_STATES (${stated.join(", ")})`);
}
export function parseScenario(params: URLSearchParams): { scenarioId: ScenarioId; theme: CaptureTheme } {
  const scenarioId = params.get("scenario") ?? "conversation-long";
  const theme = params.get("theme") ?? "klide-light";
  if (!SCENARIOS.includes(scenarioId)) throw new Error(`Unknown scenario: ${scenarioId}`);
  if (!THEMES.includes(theme)) throw new Error(`Unknown theme: ${theme}`);
  return { scenarioId: scenarioId as ScenarioId, theme };
}
