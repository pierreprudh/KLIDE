// The shared rail's pure parts. These used to live beside FocusMode, back when
// the rail was Focus's alone; both shells render it now, so a regression here
// breaks navigation everywhere rather than in one layout.

import { describe, expect, it } from "vitest";

import { conversationIsRestorable } from "./ai/storedConversations";

import {
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
  railDragWidth,
  railFromEdge,
  railConversationSections,
  railProjectRoots,
  retrievableConversation,
  visibleProviderConversations,
} from "./WorkspaceRail";
import type { Conversation } from "./ai/types";

const KIDE = "/Users/pierre/Documents/Private/KIDE";
const RUN = `${KIDE}-worktrees/klide-run-how-to-report-a-bug-on-codex-app-a9dc5e94`;

describe("rail project list", () => {
  it("keeps a linked run under its owning workspace", () => {
    expect(railProjectRoots([RUN, KIDE], RUN)).toEqual([KIDE]);
  });

  it("does not append an active linked run as another workspace", () => {
    expect(railProjectRoots([KIDE], RUN)).toEqual([KIDE]);
  });
});

describe("rail edge drag", () => {
  it("clamps a width to the rail's bounds", () => {
    expect(railFromEdge(300)).toEqual({ collapsed: false, width: 300 });
    expect(railFromEdge(9000).width).toBe(RAIL_MAX_WIDTH);
    expect(railFromEdge(RAIL_MIN_WIDTH - 4).width).toBe(RAIL_MIN_WIDTH);
  });

  it("folds rather than shrinking once the edge crosses the fold point", () => {
    expect(railFromEdge(40).collapsed).toBe(true);
  });

  it("leaves the stored width alone while folded, so it reopens as it was", () => {
    expect(railFromEdge(0, true).width).toBeNull();
  });

  // The asymmetry is the fix for a rail that read as un-openable: a reopen drag
  // measured against the open rail's fold point would sit dead for far too long.
  it("reopens a folded rail as soon as the drag means it", () => {
    expect(railFromEdge(40, true)).toEqual({ collapsed: false, width: RAIL_MIN_WIDTH });
  });

  it("still ignores a twitch on a folded rail", () => {
    expect(railFromEdge(9, true).collapsed).toBe(true);
  });

  it("does not fold an open rail at the reopen threshold", () => {
    expect(railFromEdge(40, false).collapsed).toBe(true);
    expect(railFromEdge(180, false)).toEqual({ collapsed: false, width: RAIL_MIN_WIDTH });
  });

  it("holds briefly at the minimum width while narrowing an open rail", () => {
    expect(railDragWidth(260, false)).toBe(260);
    expect(railDragWidth(199, false)).toBe(RAIL_MIN_WIDTH);
    expect(railDragWidth(180, false)).toBe(RAIL_MIN_WIDTH);
    expect(railDragWidth(168, false)).toBe(RAIL_MIN_WIDTH);
  });

  it("releases smoothly from the minimum-width detent into the fold", () => {
    expect(railDragWidth(167, false)).toBe(199);
    expect(railDragWidth(84, false)).toBe(100);
    expect(railDragWidth(0, false)).toBe(0);
  });

  it("keeps a reopening drag directly under the pointer", () => {
    expect(railDragWidth(40, true)).toBe(40);
    expect(railDragWidth(-50, true)).toBe(0);
    expect(railDragWidth(9_000, true)).toBe(RAIL_MAX_WIDTH);
  });
});

describe("rail conversation resume", () => {
  const saved: Conversation = {
    id: "saved-1",
    title: "Saved task",
    msgs: [{ role: "user", content: "hello" }],
    updatedAt: 1,
  };

  it("re-resolves the durable record instead of trusting the rendered row", () => {
    const staleRow = { ...saved, title: "Stale title" };
    expect(retrievableConversation(staleRow.id, [saved])).toBe(saved);
  });

  it("returns null when the rendered conversation has disappeared", () => {
    expect(retrievableConversation("missing", [saved])).toBeNull();
  });

  it("treats a headless delegate conversation as restorable, a console one not", () => {
    // The rail used to dim every delegate group as "read only in Focus",
    // because a delegate conversation was always a PTY session with no
    // transcript. A Focus delegate run stores ordinary messages, so what
    // decides it is the content — not the provider.
    const headless: Conversation = {
      id: "cc-1",
      title: "Fix the login bug",
      provider: "claude-code",
      msgs: [
        { role: "user", content: "fix the login bug" },
        { role: "assistant", content: "The guard was inverted — fixed." },
      ],
      updatedAt: 2,
    };
    const ptySession: Conversation = {
      id: "cc-2",
      title: "Terminal session",
      provider: "claude-code",
      msgs: [{ role: "assistant", content: "", delegateConsole: true }],
      updatedAt: 3,
    };

    expect(conversationIsRestorable(headless)).toBe(true);
    expect(conversationIsRestorable(ptySession)).toBe(false);
    // …and a plain Klide conversation is unaffected either way.
    expect(conversationIsRestorable(saved)).toBe(true);
  });
});

