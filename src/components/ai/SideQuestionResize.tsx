import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { beginDragSession } from "../../dragSession";

const SIZE_KEY = "klide.btw.size";
const DEFAULT_SIZE = 40;

export function sideQuestionSizeBounds(width: number, height: number) {
  const stacked = width <= 700;
  const extent = Math.max(1, stacked ? height : width);
  const minimum = Math.min(40, Math.max(25, (stacked ? 160 : 240) / extent * 100));
  const maximum = Math.max(60, Math.min(65, 100 - (stacked ? 160 : 280) / extent * 100));
  return { stacked, minimum, maximum };
}

function savedSize() {
  try {
    const saved = Number(localStorage.getItem(SIZE_KEY) ?? DEFAULT_SIZE);
    return Number.isFinite(saved) ? Math.max(25, Math.min(65, saved)) : DEFAULT_SIZE;
  } catch { return DEFAULT_SIZE; }
}

function rememberSize(size: number) {
  try { localStorage.setItem(SIZE_KEY, String(size)); } catch { /* Resizing still works without storage. */ }
}

export function SideQuestionResize({ panelId, open }: { panelId: string; open: boolean }) {
  const handle = useRef<HTMLDivElement>(null);
  const finishDrag = useRef<(() => void) | null>(null);
  const [size, setSize] = useState(savedSize);
  const [bounds, setBounds] = useState(() => sideQuestionSizeBounds(1000, 800));
  const clamp = (value: number) => Math.max(bounds.minimum, Math.min(bounds.maximum, value));

  useLayoutEffect(() => {
    const columns = handle.current?.parentElement;
    if (!columns) return;
    columns.style.setProperty("--btw-main-track", `${100 - size}fr`);
    columns.style.setProperty("--btw-side-track", `${size}fr`);
    columns.style.setProperty("--btw-edge", `${100 - size}%`);
  }, [size]);

  useEffect(() => {
    const columns = handle.current?.parentElement;
    if (!columns) return;
    const observer = new ResizeObserver(() => {
      const rect = columns.getBoundingClientRect();
      const next = sideQuestionSizeBounds(rect.width, rect.height);
      setBounds(next);
      setSize(value => Math.max(next.minimum, Math.min(next.maximum, value)));
    });
    observer.observe(columns);
    return () => { observer.disconnect(); finishDrag.current?.(); };
  }, []);

  function update(value: number) {
    const next = clamp(value);
    setSize(next);
    rememberSize(next);
  }

  return <div ref={handle} className="klide-btw-resize" role="separator" tabIndex={open ? 0 : -1} inert={!open} aria-hidden={!open}
    aria-label="Resize side question" aria-controls={panelId}
    aria-orientation={bounds.stacked ? "horizontal" : "vertical"}
    aria-valuemin={Math.round(bounds.minimum)} aria-valuemax={Math.round(bounds.maximum)}
    aria-valuenow={Math.round(size)} aria-valuetext={`${Math.round(size)}% side question`}
    title="Drag to resize · double-click to reset"
    onDoubleClick={() => update(DEFAULT_SIZE)}
    onKeyDown={event => {
      const decrease = bounds.stacked ? "ArrowDown" : "ArrowRight";
      const increase = bounds.stacked ? "ArrowUp" : "ArrowLeft";
      if (![decrease, increase, "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      update(event.key === "Home" ? bounds.minimum : event.key === "End" ? bounds.maximum : size + (event.key === increase ? 2 : -2));
    }}
    onMouseDown={event => {
      if (event.button !== 0) return;
      event.preventDefault();
      const columns = event.currentTarget.parentElement!;
      const rect = columns.getBoundingClientRect();
      let next = size;
      finishDrag.current?.();
      columns.dataset.resizing = "true";
      finishDrag.current = beginDragSession({
        cursor: bounds.stacked ? "row-resize" : "col-resize",
        onMove: move => {
          const position = bounds.stacked ? (move.clientY - rect.top) / rect.height : (move.clientX - rect.left) / rect.width;
          next = clamp((1 - position) * 100);
          setSize(next);
        },
        onDone: () => {
          delete columns.dataset.resizing;
          rememberSize(next);
          finishDrag.current = null;
        },
      });
    }} />;
}
