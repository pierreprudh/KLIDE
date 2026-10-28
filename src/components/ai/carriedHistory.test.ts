import { describe, expect, it } from "vitest";
import type { Msg } from "./types";
import { historyBefore, withCarriedHistory } from "./carriedHistory";

const user = (content: string): Msg => ({ role: "user", content });
const assistant = (content: string): Msg => ({ role: "assistant", content });

describe("withCarriedHistory — the first turn of a carried conversation", () => {
  it("puts the earlier prose ahead of the request, tool rows left out", () => {
    const history: Msg[] = [
      user("map the agent folder"),
      { role: "tool", content: "ls output", toolName: "Bash" } as Msg,
      assistant("It has 44 files."),
    ];
    const text = withCarriedHistory(history, "first message in this conv ?", "Claude Code");
    expect(text).toContain("began earlier with Claude Code");
    expect(text).toContain("[user]\nmap the agent folder");
    expect(text).toContain("[assistant]\nIt has 44 files.");
    expect(text).not.toContain("ls output");
    expect(text.endsWith("first message in this conv ?")).toBe(true);
  });

  it("sends the text alone when nothing was carried", () => {
    expect(withCarriedHistory([], "yo")).toBe("yo");
  });

  it("drops the oldest turns first past the budget", () => {
    const big = "x".repeat(40_000);
    const text = withCarriedHistory([user(`old ${big}`), assistant(`new ${big}`)], "next");
    expect(text).not.toContain("old x");
    expect(text).toContain("new x");
    expect(text).toContain("(1 older turn left out)");
  });
});

describe("historyBefore", () => {
  it("stops at the turn's own user message, already appended", () => {
    const msgs = [user("a"), assistant("b"), user("yo")];
    expect(historyBefore(msgs, "yo")).toEqual([user("a"), assistant("b")]);
  });
});
