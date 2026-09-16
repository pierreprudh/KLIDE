import { describe, expect, it } from "vitest";
import { railSelectedConversation } from "./railSelection";

const bound = (boundActive: string | null, ...rest: string[]) => ({
  boundActive,
  boundIds: boundActive ? [boundActive, ...rest] : rest,
});

describe("the rail's selected conversation", () => {
  it("lights the row that was just clicked before the panel has rebound", () => {
    // Focus: the old thread is still bound while the new one resumes.
    expect(
      railSelectedConversation({ focus: true, chatActive: true, convoError: false, picked: "new", ...bound("old") }),
    ).toBe("new");
    // The workbench has the same gap.
    expect(
      railSelectedConversation({ focus: false, chatActive: false, convoError: false, picked: "new", ...bound("old") }),
    ).toBe("new");
  });

  it("hands over to the bindings once they know the picked conversation", () => {
    // Focus split: "a" was picked earlier, both halves are bound, the person
    // focused the "b" half — the highlight follows the focus.
    expect(
      railSelectedConversation({ focus: true, chatActive: true, convoError: false, picked: "a", ...bound("b", "a") }),
    ).toBe("b");
    expect(
      railSelectedConversation({ focus: false, chatActive: false, convoError: false, picked: "a", ...bound("b", "a") }),
    ).toBe("b");
  });

  it("follows the binding when nothing was picked", () => {
    expect(
      railSelectedConversation({ focus: true, chatActive: true, convoError: false, picked: null, ...bound("x") }),
    ).toBe("x");
    expect(
      railSelectedConversation({ focus: false, chatActive: false, convoError: false, picked: null, ...bound("x") }),
    ).toBe("x");
    expect(
      railSelectedConversation({ focus: false, chatActive: false, convoError: false, picked: null, ...bound(null) }),
    ).toBeNull();
  });

  it("shows only the picked row on the Focus start stage and apology", () => {
    // Start stage: the panel still holds "x" but the canvas shows nothing.
    expect(
      railSelectedConversation({ focus: true, chatActive: false, convoError: false, picked: null, ...bound("x") }),
    ).toBeNull();
    // Apology: the picked thread is gone; the binding is not what is showing.
    expect(
      railSelectedConversation({ focus: true, chatActive: true, convoError: true, picked: "gone", ...bound("x") }),
    ).toBe("gone");
  });
});
