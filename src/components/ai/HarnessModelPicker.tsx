import { ChevronIcon } from "../../icons";
import { delegateLabel, type DelegateId } from "../../delegates";
import { isFavModel, toggleFavModel, subscribeFavModels } from "../../favModels";
import { ModelPickerHeader, MODEL_FILTER_STYLE, MODEL_ROW_STYLE, StarIcon } from "./ModelPickerChrome";
import { resolveModelLogo } from "../../modelIdentity";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type RefObject } from "react";
import { usePresence } from "../../hooks/usePresence";
import { inTriangle } from "./StackSideMenu";
import { createPortal } from "react-dom";
import { usePortalMenu } from "../../hooks/usePortalMenu";
import { useCustomProviders } from "../../hooks/useCustomProviders";
import { intelligenceSourceGroups } from "../../agent/harnessModelSources";
import { useMissingDelegateClis } from "../../hooks/useMissingDelegateClis";
import type { ProviderId } from "../../agent/types";
import { listProviderModels, readProviderKeyStatus } from "../../ipc/aiProviders";
import { readHermesSettings, readHermesOwnSetup, readHarnessSourceSupport, listHarnessSourceModels, loginNousPortal, NOUS_SOURCE, type HermesOwnSetup, type HermesSourceSupport } from "../../ipc/hermes";
import { describeOwnSetup } from "./hermesOwnSetup";
import { ProviderLogo } from "./icons";
import { Z } from "../../zLayers";
import { errMessage } from "../../errors";
import { openSettingsSection } from "../../settingsNavigation";

const PREFIX = "hermes-source:";
const CATEGORIES = ["API", "Local", "Self-hosted", "Subscription"];
/** The row named after the agent itself — its own models. */
const OWN = "own";
/** The side card's motion (StackSideMenu), one for one: the card keeps the
 *  top it first opened at and glides by `translateY` on a wrapper (so its own
 *  grow-in keyframes, which animate `transform`, stay untouched), its height
 *  eases to the new list, both on the same 300 ms soft curve. */
const GLIDE_MS = 300;
const EASE = "var(--ease-soft)";
/** How long a crossed row waits while the pointer heads for the open card. */
const AIM_DELAY = 220;
/** Anchor a fixed panel at its first `top`; later moves become a translate. */
function useGlide(top: number | undefined, ready: boolean): { top?: number; transform?: string; transition: string } {
  const anchor = useRef<number | undefined>(undefined);
  const settled = useRef(false);
  if (top === undefined) { anchor.current = undefined; settled.current = false; }
  // Until the card has measured itself its top is a guess: re-anchor, don't glide.
  else if (anchor.current === undefined || !settled.current) { anchor.current = top; settled.current = ready; }
  const placed = top !== undefined && anchor.current !== top;
  const moved = useRef(false);
  if (top === undefined) moved.current = false; else if (placed) moved.current = true;
  return { top: anchor.current, transform: top === undefined ? undefined : `translateY(${top - (anchor.current ?? top)}px)`,
    transition: moved.current ? `transform ${GLIDE_MS}ms ${EASE}` : "none" };
}
/** A panel's natural height — fixed chrome plus its list's full scroll
 *  height — measured after each change so `height` has a number to ease to. */
function useEasedHeight(ref: RefObject<HTMLDivElement | null>, max: number, deps: unknown[]) {
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) { setHeight(undefined); return; }
    let natural = el.offsetHeight - el.clientHeight;
    for (const child of Array.from(el.children) as HTMLElement[]) {
      if (!child.classList.contains("menu-scroll")) { natural += child.offsetHeight; continue; }
      // The list's rows, not its box: a box already taller than its rows
      // reports that height as scrollHeight, and the card would never shrink.
      const pad = getComputedStyle(child);
      natural += ((child.firstElementChild as HTMLElement | null)?.offsetHeight ?? 0) + parseFloat(pad.paddingTop) + parseFloat(pad.paddingBottom);
    }
    setHeight(Math.min(max, natural));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return height;
}
/** The provider picker's side-card geometry (StackSideMenu), shared here. */
const PAD = 5;
const GAP = 6;
const SIDE_WIDTH = 236;
const SIDE_ROW: CSSProperties = { width: "100%", display: "flex", alignItems: "center", gap: 6, padding: "7px 9px", border: "none",
  borderRadius: "var(--radius-sm)", color: "var(--fg-strong)", cursor: "pointer", font: "inherit", fontSize: 12, fontWeight: 500, textAlign: "left" };
