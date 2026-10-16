import { afterEach, describe, expect, it, vi } from "vitest";
import { findSettingsSearchTarget, revealSettingsSearchTarget } from "./searchReveal";
import { settingsSearchTarget } from "../../settingsPages";

function row(title: string, visible = true) {
  return {
    dataset: { setting: title },
    getClientRects: () => visible ? [{}] : [],
    getBoundingClientRect: () => ({ top: 420 }),
    focus: vi.fn(), setAttribute: vi.fn(), removeAttribute: vi.fn(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("revealing a settings search result", () => {
  it("skips hidden copies in previously visited pages and resolves search aliases", () => {
    const hidden = row("Font size", false);
    const visible = row("Font size");
    const content = { querySelectorAll: () => [hidden, visible] } as unknown as HTMLElement;
    expect(findSettingsSearchTarget(content, settingsSearchTarget("editor", "Editor font size"))).toBe(visible);
    expect(findSettingsSearchTarget(content, "Missing setting")).toBeNull();
  });

  it("distinguishes controls which share a search entry", () => {
    expect(settingsSearchTarget("ai", "Effort & reflection", "thinking")).toBe("Reflection");
    expect(settingsSearchTarget("ai", "Effort & reflection", "budget")).toBe("Effort");
    expect(settingsSearchTarget("general", "Files & tabs", "hidden files")).toBe("Show hidden files");
    expect(settingsSearchTarget("general", "Files & tabs", "unsaved tabs")).toBe("Confirm before closing unsaved tabs");
  });

  it.each([false, true])("scrolls only the content pane and respects reduced motion (%s)", (reduced) => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { matchMedia: () => ({ matches: reduced }), setTimeout, clearTimeout });
    vi.stubGlobal("document", { documentElement: { hasAttribute: () => false } });
    const target = row("Context window");
    const scroller = { getBoundingClientRect: () => ({ top: 100 }), scrollTop: 200, scrollTo: vi.fn() };
    const cleanup = revealSettingsSearchTarget(scroller as unknown as HTMLElement, target as unknown as HTMLElement);
    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 496, behavior: reduced ? "instant" : "smooth" });
    expect(target.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(target.setAttribute).toHaveBeenCalledWith("data-search-highlight", "true");
    vi.advanceTimersByTime(2000);
    expect(target.removeAttribute).toHaveBeenCalledWith("data-search-highlight");
    cleanup();
  });

  it("clears an old highlight and its timer when navigation cancels it", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }), setTimeout, clearTimeout });
    vi.stubGlobal("document", { documentElement: { hasAttribute: () => true } });
    const target = row("Context window");
    const scroller = { getBoundingClientRect: () => ({ top: 500 }), scrollTop: 0, scrollTo: vi.fn() };
    const cleanup = revealSettingsSearchTarget(scroller as unknown as HTMLElement, target as unknown as HTMLElement);
    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "instant" });
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
    expect(target.removeAttribute).toHaveBeenCalledOnce();
  });
});
