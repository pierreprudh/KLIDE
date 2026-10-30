import { describe, expect, it } from "vitest";
import type { Msg } from "./types";
import { historyBefore, withCarriedHistory } from "./carriedHistory";

const user = (content: string): Msg => ({ role: "user", content });
const assistant = (content: string): Msg => ({ role: "assistant", content });

describe("withCarriedHistory — the first turn of a carried conversation", () => {
  it("keeps the real request as the user text and carries earlier prose as context", () => {
    const history: Msg[] = [
      user("map the agent folder"),
      { role: "tool", content: "ls output", toolName: "Bash" } as Msg,
      assistant("It has 44 files."),
    ];
    const turn = withCarriedHistory(history, "first message in this conv ?", "Claude Code");
    // The transcript and Mission Control title must see the person's request,
    // not the synthetic history preamble shown in the reported OpenCode run.
    expect(turn.text).toBe("first message in this conv ?");
    expect(turn.attachments).toHaveLength(1);
    const context = turn.attachments[0].content;
    expect(context).toContain("began earlier with Claude Code");
    expect(context).toContain("[user]\nmap the agent folder");
    expect(context).toContain("[assistant]\nIt has 44 files.");
    expect(context).not.toContain("ls output");
    expect(context).not.toContain("first message in this conv ?");
    expect(context).toContain("attached to");
  });

  it("keeps existing attachments alongside the imported history", () => {
    const attachments = [{ path: "error.txt", content: "failure" }];
    const turn = withCarriedHistory([user("earlier request")], "fix this", "Claude Code", attachments);
    expect(turn.text).toBe("fix this");
    expect(turn.attachments).toContainEqual(attachments[0]);
    expect(turn.attachments).toHaveLength(2);
    expect(attachments).toHaveLength(1);
  });

  it("sends the text and attachments alone when nothing was carried", () => {
    const attachments = [{ path: "error.txt", content: "failure" }];
    expect(withCarriedHistory([], "yo", undefined, attachments)).toEqual({ text: "yo", attachments });
  });

  it("drops the oldest turns first past the budget", () => {
    const big = "x".repeat(40_000);
    const turn = withCarriedHistory([user(`old ${big}`), assistant(`new ${big}`)], "next");
    const context = turn.attachments[0].content;
    expect(context).not.toContain("old x");
    expect(context).toContain("new x");
    expect(context).toContain("(1 older turn left out)");
  });
});

describe("historyBefore", () => {
  it("stops at the turn's own user message, already appended", () => {
    const msgs = [user("a"), assistant("b"), user("yo")];
    expect(historyBefore(msgs, "yo")).toEqual([user("a"), assistant("b")]);
  });
});
