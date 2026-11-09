// The capture matrix lives in matrix.json; the browser scripts and the native
// parity menu (src-tauri/src/design_parity.rs) read that file directly. The
// typed copy below exists for the compiler and must equal it — the page
// refuses to render otherwise, so drift fails the first capture.
import matrix from "./matrix.json";

export const SCENARIOS = ["conversation-long", "compose-empty", "tools-and-review", "waiting-and-error", "subagent-activity", "composer-menu", "result-and-diff"] as const;
export type ScenarioId = typeof SCENARIOS[number];
export const THEMES = ["klide-light", "sage-garden-dark"] as const;
export type CaptureTheme = typeof THEMES[number];
export const FIXED_TIME = matrix.fixedTime;
const same = (typed: readonly string[], listed: { id: string }[]) => typed.join() === listed.map(e => e.id).join();
if (!same(SCENARIOS, matrix.scenarios) || !same(THEMES, matrix.themes)) throw new Error("scenarios.ts drifted from matrix.json");
export function parseScenario(params: URLSearchParams): { scenarioId: ScenarioId; theme: CaptureTheme } {
  const scenarioId = params.get("scenario") ?? "conversation-long";
  const theme = params.get("theme") ?? "klide-light";
  if (!SCENARIOS.includes(scenarioId as ScenarioId)) throw new Error(`Unknown scenario: ${scenarioId}`);
  if (!THEMES.includes(theme as CaptureTheme)) throw new Error(`Unknown theme: ${theme}`);
  return { scenarioId: scenarioId as ScenarioId, theme: theme as CaptureTheme };
}
