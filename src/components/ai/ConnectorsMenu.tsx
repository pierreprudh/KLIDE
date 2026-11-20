// Connectors, from the composer's "+" menu — the same switch Settings ›
// Connectors holds, one reach away from where a conversation needs it.
//
// A connector that is on is offered to every conversation's Run in Plan and
// Work (`agent/connector_tools.rs`): its tools by name, their schemas on
// demand, each remote tool asking for approval on first use. So the row
// doesn't attach anything to *this* message; it says which services the
// assistant can talk to and lets you switch one on or off on the spot. A
// switch here is the store's own `enabled` flag, so the next Run sees it.
//
// One row in the "+" menu — "Connectors   3 on  ›" — whose list opens in a
// card beside the menu (the provider picker's side card, `StackSideMenu`), so
// thirty servers scroll in their own card instead of stretching the menu. A
// filter appears once the list is long enough to need one.
//
// The card is portaled to <body>: both "+" menus clip (overflow) and animate
// a transform, either of which would trap a fixed child. Their outside-click
// listeners live on document / window, so a press inside the card stops at
// <body> rather than closing the menu it belongs to.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { listConnectors, upsertConnector, type Connector } from "../../ipc/connectors";
import { ConnectorMark } from "../linkMark";
import { openSettingsSection } from "../../settingsNavigation";
import { errMessage } from "../../errors";
import { notify } from "../../toast";
import { Z } from "../../zLayers";

const GAP = 6;
const MARGIN = 8;
const CARD_WIDTH = 236;
const CARD_MAX_HEIGHT = 360;
/** From this many connectors on, the card leads with a filter. */
const FILTER_FROM = 8;
/** Pointer leaves row and card: how long before the card folds away. */
const LEAVE_DELAY = 260;
/** Pointer rests on the row: how long before the card opens. */
const HOVER_DELAY = 110;

type Place = { left: number; top: number; maxHeight: number; side: "right" | "left" };

