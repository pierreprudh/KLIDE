import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canOpenConversation,
  openConversation,
  openDelegateSession,
  registerConversationOpener,
  registerSessionReattacher,
} from "./conversationNavigation";

afterEach(() => {
  registerConversationOpener(null);
  registerSessionReattacher(null);
});

describe("conversation navigation", () => {
  it("offers nothing until App registers an opener", () => {
    expect(canOpenConversation()).toBe(false);
    expect(openConversation("c1")).toBe(false);
  });

  it("opens a Delegate session's stored conversation by its id", () => {
    const open = vi.fn(() => true);
    const reattach = vi.fn();
    registerConversationOpener(open);
    registerSessionReattacher(reattach);
    openDelegateSession("convo-1:claude-code");
    expect(open).toHaveBeenCalledWith("convo-1");
    expect(reattach).not.toHaveBeenCalled();
  });

  it("reattaches the live PTY when no stored conversation has that id", () => {
    const reattach = vi.fn();
    registerConversationOpener(() => false);
    registerSessionReattacher(reattach);
    openDelegateSession("a:b:codex");
    expect(reattach).toHaveBeenCalledWith("a:b", "codex");
  });
});
