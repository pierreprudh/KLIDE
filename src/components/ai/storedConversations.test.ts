import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../../testStorage";
import type { Conversation, Msg } from "./types";
import {
  CONVERSATIONS_CHANGED_EVENT,
  CONVERSATION_DELETED_EVENT,
  SNAPSHOT_IMAGE_BUDGET,
  cacheableMessages,
  cachedConversationSizes,
  clearStoredConversations,
  conversationBytes,
  conversationImageBytes,
  dropCachedImages,
  forgetStoredConversation,
  localCacheUsage,
  conversationDuration,
  conversationStartedAt,
  deriveTitle,
  latestRestorableConversationId,
  loadConversations,
  loadPanelSession,
  persistConversation,
  renameStoredConversation,
  saveConversations,
  savePanelSession,
} from "./storedConversations";

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "new-conversation",
    title: "Build the feature",
    msgs: [{ role: "user", content: "Build the feature" }],
    updatedAt: 1,
    provider: "openai",
    model: "gpt-5.6",
    cwd: "/workspace",
    ...overrides,
  };
}

function quotaStorage(maxValueLength: number): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => {
      if (value.length > maxValueLength) {
        throw new DOMException("Conversation storage quota exceeded", "QuotaExceededError");
      }
      values.set(key, value);
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("window", new EventTarget());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("persistConversation navigation updates", () => {
  it("notifies Focus when a new conversation is first persisted with its model", () => {
    let updates = 0;
    let changedConversation: string | undefined;
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, (event) => {
      updates += 1;
      changedConversation = (event as CustomEvent<{ conversationId: string }>).detail?.conversationId;
    });

    const saved = persistConversation(conversation());

    expect(saved[0].model).toBe("gpt-5.6");
    expect(updates).toBe(1);
    expect(changedConversation).toBe("new-conversation");
  });

  it("does not notify on streaming-only message and timestamp changes", () => {
    let updates = 0;
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, () => updates += 1);
    const original = conversation();
    const saved = persistConversation(original);
    updates = 0;

    persistConversation(
      conversation({
        msgs: [...original.msgs, { role: "assistant", content: "One more token" }],
        updatedAt: 2,
      }),
      saved,
    );

    expect(updates).toBe(0);
  });

  it("notifies when the selected model changes", () => {
    let updates = 0;
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, () => updates += 1);
    const saved = persistConversation(conversation());
    updates = 0;

    persistConversation(conversation({ model: "claude-sonnet-4-6" }), saved);

    expect(updates).toBe(1);
  });

  it("merges against durable storage instead of erasing a sibling panel's write", () => {
    // Both panels mounted before either conversation existed, so each holds
    // the same stale local snapshot. The durable store must be the merge
    // authority or whichever panel writes second erases the first.
    const stalePanelSnapshot: Conversation[] = [];
    persistConversation(
      conversation({ id: "panel-a", title: "Panel A", updatedAt: 1 }),
      stalePanelSnapshot,
    );
    persistConversation(
      conversation({ id: "panel-b", title: "Panel B", updatedAt: 2 }),
      stalePanelSnapshot,
    );

    expect(loadConversations<Conversation>().map((item) => item.id)).toEqual([
      "panel-b",
      "panel-a",
    ]);
  });

  it("retries a quota-limited write after removing only the oldest snapshots", () => {
    vi.stubGlobal("localStorage", quotaStorage(500));
    const newest = conversation({
      id: "newest",
      title: "Newest",
      msgs: [{ role: "user", content: "n".repeat(180) }],
      updatedAt: 2,
    });
    const oldest = conversation({
      id: "oldest",
      title: "Oldest",
      msgs: [{ role: "user", content: "o".repeat(180) }],
      updatedAt: 1,
    });

    const saved = saveConversations([newest, oldest]);

    expect(saved.map((item) => item.id)).toEqual(["newest"]);
    expect(loadConversations<Conversation>().map((item) => item.id)).toEqual(["newest"]);
  });
});

describe("conversation start time", () => {
  it("takes the start from the first stamped message and holds it across saves", () => {
    const first = persistConversation(
      conversation({ msgs: [{ role: "user", content: "Build the feature", ts: 1_000 }], updatedAt: 1_000 }),
    );
    expect(first[0].createdAt).toBe(1_000);

    // Streaming rewrites `updatedAt` on every token; the start must not move.
    const later = persistConversation(
      conversation({
        msgs: [
          { role: "user", content: "Build the feature", ts: 1_000 },
          { role: "assistant", content: "on it", ts: 9_000 },
        ],
        updatedAt: 9_000,
      }),
      first,
    );
    expect(later[0].createdAt).toBe(1_000);
    expect(conversationDuration(later[0])).toBe(8_000);
  });

  it("keeps a legacy record's start rather than resetting it to the save time", () => {
    // Written before timestamps existed: no createdAt, no message `ts`.
    const legacy: Conversation[] = [conversation({ updatedAt: 5_000 })];
    saveConversations(legacy);
    const saved = persistConversation(conversation({ updatedAt: 12_000 }));
    expect(saved[0].createdAt).toBe(5_000);
  });

  it("falls back to the last-activity time for a record with nothing to date it", () => {
    expect(conversationStartedAt(conversation({ updatedAt: 42 }))).toBe(42);
  });
});

