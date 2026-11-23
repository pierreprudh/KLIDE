import { describe, expect, it } from "vitest";
import { klideBotLookTurn, parseMentionTurn } from "./klideBotLook";
import type { KlideBotMention } from "../ipc/klideBot";

const mention: KlideBotMention = {
  key: "k", workspaceRoot: "/w", repo: "pierreprudh/KLIDE", prNumber: 603, prTitle: `Say "hi" to it`,
  commentUrl: "u", author: "pierre", excerpt: "@klide-bot why?", body: "@klide-bot why\n does it?",
  provider: "", model: "", at: 1, announced: true, notified: true,
};

describe("klide-bot Look into it turn", () => {
  it("reads back as the card's facts", () => {
    const turn = klideBotLookTurn(mention, { cwd: "/c", branch: "b", sha: "s", headRef: "feat/x", crossRepo: false, context: "ctx" });
    expect(turn.attachment).toEqual({ path: "PR #603 thread.md", content: "ctx" });
    expect(parseMentionTurn(turn.text)).toEqual({
      author: "pierre", number: 603, title: `Say "hi" to it`, url: "https://github.com/pierreprudh/KLIDE/pull/603", ask: "why does it?",
    });
  });

  it("leaves other messages alone", () => {
    expect(parseMentionTurn("Fix the failing test on #603.")).toBeNull();
  });
});