/** A stack's eyebrow, as the provider picker draws it: small caps, a chevron
 *  that leans toward the open card, strong when open or holding the choice. */
function Eyebrow({ label, open, held, quiet, ...rest }: { label: string; open: boolean; held: boolean; quiet?: boolean } & ButtonHTMLAttributes<HTMLButtonElement> & Record<`data-${string}`, unknown>) {
  return <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={open} className="stack-side-heading" {...rest}
    style={{ width: "100%", display: "flex", alignItems: "center", gap: 5, padding: "7px 9px", border: "none", borderRadius: "var(--radius-sm)",
      background: open ? "var(--menu-row-hover)" : "transparent", cursor: "pointer", textAlign: "left", font: "inherit",
      fontSize: 9.5, fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase",
      color: open || held ? "var(--fg-strong)" : "var(--fg-dim)", opacity: quiet ? 0.5 : 1,
      transition: "color var(--motion-med) var(--ease-out), background var(--motion-med) var(--ease-out)" }}>
    <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
    <span className="stack-side-chevron" data-open={open} style={{ display: "grid", placeItems: "center" }}>
      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
    </span>
  </button>;
}
/** ↗ — the row leads out to Settings rather than choosing. */
function Leadout() {
  return <svg className="menu-leadout" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
    <path d="M7 17 17 7" /><path d="M8 7h9v9" />
  </svg>;
}
function readChoice(model: string, harness: string): { provider: string; model: string } | null {
  const prefix = harness === "hermes" ? PREFIX : "harness-source:";
  if (!model.startsWith(prefix)) return null;
  try { return JSON.parse(model.slice(prefix.length)); } catch { return null; }
}
export function HarnessModelPicker({ harness = "hermes", model, onChange, disabled, fluid, bareHover = false, placeholder, direction = "up", portalContainer }: {
  portalContainer?: HTMLElement | null;
  harness?: DelegateId; model: string; onChange: (model: string) => void; disabled?: boolean; fluid?: boolean; bareHover?: boolean; placeholder?: string; direction?: "up" | "down";
}) {
  const custom = useCustomProviders();
  const [favTick, setFavTick] = useState(0);
  useEffect(() => subscribeFavModels(() => setFavTick((n) => n + 1)), []);
  const [support, setSupport] = useState<Record<string, HermesSourceSupport>>({});
  /** API sources with no key in the keychain — they can't answer, so they're
   *  quieted and lead to Settings, as the provider side card does. */
  const [keyless, setKeyless] = useState<Set<string>>(new Set());
  const [category, setCategory] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [categoryPos, setCategoryPos] = useState<{ left: number; top: number } | null>(null);
  const [sourcePos, setSourcePos] = useState<{ left: number; top: number } | null>(null);
  const focusModels = useRef(false);
  const [models, setModels] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState<{ provider: string; model: string } | null>(null);
  const choice = readChoice(model, harness);
  const harnessName = delegateLabel(harness);
  const [loginBusy, setLoginBusy] = useState(false);
  const [catalogTick, setCatalogTick] = useState(0);
  const menu = usePortalMenu({ closeOnOutsideClick: true, computePos: (rect) => {
    const down = direction === "down" && window.innerHeight - rect.bottom > 200 || rect.top < 200;
    return { left: Math.max(8, Math.min(rect.right - 200, window.innerWidth - 208)),
      top: down ? rect.bottom + 8 : undefined, bottom: down ? undefined : window.innerHeight - rect.top + 8 };
  } });
  // The menu plays the picker's short leave animation after closing; closing
  // clears the position, so the last one is held for that window.
  const presence = usePresence(menu.open, 150);
  const lastPos = useRef(menu.pos);
  if (menu.pos) lastPos.current = menu.pos;
  const shownPos = menu.pos ?? (presence.leaving ? lastPos.current : null);
  const providersRef = useRef<HTMLDivElement>(null);
  const modelsRef = useRef<HTMLDivElement>(null);
  // ── Menu-aim, as the side card does it: a row the pointer merely crosses on
  // its way to the open card waits instead of swapping the card out.
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  const prevPoint = useRef<{ x: number; y: number } | null>(null);
  const pendingAim = useRef<number | null>(null);
  const clearAim = () => { if (pendingAim.current !== null) window.clearTimeout(pendingAim.current); pendingAim.current = null; };
  useEffect(() => clearAim, []);
  function aimingAt(card: HTMLElement | null): boolean {
    const r = card?.getBoundingClientRect(); const from = prevPoint.current; const to = lastPoint.current;
    if (!r || !from || !to) return false;
    const right = r.left >= from.x;
    if (right ? to.x < from.x : to.x > from.x) return false;
    const edgeX = right ? r.left : r.right;
    return inTriangle(to, from, { x: edgeX, y: r.top - 8 }, { x: edgeX, y: r.bottom + 8 });
  }
  /** Hover a row: open its card now, or — heading for the open card — after a beat. */
  function aimed(card: HTMLElement | null, open: () => void) {
    clearAim();
    if (aimingAt(card)) pendingAim.current = window.setTimeout(() => { pendingAim.current = null; open(); }, AIM_DELAY);
    else open();
  }
  /** Hermes's own setup — what it runs on when Klide passes nothing. */
  const [own, setOwn] = useState<HermesOwnSetup | null>(null);
  useEffect(() => {
    if (harness !== "hermes") return;
    readHermesSettings().then(setSaved).catch(() => {});
    readHermesOwnSetup().then(setOwn).catch(() => {});
  }, [harness]);
  const ownNative = harness === "hermes" && !saved && own?.model ? own : null;
  useEffect(() => {
    if (menu.open) menu.menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [menu.open, menu.menuRef]);
  useEffect(() => {
    if (source && focusModels.current) {
      menu.menuRef.current?.querySelector<HTMLInputElement>("input")?.focus();
      focusModels.current = false;
    }
  }, [source, menu.menuRef]);
  function submenuPosition(row: HTMLElement, width: number) {
    const rect = row.closest("[data-menu-panel]")!.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const isProviderPanel = row.closest('[data-level="providers"]') !== null;
    const cascadeLeft = isProviderPanel && categoryPos !== null && menu.pos !== null && categoryPos.left < menu.pos.left;
    const left = !cascadeLeft && rect.right + width + GAP <= window.innerWidth - 8 ? rect.right + GAP : rect.left - width - GAP;
    // The card's first row sits level with the row that opened it.
    return { left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
      top: rowRect.top - PAD - 1 };
  }
  function showCategory(name: string, row: HTMLElement) {
    setCategoryPos(submenuPosition(row, SIDE_WIDTH));
    if (category !== name) { setCategory(name); setSource(null); setSourcePos(null); }
  }
  /** The agent's own models open straight from the categories panel — no provider level in between. */
  function showOwn(row: HTMLElement, focus = false) {
    const own = harness === "hermes" ? saved?.provider ?? null : harness;
    setCategory(OWN); setCategoryPos(null);
    setSourcePos(submenuPosition(row, 300));
    focusModels.current = focus;
    if (own && source === own && focus) menu.menuRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    if (source !== own) { setModels([]); setError(""); setQuery(""); setLoading(own !== null); }
    setSource(own);
  }
  function showSource(id: string, row: HTMLElement, focus = false) {
    if (!support[id]?.supported || keyless.has(id)) { setSource(null); setSourcePos(null); return; }
    setSourcePos(submenuPosition(row, 300));
    focusModels.current = focus;
    if (source === id && focus) menu.menuRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    if (source !== id) { setModels([]); setError(""); setQuery(""); setLoading(true); }
    setSource(id);
  }
  const sourceGroups = useMemo(() => intelligenceSourceGroups(custom), [custom]);
  const missingClis = useMissingDelegateClis(menu.open, sourceGroups.find((g) => g.label === "Subscription")?.items.map((item) => item.id === NOUS_SOURCE ? "hermes" : item.id));
  const sources = (sourceGroups.find((g) => g.label === category)?.items ?? []).slice()
    .sort((a, b) => Number(missingClis.has(a.id === NOUS_SOURCE ? "hermes" : a.id) || keyless.has(a.id)) - Number(missingClis.has(b.id === NOUS_SOURCE ? "hermes" : b.id) || keyless.has(b.id)));
  const apiIds = (sourceGroups.find((g) => g.label === "API")?.items ?? []).map((item) => item.id).join("\n");
  useEffect(() => {
    if (!menu.open || !apiIds) return;
    let cancelled = false;
    void Promise.all(apiIds.split("\n").map(async (id) => {
      try { return (await readProviderKeyStatus(id)).hasKey ? null : id; } catch { return null; }
    })).then((ids) => { if (!cancelled) setKeyless(new Set(ids.filter((id): id is string => id !== null))); });
    return () => { cancelled = true; };
  }, [menu.open, apiIds]);
  /** A category with nothing set up — every API key missing, no self-hosted
   *  endpoint — can't be chosen: it's quieted and leads to Settings. */
  /** Does this stack hold the current choice? Its eyebrow reads strong. */
  const heldBy = (name: string) => !!current && (name === OWN
    ? current.provider === harness || (harness === "hermes" && model === "default")
    : (sourceGroups.find((g) => g.label === name)?.items ?? []).some((item) => item.id === current.provider));
  const notSetUp = (name: string) => {
    const items = sourceGroups.find((g) => g.label === name)?.items ?? [];
    if (name === "API") return items.length === 0 || items.every((item) => keyless.has(item.id));
    if (name === "Self-hosted") return items.length === 0;
    return false;
  };
  const sourceIds = sourceGroups.flatMap((g) => g.items.map((item) => item.id)).join("\n");
  const ownTitle = harness === "hermes" && saved ? sourceGroups.flatMap((g) => g.items).find((item) => item.id === saved.provider)?.name ?? saved.provider : harnessName;
  useEffect(() => {
    if (!menu.open) return;
    let cancelled = false;
    void Promise.all(sourceIds.split("\n").filter(Boolean).map(async (id) => {
      try { return [id, await readHarnessSourceSupport(harness, id)] as const; }
      catch { return [id, { supported: false, reason: "Could not check this source's harness adapter." }] as const; }
    })).then((rows) => { if (!cancelled) setSupport(Object.fromEntries(rows)); });
    return () => { cancelled = true; };
  }, [menu.open, sourceIds, harness]);
  useEffect(() => {
    if (!menu.open || !source) return;
    let cancelled = false;
    setModels([]); setError(""); setQuery(""); setLoading(true);
    void (async () => {
      try {
        if (category === "API" && !(await readProviderKeyStatus(source)).hasKey) throw new Error("Add this provider's API key in Settings → API.");
        const list = source === NOUS_SOURCE ? await listHarnessSourceModels(harness, source) : await listProviderModels(source);
        if (!cancelled) setModels(list);
      } catch (e) { if (!cancelled) setError(errMessage(e)); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [menu.open, source, category, harness, catalogTick]);
  const filteredModels = useMemo(() => {
    const filtered = models.filter((id) => id.toLowerCase().includes(query.trim().toLowerCase()));
    if (query.trim() || !source) return filtered;
    return filtered.sort((a, b) => Number(isFavModel(source, b)) - Number(isFavModel(source, a)));
  }, [models, query, source, favTick]);
  const favoriteCount = source ? filteredModels.filter((id) => isFavModel(source, id)).length : 0;
  const sectioned = !query.trim() && favoriteCount > 0 && favoriteCount < filteredModels.length;
  const sectionStyle = { padding: "7px 9px 3px", fontSize: 9.5, fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase" as const, color: "var(--fg-dim)" };
  // The side card's row fill eases at the medium beat, not the fast one.
  const style: CSSProperties = { ...MODEL_ROW_STYLE, transition: `background var(--motion-med) var(--ease-out), color var(--motion-med) var(--ease-out)` };
  const select = (id: string) => {
    if (!source) return;
    if (harness === "claude-code" && source === NOUS_SOURCE && !id.startsWith("anthropic/claude-") && !id.startsWith("claude-")) return;
    if (harness !== "hermes" && source === harness) onChange(id);
    else onChange((harness === "hermes" ? PREFIX : "harness-source:") + JSON.stringify({ provider: source, model: id }));
    menu.close();
    menu.triggerRef.current?.focus();
  };
  const current = choice ?? (model === "default" ? (harness === "hermes" ? saved ?? (ownNative?.model ? { provider: "hermes", model: ownNative.model } : null) : null) : harness !== "hermes" ? { provider: harness, model } : null);
  // A card's ceiling never depends on where it sits; where it sits depends on
  // its real height — level with its row, lifted only as far as the window's
  // bottom edge needs (the side card's rule), never by a fixed guess.
  const providersMax = Math.min(300, window.innerHeight - 16);
  const modelsMax = Math.min(360, window.innerHeight - 16);
  const providersHeight = useEasedHeight(providersRef, providersMax, [category, sources.length, providersMax]);
  const modelsHeight = useEasedHeight(modelsRef, modelsMax, [category, source, filteredModels.length, loading, error, query.trim() === "", loginBusy, modelsMax]);
  const upward = shownPos?.bottom !== undefined;
  const lift = (top: number | undefined, height: number) => top === undefined ? undefined : Math.max(8, Math.min(top, window.innerHeight - height - 8));
  const providersGuess = Math.min(providersMax, Math.max(1, sources.length) * 34 + PAD * 2 + 2);
  const providersGlide = useGlide(category && category !== OWN ? lift(categoryPos?.top, providersHeight ?? providersGuess) : undefined, providersHeight !== undefined);
  const modelsGlide = useGlide((source || category === OWN) ? lift(sourcePos?.top, modelsHeight ?? modelsMax) : undefined, modelsHeight !== undefined);
  const heightEase = `height ${GLIDE_MS}ms ${EASE}`;
  return <div style={{ flex: fluid ? 1 : "0 1 112px", minWidth: 64, maxWidth: fluid ? undefined : 138 }}>
    <button type="button" ref={menu.triggerRef} disabled={disabled} aria-haspopup="menu" aria-expanded={menu.open}
      title={current ? `${current.provider} · ${current.model}` : model} style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: fluid ? "flex-start" : "flex-end", gap: 5,
        width: "100%", height: 24, padding: "0 16px 0 2px", borderRadius: "var(--radius-sm)", border: "1px solid transparent",
        background: menu.open && !bareHover ? "var(--bg-hover)" : "transparent", boxShadow: "none", color: menu.open ? "var(--fg-strong)" : "var(--fg-subtle)",
        font: "inherit", fontSize: 11, fontWeight: 500, cursor: disabled ? "default" : "pointer",
        transition: "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)" }}
      onMouseEnter={(e) => { if (!disabled && !menu.open) { e.currentTarget.style.background = bareHover ? "transparent" : "var(--bg-hover)"; e.currentTarget.style.color = "var(--fg-strong)"; } }}
      onMouseLeave={(e) => { if (!menu.open) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--fg-subtle)"; } }}
      onClick={() => { if (menu.open) menu.close(); else { setCategory(null); setSource(null); menu.openMenu(); } }}>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: fluid ? "left" : "right" }}>{(current?.model ?? (model || placeholder || "default")).split("/").pop()}</span>
      <ChevronIcon size={12} style={{ position: "absolute", right: 2, color: "var(--fg-dim)", transform: menu.open ? "rotate(180deg)" : "none" }} />
    </button>
    {presence.mounted && shownPos && createPortal(<div ref={menu.menuRef}
      style={{ position: "fixed", ...shownPos, width: 200, zIndex: Z.popover }}
      onMouseMove={(e) => { prevPoint.current = lastPoint.current; lastPoint.current = { x: e.clientX, y: e.clientY }; }}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); menu.close(); menu.triggerRef.current?.focus(); }
        const target = e.target as HTMLElement;
        if (e.key === "ArrowRight" && target.dataset.own) {
          e.preventDefault(); showOwn(target, true);
          requestAnimationFrame(() => menu.menuRef.current?.querySelector<HTMLInputElement>('[data-level="models"] input')?.focus());
        } else if (e.key === "ArrowRight" && target.dataset.category) {
          e.preventDefault();
          showCategory(target.dataset.category, target);
          requestAnimationFrame(() => menu.menuRef.current?.querySelector<HTMLButtonElement>('[data-level="providers"] button')?.focus());
        } else if (e.key === "ArrowRight" && target.dataset.source) {
          e.preventDefault(); showSource(target.dataset.source, target, true);
        } else if (e.key === "ArrowLeft" && target.closest('[data-level="models"]')) {
          e.preventDefault(); setSource(null);
          if (category === OWN) { setCategory(null); setSourcePos(null); }
          menu.menuRef.current?.querySelector<HTMLButtonElement>(category === OWN ? '[data-level="categories"] button' : '[data-level="providers"] button')?.focus();
        } else if (e.key === "ArrowLeft" && target.closest('[data-level="providers"]')) {
          e.preventDefault(); setCategory(null); setSource(null);
          menu.menuRef.current?.querySelector<HTMLButtonElement>('[data-level="categories"] button')?.focus();
        } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && target.tagName !== "INPUT") {
          const buttons = Array.from(target.closest("[data-menu-panel]")?.querySelectorAll<HTMLButtonElement>("button") ?? []);
          const index = buttons.indexOf(target as HTMLButtonElement);
          e.preventDefault(); buttons[(index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }
      }}>
      <div role="menu" data-menu-panel data-level="categories" className="picker-menu menu-glass" data-leaving={presence.leaving}
        style={{ padding: PAD, overflow: "hidden", transformOrigin: upward ? "bottom right" : "top right" }}>
        <Eyebrow label={harnessName} open={category === OWN} held={heldBy(OWN)} data-own
          onMouseEnter={(e) => { const row = e.currentTarget; aimed(category === OWN ? null : providersRef.current ?? modelsRef.current, () => showOwn(row)); }} onClick={(e) => showOwn(e.currentTarget, true)} />
        {CATEGORIES.map((name) => <Eyebrow key={name} label={name} open={category === name} held={heldBy(name)} quiet={notSetUp(name)} data-category={name}
          onMouseEnter={(e) => { const row = e.currentTarget; if (category === name) { clearAim(); return; } aimed(providersRef.current ?? modelsRef.current, () => showCategory(name, row)); }}
          onClick={(e) => showCategory(name, e.currentTarget)} />)}
      </div>
      {category && categoryPos && <div style={{ position: "fixed", left: categoryPos.left, top: providersGlide.top, transform: providersGlide.transform, transition: providersGlide.transition }}>
      <div ref={providersRef} role="menu" aria-label={category} data-menu-panel data-level="providers" className="picker-menu menu-glass" data-leaving={presence.leaving} onMouseEnter={clearAim}
        style={{ width: SIDE_WIDTH, height: providersHeight, maxHeight: providersMax, display: "flex", flexDirection: "column", overflow: "hidden", transformOrigin: "top left", transition: providersGlide.transition === "none" ? "none" : heightEase }}>
        <div className="menu-scroll" style={{ minHeight: 0, overflow: "auto", padding: PAD, overscrollBehavior: "contain" }}>
        <div key={category} className="stack-side-rows">
        {sources.map((p) => {
          const cliMissing = missingClis.has(p.id === NOUS_SOURCE ? "hermes" : p.id);
          const unsupported = !support[p.id]?.supported;
          const dimmed = unsupported || keyless.has(p.id) || cliMissing;
          return <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={source === p.id} data-source={p.id}
            key={p.id} className="stack-side-row" data-active={source === p.id || current?.provider === p.id ? "true" : undefined} aria-disabled={unsupported || undefined}
            title={keyless.has(p.id) ? `Add a ${p.name} API key in Settings` : support[p.id]?.reason ?? (cliMissing ? `${p.id === NOUS_SOURCE ? "Hermes" : p.name} CLI is not installed` : undefined)}
            style={SIDE_ROW}
            onMouseEnter={(e) => { const row = e.currentTarget; if (source === p.id) { clearAim(); return; } aimed(modelsRef.current, () => showSource(p.id, row)); }}
            onClick={(e) => { if (keyless.has(p.id)) { menu.close(); openSettingsSection("api"); } else showSource(p.id, e.currentTarget, true); }}>
            <span style={{ width: 20, height: 20, display: "grid", placeItems: "center", flexShrink: 0, color: "var(--fg-subtle)", opacity: dimmed ? 0.4 : 1 }}>
              <ProviderLogo id={p.id === NOUS_SOURCE ? "hermes" : p.id as ProviderId} size={16} />
            </span>
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: dimmed ? 0.45 : 1 }}>{p.name}</span>
            {unsupported ? <span style={{ fontSize: 10, color: "var(--fg-dim)", whiteSpace: "nowrap" }}>{support[p.id] ? "Needs bridge" : "Checking…"}</span>
              : keyless.has(p.id) && <Leadout />}
          </button>;
        })}
        {sources.length === 0 && <button type="button" role="menuitem" className="stack-side-row" style={SIDE_ROW} onClick={() => { menu.close(); openSettingsSection("api"); }}>
          <span style={{ flex: 1 }}>Add a self-hosted endpoint</span><Leadout />
        </button>}
        </div>
        </div>
      </div></div>}
      {(source || category === OWN) && sourcePos && <div style={{ position: "fixed", left: sourcePos.left, top: modelsGlide.top, transform: modelsGlide.transform, transition: modelsGlide.transition }}>
      <div ref={modelsRef} role="menu" data-menu-panel data-level="models" className="picker-menu menu-glass" data-leaving={presence.leaving} onMouseEnter={clearAim}
        style={{ width: 300, height: modelsHeight, maxHeight: modelsMax, display: "flex", flexDirection: "column", overflow: "hidden", transformOrigin: "top left", transition: modelsGlide.transition === "none" ? "none" : heightEase }}>
        <ModelPickerHeader icon={<ProviderLogo id={!source || source.startsWith("hermes-subscription:") ? (source ? "hermes" : harness) : source as ProviderId} size={15} />}
          title={category === OWN ? ownTitle : sources.find((p) => p.id === source)?.name ?? "Models"}
          caption={category === OWN ? (harness === "hermes" ? (saved ? "Hermes’s configured source" : ownNative ? "Hermes’s own setup" : "Not set up yet") : `${harnessName}’s own models`) : loading ? "Loading models…" : `${models.length} models available`} />
        {category === "Subscription" && <div style={{ padding: 9, fontSize: 11, color: "var(--fg-subtle)" }}>{source === NOUS_SOURCE ? "Uses your Nous Portal allowance. Hermes manages authentication." : harness === "hermes" ? "Uses this subscription through Hermes’s own authentication." : "Uses the harness’s own authentication."}</div>}
        {!(category === OWN && harness === "hermes" && !saved) && <div style={{ flexShrink: 0, padding: "6px 8px", borderBottom: "1px solid var(--panel-border)" }}>
        <input aria-label="Search or enter model" value={query} placeholder="Filter models…" style={MODEL_FILTER_STYLE}
          onFocus={(e) => { e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 50%, var(--border))"; e.currentTarget.style.background = "var(--bg-elevated)"; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg)"; }} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && query.trim() && !loading && !error) select(query.trim()); }} />
        </div>}
        <div className="menu-scroll" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 4 }}>
        <div key={`${category}:${source}`} className="stack-side-rows">
        {ownNative && category === OWN && <button type="button" role="menuitemradio" aria-checked={model === "default"} data-own-setup className="provider-category-row"
          style={{ ...style, display: "flex", flexDirection: "column", alignItems: "stretch", gap: 2, background: model === "default" ? "var(--menu-row-active)" : undefined }}
          onClick={() => { onChange("default"); menu.close(); menu.triggerRef.current?.focus(); }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}><ProviderLogo id="hermes" size={16} /><span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ownNative.model}</span></span>
          <span style={{ fontSize: 10.5, color: "var(--fg-dim)", whiteSpace: "normal", lineHeight: 1.3 }}>{describeOwnSetup(ownNative)} · change it in Settings</span>
        </button>}
        {category === OWN && harness === "hermes" && !saved && !ownNative && <div style={{ padding: 9, fontSize: 12, color: "var(--fg-subtle)" }}>Hermes isn’t set up yet. Run `hermes setup` in a terminal, or give it a Klide source.<button type="button" style={style} onClick={() => { menu.close(); openSettingsSection("subscription"); }}>Open Settings ↗</button></div>}
        {loading && <div style={{ padding: 9, fontSize: 12 }}>Loading models…</div>}
        {source === NOUS_SOURCE && <div style={{ padding: "4px 9px", fontSize: 11 }}>
          <button type="button" style={style} disabled={loginBusy} onClick={async () => {
            setLoginBusy(true); setError("");
            try { await loginNousPortal(); setCatalogTick((n) => n + 1); }
            catch (e) { setError(errMessage(e)); }
            finally { setLoginBusy(false); }
          }}>{loginBusy ? "Complete sign-in in your browser…" : "Sign in to Nous Portal ↗"}</button>
        </div>}
        {error && <div style={{ padding: 9, fontSize: 12, color: "var(--fg-subtle)" }}>{error}<button type="button" style={style} onClick={() => { menu.close(); openSettingsSection(category === "Local" ? "local-ai" : category === "Subscription" ? "subscription" : "api"); }}>Open Settings ↗</button></div>}
        {!error && source && filteredModels.map((id, index) => <Fragment key={id}>
          {sectioned && index === 0 && <div style={sectionStyle}>Favorites</div>}
          {sectioned && index === favoriteCount && <div style={sectionStyle}>All models</div>}
          <button type="button" role="menuitem" className="provider-category-row hermes-model-row" style={{ ...style, background: current?.provider === source && current.model === id ? "var(--menu-row-active)" : undefined }} onClick={() => select(id)}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 20, height: 20, display: "grid", placeItems: "center", flexShrink: 0 }}>{resolveModelLogo(id, 17)}</span>
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: current?.model === id ? 550 : 500 }}>{id.slice(id.indexOf("/") + 1)}</span>
            <span role="button" tabIndex={0} className="hermes-model-star"
              aria-label={isFavModel(source, id) ? "Remove from favorites" : "Add to favorites"}
              title={isFavModel(source, id) ? "Remove from favorites" : "Add to favorites"}
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleFavModel(source, id); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); toggleFavModel(source, id); } }}
              style={{ flexShrink: 0, display: "grid", placeItems: "center", width: 22, height: 22,
                marginRight: -4, borderRadius: 6, color: isFavModel(source, id) ? "var(--accent)" : "var(--fg-dim)",
                opacity: isFavModel(source, id) ? 1 : undefined, transition: "opacity 120ms ease, color 120ms ease" }}>
              <StarIcon filled={isFavModel(source, id)} />
            </span></div>
          {id.includes("/") && <div style={{ fontSize: 10, color: "var(--fg-dim)", marginLeft: 26, marginTop: 2 }}>{id}</div>}
        </button></Fragment>)}
        {!error && !loading && query.trim() && !models.includes(query.trim()) && <button type="button" role="menuitem" style={style} onClick={() => select(query.trim())}>Use “{query.trim()}”</button>}
        </div>
        </div>
      </div></div>}
    </div>, portalContainer ?? document.body)}
  </div>;
}
