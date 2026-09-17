import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStorage } from "./testStorage";
import type { Skill } from "./skills";

function skill(name: string, enabled = true): Skill {
  return { id: name, name, description: "", instructions: "", tools: [], enabled };
}

describe("skill appearance", () => {
  let mod: typeof import("./skillAppearance");

  beforeEach(async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    vi.resetModules();
    mod = await import("./skillAppearance");
  });

  it("sets a lowercase skill name as a name", () => {
    expect(mod.defaultLabel("visualise")).toBe("Visualise");
    expect(mod.defaultLabel("code-review")).toBe("Code review");
    expect(mod.defaultLabel("Analytics Dashboard")).toBe("Analytics Dashboard");
  });

  it("takes a plugin skill's own half of the name", () => {
    expect(mod.defaultLabel("ui-ux-pro-max:banner-design")).toBe("Banner design");
  });

  it("draws every skill, with a mark only where one ships", () => {
    expect(mod.appearanceOf(skill("visualise"), [])).toMatchObject({ label: "Visualise", mark: "diagram", lede: true });
    expect(mod.appearanceOf(skill("Code Review"), [])).toMatchObject({ command: "code-review", label: "Code Review", mark: null, lede: true });
  });

  it("wires every enabled skill and no disabled one", () => {
    const ledes = mod.skillLedes([skill("visualise"), skill("Code Review")], []);
    expect([...ledes.keys()]).toEqual(["visualise", "code-review"]);
    expect(ledes.get("code-review")).toEqual({ label: "Code Review", mark: null });
    expect(mod.skillLedes([skill("visualise", false)], []).size).toBe(0);
  });

  it("keeps a mark cleared once you clear it", () => {
    mod.saveAppearance({ command: "visualise", label: "Visualise", mark: null, lede: true });
    expect(mod.skillLedes([skill("visualise")], mod.savedAppearances()).get("visualise")).toEqual({ label: "Visualise", mark: null });
  });

  it("takes a saved answer over the shipped default, off included", () => {
    mod.saveAppearance({ command: "visualise", label: "Draw", mark: "plan", lede: true });
    expect(mod.appearanceOf(skill("visualise"), mod.savedAppearances())).toMatchObject({ label: "Draw", mark: "plan" });
    expect(mod.skillLedes([skill("visualise")], mod.savedAppearances()).get("visualise")).toEqual({ label: "Draw", mark: "plan" });

    mod.saveAppearance({ command: "visualise", label: "Draw", mark: "plan", lede: false });
    expect(mod.skillLedes([skill("visualise")], mod.savedAppearances()).size).toBe(0);
  });

  it("keeps a renamed, marked skill as renamed and marked", () => {
    mod.saveAppearance({ command: "code-review", label: "Review", mark: "review", lede: true });
    const ledes = mod.skillLedes([skill("Code Review")], mod.savedAppearances());
    expect(ledes.get("code-review")).toEqual({ label: "Review", mark: "review" });
  });

  it("falls back to the default label when the saved one is blank", () => {
    mod.saveAppearance({ command: "visualise", label: "   ", mark: "ai", lede: true });
    expect(mod.skillLedes([skill("visualise")], mod.savedAppearances()).get("visualise")?.label).toBe("Visualise");
  });

  it("forgets a saved answer on reset, back to the default", () => {
    mod.saveAppearance({ command: "visualise", label: "Draw", mark: "plan", lede: false });
    mod.resetAppearance("visualise");
    expect(mod.savedAppearances()).toEqual([]);
    expect(mod.appearanceOf(skill("visualise"), mod.savedAppearances())).toMatchObject({ mark: "diagram", lede: true });
  });

  it("survives a corrupt store", () => {
    localStorage.setItem("klide.skillAppearance", "{ not json");
    expect(mod.savedAppearances()).toEqual([]);
  });
});
