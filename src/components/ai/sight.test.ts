import { describe, expect, it } from "vitest";
import { eyesName, eyesOf, eyesSettingOf, photoGate, seenByModel, type Eyes } from "./sight";

const local: Eyes = { provider: "ollama", model: "gemma3:12b", source: "local" };

describe("photoGate", () => {
  it("a model that sees needs no eyes and promises photos", () => {
    const gate = photoGate(true, null);
    expect(gate.allowPhotos).toBe(true);
    expect(gate.menuLabel).toBe("Photo or document");
    expect(gate.stagedNote).toBeNull();
  });

  it("a blind model with eyes still takes photos, and says who will look", () => {
    const gate = photoGate(false, local);
    expect(gate.allowPhotos).toBe(true);
    expect(gate.menuLabel).toBe("Photo or document");
    expect(gate.dropHint).toContain("gemma3:12b");
    expect(gate.stagedNote).toBe("Described by gemma3:12b");
  });

  it("a blind model with no eyes refuses photos, documents only", () => {
    const gate = photoGate(false, null);
    expect(gate.allowPhotos).toBe(false);
    expect(gate.menuLabel).toBe("Document");
    expect(gate.dropHint).toBe("Drop a document to attach");
    expect(gate.stagedNote).toBeNull();
  });
});

describe("seen_by labels", () => {
  it("splits provider/model on the first slash so namespaced ids survive", () => {
    expect(seenByModel("ollama/gemma3:12b")).toBe("gemma3:12b");
    expect(seenByModel("openrouter/google/gemma-3-27b-it")).toBe("google/gemma-3-27b-it");
    expect(seenByModel("bare")).toBe("bare");
  });

  it("names the eyes by the exact model, minus a vendor namespace", () => {
    expect(eyesName("anthropic/claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(eyesName("openrouter/google/gemma-3-27b-it")).toBe("gemma-3-27b-it");
    expect(eyesName({ model: "gemma3:12b" })).toBe("gemma3:12b");
  });
});

describe("eyesOf", () => {
  it("lists each pair that read a photo, with how many, from the described photos", () => {
    const msgs = [
      { role: "user", attachments: [
        { seenBy: "anthropic/claude-sonnet-4-6" },
        { seenBy: "anthropic/claude-sonnet-4-6" },
        { path: "notes.md" },
      ] },
      { role: "assistant" },
      { role: "user", attachments: [{ seenBy: "ollama/gemma4:12b" }] },
    ];
    expect(eyesOf(msgs)).toEqual([
      { provider: "anthropic", model: "claude-sonnet-4-6", images: 2 },
      { provider: "ollama", model: "gemma4:12b", images: 1 },
    ]);
  });

  it("is empty for a conversation that borrowed no eyes", () => {
    expect(eyesOf([{ role: "user", attachments: [{ path: "shot.png" }] }, { role: "assistant" }])).toEqual([]);
  });
});

describe("eyesSettingOf", () => {
  it("is a pair only when both halves are set", () => {
    expect(eyesSettingOf(undefined)).toBeUndefined();
    expect(eyesSettingOf({ eyesProvider: "ollama" })).toBeUndefined();
    expect(eyesSettingOf({ eyesProvider: " ", eyesModel: "x" })).toBeUndefined();
    expect(eyesSettingOf({ eyesProvider: "ollama", eyesModel: "gemma3:12b" })).toEqual({
      provider: "ollama",
      model: "gemma3:12b",
    });
  });
});
