import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Z } from "../zLayers";
import { watchDelegateStatus } from "../delegateStatusNotify";
import { watchWorkerStatus } from "../workerStatus";
import { watchRunAttention } from "../runAttention";
import { ProviderLogo } from "./ai/icons";
import type { ProviderId } from "../agent/types";
import { CloseIcon, ErrorIcon, InfoIcon, SuccessIcon, WarningIcon } from "../icons";
import {
  type Toast,
  type ToastTone,
  dismissToast,
  subscribeToasts,
} from "../toast";

// The single transient-notification surface. Mounted once at the App root;
// renders whatever the toast bus holds as a stack in the bottom-right corner,
// above the status bar.
//
// One stack, two shapes. At rest the newest toast sits in front and the older
// ones tuck behind it — each one PEEK px higher and 5% smaller, content hidden,
// so the stack reads as a pile of cards. Point at it (or tab into it) and it
// fans out into a list, every toast readable, and every timer pauses until
// the pointer leaves. Each card's place is a pure function of how far back it
// is and whether the stack is open; one CSS transition carries it between them.

const WIDTH = 340;
/** How much of each tucked toast shows above the one in front of it. */
const PEEK = 14;
/** Space between toasts once the stack fans out. */
const GAP = 10;
/** Toasts drawn while the stack is shut; deeper ones wait behind, invisible. */
const SHOWN = 3;
/** Before a card has measured itself. */
const FALLBACK_HEIGHT = 56;
/** A dismissed toast slides right and fades; the row is dropped after. */
const EXIT_MS = 220;

const MOVE = "420ms var(--ease-out)";
const FADE = `${EXIT_MS}ms`;
const ACCELERATE = `${EXIT_MS}ms cubic-bezier(0.4, 0, 1, 1)`;

const TONE_ICON: Record<ToastTone, typeof InfoIcon> = {
  info: InfoIcon,
  success: SuccessIcon,
  warn: WarningIcon,
  error: ErrorIcon,
};

const TONE_COLOR: Record<ToastTone, string> = {
  info: "var(--fg-subtle)",
  success: "var(--success)",
  warn: "var(--warning)",
  error: "var(--danger)",
};

const WASH = "color-mix(in srgb, var(--fg) 7%, transparent)";

// "Title — detail" messages render as two lines: the title in full strength,
// the detail quieter underneath. Messages without a dash stay one line.
function splitMessage(message: string): { title: string; detail: string | null } {
  const idx = message.indexOf(" — ");
  if (idx === -1) return { title: message, detail: null };
  return { title: message.slice(0, idx), detail: message.slice(idx + 3) };
}

const CLAMP: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  whiteSpace: "normal",
  wordBreak: "break-word",
};

/** Where one card sits, relative to the corner the stack is anchored to. */
type Place = {
  y: number;
  scale: number;
  height: number | undefined;
  opacity: number;
  /** Behind the front card with the stack shut — content hidden, inert. */
  tucked: boolean;
  z: number;
};

// A toast that left the bus (auto-dismiss, ✕, or pushed out by the stack cap)
// stays rendered with `leaving: true` until its exit has played, so it slides
// away from where it was while the survivors close the gap.
type Row = { toast: Toast; leaving: boolean };

