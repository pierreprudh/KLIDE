// The AiPanel host seam — the pure half of the App↔AiPanel contract.
//
// Four surfaces render an AI panel (the anchored column, free-floating
// windows, grid cells, and Focus). Before this module each site re-derived
// the same policy by hand — which panel a pending Mission Control handoff
// targets, which panel adopts a resumed conversation, which workspace root a
// worktree-pinned panel runs in — so a change meant editing three or four
// prop lists and hoping they stayed consistent. The policy now lives here,
// and `App.renderAiPanel` is the one place that turns it into props.
import type { ReactNode } from "react";
import type { ProviderId } from "../../agent/types";
import type { AiPanelInstance } from "../../hooks/usePanelLayout";

/** The id of the first/default AI panel slot. Everything that addresses "the"
 *  AI panel when none has been explicitly created keys off this. */
export const DEFAULT_AI_PANEL_ID = "ai-main";

/** A queued Mission Control → AI panel handoff: open panel `panelId` pinned to
 *  `provider`, optionally resuming an on-disk session or reattaching to a live
 *  conversation. The host queues one per spawned panel (a race "watch live"
 *  spawns several in one tick); each is consumed by its panel on mount. */
export type PendingAiPanel = {
  panelId: string;
  provider: ProviderId;
  resumeSessionId: string | null;
  initialTask: string | null;
  /** Set only for "Reattach" to a live session — binds the new panel to the
   *  running PTY's conversation id so its terminal reconnects + replays. */
  conversationId: string | null;
};

/** The initial* prop bundle one panel receives on mount. `matched` is true
 *  when the pending handoff targets this panel (the host wires
 *  `onInitialConsumed` only then, so an unrelated panel can never clear it). */
export type PanelHandoff = {
  matched: boolean;
  initialProvider: ProviderId | undefined;
  initialConversationId: string | undefined;
  initialResumeSessionId: string | undefined;
  initialTask: string | undefined;
};

/** Resolve which initial* props a panel gets: the pending handoff applies only
 *  to the panel it targets; every other panel starts on its own provider. */
export function initialHandoffFor(
  panelId: string,
  panelProvider: ProviderId | undefined,
  pending: PendingAiPanel | null
): PanelHandoff {
  if (!pending || pending.panelId !== panelId) {
    return {
      matched: false,
      initialProvider: panelProvider,
      initialConversationId: undefined,
      initialResumeSessionId: undefined,
      initialTask: undefined,
    };
  }
  return {
    matched: true,
    initialProvider: pending.provider,
    initialConversationId: pending.conversationId ?? undefined,
    initialResumeSessionId: pending.resumeSessionId ?? undefined,
    initialTask: pending.initialTask ?? undefined,
  };
}

/** A resumed conversation is targeted at one panel by id — only that panel
 *  adopts it. Without the keying every mounted panel would receive the same
 *  conversation in one render and a resume click would clobber all of them. */
export function resumeConversationFor<C>(
  panelId: string,
  target: { panelId: string; convo: C } | null
): C | null {
  return target !== null && target.panelId === panelId ? target.convo : null;
}

/** Where a panel's runs live. A worktree-pinned panel (floating surfaces only)
 *  works its own checkout and shows the worktree name under the composer;
 *  anchored/grid surfaces always run in the main workspace. */
export function panelWorkspace(
  panel: Pick<AiPanelInstance, "cwd"> | undefined,
  workspaceRoot: string | null,
  respectWorktree: boolean
): { root: string | null; worktreeName: string | undefined } {
  const cwd = respectWorktree ? panel?.cwd : undefined;
  return {
    root: cwd ?? workspaceRoot,
    worktreeName: cwd ? cwd.split("/").filter(Boolean).pop() : undefined,
  };
}

/** Per-surface knobs for `App.renderAiPanel`. Everything else about the panel
 *  — handoff keying, resume targeting, model/provider/review policy, memory +
 *  skill notices — is derived inside the host and not configurable per site. */
export type AiPanelRenderOptions = {
  key?: string;
  /** Rendered width; defaults to the panel rect (or 360). */
  width?: number;
  /** "focus" restyles the surface for the fullscreen Focus screen. */
  variant?: "focus";
  /** Focus hero composer hands its first message through this. */
  initialMessage?: string | null;
  /** Honour a per-panel worktree cwd (free-floating surfaces only). */
  respectWorktree?: boolean;
  /** Show the close action (surfaces with more than one panel). */
  closable?: boolean;
  /** Offer the "duplicate panel" affordance. */
  duplicatable?: boolean;
};

/** The render-prop shape surfaces receive instead of ~25 threaded AiPanel
 *  props: give me the panel (or undefined for the default slot) and the
 *  surface knobs, get the fully wired element back. */
export type RenderAiPanel = (
  panel: AiPanelInstance | undefined,
  opts?: AiPanelRenderOptions
) => ReactNode;
