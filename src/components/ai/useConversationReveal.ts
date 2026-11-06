import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Msg } from "./types";
import type { ConversationMatch } from "./transcriptNavigation";

// CSS highlights leave React's text nodes untouched. Keep each panel's ranges
// separate so closing a split chat cannot remove the other panel's highlight.
const panelRanges = new Map<object, Range[]>();
type HighlightRegistry = { set: (name: string, value: unknown) => void; delete: (name: string) => void };
function publishRanges() {
  const css = globalThis.CSS as typeof CSS & { highlights?: HighlightRegistry };
  const HighlightClass = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!css?.highlights || !HighlightClass) return;
  const ranges = [...panelRanges.values()].flat();
  if (ranges.length) css.highlights.set("klide-conversation-match", new HighlightClass(...ranges));
  else css.highlights.delete("klide-conversation-match");
}

function matchingRanges(root: HTMLElement, query: string): Range[] {
  if (!query) return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      return parent && !parent.closest("script, style, button, [inert]") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) nodes.push(node as Text);
  const text = nodes.map(n => n.data).join("").toLowerCase();
  const needle = query.toLowerCase();
  const ranges: Range[] = [];
  let at = 0;
  while ((at = text.indexOf(needle, at)) !== -1) {
    const range = document.createRange();
    let position = 0;
    for (const n of nodes) {
      if (position <= at && position + n.length > at) range.setStart(n, at - position);
      if (position < at + needle.length && position + n.length >= at + needle.length) {
        range.setEnd(n, at + needle.length - position);
        break;
      }
      position += n.length;
    }
    ranges.push(range);
    at += needle.length;
  }
  return ranges;
}

/** The caller prepares the range and opens controlled tool groups in the same
 * event. After commit, reveal native disclosures and scroll only on an explicit
 * request. Token updates refresh highlights without moving the reader. */
export function useConversationReveal(conversationId: string, messages: readonly Msg[], root: RefObject<HTMLDivElement | null>, enabled = true) {
  const [request, setRequest] = useState<{ id: string; index: number; match?: ConversationMatch; serial: number } | null>(null);
  const owner = useRef({});
  const lastScroll = useRef(0);
  const serial = useRef(0);
  useLayoutEffect(() => {
    const panel = root.current;
    if (!enabled || !panel || request?.id !== conversationId) return;
    let target: HTMLElement | null = null;
    let frame = 0;
    let overlay: HTMLDivElement | null = null;
    let selectedRange: Range | undefined;
    let resizeObserver: ResizeObserver | null = null;
    const drawFallback = () => {
      overlay?.replaceChildren();
      if (!overlay || !selectedRange) return;
      const clip = panel.getBoundingClientRect();
      for (const rect of Array.from(selectedRange.getClientRects())) {
        const left = Math.max(rect.left, clip.left), top = Math.max(rect.top, clip.top);
        const right = Math.min(rect.right, clip.right), bottom = Math.min(rect.bottom, clip.bottom);
        if (right <= left || bottom <= top) continue;
        const mark = document.createElement("div");
        Object.assign(mark.style, { position: "fixed", left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px`, background: getComputedStyle(panel).getPropertyValue("--accent-soft"), borderRadius: "2px" });
        overlay.append(mark);
      }
    };
    const reveal = () => {
      target = (request.match?.field === "Reasoning"
        ? panel.querySelector<HTMLElement>(`[data-conversation-thinking="${request.index}"]`) : null)
        ?? panel.querySelector<HTMLElement>(`[data-conversation-message="${request.index}"]`);
      if (!target) return;
      panel.classList.add("conversation-revealing");
      target.classList.add("conversation-message-target");
      if (request.match) target.querySelectorAll("details").forEach(details => { details.open = true; });
      const query = request.match?.text.slice(request.match.offset, request.match.offset + request.match.length) ?? "";
      const searchRoot = request.match?.field === "Reasoning" ? target.querySelector<HTMLElement>(".klide-think") ?? target : target;
      const ranges = matchingRanges(searchRoot, query);
      selectedRange = ranges[Math.min(request.match?.occurrence ?? 0, ranges.length - 1)];
      panelRanges.set(owner.current, selectedRange ? [selectedRange] : []);
      publishRanges();
      // Older WebKit versions have Range geometry but no CSS Highlight API.
      // Paint a decoration above the text, never insert marks into React nodes.
      if ((!((globalThis.CSS as typeof CSS & { highlights?: unknown })?.highlights) || !(globalThis as unknown as { Highlight?: unknown }).Highlight) && selectedRange) {
        overlay = document.createElement("div");
        overlay.setAttribute("aria-hidden", "true");
        overlay.className = "conversation-match-overlay";
        Object.assign(overlay.style, { position: "fixed", inset: "0", pointerEvents: "none", zIndex: "100" });
        document.body.append(overlay);
        panel.addEventListener("scroll", drawFallback, { passive: true });
        window.addEventListener("resize", drawFallback);
        resizeObserver = new ResizeObserver(drawFallback);
        resizeObserver.observe(panel);
      }
      if (lastScroll.current !== request.serial) {
        lastScroll.current = request.serial;
        // Scroll this chat only; scrollIntoView can move the surrounding canvas.
        const box = selectedRange?.getBoundingClientRect();
        const top = box && box.height ? box.top : target.getBoundingClientRect().top;
        panel.scrollTop += top - panel.getBoundingClientRect().top - (request.match ? 100 : 24);
      }
      drawFallback();
    };
    frame = requestAnimationFrame(reveal);
    return () => {
      cancelAnimationFrame(frame);
      panel.removeEventListener("scroll", drawFallback);
      window.removeEventListener("resize", drawFallback);
      resizeObserver?.disconnect();
      overlay?.remove();
      target?.classList.remove("conversation-message-target");
      panel.classList.remove("conversation-revealing");
      panelRanges.delete(owner.current);
      publishRanges();
    };
  }, [conversationId, messages, request, root, enabled]);
  return {
    reasoningIndex: request?.id === conversationId && request.match?.field === "Reasoning" ? request.index : undefined,
    reveal: (index: number, match?: ConversationMatch) => setRequest({ id: conversationId, index, match, serial: ++serial.current }),
    clear: () => setRequest(null),
  };
}
