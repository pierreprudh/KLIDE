import { delegateLabel, type DelegateId } from "../../delegates";
import { isFavModel, toggleFavModel, subscribeFavModels } from "../../favModels";
import { ModelPickerHeader, MODEL_FILTER_STYLE, MODEL_ROW_STYLE, StarIcon } from "./ModelPickerChrome";
import { resolveModelLogo } from "../../modelIdentity";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePortalMenu } from "../../hooks/usePortalMenu";
import { useCustomProviders } from "../../hooks/useCustomProviders";
import { intelligenceSourceGroups } from "../../agent/harnessModelSources";
import { useMissingDelegateClis } from "../../hooks/useMissingDelegateClis";
import { refreshCustomCli, type CustomCli } from "../../customCli";
import type { ProviderId } from "../../agent/types";
import { listProviderModels, readProviderKeyStatus } from "../../ipc/aiProviders";
import { readHermesSettings, readHarnessSourceSupport, listHarnessSourceModels, loginNousPortal, NOUS_SOURCE, type HermesSourceSupport } from "../../ipc/hermes";
import { ProviderLogo } from "./icons";
import { Z } from "../../zLayers";
import { errMessage } from "../../errors";
import { openSettingsSection } from "../../settingsNavigation";

const PREFIX = "hermes-source:";
const CATEGORIES = ["API", "Local", "Self-hosted", "Subscription"];
/** The row named after the agent itself — its own models. */
const OWN = "own";
function readChoice(model: string, harness: string): { provider: string; model: string } | null {
  const prefix = harness === "hermes" ? PREFIX : "harness-source:";
  if (!model.startsWith(prefix)) return null;
  try { return JSON.parse(model.slice(prefix.length)); } catch { return null; }
}
export function HarnessModelPicker({ harness = "hermes", model, onChange, disabled, fluid, bareHover = false, placeholder, direction = "up" }: {
  harness?: DelegateId; model: string; onChange: (model: string) => void; disabled?: boolean; fluid?: boolean; bareHover?: boolean; placeholder?: string; direction?: "up" | "down";
}) {
  const custom = useCustomProviders();
  const [favTick, setFavTick] = useState(0);
  useEffect(() => subscribeFavModels(() => setFavTick((n) => n + 1)), []);
  const [customClis, setCustomClis] = useState<CustomCli[]>([]);
  const [support, setSupport] = useState<Record<string, HermesSourceSupport>>({});
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
  useEffect(() => { if (harness === "hermes") readHermesSettings().then(setSaved).catch(() => {}); }, [harness]);
  useEffect(() => {
    if (menu.open) menu.menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [menu.open, menu.menuRef]);
  useEffect(() => {
    if (source && focusModels.current) {
      menu.menuRef.current?.querySelector<HTMLInputElement>("input")?.focus();
      focusModels.current = false;
    }
  }, [source, menu.menuRef]);
  function submenuPosition(row: HTMLElement, width: number, height: number) {
    const rect = row.closest("[data-menu-panel]")!.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const isProviderPanel = row.closest('[data-level="providers"]') !== null;
    const cascadeLeft = isProviderPanel && categoryPos !== null && menu.pos !== null && categoryPos.left < menu.pos.left;
    const left = !cascadeLeft && rect.right + width + 4 <= window.innerWidth - 8 ? rect.right + 4 : rect.left - width - 4;
    return { left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(rowRect.top, window.innerHeight - height - 8)) };
  }
  function showCategory(name: string, row: HTMLElement) {
    setCategoryPos(submenuPosition(row, 220, 300));
    if (category !== name) { setCategory(name); setSource(null); setSourcePos(null); }
  }
  /** The agent's own models open straight from the categories panel — no provider level in between. */
  function showOwn(row: HTMLElement, focus = false) {
    const own = harness === "hermes" ? saved?.provider ?? null : harness;
    setCategory(OWN); setCategoryPos(null);
    setSourcePos(submenuPosition(row, 300, 360));
    focusModels.current = focus;
    if (own && source === own && focus) menu.menuRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    if (source !== own) { setModels([]); setError(""); setQuery(""); setLoading(own !== null); }
    setSource(own);
  }
  function showSource(id: string, row: HTMLElement, focus = false) {
    if (!support[id]?.supported) { setSource(null); setSourcePos(null); return; }
    setSourcePos(submenuPosition(row, 300, 360));
    focusModels.current = focus;
    if (source === id && focus) menu.menuRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    if (source !== id) { setModels([]); setError(""); setQuery(""); setLoading(true); }
    setSource(id);
  }
  const sourceGroups = useMemo(() => intelligenceSourceGroups(custom, customClis), [custom, customClis]);
  const missingClis = useMissingDelegateClis(menu.open, sourceGroups.find((g) => g.label === "Subscription")?.items.map((item) => item.id === NOUS_SOURCE ? "hermes" : item.id));
  const sources = (sourceGroups.find((g) => g.label === category)?.items ?? []).slice()
    .sort((a, b) => Number(missingClis.has(a.id === NOUS_SOURCE ? "hermes" : a.id)) - Number(missingClis.has(b.id === NOUS_SOURCE ? "hermes" : b.id)));
  const sourceIds = sourceGroups.flatMap((g) => g.items.map((item) => item.id)).join("\n");
  const ownTitle = harness === "hermes" && saved ? sourceGroups.flatMap((g) => g.items).find((item) => item.id === saved.provider)?.name ?? saved.provider : harnessName;
  useEffect(() => {
    if (!menu.open) return;
    void refreshCustomCli().then(setCustomClis).catch(() => {});
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
  const style = MODEL_ROW_STYLE;
  const select = (id: string) => {
    if (!source) return;
    if (harness === "claude-code" && source === NOUS_SOURCE && !id.startsWith("anthropic/claude-") && !id.startsWith("claude-")) return;
    if (harness !== "hermes" && source === harness) onChange(id);
    else onChange((harness === "hermes" ? PREFIX : "harness-source:") + JSON.stringify({ provider: source, model: id }));
    menu.close();
    menu.triggerRef.current?.focus();
  };
  const current = choice ?? (model === "default" ? (harness === "hermes" ? saved : null) : harness !== "hermes" ? { provider: harness, model } : null);
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
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ position: "absolute", right: 2, color: "var(--fg-dim)", transform: menu.open ? "rotate(180deg)" : "none" }}><path d="M6 9l6 6 6-6" /></svg>
    </button>
    {menu.open && menu.pos && createPortal(<div ref={menu.menuRef}
      style={{ position: "fixed", ...menu.pos, width: 200, zIndex: Z.popover }}
      onKeyDown={(e) => {
        if (e.key === "Escape") { menu.close(); menu.triggerRef.current?.focus(); }
        const target = e.target as HTMLElement;
        if (e.key === "ArrowRight" && target.dataset.own) {
          e.preventDefault(); showOwn(target, true);
          requestAnimationFrame(() => menu.menuRef.current?.querySelector<HTMLInputElement>('[data-level="models"] input')?.focus());
        } else if (e.key === "ArrowRight" && target.dataset.category) {
          e.preventDefault(); showCategory(target.dataset.category, target);
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
      <div role="menu" data-menu-panel data-level="categories" className="popover-enter menu-glass" style={{ overflow: "hidden" }}>
        <ModelPickerHeader icon={<ProviderLogo id={harness} size={15} />} title={harnessName} caption="Choose an intelligence source" />
        <div style={{ padding: 4 }}>
        <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={category === OWN} data-own className="provider-category-row"
          style={{ ...style, background: category === OWN ? "var(--menu-row-active)" : undefined }}
          onMouseEnter={(e) => showOwn(e.currentTarget)} onClick={(e) => showOwn(e.currentTarget, true)}>
          {harnessName} <span style={{ float: "right" }} aria-hidden>›</span>
        </button>
        {CATEGORIES.map((name) => <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={category === name} data-category={name}
          key={name} className="provider-category-row" style={{ ...style, background: category === name ? "var(--menu-row-active)" : undefined }}
          onMouseEnter={(e) => showCategory(name, e.currentTarget)} onClick={(e) => showCategory(name, e.currentTarget)}>
          {name} <span style={{ float: "right" }} aria-hidden>›</span>
        </button>)}
        </div>
      </div>
      {category && categoryPos && <div role="menu" data-menu-panel data-level="providers" className="popover-enter menu-glass"
        style={{ position: "fixed", ...categoryPos, width: 220, maxHeight: Math.min(300, window.innerHeight - categoryPos.top - 8), display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <ModelPickerHeader title={category} caption="Choose a provider" />
        <div className="menu-scroll" style={{ minHeight: 0, overflow: "auto", padding: 4 }}>
        {sources.map((p) => <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={source === p.id} data-source={p.id}
          key={p.id} className="provider-category-row" aria-disabled={!support[p.id]?.supported} title={support[p.id]?.reason ?? (missingClis.has(p.id === NOUS_SOURCE ? "hermes" : p.id) ? `${p.id === NOUS_SOURCE ? "Hermes" : p.name} CLI is not installed` : undefined)}
          style={{ ...style, display: "flex", alignItems: "center", gap: 8, opacity: !support[p.id]?.supported || missingClis.has(p.id === NOUS_SOURCE ? "hermes" : p.id) ? 0.45 : 1, background: source === p.id ? "var(--menu-row-active)" : undefined }}
          onMouseEnter={(e) => showSource(p.id, e.currentTarget)} onClick={(e) => showSource(p.id, e.currentTarget, true)}>
          <ProviderLogo id={p.id === NOUS_SOURCE ? "hermes" : p.id as ProviderId} size={16} />
          <span style={{ flex: 1 }}>{p.name}</span>{support[p.id]?.supported ? <span aria-hidden>›</span> : <span style={{ fontSize: 10, color: "var(--fg-dim)" }}>{support[p.id] ? "Needs bridge" : "Checking…"}</span>}
        </button>)}
        {sources.length === 0 && <button type="button" style={style} onClick={() => { menu.close(); openSettingsSection("api"); }}>Add a self-hosted endpoint ↗</button>}
        </div>
      </div>}
      {(source || category === OWN) && sourcePos && <div role="menu" data-menu-panel data-level="models" className="popover-enter menu-glass"
        style={{ position: "fixed", ...sourcePos, width: 300, maxHeight: Math.min(360, window.innerHeight - sourcePos.top - 8), display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <ModelPickerHeader icon={<ProviderLogo id={!source || source.startsWith("hermes-subscription:") ? (source ? "hermes" : harness) : source as ProviderId} size={15} />}
          title={category === OWN ? ownTitle : sources.find((p) => p.id === source)?.name ?? "Models"}
          caption={category === OWN ? (harness === "hermes" ? (saved ? "Hermes’s configured source" : "No configured source yet") : `${harnessName}’s own models`) : loading ? "Loading models…" : `${models.length} models available`} />
        {category === "Subscription" && <div style={{ padding: 9, fontSize: 11, color: "var(--fg-subtle)" }}>{source === NOUS_SOURCE ? "Uses your Nous Portal allowance. Hermes manages authentication." : harness === "hermes" ? "Uses this subscription through Hermes’s own authentication." : "Uses the harness’s own authentication."}</div>}
        <div style={{ flexShrink: 0, padding: "6px 8px", borderBottom: "1px solid var(--panel-border)" }}>
        <input aria-label="Search or enter model" value={query} placeholder="Filter models…" style={MODEL_FILTER_STYLE}
          onFocus={(e) => { e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 50%, var(--border))"; e.currentTarget.style.background = "var(--bg-elevated)"; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg)"; }} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && query.trim() && !loading && !error) select(query.trim()); }} />
        </div>
        <div className="menu-scroll" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 4 }}>
        {category === OWN && harness === "hermes" && !saved && <div style={{ padding: 9, fontSize: 12, color: "var(--fg-subtle)" }}>Hermes has no configured source yet.<button type="button" style={style} onClick={() => { menu.close(); openSettingsSection("subscription"); }}>Open Settings ↗</button></div>}
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
      </div>}
    </div>, document.body)}
  </div>;
}
