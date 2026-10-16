/** Only look inside visible pages: visited pages remain mounted with duplicate rows. */
export function findSettingsSearchTarget(content: HTMLElement, name: string | null): HTMLElement | null {
  if (name === null) return content.querySelector<HTMLElement>("h1");
  const normalized = name.toLowerCase();
  return Array.from(content.querySelectorAll<HTMLElement>("[data-setting]"))
    .find((element) => element.dataset.setting?.toLowerCase() === normalized && element.getClientRects().length > 0)
    ?? null;
}

/** Scroll the content pane only, then mark the row without changing its layout. */
export function revealSettingsSearchTarget(scroller: HTMLElement, target: HTMLElement): () => void {
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    document.documentElement.hasAttribute("data-motion-still");
  const top = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 24;
  scroller.scrollTo({ top: Math.max(0, top), behavior: still ? "instant" : "smooth" });
  target.focus({ preventScroll: true });
  target.setAttribute("data-search-highlight", "true");
  const timer = window.setTimeout(() => target.removeAttribute("data-search-highlight"), 2000);
  return () => {
    window.clearTimeout(timer);
    target.removeAttribute("data-search-highlight");
  };
}