describe("reading a conversation is not using it", () => {
  const stored = conversation({
    id: "old-thread",
    title: "Hello",
    msgs: [
      { role: "user", content: "Hello", ts: 1_000 },
      { role: "assistant", content: "hi there", ts: 2_000 },
    ],
    updatedAt: 2_000,
    createdAt: 1_000,
  });

  it("keeps the stored time when a re-save carries the same messages", () => {
    saveConversations([stored]);

    // What loading a conversation does: snapshot it verbatim, stamped `now`.
    const saved = persistConversation({ ...stored, updatedAt: 9_999_000 });

    expect(saved[0].updatedAt).toBe(2_000);
  });

  it("does not let a read reorder the history around it", () => {
    const newer = conversation({
      id: "newer-thread",
      title: "Newer",
      msgs: [{ role: "user", content: "Newer", ts: 5_000 }],
      updatedAt: 5_000,
      createdAt: 5_000,
    });
    saveConversations([newer, stored]);

    persistConversation({ ...stored, updatedAt: 9_999_000 });

    // The thread that was actually worked on most recently stays on top.
    expect(loadConversations<Conversation>().map((c) => c.id)).toEqual([
      "newer-thread",
      "old-thread",
    ]);
  });

  it("still stamps the time when a turn is actually added", () => {
    saveConversations([stored]);

    const saved = persistConversation({
      ...stored,
      msgs: [...stored.msgs, { role: "user", content: "one more thing", ts: 9_000 }],
      updatedAt: 9_000,
    });

    expect(saved[0].updatedAt).toBe(9_000);
  });

  it("saves a metadata edit without counting it as activity", () => {
    saveConversations([stored]);

    const saved = persistConversation({
      ...stored,
      model: "gpt-5.6-mini",
      updatedAt: 9_999_000,
    });

    expect(saved[0].model).toBe("gpt-5.6-mini");
    expect(saved[0].updatedAt).toBe(2_000);
  });
});

describe("stored conversation index round-trip and corruption tolerance", () => {
  it("round-trips a conversation through the persisted index unchanged", () => {
    const original = conversation({
      id: "round-trip",
      branch: "feature/x",
      worktree: "x",
      forkedFrom: {
        conversationId: "parent",
        title: "Parent",
        messageIndex: 1,
        createdAt: 10,
        mode: "chat",
      },
      createdAt: 1,
    });

    saveConversations([original]);

    expect(loadConversations<Conversation>()).toEqual([original]);
  });

  it("returns an empty index for unparseable JSON instead of throwing", () => {
    localStorage.setItem("klide-conversations", "{not json");
    expect(loadConversations<Conversation>()).toEqual([]);
  });

  it("returns an empty index when the stored value is not an array", () => {
    localStorage.setItem("klide-conversations", JSON.stringify({ msgs: [] }));
    expect(loadConversations<Conversation>()).toEqual([]);
  });

  it("heals a torn record on read: drops entries without msgs and strips null message slots", () => {
    const healthy = conversation({ id: "healthy" });
    localStorage.setItem(
      "klide-conversations",
      JSON.stringify([
        healthy,
        { id: "no-msgs", title: "Torn", updatedAt: 2 },
        {
          ...conversation({ id: "null-slot" }),
          msgs: [null, { role: "user", content: "kept" }, 42],
        },
      ]),
    );

    const loaded = loadConversations<Conversation>();

    expect(loaded.map((c) => c.id)).toEqual(["healthy", "null-slot"]);
    expect(loaded[1].msgs).toEqual([{ role: "user", content: "kept" }]);
  });
});

