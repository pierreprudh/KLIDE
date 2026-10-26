import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SideQuestionToggle } from "./SideQuestionToggle";

const defaults = {
  conversationId: "main-chat",
  invokedFor: undefined as string | undefined,
  open: false,
  hasHistory: false,
  working: false,
  panelId: "btw-pane-main-chat",
  onToggle: () => {},
};

describe("side question toggle visibility", () => {
  it("shows nothing in a chat where /btw has not been invoked, even with saved history", () => {
    expect(renderToStaticMarkup(<SideQuestionToggle {...defaults} />)).toBe("");
    expect(renderToStaticMarkup(<SideQuestionToggle {...defaults} hasHistory />)).toBe("");
  });

  it("does not carry the control into a different chat", () => {
    expect(renderToStaticMarkup(<SideQuestionToggle {...defaults} invokedFor="previous-chat" />)).toBe("");
  });

  it("allows closing and reopening after invoking /btw in this chat", () => {
    expect(renderToStaticMarkup(<SideQuestionToggle {...defaults} invokedFor="main-chat" open />)).toContain('aria-expanded="true"');
    expect(renderToStaticMarkup(<SideQuestionToggle {...defaults} invokedFor="main-chat" hasHistory />)).toContain("Reopen side question");
  });
});
