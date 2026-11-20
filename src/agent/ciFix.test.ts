import { expect, it } from "vitest";
import { ciDiagnosis, ciFixPrompt } from "./ciFix";
import type { AgentEvent } from "./types";

const fired = {
  key: "k", workspaceRoot: "/w", prNumber: 573, prTitle: "Canary", prUrl: "u", checks: ["Frontend tests"],
  provider: "openrouter", model: "m", runId: "run_1", error: null, at: 1, announced: true,
};
const ws = { cwd: "/w-fix", branch: "klide/fix-pr-573-590249af", sha: "590249afda8a778ab13d4bd2f062c3f4675bb63c", headRef: "test/canary", crossRepo: false };

it("takes the last assistant text as the diagnosis", () => {
  const msg = (text: string) => ({ type: "assistant_message", runId: "r", messageId: text, content: [{ type: "text", text }] }) as unknown as AgentEvent;
  expect(ciDiagnosis([msg("first"), msg("Delete the canary test."), msg("  ")])).toBe("Delete the canary test.");
  expect(ciDiagnosis([])).toBe("");
});

it("names the branch, commit and push target, and fences the diagnosis", () => {
  const p = ciFixPrompt(fired, "Delete it.", ws);
  expect(p).toContain("PR #573");
  expect(p).toContain("`klide/fix-pr-573-590249af`");
  expect(p).toContain("`590249af`");
  expect(p).toContain("git push origin HEAD:test/canary");
  expect(p).toContain("<diagnosis>\nDelete it.\n</diagnosis>");
});

it("never offers a push to a fork's branch", () => {
  const p = ciFixPrompt(fired, "", { ...ws, crossRepo: true });
  expect(p).not.toContain("git push");
  expect(p).toContain("Don't push");
});
