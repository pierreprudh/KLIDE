import { expect, it } from "vitest";
import { botActivityLabel, botActivitySummary, botActivityThreads } from "./botActivity";
import type { BotMention } from "../ipc/klideBot";

it("distinguishes mentions, requests, replies and review verdicts", () => {
  expect(botActivityLabel({ kind: "mention" })).toBe("Mention");
  expect(botActivityLabel({ kind: "review_request" })).toBe("Review requested");
  expect(botActivityLabel({ kind: "reply" })).toBe("Bot reply");
  expect(botActivityLabel({ kind: "review", verdict: "pass" })).toBe("Review passed");
  expect(botActivityLabel({ kind: "review", verdict: "fail" })).toBe("Review found issues");
});

it("shows the review content without its marker, metadata or footer", () => {
  const body = '<!-- klide-review --> verdict=pass sha=abc\n**Review** · `model` · abc\n\nEverything looks sound.\n\nVERDICT: PASS\n\n<sub>Run details</sub>';
  expect(botActivitySummary({ kind: "review", body })).toBe("Everything looks sound.");
  expect(botActivitySummary({ kind: "mention", body: "@klide-bot why?" })).toBe("why?");
});

it("keeps questions and replies together, with reviews in their own filter", () => {
  const event = (id: number, kind: BotMention["kind"], pr = 603, repo = "o/r"): BotMention => ({ workspaceRoot: "/w", repo, prNumber: pr, commentId: id, commentUrl: "u", author: "p", body: "b", at: id, kind });
  const items = [event(1, "mention"), event(4, "review_request", 624), event(2, "reply"), event(5, "mention", 603, "other/r"), event(3, "review")];
  expect(botActivityThreads(items, "mentions").map(t => [t.key, t.events.map(e => e.commentId)])).toEqual([["other/r#603", [5]], ["o/r#603", [2, 1]]]);
  expect(botActivityThreads(items, "reviews").map(t => t.events.map(e => e.commentId))).toEqual([[4], [3]]);
  expect(botActivityThreads(items, "all").map(t => t.events.map(e => e.commentId))).toEqual([[5], [4], [3, 2, 1]]);
  expect(items.map(e => e.commentId)).toEqual([1, 4, 2, 5, 3]);
});
