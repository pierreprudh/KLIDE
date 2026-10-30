import { describe, expect, it } from "vitest";
import type { Msg } from "./types";
import { historyBefore, withCarriedHistory } from "./carriedHistory";

const user = (content: string): Msg => ({ role: "user", content });
const assistant = (content: string): Msg => ({ role: "assistant", content });

describe("retrievable carried history", () => {
  it("keeps the request intact and the last three prose messages in order", () => {
    const history: Msg[] = [user("original goal"), assistant("older detail"), user("recent one"),
      { role: "tool", content: "tool output", toolName: "Bash" } as Msg,
      assistant("recent two"), user("recent three")];
    const turn = withCarriedHistory(history, "what next?", "Claude Code");
    expect(turn.text).toBe("what next?");
    const context = turn.attachments[0].content;
    expect(context).toContain("Earlier conversation with Claude Code");
    expect(context).toContain('count="3" total="5"');
    const recent = context.split("<recent-messages")[1].split("</recent-messages>")[0];
    expect(recent).toContain("[message 3, user]\nrecent one");
    expect(recent).toContain("[message 4, assistant]\nrecent two");
    expect(recent).toContain("[message 5, user]\nrecent three");
    expect(context).not.toContain("older detail");
    expect(context).not.toContain("tool output");
    expect(context).toContain("search_conversations");
    expect(context).toContain("read_conversation");
    expect(context).toContain('conversationId: "current"');
    expect(turn.conversationHistory?.messages).toHaveLength(5);
    expect(turn.conversationHistory?.messages[1].text).toBe("older detail");
  });

  it("bounds the prompt even for huge messages, preserving the exact archive", () => {
    const huge = "x" + "🦀".repeat(50_000);
    const turn = withCarriedHistory([user(huge), assistant(huge), user(huge), assistant(huge)], "next");
    expect(turn.attachments[0].content.length).toBeLessThan(9000);
    expect(turn.conversationHistory?.messages.map((m) => m.text)).toEqual([huge, huge, huge, huge]);
    expect(turn.attachments[0].content).toContain("unverified excerpt");
    for (const char of turn.attachments[0].content) {
      expect(char.length !== 1 || !/[\uD800-\uDFFF]/.test(char)).toBe(true);
    }
  });

  it("preserves user attachments and handles fewer than three messages", () => {
    const attachments = [{ path: "error.txt", content: "failure" }];
    const turn = withCarriedHistory([user("earlier request")], "fix this", "Claude Code", attachments);
    expect(turn.attachments).toContainEqual(attachments[0]);
    expect(attachments).toHaveLength(1);
    expect(turn.attachments[0].content).toContain('count="1" total="1"');
  });

  it("adds nothing for empty or tool-only history", () => {
    const attachments = [{ path: "error.txt", content: "failure" }];
    expect(withCarriedHistory([], "yo", undefined, attachments)).toEqual({ text: "yo", attachments });
    expect(withCarriedHistory([{ role: "tool", content: "tool output" } as Msg], "yo").conversationHistory).toBeUndefined();
  });
});

describe("historyBefore", () => {
  it("stops at the turn's own user message, already appended", () => {
    expect(historyBefore([user("a"), assistant("b"), user("yo")], "yo")).toEqual([user("a"), assistant("b")]);
    expect(historyBefore([user("a"), assistant("b"), user("first queued"), user("second queued")], "first queued")).toEqual([user("a"), assistant("b")]);
  });
});