describe("rail conversation disclosure", () => {
  const conversations = Array.from({ length: 7 }, (_, index): Conversation => ({
    id: `conversation-${index + 1}`,
    title: `Conversation ${index + 1}`,
    msgs: [],
    updatedAt: 7 - index,
  }));

  it("shows at most five conversations before More is selected", () => {
    expect(visibleProviderConversations(conversations, false).map((c) => c.id)).toEqual([
      "conversation-1",
      "conversation-2",
      "conversation-3",
      "conversation-4",
      "conversation-5",
    ]);
  });

  it("reveals every conversation after More is selected", () => {
    expect(visibleProviderConversations(conversations, true)).toEqual(conversations);
  });

  it("keeps an older open conversation inside the collapsed five-row window", () => {
    expect(
      visibleProviderConversations(conversations, false, new Set(["conversation-7"])).map(
        (c) => c.id,
      ),
    ).toEqual([
      "conversation-1",
      "conversation-2",
      "conversation-3",
      "conversation-4",
      "conversation-7",
    ]);
  });

  // Free mode can hold several conversations at once, across panels. The rail
  // is what says which are open, so every one of them has to survive the
  // collapse — one pinned row was the old single-selection assumption.
  it("keeps every open conversation, not just one", () => {
    expect(
      visibleProviderConversations(
        conversations,
        false,
        new Set(["conversation-6", "conversation-7"]),
      ).map((c) => c.id),
    ).toEqual([
      "conversation-1",
      "conversation-2",
      "conversation-3",
      "conversation-6",
      "conversation-7",
    ]);
  });

  it("does not grow the window past the row limit when several are open", () => {
    const open = new Set(["conversation-5", "conversation-6", "conversation-7"]);
    const visible = visibleProviderConversations(conversations, false, open).map((c) => c.id);

    // A collapsed group stays a fixed height: all three open ones are kept and
    // the two newest fill what is left. conversation-5 is open AND recent —
    // the row it would have occupied anyway must not be spent twice.
    expect(visible).toEqual([
      "conversation-1",
      "conversation-2",
      "conversation-5",
      "conversation-6",
      "conversation-7",
    ]);
  });

  it("pins nothing when no conversation is open", () => {
    expect(visibleProviderConversations(conversations, false).map((c) => c.id)).toEqual([
      "conversation-1",
      "conversation-2",
      "conversation-3",
      "conversation-4",
      "conversation-5",
    ]);
  });
});

describe("rail conversation sections", () => {
  const WEB = "/Users/pierre/Sites/website";
  const at = (id: string, updatedAt: number, cwd: string): Conversation => ({ id, title: id, msgs: [], updatedAt, cwd });
  const conversations = [
    at("old", 1, KIDE),
    at("pinned", 2, KIDE),
    at("asking-here", 3, KIDE),
    at("asking-there", 4, WEB),
    at("there", 5, WEB),
    at("new", 6, KIDE),
  ];
  const folderOf = (c: Conversation) => (c.cwd === WEB ? WEB : KIDE);
  const ids = (list: Conversation[]) => list.map((c) => c.id);

  it("gathers what waits on you from every folder, newest first", () => {
    const sections = railConversationSections(
      conversations, folderOf, KIDE, new Set(["asking-here", "asking-there"]), new Set(["pinned"]),
    );
    expect(ids(sections.needs)).toEqual(["asking-there", "asking-here"]);
    expect(ids(sections.pinned)).toEqual(["pinned"]);
    // Another folder's conversations stay out unless they wait on you.
    expect(ids(sections.recent)).toEqual(["new", "old"]);
  });

  it("shows a conversation once: waiting on you takes it out of Pinned", () => {
    const sections = railConversationSections(
      conversations, folderOf, KIDE, new Set(["pinned"]), new Set(["pinned"]),
    );
    expect(ids(sections.needs)).toEqual(["pinned"]);
    expect(sections.pinned).toEqual([]);
  });

  it("with no folder open, only what waits on you", () => {
    const sections = railConversationSections(conversations, folderOf, null, new Set(["there"]), new Set());
    expect(ids(sections.needs)).toEqual(["there"]);
    expect(sections.recent).toEqual([]);
  });
});

describe("rail list window", () => {
  const conversations = Array.from({ length: 12 }, (_, index): Conversation => ({
    id: `c${index + 1}`,
    title: `C${index + 1}`,
    msgs: [],
    updatedAt: 12 - index,
  }));

  it("takes its own row limit, keeping an open row inside it", () => {
    const visible = visibleProviderConversations(conversations, false, new Set(["c12"]), 10);
    expect(visible).toHaveLength(10);
    expect(visible[visible.length - 1]?.id).toBe("c12");
  });
});
