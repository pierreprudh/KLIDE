import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Msg } from "./types";

type Link = { start: number; end: number; members: number[]; direct?: boolean };

/** Stable empty result: most conversations have no observer or Mission rows,
 * and the panel re-renders ~28×/s while a Run streams. Returning the same
 * constant keeps `links` identity-stable so the layout effect below does not
 * re-run (and no ResizeObserver is ever created) for them. */
const EMPTY_LINKS: Link[] = [];

/** A `Watching `cmd` as `shell`. …` tool row, read once per row instead of
 * once per observer message. */
const WATCHING_RE = /^Watching `[^`]*` as `([^`]*)`\./;

/** Scan backward from a tool row to the assistant message that requested it,
 * stopping at the turn boundary. */
function launchStart(msgs: Msg[], toolIndex: number, toolCallId?: string): number {
  for (let i = toolIndex - 1; i >= 0; i--) {
    const row = msgs[i];
    if (row.role === "user") break;
    if (row.role === "assistant" && row.toolCalls?.some(call => call.id === toolCallId)) return i;
  }
  return -1;
}

/** Match the durable observer id, never the position of the latest user turn.
 * A single O(n) pre-scan indexes plan receipts and watch rows so the link
 * pass never does a `findIndex` per message — the previous shape was O(n²)
 * with a `JSON.parse` in the inner loop, re-run on every streamed flush. */
export function observerConnections(msgs: Msg[]): Link[] {
  let anyObserver = false;
  for (const row of msgs) {
    if ((row.role === "assistant" && row.missionReportId) || (row.role === "system" && row.observer)) { anyObserver = true; break; }
  }
  if (!anyObserver) return EMPTY_LINKS;
  // First tool row per Mission id / observed shell — the first occurrence is
  // the only candidate the old `findIndex` (bounded to `i < end`) could ever
  // match, so a map lookup with the same bound is equivalent.
  const planFirst = new Map<string, number>();
  const watchFirst = new Map<string, number>();
  for (let i = 0; i < msgs.length; i++) {
    const row = msgs[i];
    if (row.role !== "tool") continue;
    if (row.toolName === "plan_mission") {
      try {
        const receipt = JSON.parse(row.content) as { action?: unknown; missionId?: unknown };
        if (receipt?.action === "plan" && typeof receipt.missionId === "string" && !planFirst.has(receipt.missionId)) {
          planFirst.set(receipt.missionId, i);
        }
      } catch { /* not a receipt-shaped row */ }
    } else if (row.toolName === "run_command" && row.content.startsWith("Watching `")) {
      const shellId = WATCHING_RE.exec(row.content)?.[1];
      if (shellId && !watchFirst.has(shellId)) watchFirst.set(shellId, i);
    }
  }
  const links: Link[] = [];
  msgs.forEach((msg, end) => {
    if (msg.role === "assistant" && msg.missionReportId) {
      const toolIndex = planFirst.get(msg.missionReportId) ?? -1;
      if (toolIndex < 0 || toolIndex >= end) return;
      const tool = msgs[toolIndex];
      if (!tool || tool.role !== "tool") return;
      const start = launchStart(msgs, toolIndex, tool.toolCallId);
      if (start >= 0) links.push({ start, end, members: [start, end], direct: true });
      return;
    }
    if (msg.role !== "system" || !msg.observer) return;
    const toolIndex = watchFirst.get(msg.observer.shellId) ?? -1;
    if (toolIndex < 0 || toolIndex >= end) return;
    const tool = msgs[toolIndex];
    if (!tool || tool.role !== "tool") return;
    const start = launchStart(msgs, toolIndex, tool.toolCallId);
    if (start < 0) return;
    const members = [end];
    for (let i = start; i < toolIndex; i++) members.push(i);
    for (let i = toolIndex + 1; i < end && msgs[i].role !== "user" && msgs[i].role !== "system"; i++) members.push(i);
    for (let i = end + 1; i < msgs.length && msgs[i].role !== "user" && msgs[i].role !== "system"; i++) members.push(i);
    links.push({ start, end, members });
  });
  return links;
}

export function ObserverConnections({ msgs, children }: { msgs: Msg[]; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const links = useMemo(() => observerConnections(msgs), [msgs]);
  const [hovered, setHovered] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const [paths, setPaths] = useState<string[]>([]);
  const active = focused ?? hovered;
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    if (links.length === 0) {
      // Nothing to draw: skip the ResizeObserver and the forced layout
      // measure entirely. Only clear paths left over from a previous state,
      // keeping the array identity stable so this stays a no-op re-render.
      setPaths(prev => (prev.length === 0 ? prev : []));
      return;
    }
    const measure = () => {
      const box = node.getBoundingClientRect();
      setPaths(links.map(link => {
        const logos = Array.from(node.querySelectorAll<HTMLElement>('[data-observer-logo]'));
        const a = logos.filter(logo => Number(logo.dataset.observerLogo) <= link.start).pop();
        const b = logos.find(logo => link.direct ? Number(logo.dataset.observerLogo) === link.end : Number(logo.dataset.observerLogo) > link.end && link.members.includes(Number(logo.dataset.observerLogo)));
        if (!a || !b) return "";
        const from = a.getBoundingClientRect(), to = b.getBoundingClientRect();
        const x1 = from.left - box.left - 3, x2 = to.left - box.left - 3;
        const y1 = from.top - box.top + from.height / 2;
        const y2 = to.top - box.top + to.height / 2;
        const gutter = Math.min(x1, x2) - 6;
        return `M ${x1} ${y1} C ${gutter} ${y1} ${gutter} ${y1 + 8} ${gutter} ${y1 + 16} L ${gutter} ${y2 - 16} C ${gutter} ${y2 - 8} ${gutter} ${y2} ${x2} ${y2}`;
      }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    node.querySelectorAll('[data-observer-row]').forEach(row => observer.observe(row));
    return () => observer.disconnect();
  }, [links]);
  const rowOf = (target: EventTarget | null) => {
    const row = target instanceof Element ? target.closest<HTMLElement>('[data-observer-row]') : null;
    return row ? Number(row.dataset.observerRow) : null;
  };
  return <div ref={root} style={{ position: "relative" }} onMouseOver={e => setHovered(rowOf(e.target))} onMouseLeave={() => setHovered(null)} onFocusCapture={e => setFocused(rowOf(e.target))} onBlurCapture={e => setFocused(rowOf(e.relatedTarget))}>
    <svg aria-hidden="true" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible", pointerEvents: "none" }}>
      {links.map((link, i) => <path key={`${link.start}-${link.end}`} className="observer-hover-connection" d={paths[i] ?? ""} data-active={active !== null && link.members.includes(active)} />)}
    </svg>
    {children}
  </div>;
}
