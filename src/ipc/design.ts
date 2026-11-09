// Typed frontend Adapter for the `design_canvas_*` command family — the
// loopback proxy that puts a project's own dev server on Design mode's canvas
// with the element picker injected (src-tauri/src/design_canvas.rs).

import { invoke } from "@tauri-apps/api/core";

export type DesignCanvas = {
  /** The page to load in the canvas iframe, through the proxy. */
  url: string;
  /** Carried by every message the injected picker posts. */
  token: string;
  /** The proxy's origin; messages from any other origin are ignored. */
  origin: string;
};

/** Put `url` (a dev server on this machine) on the canvas. */
export const openDesignCanvas = (url: string) => invoke<DesignCanvas>("design_canvas_open", { url });

/** Stop the canvas proxy. */
export const closeDesignCanvas = () => invoke<void>("design_canvas_close");

/** Dev-server addresses answering on the usual ports right now. */
export const designCanvasCandidates = () => invoke<string[]>("design_canvas_candidates");
