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
import type { AgentAttachment, AgentMode, ProviderId } from "../../agent/types";
import type { AiPanelInstance } from "../../hooks/usePanelLayout";
import { isDelegateProvider } from "../../agent/providers";
import { normalizeProjectPath } from "../../projectPaths";

/** The id of the first/default AI panel slot. Everything that addresses "the"
 *  AI panel when none has been explicitly created keys off this. */
export const DEFAULT_AI_PANEL_ID = "ai-main";

/** React identity for one rendered Conversation session. A panel keeps its
 * state while moving between surfaces in the same Workspace, but changing the
 * effective Workspace remounts it so messages and Run identity cannot migrate
 * into another checkout.
 *
 * `seat` is the second reason to remount: a surface with one AI slot reuses
 * its panel for the next admission (see `surfaceShowsOneAiPanel`), and a
 * handoff arrives through mount-time props — `initialConversationId` is read
 * by the Conversation session's initializer and nowhere else. Bumping the
 * seat is how the reused panel picks the handoff up instead of silently
 * keeping the identity of the thread it was already holding. Seat 0 is
 * spelled the old way so a panel nobody reseated never remounts. */
export function conversationSessionKey(
  panelId: string,
  workspaceRoot: string | null,
  surfaceKey?: string,
  seat?: number,
): string {
  const base = `${surfaceKey ?? panelId}::${workspaceRoot ?? "no-workspace"}`;
  return seat ? `${base}::seat-${seat}` : base;
}

/** The four things that can render an AI panel. Three of them show exactly
 *  one — Focus renders the centered conversation, the anchored column has a
 *  single AI slot, a grid cell holds one panel — and only free (floating)
 *  mode renders the whole fleet. */
export type AiSurface = "focus" | "anchored" | "grid" | "free";

/** Whether this surface renders one AI panel or all of them. An admission
 *  that appends a panel to a one-slot surface opens a session nobody can
 *  see: it spawns, streams, and stays invisible until the layout changes. */
export function surfaceShowsOneAiPanel(surface: AiSurface): boolean {
  return surface !== "free";
}

/** Whether an admission has to land on the workbench rather than in Focus.
 *  An interactive delegate session — the CLI's own terminal, resumed or
 *  reattached — is a workbench surface by construction: Focus runs the same
 *  delegate one-shot and headless (`delegate/chat.rs`) and renders its answer
 *  as an ordinary Klide message, so `AiPanel` deliberately withholds the
 *  terminal there. Landing such an admission in Focus is the "nothing
 *  happened" bug; it has to move. */
export function admissionNeedsWorkbench(intent: {
  kind: string;
  provider?: ProviderId;
}): boolean {
  if (intent.kind !== "handoff" && intent.kind !== "reattach") return false;
  return !!intent.provider && isDelegateProvider(intent.provider);
}

/** The base an admission asks for. Focus is usually just where the user
 *  happens to be, but "Continue in Focus" names it: the admission carries the
 *  surface with it and switches to it from anywhere. */
export function admissionBase(kind: string, base: AiSurface): AiSurface {
  return kind === "focus-resume" ? "focus" : base;
}

/** The surface an admission will actually be rendered on, after any forced
 *  move off Focus. The slot decision reads this, not the current base: a
 *  delegate resume started from Focus lands on the workbench, and it is the
 *  workbench's slot count that decides whether it reuses a panel. */
export function admissionSurface(
  needsWorkbench: boolean,
  base: AiSurface,
  workbench: "anchored" | "free",
): AiSurface {
  return needsWorkbench && base === "focus" ? workbench : base;
}

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
  /** Start this panel on a new Conversation identity rather than restoring
   *  what it last held. A handoff names a Provider and no conversation, so
   *  the thread it opens is new by definition — which a brand-new panel got
   *  for free (nothing bound to restore) and a *reused* one would not: its
   *  durable binding outranks a requested Provider, so the CLI session would
   *  arrive and the panel would go on showing the chat it already had. A
   *  reattach is the opposite and names its conversation. */
  initialStartFresh: boolean;
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
      initialStartFresh: false,
    };
  }
  return {
    matched: true,
    initialProvider: pending.provider,
    initialConversationId: pending.conversationId ?? undefined,
    initialResumeSessionId: pending.resumeSessionId ?? undefined,
    initialTask: pending.initialTask ?? undefined,
    initialStartFresh: pending.conversationId === null,
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

/** Where a panel's runs live. A worktree pin follows the Conversation session
 *  across Focus, anchored, grid, and free surfaces; changing layout must never
 *  move an agent back into the main checkout. */
export function panelWorkspace(
  panel: Pick<AiPanelInstance, "cwd"> | undefined,
  workspaceRoot: string | null,
  respectWorktree: boolean
): { root: string | null; worktreeName: string | undefined } {
  const candidate = respectWorktree ? panel?.cwd : undefined;
  const cwd =
    candidate && normalizeProjectPath(candidate) !== normalizeProjectPath(workspaceRoot)
      ? candidate
      : undefined;
  return {
    root: cwd ?? workspaceRoot,
    worktreeName: cwd ? cwd.split("/").filter(Boolean).pop() : undefined,
  };
}

/** The single footer action changes meaning with the edit lifecycle: approve a
 * reviewed proposal while the run is paused, or finalize already-applied edits
 * once an auto-accept run settles. */
export function modificationAcceptanceMode(
  hasPendingDiff: boolean,
  changedFiles: number,
  streaming: boolean,
): "pending-diff" | "applied-run" | null {
  if (hasPendingDiff) return "pending-diff";
  if (changedFiles > 0 && !streaming) return "applied-run";
  return null;
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
  /** Photos/documents staged on that first message. They travel beside the
   *  text rather than inside it, so the first turn carries what was dropped
   *  on the start stage. */
  initialAttachments?: AgentAttachment[] | null;
  /** The mode a start-stage slash command pinned to that first turn; null
   *  lets the panel's own mode setting decide. */
  initialMode?: AgentMode | null;
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
