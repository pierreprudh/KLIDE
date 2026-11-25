import { expect, it } from "vitest";
import { klideBotLookTurn, mentionAsk } from "./klideBotLook";
import type { BotMention } from "../ipc/klideBot";

const mention: BotMention = { workspaceRoot: "/w", repo: "o/r", prNumber: 603, commentId: 1,
  commentUrl: "https://github.com/o/r/pull/603#issuecomment-1", author: "pierre", body: "@Klide-Bot, why\n does it fail?", at: 1 };

it("starts an investigation with the full GitHub context attached and no posting or pushing", () => {
  const turn = klideBotLookTurn(mention, { cwd: "/worktree", title: "Fix the bug", url: "https://github.com/o/r/pull/603", context: "Full thread and diff" });
  expect(turn.text).toContain("why does it fail?");
  expect(turn.text).toContain("explain your findings before making changes");
  expect(turn.text).toContain("Do not post a GitHub reply or push commits");
  expect(turn.attachment).toEqual({ path: "PR #603 thread.md", content: "Full thread and diff" });
});

it("keeps the opening line short without dropping the attached context", () => {
  const turn = klideBotLookTurn({ ...mention, body: `@klide-bot ${"long question ".repeat(1000)}` }, { cwd: "/w", title: "Title", url: "u", context: "full context" });
  expect(turn.text.length).toBeLessThan(600);
  expect(turn.attachment.content).toBe("full context");
  expect(mentionAsk("@klide-bot:")).toBe("");
});
