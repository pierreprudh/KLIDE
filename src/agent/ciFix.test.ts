import { expect, it } from "vitest";
import { ciDiagnosis, ciFixTurn } from "./ciFix";
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

it("keeps the visible line short and puts the diagnosis in a fenced note", () => {
  const { text, attachment } = ciFixTurn(fired, "Delete it.", ws);
  expect(text).toBe("Fix the failing Frontend tests on #573. Smallest change, run the check, commit, then push with `git push origin HEAD:test/canary`.");
  expect(attachment.path).toBe("CI #573 diagnosis.md");
  expect(attachment.content).toContain("`klide/fix-pr-573-590249af`");
  expect(attachment.content).toContain("`590249af`");
  expect(attachment.content).toContain("<diagnosis>\nDelete it.\n</diagnosis>");
});

it("never offers a push to a fork's branch", () => {
  const { text } = ciFixTurn(fired, "", { ...ws, crossRepo: true });
  expect(text).not.toContain("git push");
  expect(text).toContain("Don't push");
});
