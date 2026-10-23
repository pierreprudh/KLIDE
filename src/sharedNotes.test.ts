import { describe, expect, it } from "vitest";
import { sharedNoteLesson, sharedNotesForConversation, type SharedNoteSet } from "./sharedNotes";

const set: SharedNoteSet = { id: "initiative", title: "Remote execution", body: "Use event cursors. Verify restart behavior.", conversationIds: ["claude", "ollama"], archived: false, updatedAtMs: 1 };

describe("shared notes", () => {
  it("finds membership by conversation identity regardless of provider", () => {
    const store = { revision: 1, sets: [set] };
    expect(sharedNotesForConversation(store, "claude")).toBe(set);
    expect(sharedNotesForConversation(store, "ollama")).toBe(set);
    expect(sharedNotesForConversation(store, "unrelated")).toBeUndefined();
  });
  it("keeps archived notes visible to their linked conversations", () => {
    expect(sharedNotesForConversation({ revision: 2, sets: [{ ...set, archived: true }] }, "claude")?.archived).toBe(true);
  });
  it("promotes only the user-selected lesson and records its working-note source", () => {
    const input = sharedNoteLesson(set, " Replay cursors ", " Event streams must support replay from a cursor. ");
    expect(input.notes).toBe("Event streams must support replay from a cursor.");
    expect(input.title).toBe("Replay cursors");
    expect(input).not.toHaveProperty("reviewState");
    expect(input.notes).not.toContain("Verify restart");
    expect(input.sourceRefs[0]).toMatchObject({ sourceType: "file", id: "initiative", path: ".klide/shared-notes/state.json" });
    expect(input.provider).toBeNull();
  });
});
