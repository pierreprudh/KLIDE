import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStorage } from "./testStorage";
import {
  forgetPinnedConversation,
  isPinnedConversation,
  orderPinnedFirst,
  pinnedConversationIds,
  subscribePinnedConversations,
  togglePinnedConversation,
} from "./pinnedConversations";

describe("pinned conversations", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });

  it("toggles a pin, persists it, and tells subscribers", () => {
    const seen = vi.fn();
    const stop = subscribePinnedConversations(seen);
    expect(togglePinnedConversation("a")).toBe(true);
    expect(isPinnedConversation("a")).toBe(true);
    expect([...pinnedConversationIds()]).toEqual(["a"]);
    expect(togglePinnedConversation("a")).toBe(false);
    expect(isPinnedConversation("a")).toBe(false);
    expect(seen).toHaveBeenCalledTimes(2);
    stop();
  });

  it("drops the pin of a conversation that left history", () => {
    togglePinnedConversation("a");
    togglePinnedConversation("b");
    forgetPinnedConversation("a");
    expect([...pinnedConversationIds()]).toEqual(["b"]);
  });

  it("survives a corrupt store", () => {
    localStorage.setItem("klide.pinnedConversations", "{nope");
    expect(pinnedConversationIds().size).toBe(0);
    expect(togglePinnedConversation("a")).toBe(true);
  });

  it("lifts pinned rows to the top without reshuffling either half", () => {
    const rows = [{ id: "n1" }, { id: "p1" }, { id: "n2" }, { id: "p2" }];
    expect(orderPinnedFirst(rows, new Set(["p2", "p1"])).map((r) => r.id)).toEqual(["p1", "p2", "n1", "n2"]);
    expect(orderPinnedFirst(rows, new Set()).map((r) => r.id)).toEqual(["n1", "p1", "n2", "p2"]);
  });
});
