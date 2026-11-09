import catalog from "./catalog.json";
import { foldAgentEvents, foldedToMsgs } from "../../src/agent/foldEvents";
import { scenarioEvents } from "./events";
import type { ScenarioId } from "./scenarios";
import type { Conversation, Msg } from "../../src/components/ai/types";

export const FIXTURE_VERSION = "2";
export const FIXED_TIME = catalog.fixedTime;
export const MODEL = "fixture-vision";
export const WORKSPACE = "/design-fixture/klide";
const longPath = "src/components/conversation/very-long-workspace-name/keyboard-navigation-and-accessibility/TranscriptWithRetainedToolEvidence.tsx";
const msgs: Msg[] = [
  { role: "user", content: "Inspect the conversation panel. Keep long paths and tool output readable, then explain how keyboard navigation works.", ts: FIXED_TIME },
  { role: "assistant", content: "I’ll read the transcript and its keyboard bindings before proposing a change.", ts: FIXED_TIME + 1000 },
  ...Array.from({ length: 6 }, (_, i): Msg[] => [
    { role: "assistant", content: "", thinking: `Inspecting evidence ${i + 1}.`, thinkingMs: 800, toolCalls: [{ id: `fixture-call-${i}`, name: "read_file", args: { path: i % 2 ? longPath : "src/shortcuts.ts" } }] },
    { role: "tool", toolCallId: `fixture-call-${i}`, toolName: "read_file", content: `Read fixture ${i + 1}: keyboard actions stay scoped to the active surface.` },
  ]).flat(),
  { role: "assistant", content: `The transcript uses the normal tool fold. Its source is \`${longPath}\`.\n\n## Keyboard behavior\n\nTab moves between controls. Escape dismisses a menu and returns focus. Long code stays in its own horizontal scroll area.\n\n\`\`\`typescript\n${Array.from({ length: 30 }, (_, i) => `const observation${i + 1} = { path: "${longPath}", expected: "keep the reading column inside its viewport" };`).join("\n")}\n\`\`\`\n\nThe checks above describe synthetic fixture content; no workspace files were read.`, meta: { ms: 4200, tokens: 620, exact: true }, ts: FIXED_TIME + 9000 },
  { role: "user", content: "What should I verify at a smaller window size?", ts: FIXED_TIME + 10000 },
  { role: "assistant", content: "Check that the composer stays reachable, code scrolls inside its block, and opening the tool fold preserves readable text. Scroll up to inspect earlier evidence, then use **Jump to latest message** to return here.", meta: { ms: 1800, tokens: 52, exact: true }, ts: FIXED_TIME + 12000 },
];

export function fixtureConversation(scenario: ScenarioId = "conversation-long", state = "initial"): Conversation {
  const empty = scenario === "compose-empty" || scenario === "composer-menu";
  const children = scenario === "subagent-activity";
  const history = scenario === "conversation-long" ? structuredClone(msgs) : foldedToMsgs(foldAgentEvents(scenarioEvents(scenario, state)));
  return { id: "design-fixture-conversation", title: "Conversation layout evidence", renamed: true, provider: children ? "claude-code" : "openai", model: children ? "default" : MODEL, cwd: WORKSPACE, branch: "fixture/design-feedback", createdAt: FIXED_TIME, updatedAt: FIXED_TIME + 12000, msgs: empty ? [] : history };
}