function ToastCard({
  toast,
  place,
  open,
  leaving,
  onHeight,
}: {
  toast: Toast;
  place: Place;
  open: boolean;
  leaving: boolean;
  onHeight: (id: number, height: number) => void;
}) {
  const { id, message, tone, action, actions, provider, duration } = toast;
  const buttons = [...(actions ?? []), ...(action ? [action] : [])];
  const { tucked } = place;
  const interactive = !leaving && !tucked;

  // Auto-dismiss runs only while the stack is shut: an open stack is being
  // read, and every toast in it waits. A re-shut restarts the full duration.
  useEffect(() => {
    if (open || leaving || duration <= 0) return;
    const t = window.setTimeout(() => dismissToast(id), duration);
    return () => window.clearTimeout(t);
  }, [open, leaving, duration, id]);

  // The card's own height, measured off its content so a long message makes
  // a taller card — the stack lays out from these.
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = content.current;
    if (!el) return;
    onHeight(id, el.offsetHeight);
    const ro = new ResizeObserver(() => onHeight(id, el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [id, onHeight]);

  // Enter: the first frame is drawn below the front slot and transparent,
  // then the card rises into place on the same transition as everything else.
  const card = useRef<HTMLDivElement>(null);
  const [entered, setEntered] = useState(false);
  useLayoutEffect(() => {
    void card.current?.offsetWidth; // commit the starting style before it changes
    setEntered(true);
  }, []);

  const x = leaving ? 60 : 0;
  const y = entered ? place.y : 24;
  const opacity = leaving || !entered ? 0 : place.opacity;
  const Mark = TONE_ICON[tone];
  const { title, detail } = splitMessage(message);
  const stacked = buttons.length > 1;
  const buttonRow = buttons.map((button) => (
    <button
      key={button.label}
      type="button"
      tabIndex={interactive ? 0 : -1}
      onClick={() => {
        button.run();
        dismissToast(id);
      }}
      style={{
        flexShrink: 0,
        height: 26,
        padding: "0 11px",
        borderRadius: 999,
        border: "none",
        background: WASH,
        color: button.primary ? "var(--accent)" : "var(--fg-strong)",
        fontSize: 12,
        transition: "transform 160ms var(--ease-out)",
      }}
      onPointerDown={(e) => {
        e.currentTarget.style.transform = "scale(0.96)";
      }}
      onPointerUp={(e) => {
        e.currentTarget.style.transform = "";
      }}
      onPointerLeave={(e) => {
        e.currentTarget.style.transform = "";
      }}
    >
      {button.label}
    </button>
  ));

  return (
    <div
      ref={card}
      role="status"
      aria-live={tone === "error" ? "assertive" : "polite"}
      aria-hidden={tucked || undefined}
      style={{
        position: "absolute",
        right: 0,
        bottom: 0,
        width: "100%",
        height: place.height,
        overflow: "hidden",
        boxSizing: "border-box",
        borderRadius: 12,
        transformOrigin: "50% 0",
        transform: `translate3d(${x}px, ${y}px, 0) scale(${place.scale})`,
        opacity,
        zIndex: place.z,
        pointerEvents: interactive ? "auto" : "none",
        background: tucked
          ? "color-mix(in srgb, var(--fg) 5%, var(--bg-elevated))"
          : "var(--bg-elevated)",
        boxShadow: tucked
          ? `0 0 0 1px ${WASH}`
          : "0 0 0 1px var(--panel-border), var(--panel-shadow)",
        transition: leaving
          ? `transform ${ACCELERATE}, opacity ${ACCELERATE}`
          : `transform ${MOVE}, height ${MOVE}, opacity ${FADE}, background-color ${FADE}, box-shadow ${FADE}`,
        willChange: "transform, opacity",
      }}
    >
      <div
        ref={content}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 10px 12px 14px",
          opacity: tucked ? 0 : 1,
          transition: `opacity ${FADE}`,
        }}
      >
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ flexShrink: 0, display: "grid", placeItems: "center", color: TONE_COLOR[tone] }}>
              {/* A toast about an agent wears its mark; the tone stays in the
                  wording and the buttons. */}
              {provider ? <ProviderLogo id={provider as ProviderId} size={18} /> : <Mark size={18} />}
            </span>
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
              <div style={{ ...CLAMP, fontSize: 13, lineHeight: "18px", color: "var(--fg-strong)" }}>
                {title}
              </div>
              {detail && (
                <div
                  style={{
                    ...CLAMP,
                    fontSize: 12,
                    lineHeight: "17px",
                    color: "var(--fg-subtle)",
                    // A command sits a step in from the words about it.
                    paddingLeft: detail.startsWith("›") ? 8 : 0,
                  }}
                >
                  {detail}
                </div>
              )}
            </div>
            {!stacked && buttonRow}
          </div>
          {stacked && (
            // More than one answer goes on its own line under the words, so
            // the words keep the card's width; the row is centred under them.
            <div style={{ display: "flex", justifyContent: "center", gap: 12 }}>{buttonRow}</div>
          )}
        </div>
        <button
          type="button"
          tabIndex={interactive ? 0 : -1}
          onClick={() => dismissToast(id)}
          aria-label={`Dismiss ${title}`}
          style={{
            flexShrink: 0,
            width: 26,
            height: 26,
            display: "grid",
            placeItems: "center",
            borderRadius: 999,
            border: "none",
            background: "transparent",
            color: "var(--fg-dim)",
            transition: "background-color 160ms, color 160ms",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = WASH;
            e.currentTarget.style.color = "var(--fg-strong)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--fg-dim)";
          }}
        >
          <CloseIcon size={14} />
        </button>
      </div>
    </div>
  );
}