describe("panel session binding", () => {
  it("round-trips the panel binding", () => {
    savePanelSession("ai-main", {
      convoId: "conversation-a",
      provider: "openai",
      workspaceRoot: "/workspace",
    });

    expect(loadPanelSession("ai-main")).toEqual({
      convoId: "conversation-a",
      provider: "openai",
      workspaceRoot: "/workspace",
    });
  });

  it("returns null for a missing, unparseable, or convoId-less record", () => {
    expect(loadPanelSession("missing")).toBeNull();

    localStorage.setItem("klide.panelSession.torn", "{not json");
    expect(loadPanelSession("torn")).toBeNull();

    localStorage.setItem("klide.panelSession.no-id", JSON.stringify({ provider: "openai" }));
    expect(loadPanelSession("no-id")).toBeNull();
  });

  it("drops a corrupt workspaceRoot instead of scoping the binding wrongly", () => {
    localStorage.setItem(
      "klide.panelSession.odd",
      JSON.stringify({ convoId: "c", workspaceRoot: 42, provider: 7, active: true }),
    );

    expect(loadPanelSession("odd")).toEqual({
      convoId: "c",
      workspaceRoot: undefined,
      provider: undefined,
    });
  });
});

describe("deriveTitle — the one title rule", () => {
  it("titles from the first user message, whitespace-collapsed", () => {
    expect(
      deriveTitle([
        { role: "assistant", content: "hello" },
        { role: "user", content: "  Fix the\n  flaky   test  " },
      ]),
    ).toBe("Fix the flaky test");
  });

  it("caps at 80 characters with an ellipsis", () => {
    const long = "a".repeat(120);
    const title = deriveTitle([{ role: "user", content: long }]);
    expect(title).toBe(`${"a".repeat(79)}…`);
    expect(title.length).toBe(80);
  });

  it("keeps an exactly-80-character message whole", () => {
    const exact = "b".repeat(80);
    expect(deriveTitle([{ role: "user", content: exact }])).toBe(exact);
  });

  it("falls back to 'Untitled chat' when there is no user text", () => {
    expect(deriveTitle([])).toBe("Untitled chat");
    expect(deriveTitle([{ role: "user", content: "   " }])).toBe("Untitled chat");
    expect(deriveTitle([{ role: "assistant", content: "only me" }])).toBe("Untitled chat");
  });
});

describe("a panel restores only its own Provider's thread", () => {
  it("does not adopt another Provider's conversation when this one has none", () => {
    saveConversations([
      conversation({ id: "delegate-thread", provider: "claude-code", updatedAt: 9 }),
    ]);
    expect(latestRestorableConversationId("/workspace", "openrouter")).toBeNull();
  });

  it("still finds this Provider's own most recent thread past a newer foreign one", () => {
    saveConversations([
      conversation({ id: "delegate-thread", provider: "claude-code", updatedAt: 9 }),
      conversation({ id: "router-thread", provider: "openrouter", updatedAt: 4 }),
    ]);
    expect(latestRestorableConversationId("/workspace", "openrouter")).toBe("router-thread");
  });

  it("lets an Auto panel reopen the latest thread of any Provider", () => {
    // An Auto thread records the Provider the router landed it on, never
    // "auto" — so the own-Provider rule would leave an Auto panel with nothing.
    // Continuing the thread re-locks to its origin in Rust, so adopting it is
    // safe.
    saveConversations([
      conversation({ id: "routed-to-anthropic", provider: "anthropic", updatedAt: 9 }),
      conversation({ id: "older-local", provider: "ollama", updatedAt: 4 }),
    ]);
    expect(latestRestorableConversationId("/workspace", "auto")).toBe("routed-to-anthropic");
  });

  it("falls back to the latest thread only when no Provider is asked for", () => {
    saveConversations([
      conversation({ id: "delegate-thread", provider: "claude-code", updatedAt: 9 }),
    ]);
    expect(latestRestorableConversationId("/workspace")).toBe("delegate-thread");
  });
});

