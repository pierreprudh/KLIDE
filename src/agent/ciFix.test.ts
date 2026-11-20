import { expect, it } from "vitest";
import { ciDiagnosis, ciFixTurn, ciLog, ciVerdict } from "./ciFix";
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

it("carries the CI log the watch already fetched", () => {
  const first = { type: "user_message", text: "CI failed…\n<ci-log-18f>\n##[error] expected 3, got 2\n</ci-log-18f>" } as unknown as AgentEvent;
  expect(ciLog([first])).toBe("##[error] expected 3, got 2");
  expect(ciFixTurn(fired, "", ws, ciLog([first])).attachment.content).toContain("<ci-log>\n##[error] expected 3, got 2\n</ci-log>");
});

it("boils a diagnosis down to one plain sentence", () => {
  expect(ciVerdict("## Cause\n\nThe **canary** test asserts `1 + 1 === 3`. Delete it.\n\n## Fix\n…")).toBe("The canary test asserts 1 + 1 === 3.");
  expect(ciVerdict("")).toBe("");
  expect(ciVerdict("x".repeat(200)).length).toBe(120);
});
