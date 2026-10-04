import { describe, expect, it } from "vitest";
import { mentionKeyAction, mentionQueryAt, replaceMention } from "./mentions";

describe("mentionQueryAt", () => {
  it("opens on a lone @ at the head and knows it is at the start", () => {
    expect(mentionQueryAt("@")).toEqual({ query: "", start: 0, atStart: true });
    expect(mentionQueryAt("@rev")).toEqual({ query: "rev", start: 0, atStart: true });
  });

  it("opens mid-sentence after a space, not at the start", () => {
    expect(mentionQueryAt("fix @src/ap")).toEqual({ query: "src/ap", start: 4, atStart: false });
  });

  it("reads the word under the caret, not the end of the draft", () => {
    const value = "look at @src then @README";
    expect(mentionQueryAt(value, 11)).toEqual({ query: "sr", start: 8, atStart: false });
  });

  it("stays shut on an email, a closed mention and a second @", () => {
    expect(mentionQueryAt("mail a@b.dev")).toBeNull();
    expect(mentionQueryAt("fix @src/app.ts ")).toBeNull();
    expect(mentionQueryAt("@@")).toBeNull();
  });
});

describe("replaceMention", () => {
  it("swaps the typed word for the path and parks the caret after the space", () => {
    const next = replaceMention({ value: "fix @ap now", start: 4, caret: 7, text: "src/App.tsx" });
    expect(next).toEqual({ value: "fix @src/App.tsx  now", caret: 17 });
  });

  it("puts a subagent at the head and keeps the sentence typed after it", () => {
    const next = replaceMention({ value: "@rev the diff", start: 0, caret: 4, text: "reviewer" });
    expect(next).toEqual({ value: "@reviewer  the diff", caret: 10 });
  });
});

describe("mentionKeyAction", () => {
  it("maps the same keys the slash menu answers", () => {
    expect(mentionKeyAction("ArrowDown")).toBe("next");
    expect(mentionKeyAction("ArrowUp")).toBe("prev");
    expect(mentionKeyAction("Enter")).toBe("accept");
    expect(mentionKeyAction("Tab")).toBe("accept");
    expect(mentionKeyAction("Escape")).toBe("close");
    expect(mentionKeyAction("a")).toBeNull();
  });
});