describe("what a snapshot may cache", () => {
  const photo = (kb: number) => ({
    path: "shot.png",
    content: "",
    mime: "image/png",
    dataUri: `data:image/png;base64,${"A".repeat(kb * 1000)}`,
  });

  it("leaves a small photo alone", () => {
    const msgs: Msg[] = [{ role: "user", content: "look", attachments: [photo(20)] }];
    expect(cacheableMessages(msgs)).toBe(msgs); // same identity: nothing copied
  });

  it("strips a photo past the budget but keeps its name", () => {
    const msgs: Msg[] = [{ role: "user", content: "look", attachments: [photo(400)] }];
    const capped = cacheableMessages(msgs);
    const attachment = (capped[0] as { attachments: { path: string; mime?: string; dataUri?: string }[] }).attachments[0];
    expect(attachment.dataUri).toBeUndefined();
    expect(attachment).toMatchObject({ path: "shot.png", mime: "image/png" });
  });

  it("keeps the newest photo and strips the older one", () => {
    const msgs: Msg[] = [
      { role: "user", content: "first", attachments: [photo(100)] },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second", attachments: [photo(100)] },
    ];
    const capped = cacheableMessages(msgs, 120_000);
    const at = (i: number) =>
      (capped[i] as { attachments?: { dataUri?: string }[] }).attachments?.[0];
    expect(at(0)?.dataUri).toBeUndefined();
    expect(at(2)?.dataUri).toBeDefined();
    expect(capped[1]).toBe(msgs[1]); // untouched messages keep their identity
  });

  it("caps what persistConversation writes, so one screenshot cannot fill the quota", () => {
    const saved = persistConversation(
      conversation({
        id: "photo-thread",
        msgs: [{ role: "user", content: "describe this", attachments: [photo(2_000)] }],
      }),
    );
    expect(conversationImageBytes(saved[0].msgs)).toBe(0);
    expect(conversationBytes(saved[0])).toBeLessThan(SNAPSHOT_IMAGE_BUDGET);
  });

  it("measures and manages what is cached", () => {
    persistConversation(conversation({ id: "a", updatedAt: 2 }));
    persistConversation(conversation({ id: "b", updatedAt: 1, msgs: [{ role: "user", content: "b", attachments: [photo(20)] }] }));

    const sizes = cachedConversationSizes();
    expect(sizes.map((s) => s.id)).toEqual(["b", "a"]); // biggest first
    expect(sizes[0].imageBytes).toBeGreaterThan(0);
    expect(localCacheUsage().bytes).toBeGreaterThan(0);

    expect(dropCachedImages()).toBeGreaterThan(0);
    expect(cachedConversationSizes().every((s) => s.imageBytes === 0)).toBe(true);

    expect(forgetStoredConversation("a").map((c) => c.id)).toEqual(["b"]);
    expect(clearStoredConversations()).toEqual([]);
    expect(loadConversations()).toEqual([]);
  });
});

describe("forgetting a conversation", () => {
  it("announces the deletion so a panel showing the thread can let go of it", () => {
    persistConversation(conversation({ id: "a" }));
    persistConversation(conversation({ id: "b" }));
    const deleted: string[] = [];
    window.addEventListener(CONVERSATION_DELETED_EVENT, (event) => {
      deleted.push((event as CustomEvent<{ conversationId: string }>).detail.conversationId);
    });

    expect(forgetStoredConversation("a").map((c) => c.id)).toEqual(["b"]);

    expect(deleted).toEqual(["a"]);
    expect(loadConversations<Conversation>().map((c) => c.id)).toEqual(["b"]);
  });
});

describe("renameStoredConversation — a given name outlives the derived one", () => {
  it("renames in place, marks the record, and does not count as activity", () => {
    saveConversations([
      conversation({ id: "newer", title: "Newer", updatedAt: 20 }),
      conversation({ id: "older", title: "Older", updatedAt: 10 }),
    ]);
    const next = renameStoredConversation("older", "  Payments   refactor ");
    expect(next.map((c) => c.id)).toEqual(["newer", "older"]);
    const renamed = next.find((c) => c.id === "older");
    expect(renamed?.title).toBe("Payments refactor");
    expect(renamed?.renamed).toBe(true);
    expect(renamed?.updatedAt).toBe(10);
  });

  it("ignores an empty name and an unknown id", () => {
    saveConversations([conversation({ id: "only", title: "Only", updatedAt: 1 })]);
    expect(renameStoredConversation("only", "   ")[0]?.title).toBe("Only");
    expect(renameStoredConversation("missing", "Name")).toHaveLength(1);
    expect(loadConversations<Conversation>()[0]?.renamed).toBeUndefined();
  });

  it("survives the panel's next snapshot, which re-derives the title", () => {
    saveConversations([conversation({ id: "thread", title: "Fix the flaky test", updatedAt: 1 })]);
    renameStoredConversation("thread", "Flaky test");
    const persisted = persistConversation(
      conversation({
        id: "thread",
        title: "Fix the flaky test",
        updatedAt: 2,
        msgs: [
          { role: "user", content: "Fix the flaky test" },
          { role: "assistant", content: "Done." },
        ],
      }),
    );
    expect(persisted[0]?.title).toBe("Flaky test");
    expect(persisted[0]?.renamed).toBe(true);
    expect(persisted[0]?.msgs).toHaveLength(2);
  });

  it("publishes the change so every rail reloads", () => {
    saveConversations([conversation({ id: "thread", title: "Old", updatedAt: 1 })]);
    const seen: string[] = [];
    const onChange = (e: Event) =>
      seen.push((e as CustomEvent<{ conversationId: string }>).detail.conversationId);
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, onChange);
    try {
      renameStoredConversation("thread", "New");
    } finally {
      window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, onChange);
    }
    expect(seen).toEqual(["thread"]);
  });
});
