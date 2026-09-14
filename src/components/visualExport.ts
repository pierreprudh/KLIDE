import { invoke, isTauri } from "@tauri-apps/api/core";

export async function renderVisualPng(node: HTMLElement): Promise<string> {
  await document.fonts.ready;
  const { toPng } = await import("html-to-image");
  const width = Math.ceil(node.scrollWidth);
  const height = Math.ceil(node.scrollHeight);
  if (!width || !height || width * height > 16_000_000) throw new Error("This visual is too large to export.");
  // The export library deep-clones SVGs without resolving descendant styles.
  // Freeze their computed paint/type in an offscreen copy, never in the live figure.
  const snapshot = node.cloneNode(true) as HTMLElement;
  const originals = [node, ...node.querySelectorAll<HTMLElement | SVGElement>("*")];
  const copies = [snapshot, ...snapshot.querySelectorAll<HTMLElement | SVGElement>("*")];
  originals.forEach((original, index) => {
    const target = copies[index];
    if (!target.style) return;
    const computed = getComputedStyle(original);
    for (const property of Array.from(computed)) {
      target.style.setProperty(property, computed.getPropertyValue(property));
    }
  });
  snapshot.setAttribute("aria-hidden", "true");
  snapshot.inert = true;
  Object.assign(snapshot.style, { position: "fixed", left: "-100000px", top: "0", width: `${width}px`, height: `${height}px`, overflow: "visible", contain: "none" });
  document.body.appendChild(snapshot);
  try {
    return await toPng(snapshot, {
      width, height, pixelRatio: 2,
      backgroundColor: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#ffffff",
      style: { position: "static", left: "auto", top: "auto", overflow: "visible", contain: "none" },
    });
  } finally {
    snapshot.remove();
  }
}

export async function saveVisualPng(node: HTMLElement): Promise<void> {
  const dataUrl = await renderVisualPng(node);
  if (isTauri()) {
    await invoke("save_visual_png", { content: dataUrl.slice(dataUrl.indexOf(",") + 1) });
  } else {
    const link = document.createElement("a");
    link.download = "visual.png";
    link.href = dataUrl;
    link.click();
  }
}
