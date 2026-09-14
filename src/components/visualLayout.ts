const authoredFrames = new WeakMap<SVGSVGElement, string>();

/** Trim only unused outer SVG canvas; never reposition authored nodes. */
export function fitVisualCanvases(root: HTMLElement): void {
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
      svg.setAttribute("viewBox", `${x} ${y} ${right - x} ${bottom - y}`);
      svg.style.display = "block";
      svg.style.width = "100%";
      svg.style.maxWidth = `${right - x}px`;
      svg.style.minWidth = `${Math.min(right - x, 520)}px`;
      svg.style.height = "auto";
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
