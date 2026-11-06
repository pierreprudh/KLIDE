import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../../testStorage";

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("localStorage", memoryStorage());
});

describe("conversation composer drafts", () => {
  it("keeps separate drafts and attachments across navigation and a module reload", async () => {
    let store = await import("./composerDraft");
    const a = store.composerDraftKey("/work", "a");
    const b = store.composerDraftKey("/work", "b");
    const photo = { path: "screen.png", content: "", dataUri: "data:image/png;base64,AQID" };
    store.updateComposerDraft(a, () => ({ text: "unfinished", attachments: [photo] }));
    store.updateComposerDraft(b, () => ({ text: "other conversation", attachments: [] }));
    expect(store.readComposerDraft(a)).toEqual({ text: "unfinished", attachments: [photo] });
    expect(store.readComposerDraft(store.composerDraftKey("/other", "a")).text).toBe("");
    vi.resetModules();
    store = await import("./composerDraft");
    expect(store.readComposerDraft(a)).toEqual({ text: "unfinished", attachments: [photo] });
    store.updateComposerDraft(a, () => ({ text: "", attachments: [] }));
    vi.resetModules();
    store = await import("./composerDraft");
    expect(store.readComposerDraft(a)).toEqual({ text: "", attachments: [] });
    expect(store.readComposerDraft(b).text).toBe("other conversation");
  });

  it("routes an asynchronous paste to its original conversation", async () => {
    const store = await import("./composerDraft");
    const a = store.composerDraftKey("/work", "a");
    const b = store.composerDraftKey("/work", "b");
    const finishPaste = () => store.updateComposerDraft(a, current => ({ ...current, attachments: [{ path: "late.txt", content: "pasted" }] }));
    store.updateComposerDraft(b, () => ({ text: "new draft", attachments: [] }));
    finishPaste();
    expect(store.readComposerDraft(a).attachments).toHaveLength(1);
    expect(store.readComposerDraft(b)).toEqual({ text: "new draft", attachments: [] });
  });
  it("removes a deleted conversation's drafts in every workspace", async () => {
    const store = await import("./composerDraft");
    const a = store.composerDraftKey("/work", "a");
    const otherA = store.composerDraftKey("/other", "a");
    const b = store.composerDraftKey("/work", "b");
    for (const key of [a, otherA, b]) store.updateComposerDraft(key, () => ({ text: "saved", attachments: [] }));
    store.forgetComposerDrafts("a");
    vi.resetModules();
    const restored = await import("./composerDraft");
    expect(restored.readComposerDraft(a).text).toBe("");
    expect(restored.readComposerDraft(otherA).text).toBe("");
    expect(restored.readComposerDraft(b).text).toBe("saved");
  });

});
