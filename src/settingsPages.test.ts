import { describe, expect, it } from "vitest";
import { SETTINGS_PAGES, defaultSettingsPage, settingsPageForSearch, settingsSearchTarget } from "./settingsPages";

describe("settings subpage destinations", () => {
  it("reveals controls moved off the category's first page when searched", () => {
    expect(settingsPageForSearch("ai", "System prompts")).toBe("ai-prompts");
    expect(settingsPageForSearch("ai", "Context window")).toBe("ai-inference");
    expect(settingsPageForSearch("ai", "Diff review before edits")).toBe("ai-execution");
    expect(settingsPageForSearch("ai", "Eyes model (OCR)")).toBe("ai-automation");
    expect(settingsPageForSearch("layout", "Panel sizes")).toBe("layout-sizes");
  });

  it("keeps compact categories together while search still targets their controls", () => {
    expect(SETTINGS_PAGES.general).toBeUndefined();
    expect(SETTINGS_PAGES.appearance).toBeUndefined();
    expect(defaultSettingsPage("general")).toBe("general");
    expect(defaultSettingsPage("appearance")).toBe("appearance");
    expect(settingsPageForSearch("general", "Auto-save")).toBe("general");
    expect(settingsPageForSearch("general", "Files & tabs")).toBe("general");
    expect(settingsPageForSearch("appearance", "Welcome film")).toBe("appearance");
    expect(settingsPageForSearch("appearance", "Profile picture in conversations")).toBe("appearance");
    expect(settingsSearchTarget("appearance", "Welcome film")).toBe("Welcome");
    expect(settingsSearchTarget("appearance", "Profile picture in conversations")).toBe("Your profile picture");
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
    expect(settingsPageForSearch("general", "System prompts")).toBe("general");
  });
});
