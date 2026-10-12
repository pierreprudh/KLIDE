const authoredFrames = new WeakMap<SVGSVGElement, string>();

// The settle in flight for a drawing, so a second fit asked for while it is
// still gliding toward the same frame lets it finish instead of cutting in.
const settling = new WeakMap<SVGSVGElement, { target: string; cancel: () => void }>();
const SETTLE_MS = 640;
// Apple's ease-out: fast off the mark, long soft landing.
const easeOut = (t: number) => 1 - Math.pow(1 - t, 4);

/** Trim only unused outer SVG canvas; never reposition authored nodes.
 *  With `animate`, a drawing that was still growing a moment ago glides
 *  from its authored frame to the fitted one rather than snapping. */
export function fitVisualCanvases(root: HTMLElement, animate = false): void {
  root.querySelectorAll<SVGSVGElement>(":scope > svg").forEach(svg => {
    if (!svg.hasAttribute("viewBox") || svg.querySelector("filter, mask")) return;
    try {
      const authored = authoredFrames.get(svg) ?? svg.getAttribute("viewBox")!;
      authoredFrames.set(svg, authored);
      const [x0, y0, width, height] = authored.trim().split(/[\s,]+/).map(Number);
      const frame = { x: x0, y: y0, width, height };
      const box = svg.getBBox();
      if (!box.width || !box.height || !frame.width || !frame.height) return;
      if (box.x < frame.x || box.y < frame.y ||
          box.x + box.width > frame.x + frame.width ||
          box.y + box.height > frame.y + frame.height) return;
      const pad = 8;
      // Preserve intentional clipping and drawings that already fit their canvas.
      const x = Math.max(frame.x, box.x - pad);
      const y = Math.max(frame.y, box.y - pad);
      const right = Math.min(frame.x + frame.width, box.x + box.width + pad);
      const bottom = Math.min(frame.y + frame.height, box.y + box.height + pad);
      if (right <= x || bottom <= y) return;
      const target = `${x} ${y} ${right - x} ${bottom - y}`;
      const inFlight = settling.get(svg);
      if (inFlight?.target === target) return;
      inFlight?.cancel();
      const place = (frame: string, w: number) => {
        svg.setAttribute("viewBox", frame);
        svg.style.display = "block";
        svg.style.width = "100%";
        svg.style.maxWidth = `${w}px`;
        svg.style.minWidth = `${Math.min(w, 520)}px`;
        svg.style.height = "auto";
      };
      const current = (svg.getAttribute("viewBox") ?? authored).trim().split(/[\s,]+/).map(Number);
      const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!animate || reduced || current.length !== 4 || current.some(Number.isNaN)) {
        place(target, right - x);
        return;
      }
      const from = current as [number, number, number, number];
      const to = [x, y, right - x, bottom - y];
      const start = performance.now();
      let raf = 0;
      const step = (now: number) => {
        const t = easeOut(Math.min(1, (now - start) / SETTLE_MS));
        const f = to.map((v, i) => from[i] + (v - from[i]) * t);
        place(f.join(" "), f[2]);
        if (t < 1) raf = requestAnimationFrame(step);
        else { place(target, right - x); settling.delete(svg); }
      };
      settling.set(svg, { target, cancel: () => cancelAnimationFrame(raf) });
      raf = requestAnimationFrame(step);
    } catch { /* Unsupported SVG geometry keeps the authored canvas. */ }
  });
}

/** Fit a single drawing in both dimensions, without inflating short diagrams. */
export function viewerDrawingWidth(width: number, height: number, availableWidth: number, availableHeight: number): number {
  if (width <= 0 || height <= 0) return Math.max(1, Math.min(880, availableWidth));
  return Math.max(1, Math.min(1120, availableWidth, availableHeight * width / height, width * 1.5));
}

export function fitViewerCanvas(viewport: HTMLElement, content: HTMLElement): void {
  const padding = getComputedStyle(viewport);
  const width = viewport.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight);
  const height = viewport.clientHeight - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom) - 8;
  const body = content.querySelector<HTMLElement>(".klide-viz > [data-visual-content]");
  if (body) fitVisualCanvases(body);
  const svg = body?.children.length === 1 && body.firstElementChild instanceof SVGSVGElement ? body.firstElementChild : null;
  if (svg?.hasAttribute("viewBox")) {
    const box = svg.viewBox.baseVal;
    content.style.maxWidth = `${viewerDrawingWidth(box.width, box.height, width, height)}px`;
    svg.style.maxWidth = "100%";
    svg.style.minWidth = "0";
  } else {
    content.style.maxWidth = "880px";
  }
}