export function ConnectorsMenu({ onNavigate }: { onNavigate: () => void }) {
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<Place | null>(null);
  const [query, setQuery] = useState("");
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const rowRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let live = true;
    listConnectors()
      .then((all) => { if (live) setConnectors(all); })
      .catch(() => { if (live) setConnectors([]); });
    return () => { live = false; };
  }, []);

  const clearTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clearTimer, []);
  const later = (ms: number, run: () => void) => {
    clearTimer();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      run();
    }, ms);
  };

  // Beside the "+" menu, level with the row; flipped left when the window has
  // no room on the right, lifted when it would run past the bottom edge.
  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    const row = rowRef.current;
    const menu = row?.parentElement?.closest<HTMLElement>("[role=menu]") ?? row;
    if (!row || !menu) return;
    const m = menu.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const side = m.right + GAP + CARD_WIDTH > window.innerWidth - MARGIN && m.left - GAP - CARD_WIDTH > MARGIN ? "left" : "right";
    const left = side === "right" ? m.right + GAP : m.left - GAP - CARD_WIDTH;
    const maxHeight = Math.min(CARD_MAX_HEIGHT, window.innerHeight - MARGIN * 2);
    const height = Math.min(maxHeight, cardRef.current?.scrollHeight ?? maxHeight);
    let top = r.top - 5;
    top = Math.min(top, window.innerHeight - MARGIN - height);
    top = Math.max(MARGIN, top);
    setPlace({ left, top, maxHeight, side });
  }, [open, connectors?.length]);

  // Fade the edge the list continues past, so a hidden scrollbar still says
  // "there's more".
  function readEdges() {
    const list = listRef.current;
    if (!list) return;
    const top = list.scrollTop > 2;
    const bottom = list.scrollTop + list.clientHeight < list.scrollHeight - 2;
    setEdges((e) => (e.top === top && e.bottom === bottom ? e : { top, bottom }));
  }
  useLayoutEffect(readEdges, [place, query, connectors]);

  // Esc folds the card first; the "+" menu's own Esc waits for the next one.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      e.preventDefault();
      setOpen(false);
      rowRef.current?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  async function toggle(connector: Connector) {
    const next = { ...connector, enabled: !connector.enabled };
    // Flip at once; the store's answer replaces it, a failure puts it back.
    setConnectors((prev) => prev?.map((c) => (c.id === connector.id ? next : c)) ?? prev);
    try {
      setConnectors(await upsertConnector(next));
    } catch (e) {
      setConnectors((prev) => prev?.map((c) => (c.id === connector.id ? connector : c)) ?? prev);
      notify(errMessage(e), { tone: "error" });
    }
  }

  function manage() {
    setOpen(false);
    onNavigate();
    openSettingsSection("connectors");
  }

  function cardButtons(): HTMLButtonElement[] {
    return Array.from(cardRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
  }
  /** Open the card; from the keyboard, step into it as well. A pointer
   *  open leaves focus where it was — no ring on a row nobody chose. */
  function enterCard(withKeys: boolean) {
    clearTimer();
    setOpen(true);
    if (!withKeys) return;
    requestAnimationFrame(() => {
      const filter = cardRef.current?.querySelector<HTMLInputElement>("input");
      (filter ?? cardButtons()[0])?.focus({ preventScroll: true });
    });
  }
  function onCardKey(e: KeyboardEvent<HTMLDivElement>) {
    const buttons = cardButtons();
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => buttons[(i + buttons.length) % buttons.length]?.focus();
    const inFilter = (e.target as HTMLElement).tagName === "INPUT";
    const keys: Record<string, () => void> = {
      ArrowDown: () => go(at + 1),
      ArrowUp: () => go(at < 0 ? buttons.length - 1 : at - 1),
      ArrowLeft: () => {
        setOpen(false);
        rowRef.current?.focus();
      },
    };
    if (inFilter && e.key === "ArrowLeft") return;
    const run = keys[e.key];
    if (!run) return;
    e.preventDefault();
    run();
  }

  const on = connectors?.filter((c) => c.enabled).length ?? 0;
  const none = connectors !== null && connectors.length === 0;
  const q = query.trim().toLowerCase();
  const shown = (connectors ?? []).filter((c) => !q || c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q));
  const filterable = (connectors?.length ?? 0) >= FILTER_FROM;

  const card = open && connectors && connectors.length > 0 && createPortal(
    <div
      ref={cardRef}
      role="menu"
      aria-label="Connectors"
      className="klide-menu-connectors-card menu-glass"
      data-side={place?.side}
      style={{
        left: place?.left ?? 0,
        top: place?.top ?? 0,
        width: CARD_WIDTH,
        maxHeight: place?.maxHeight ?? CARD_MAX_HEIGHT,
        visibility: place ? "visible" : "hidden",
        zIndex: Z.popover + 1,
      }}
      // Keep the press from reaching the "+" menu's outside-click listener.
      onMouseDown={(e) => e.nativeEvent.stopPropagation()}
      onMouseEnter={clearTimer}
      onMouseLeave={() => later(LEAVE_DELAY, () => setOpen(false))}
      onKeyDown={onCardKey}
    >
      {filterable && (
        <input
          className="klide-menu-connectors-filter klide-bare-filter"
          placeholder="Filter connectors"
          aria-label="Filter connectors"
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      <div
        ref={listRef}
        className="klide-menu-connectors-list menu-scroll"
        data-fade-top={edges.top || undefined}
        data-fade-bottom={edges.bottom || undefined}
        onScroll={readEdges}
      >
        {shown.length === 0 ? (
          <div className="klide-menu-connectors-empty">No connector matches</div>
        ) : shown.map((connector, i) => (
          <button
            key={connector.id}
            type="button"
            role="menuitemcheckbox"
            aria-checked={connector.enabled}
            className="klide-menu-connectors-item"
            data-off={!connector.enabled || undefined}
            style={{ "--i": Math.min(i, 10) } as CSSProperties}
            onClick={() => void toggle(connector)}
          >
            <span className="klide-menu-connectors-mark">
              <ConnectorMark connector={connector.id} label={connector.label} server={connector.server} size={14} tone="brand" />
            </span>
            <span className="klide-menu-connectors-name">{connector.label}</span>
            <span className="klide-menu-switch" data-checked={connector.enabled || undefined} aria-hidden="true">
              <span />
            </span>
          </button>
        ))}
      </div>
      <div className="klide-menu-connectors-foot">
        <button type="button" role="menuitem" className="klide-menu-connectors-item klide-menu-connectors-manage" onClick={manage}>
          Manage connectors
        </button>
      </div>
    </div>,
    document.body,
  );

  return (
    <div className="klide-menu-connectors">
      <button
        ref={rowRef}
        type="button"
        role="menuitem"
        aria-haspopup={none ? undefined : "menu"}
        aria-expanded={none ? undefined : open}
        className="klide-menu-connectors-row"
        data-open={open || undefined}
        title={none ? "Connect Linear, Notion, GitHub and other MCP servers" : "The services the assistant can reach in Plan and Work"}
        onClick={(e) => (none ? manage() : open ? setOpen(false) : enterCard(e.detail === 0))}
        onMouseEnter={() => { if (!none) later(open ? 0 : HOVER_DELAY, () => setOpen(true)); }}
        onMouseLeave={() => { if (open) later(LEAVE_DELAY, () => setOpen(false)); else clearTimer(); }}
        onKeyDown={(e) => {
          if (!none && e.key === "ArrowRight") {
            e.preventDefault();
            enterCard(true);
          }
        }}
      >
        <span className="klide-menu-connectors-label">Connectors</span>
        <span className="klide-menu-connectors-meta">
          {connectors === null ? "" : none ? "Add" : `${on} on`}
        </span>
        {!none && (
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="klide-menu-connectors-chevron"
          >
            <path d="m9 6 6 6-6 6" />
          </svg>
        )}
      </button>
      {card}
    </div>
  );
}
