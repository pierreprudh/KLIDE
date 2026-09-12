import { describe, it, expect } from "vitest";
import { navigatePromptHistory, promptHistoryEntries, type PromptHistoryInput } from "./promptHistory";
import type { Msg } from "./types";

const user = (content: string, extra: Partial<Extract<Msg, { role: "user" }>> = {}): Msg =>
  ({ role: "user", content, ...extra }) as Msg;

const nav = (over: Partial<PromptHistoryInput>) =>
  navigatePromptHistory({
    direction: "older",
    entries: ["first", "second", "third"],
    index: null,
    value: "",
    selectionStart: 0,
    selectionEnd: 0,
    draft: "",
    ...over,
  });

describe("promptHistoryEntries", () => {
  it("keeps typed user turns oldest first", () => {
    const entries = promptHistoryEntries([
      user("one"),
      { role: "assistant", content: "…" } as Msg,
      user("two"),
    ]);
    expect(entries).toEqual(["one", "two"]);
  });

  it("skips wake turns and blank turns", () => {
    const entries = promptHistoryEntries([
      user("", { attachments: [] }),
      user("read your mail", { wake: true }),
      user("   "),
      user("real"),
    ]);
    expect(entries).toEqual(["real"]);
  });

  it("collapses an immediately repeated prompt", () => {
    expect(promptHistoryEntries([user("again"), user("again"), user("new"), user("again")]))
      .toEqual(["again", "new", "again"]);
  });
});

describe("navigatePromptHistory", () => {
  it("recalls the newest prompt from an empty draft", () => {
    expect(nav({})).toEqual({ text: "third", index: 2, stash: true });
  });

  it("walks further back while the recalled entry is untouched", () => {
    expect(nav({ index: 2, value: "third", selectionStart: 5, selectionEnd: 5 }))
      .toEqual({ text: "second", index: 1 });
  });

  it("stops at the oldest prompt instead of moving the caret", () => {
    expect(nav({ index: 0, value: "first", selectionStart: 5, selectionEnd: 5 }))
      .toEqual({ text: "first", index: 0 });
  });

  it("leaves a multi-line draft's arrows alone below the first line", () => {
    expect(nav({ value: "a\nb", selectionStart: 3, selectionEnd: 3 })).toBeNull();
  });

  it("still recalls from the first line of a multi-line draft", () => {
    expect(nav({ value: "a\nb", selectionStart: 1, selectionEnd: 1, draft: "" }))
      .toEqual({ text: "third", index: 2, stash: true });
  });

  it("starts a fresh browse when the recalled entry was edited, keeping the edit as the draft", () => {
    expect(nav({ index: 2, value: "third!", selectionStart: 6, selectionEnd: 6 }))
      .toEqual({ text: "third", index: 2, stash: true });
  });

  it("hands a down-arrow back once the recalled entry is edited", () => {
    expect(nav({ direction: "newer", index: 2, value: "third!", selectionStart: 6, selectionEnd: 6 })).toBeNull();
  });

  it("ignores a key pressed over a selection", () => {
    expect(nav({ value: "abc", selectionStart: 0, selectionEnd: 3 })).toBeNull();
  });

  it("does nothing with no history", () => {
    expect(nav({ entries: [] })).toBeNull();
  });

  it("does nothing on the way forward unless a browse is open", () => {
    expect(nav({ direction: "newer", value: "draft", selectionStart: 5, selectionEnd: 5 })).toBeNull();
  });

  it("walks forward and restores the stashed draft past the newest entry", () => {
    const back = nav({ direction: "newer", index: 1, value: "second", selectionStart: 0, selectionEnd: 0, draft: "half written" });
    expect(back).toEqual({ text: "third", index: 2 });
    expect(nav({ direction: "newer", index: 2, value: "third", selectionStart: 0, selectionEnd: 0, draft: "half written" }))
      .toEqual({ text: "half written", index: null });
  });
});
