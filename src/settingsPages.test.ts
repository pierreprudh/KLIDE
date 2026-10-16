import { describe, expect, it } from "vitest";
import { defaultSettingsPage, settingsPageForSearch } from "./settingsPages";

describe("settings subpage destinations", () => {
  it("reveals controls moved off the category's first page when searched", () => {
    expect(settingsPageForSearch("ai", "System prompts")).toBe("ai-prompts");
    expect(settingsPageForSearch("ai", "Context window")).toBe("ai-inference");
    expect(settingsPageForSearch("ai", "Diff review before edits")).toBe("ai-execution");
    expect(settingsPageForSearch("ai", "Eyes model (OCR)")).toBe("ai-automation");
    expect(settingsPageForSearch("general", "Auto-save")).toBe("general-files");
    expect(settingsPageForSearch("layout", "Panel sizes")).toBe("layout-sizes");
    expect(settingsPageForSearch("appearance", "Welcome film")).toBe("appearance-welcome");
  });

  it("finds new pages by name even without a persisted setting in the search catalog", () => {
    expect(settingsPageForSearch("api", "Custom endpoints")).toBe("api-endpoints");
    expect(settingsPageForSearch("subscription", "CLI setup")).toBe("subscription-setup");
    expect(settingsPageForSearch("layout", "Layout builder")).toBe("layout-builder");
  });

  it("keeps section-only navigation and unsplit destinations reachable", () => {
    expect(defaultSettingsPage("api")).toBe("api-keys");
    expect(settingsPageForSearch("storage", "Saved conversations & disk usage")).toBe("storage");
    expect(settingsPageForSearch("editor", "Line numbers")).toBe("editor");
    expect(settingsPageForSearch("general", "System prompts")).toBe("general-startup");
  });
});
