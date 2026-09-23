import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Msg } from "./types";

/** Match the durable observer id, never the position of the latest user turn. */
export function observerConnections(msgs: Msg[]) {
  const links: { start: number; end: number; members: number[] }[] = [];
  msgs.forEach((msg, end) => {
    if (msg.role !== "system" || !msg.observer) return;
    const toolIndex = msgs.findIndex((row, i) => i < end && row.role === "tool" && row.toolName === "run_command" && row.content.startsWith("Watching `") && row.content.includes(` as \`${msg.observer!.shellId}\`.`));
    if (toolIndex < 0) return;
    const tool = msgs[toolIndex];
    if (tool.role !== "tool") return;
    let start = -1;
    for (let i = toolIndex - 1; i >= 0; i--) {
      const row = msgs[i];
      if (row.role === "user") break;
      if (row.role === "assistant" && row.toolCalls?.some(call => call.id === tool.toolCallId)) { start = i; break; }
    }
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
    const measure = () => {
      const box = node.getBoundingClientRect();
      setPaths(links.map(link => {
        const logos = Array.from(node.querySelectorAll<HTMLElement>('[data-observer-logo]'));
        const a = logos.filter(logo => Number(logo.dataset.observerLogo) <= link.start).pop();
        const b = logos.find(logo => Number(logo.dataset.observerLogo) > link.end && link.members.includes(Number(logo.dataset.observerLogo)));
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
