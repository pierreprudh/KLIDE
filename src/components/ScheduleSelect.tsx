import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, ChevronIcon, SearchIcon } from "../icons";
import { usePortalMenu } from "../hooks/usePortalMenu";
import { Z } from "../zLayers";

export type ScheduleSelectOption = {
  value: string; label: string; description?: string; group?: string;
  icon?: ReactNode; disabled?: boolean;
};

type Props = {
  label: string; value: string; options: ScheduleSelectOption[];
  onChange: (value: string) => void; portalContainer: HTMLElement | null;
  searchable?: boolean; disabled?: boolean; compact?: boolean;
};

/** A modal-safe selector using the command palette's search and glass rows. */
export function ScheduleSelect({ label, value, options, onChange, portalContainer, searchable = false, disabled, compact }: Props) {
  const id = useId();
  const search = useRef<HTMLInputElement>(null);
  const header = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [sized, setSized] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(value);
  const selected = options.find(option => option.value === value);
  const matches = options.filter(option => `${option.label} ${option.group ?? ""} ${option.description ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const enabled = matches.filter(option => !option.disabled);
  const activeIndex = matches.findIndex(option => option.value === active);
  const menu = usePortalMenu({ closeOnOutsideClick: true, computePos: rect => {
    const width = Math.min(searchable ? 320 : 272, window.innerWidth - 16);
    const below = window.innerHeight - rect.bottom - 16;
    const above = rect.top - 16;
    const down = below >= 260 || below >= above;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const origin = Math.max(12, Math.min(width - 12, rect.left - left + rect.width / 2));
    return { left, width, transformOrigin: `${origin}px ${down ? "top" : "bottom"}`,
      top: down ? rect.bottom + 6 : undefined, bottom: down ? undefined : window.innerHeight - rect.top + 6,
      maxHeight: Math.max(80, Math.min(400, down ? below : above)) };
  } });
  // Like the command palette, measure the natural inner content, not the
  // animated shell. Filtering can then resize without a feedback loop.
  useLayoutEffect(() => {
    if (!menu.open) { setHeight(null); setSized(false); return; }
    const heading = header.current;
    const body = content.current;
    if (!heading || !body) return;
    const max = menu.pos?.maxHeight ?? 400;
    const measure = () => setHeight(Math.min(max, heading.offsetHeight + body.offsetHeight + 12));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(heading); observer.observe(body);
    const frame = requestAnimationFrame(() => setSized(true));
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [menu.open, menu.pos?.maxHeight]);
  useEffect(() => {
    if (!menu.open) return;
    (search.current ?? menu.menuRef.current)?.focus({ preventScroll: true });
  }, [menu.open, menu.menuRef]);
  useEffect(() => {
    if (menu.open) menu.menuRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, menu.open, menu.menuRef]);
  useEffect(() => { if (disabled) menu.close(); }, [disabled, menu.close]);

  function close() { menu.close(); menu.triggerRef.current?.focus(); }
  function open() {
    setQuery("");
    setActive(options.find(option => option.value === value && !option.disabled)?.value ?? options.find(option => !option.disabled)?.value ?? "");
    menu.openMenu();
  }
  function choose(option: ScheduleSelectOption) {
    if (option.disabled) return;
    onChange(option.value); close();
  }
  function step(delta: number) {
    if (!enabled.length) return;
    const index = enabled.findIndex(option => option.value === active);
    setActive(enabled[(index + delta + enabled.length) % enabled.length].value);
  }

  return <>
    <button ref={menu.triggerRef} type="button" className={`scheduled-select-trigger${compact ? " scheduled-select-compact" : ""}`}
      aria-label={`${label}: ${selected?.label ?? value}`} aria-haspopup="listbox" aria-expanded={menu.open}
      aria-controls={menu.open ? `${id}-list` : undefined} disabled={disabled}
      onClick={() => menu.open ? close() : open()}
      onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); open(); } }}>
      {selected?.icon}<span>{selected?.label ?? value}</span><ChevronIcon size={12} />
    </button>
    {menu.open && menu.pos && createPortal(<div ref={menu.menuRef} className="scheduled-select-menu menu-glass picker-menu" data-sized={sized || undefined}
      tabIndex={-1} style={{ position: "fixed", ...menu.pos, height: height ?? undefined, zIndex: Z.popover }}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
        else if (event.key === "Tab") close();
        else if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); step(event.key === "ArrowDown" ? 1 : -1); }
        else if ((event.key === "Home" || event.key === "End") && event.target !== search.current) { event.preventDefault(); setActive((event.key === "Home" ? enabled[0] : enabled[enabled.length - 1])?.value ?? ""); }
        else if (event.key === "Enter") { event.preventDefault(); const option = enabled.find(option => option.value === active); if (option) choose(option); }
      }}>
      <div ref={header} className="scheduled-select-header">
        {searchable ? <><SearchIcon size={14} /><input ref={search} className="klide-cmd-input" role="combobox" aria-label={`Find ${label.toLocaleLowerCase()}`} aria-autocomplete="list" aria-expanded aria-controls={`${id}-list`}
          aria-activedescendant={activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
          placeholder="Search agents…" value={query} onChange={event => {
            const next = event.target.value; setQuery(next);
            setActive(options.find(option => !option.disabled && `${option.label} ${option.group ?? ""} ${option.description ?? ""}`.toLocaleLowerCase().includes(next.trim().toLocaleLowerCase()))?.value ?? "");
          }} /></> : <span>{label}</span>}
        <button type="button" className="klide-cmd-esc" aria-label={`Close ${label.toLocaleLowerCase()} choices`} onClick={close}>Esc</button>
      </div>
      <div id={`${id}-list`} role="listbox" aria-label={label} className="scheduled-select-list menu-scroll"><div ref={content}>
        {!matches.length && <p className="scheduled-select-empty">No matching agents.</p>}
        {matches.map((option, index) => <Fragment key={option.value}>
          {option.group && option.group !== matches[index - 1]?.group && <div role="presentation" className="klide-cmd-heading">{option.group}</div>}
          <button type="button" id={`${id}-option-${index}`} role="option" aria-selected={option.value === value} disabled={option.disabled} aria-disabled={option.disabled || undefined}
            tabIndex={-1} className="scheduled-select-option" data-active={option.value === active || undefined}
            onMouseEnter={() => { if (!option.disabled) setActive(option.value); }} onClick={() => choose(option)}>
            {option.icon && <span className="scheduled-select-icon">{option.icon}</span>}
            <span className="scheduled-select-copy"><span>{option.label}</span>{option.description && <small>{option.description}</small>}</span>
            {option.value === value && <CheckIcon size={14} />}
          </button>
        </Fragment>)}
      </div></div>
    </div>, portalContainer ?? document.body)}
  </>;
}