export default function ToastHost() {
  const [rows, setRows] = useState<Row[]>([]);
  const [open, setOpen] = useState(false);
  const [heights, setHeights] = useState<Record<number, number>>({});
  const exiting = useRef(new Set<number>());
  const region = useRef<HTMLDivElement>(null);
  // A leaving card keeps the place it had when it left; the survivors move on.
  const lastPlace = useRef(new Map<number, Place>());

  useEffect(
    () =>
      subscribeToasts((next) => {
        setRows((prev) => {
          const live = new Map(next.map((t) => [t.id, t]));
          const merged: Row[] = [];
          for (const r of prev) {
            const t = live.get(r.toast.id);
            if (t) {
              merged.push({ toast: t, leaving: false });
              live.delete(r.toast.id);
            } else {
              merged.push(r.leaving ? r : { ...r, leaving: true });
            }
          }
          for (const t of live.values()) merged.push({ toast: t, leaving: false });
          return merged;
        });
      }),
    [],
  );

  // Timer-driven removal, so a missed transition event can never leave a
  // ghost toast behind.
  useEffect(() => {
    for (const r of rows) {
      if (!r.leaving || exiting.current.has(r.toast.id)) continue;
      const id = r.toast.id;
      exiting.current.add(id);
      window.setTimeout(() => {
        exiting.current.delete(id);
        lastPlace.current.delete(id);
        setRows((prev) => prev.filter((p) => p.toast.id !== id));
        setHeights(({ [id]: _gone, ...rest }) => rest);
      }, EXIT_MS);
    }
  }, [rows]);

  const onHeight = useRef((id: number, h: number) =>
    setHeights((prev) => (prev[id] === h ? prev : { ...prev, [id]: h })),
  ).current;

  const live = rows.filter((r) => !r.leaving).reverse(); // newest first

  // The stack shuts once the last toast is gone, so the next one arrives tucked.
  useEffect(() => {
    if (live.length === 0) setOpen(false);
  }, [live.length]);

  // The delegate status watcher lives with the surface that renders its
  // output: ToastHost is mounted exactly once at the App root, so this is
  // the one place the app-wide "agent needs you / turn done" subscription
  // can't be double-mounted or forgotten.
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const stopDelegates = watchDelegateStatus();
    const stopWorkers = watchWorkerStatus();
    const stopAttention = watchRunAttention();
    return () => { stopDelegates(); stopWorkers(); stopAttention(); };
  }, []);

  if (rows.length === 0) return null;

  const heightOf = (id: number) => heights[id] ?? FALLBACK_HEIGHT;
  const frontHeight = live.length ? heightOf(live[0].toast.id) : 0;

  const places = new Map<number, Place>();
  let stacked = 0; // open: where the next card's bottom edge sits
  live.forEach((r, depth) => {
    const id = r.toast.id;
    const back = Math.min(depth, SHOWN - 1);
    const place: Place = open
      ? { y: -stacked, scale: 1, height: heights[id], opacity: 1, tucked: false, z: SHOWN + 1 - back }
      : {
          y: -back * PEEK,
          scale: 1 - back * 0.05,
          // A tucked card takes the front card's height, so the strip that
          // peeks out above it is exactly PEEK whatever its own message is.
          height: depth === 0 ? heights[id] : frontHeight,
          opacity: depth < SHOWN ? 1 : 0,
          tucked: depth > 0,
          z: SHOWN + 1 - back,
        };
    stacked += heightOf(id) + GAP;
    places.set(id, place);
    lastPlace.current.set(id, place);
  });

  const regionHeight = open
    ? Math.max(0, stacked - GAP)
    : frontHeight + Math.min(Math.max(live.length - 1, 0), SHOWN - 1) * PEEK;

  return createPortal(
    <div
      ref={region}
      role="region"
      aria-label="Notifications"
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(e) => {
        if (!region.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
      style={{
        position: "fixed",
        right: 12,
        bottom: "calc(var(--size-status-bar) + 12px)",
        zIndex: Z.toast,
        width: WIDTH,
        height: regionHeight,
        pointerEvents: live.length ? "auto" : "none",
      }}
    >
      {rows.map((r) => {
        const id = r.toast.id;
        const place = places.get(id) ??
          lastPlace.current.get(id) ?? {
            y: 0, scale: 1, height: undefined, opacity: 1, tucked: false, z: 0,
          };
        return (
          <ToastCard
            key={id}
            toast={r.toast}
            place={r.leaving ? { ...place, z: 0 } : place}
            open={open}
            leaving={r.leaving}
            onHeight={onHeight}
          />
        );
      })}
    </div>,
    document.body,
  );
}
