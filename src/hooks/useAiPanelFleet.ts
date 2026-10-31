import { useCallback, useReducer, useRef } from "react";
import type { Conversation } from "../components/ai/types";
import type { PendingAiPanel } from "../components/ai/panelHost";
import type { AgentAttachment, ProviderId } from "../agent/types";
import type { PanelRect } from "../panelLayout";

export type RaceWatchTab = {
  panelId: string;
  label: string;
  /** Harness run id — the column head asks it whether the run is still live. */
  runId: string;
  /** The racer's provider — the column head wears its logo, not a letter. */
  provider: ProviderId;
};
export type RaceFollowUp = { text: string; nonce: number };

/** A composed first turn parked for a panel that was just repointed at an
 *  isolated worktree — consumed once the remounted Conversation session is
 *  ready to send it. */
export type IsolatedRunStart = { text: string; attachments: AgentAttachment[] };

export type AiPanelFleetState = {
  pendingByPanel: Record<string, PendingAiPanel>;
  resumeTarget: { panelId: string; convo: Conversation } | null;
  raceWatchTabs: RaceWatchTab[];
  focusActiveTabId: string | null;
  followUpsByPanel: Record<string, RaceFollowUp>;
  /** Text typed into a history reader's composer, parked until the panel has
   *  actually loaded the conversation being resumed. It cannot be handed over
   *  as a follow-up in the same pass: AiPanel declares its follow-up effect
   *  above its resume effect, so a same-render pair sends the turn into the
   *  outgoing conversation and then `loadConversation` overwrites it. Holding
   *  it here until `resume-consumed` makes "continue this one" mean it. */
  pendingContinuation: { panelId: string; text: string; nonce: number } | null;
  /** Per-panel settings, keyed by panel id like every queue above. They live
   *  in the fleet so `release` clears them with everything else — a closed
   *  panel must leave no map entry behind. */
  modelsByPanel: Record<string, string[]>;
  reviewOverrideByPanel: Record<string, boolean>;
  /** The full-auto rung's command half. Deliberately in-memory with no global
   *  default: silencing the command gate is opted into per conversation and
   *  reverts to prompting on reload. */
  commandsOverrideByPanel: Record<string, boolean>;
  isolatedStartByPanel: Record<string, IsolatedRunStart>;
  /** How many times a panel has been reseated — reused by a one-slot surface
   *  for a new admission. It is the remount lever: `conversationSessionKey`
   *  folds it into the React key so a reused panel picks up mount-time
   *  handoff props instead of keeping the thread it already held. */
  seatByPanel: Record<string, number>;
};

export const initialAiPanelFleetState: AiPanelFleetState = {
  pendingByPanel: {},
  resumeTarget: null,
  raceWatchTabs: [],
  focusActiveTabId: null,
  followUpsByPanel: {},
  pendingContinuation: null,
  modelsByPanel: {},
  reviewOverrideByPanel: {},
  commandsOverrideByPanel: {},
  isolatedStartByPanel: {},
  seatByPanel: {},
};

export type AiPanelFleetAction =
  | { type: "handoffs-queued"; handoffs: PendingAiPanel[] }
  | { type: "handoff-consumed"; panelId: string }
  | {
      type: "resume-targeted";
      panelId: string;
      convo: Conversation;
      continueWith?: { text: string; nonce: number };
    }
  | { type: "resume-consumed"; panelId: string }
  | {
      type: "race-watch-started";
      handoffs: PendingAiPanel[];
      tabs: RaceWatchTab[];
      focusActiveTabId: string | null;
    }
  | { type: "race-tab-selected"; panelId: string | null }
  | { type: "race-follow-up-queued"; text: string; nonce: number }
  | { type: "follow-up-consumed"; panelId: string }
  | { type: "panel-closed"; panelId: string }
  | { type: "race-watch-cleared" }
  | { type: "panel-models-reported"; panelId: string; models: string[] }
  | { type: "review-override-set"; panelId: string; required: boolean }
  | { type: "commands-override-set"; panelId: string; enabled: boolean }
  | { type: "isolated-start-queued"; panelId: string; start: IsolatedRunStart }
  | { type: "isolated-start-consumed"; panelId: string }
  | { type: "seat-bumped"; panelId: string };

function indexHandoffs(
  current: Record<string, PendingAiPanel>,
  handoffs: PendingAiPanel[],
): Record<string, PendingAiPanel> {
  if (handoffs.length === 0) return current;
  const next = { ...current };
  for (const handoff of handoffs) next[handoff.panelId] = handoff;
  return next;
}

function omitPanel<T>(record: Record<string, T>, panelId: string): Record<string, T> {
  if (!(panelId in record)) return record;
  const { [panelId]: _removed, ...rest } = record;
  return rest;
}

/** Atomic state transitions for the multi-panel host. A close or consume event
 * updates every related queue in one pass, so handoffs, resume targets, race
 * tabs, follow-ups, and per-panel settings cannot drift into mutually
 * inconsistent states. */
export function aiPanelFleetReducer(
  state: AiPanelFleetState,
  action: AiPanelFleetAction,
): AiPanelFleetState {
  switch (action.type) {
    case "handoffs-queued":
      return {
        ...state,
        pendingByPanel: indexHandoffs(state.pendingByPanel, action.handoffs),
      };
    case "handoff-consumed":
      return {
        ...state,
        pendingByPanel: omitPanel(state.pendingByPanel, action.panelId),
      };
    case "resume-targeted":
      return {
        ...state,
        resumeTarget: { panelId: action.panelId, convo: action.convo },
        pendingContinuation: action.continueWith
          ? {
              panelId: action.panelId,
              text: action.continueWith.text,
              nonce: action.continueWith.nonce,
            }
          : null,
      };
    case "resume-consumed": {
      if (state.resumeTarget?.panelId !== action.panelId) return state;
      // The panel has the conversation now, so a parked continuation is safe
      // to release into the normal follow-up path.
      const continuation =
        state.pendingContinuation?.panelId === action.panelId
          ? state.pendingContinuation
          : null;
      return {
        ...state,
        resumeTarget: null,
        pendingContinuation: continuation ? null : state.pendingContinuation,
        followUpsByPanel: continuation
          ? {
              ...state.followUpsByPanel,
              [action.panelId]: { text: continuation.text, nonce: continuation.nonce },
            }
          : state.followUpsByPanel,
      };
    }
    case "race-watch-started":
      return {
        ...state,
        pendingByPanel: indexHandoffs(state.pendingByPanel, action.handoffs),
        raceWatchTabs: action.tabs,
        focusActiveTabId: action.focusActiveTabId,
        followUpsByPanel: {},
      };
    case "race-tab-selected":
      return { ...state, focusActiveTabId: action.panelId };
    case "race-follow-up-queued": {
      const text = action.text.trim();
      if (!text || state.raceWatchTabs.length === 0) return state;
      return {
        ...state,
        followUpsByPanel: Object.fromEntries(
          state.raceWatchTabs.map((tab) => [
            tab.panelId,
            { text, nonce: action.nonce },
          ]),
        ),
      };
    }
    case "follow-up-consumed":
      return {
        ...state,
        followUpsByPanel: omitPanel(state.followUpsByPanel, action.panelId),
      };
    case "panel-closed": {
      const tabs = state.raceWatchTabs.filter((tab) => tab.panelId !== action.panelId);
      const active =
        state.focusActiveTabId === action.panelId
          ? tabs[0]?.panelId ?? null
          : state.focusActiveTabId;
      return {
        ...state,
        pendingByPanel: omitPanel(state.pendingByPanel, action.panelId),
        resumeTarget:
          state.resumeTarget?.panelId === action.panelId ? null : state.resumeTarget,
        pendingContinuation:
          state.pendingContinuation?.panelId === action.panelId
            ? null
            : state.pendingContinuation,
        raceWatchTabs: tabs,
        focusActiveTabId: active,
        followUpsByPanel: omitPanel(state.followUpsByPanel, action.panelId),
        modelsByPanel: omitPanel(state.modelsByPanel, action.panelId),
        reviewOverrideByPanel: omitPanel(state.reviewOverrideByPanel, action.panelId),
        commandsOverrideByPanel: omitPanel(state.commandsOverrideByPanel, action.panelId),
        isolatedStartByPanel: omitPanel(state.isolatedStartByPanel, action.panelId),
        seatByPanel: omitPanel(state.seatByPanel, action.panelId),
      };
    }
    case "race-watch-cleared":
      return {
        ...state,
        raceWatchTabs: [],
        focusActiveTabId: null,
        followUpsByPanel: {},
      };
    case "panel-models-reported": {
      const current = state.modelsByPanel[action.panelId] ?? [];
      if (
        current.length === action.models.length &&
        current.every((name, idx) => name === action.models[idx])
      ) {
        return state;
      }
      return {
        ...state,
        modelsByPanel: { ...state.modelsByPanel, [action.panelId]: action.models },
      };
    }
    case "review-override-set":
      return {
        ...state,
        reviewOverrideByPanel: {
          ...state.reviewOverrideByPanel,
          [action.panelId]: action.required,
        },
      };
    case "commands-override-set":
      return {
        ...state,
        commandsOverrideByPanel: {
          ...state.commandsOverrideByPanel,
          [action.panelId]: action.enabled,
        },
      };
    case "isolated-start-queued":
      return {
        ...state,
        isolatedStartByPanel: {
          ...state.isolatedStartByPanel,
          [action.panelId]: action.start,
        },
      };
    case "seat-bumped":
      return {
        ...state,
        seatByPanel: {
          ...state.seatByPanel,
          [action.panelId]: (state.seatByPanel[action.panelId] ?? 0) + 1,
        },
      };
    case "isolated-start-consumed":
      return {
        ...state,
        isolatedStartByPanel: omitPanel(state.isolatedStartByPanel, action.panelId),
      };
  }
}

// ── Admission ──────────────────────────────────────────────────────────

/** Seed handed to the layout module when the fleet admits a new panel. The
 *  layout owns the rect it gets (cascade or the explicit race split). */
export type PanelSeed = {
  provider?: ProviderId;
  model?: string;
  cwd?: string;
  rect?: PanelRect;
};

/** One racer of a race-watch admission. `rect` is computed by the caller —
 *  panel geometry is layout business, the fleet only passes it through. */
export type RaceAdmitMember = {
  runId: string;
  provider: ProviderId;
  model?: string;
  cwd?: string;
  label: string;
  rect?: PanelRect;
};

/** Why a Conversation session is being admitted into the fleet. One verb for
 *  the rituals App used to hand-repeat per call site:
 *  - `resume-run`    — resume an on-disk Klide run as a panel conversation.
 *  - `fork`          — open a forked/branched Conversation (the convo carries
 *                      its provider, model, and worktree pin).
 *  - `focus-resume`  — continue a Run's conversation on the Focus canvas,
 *                      wherever the user currently is. A delegate CLI's own
 *                      `/resume`, answered chat-first: the transcript comes
 *                      across and the next turn runs the same CLI headless.
 *  - `handoff`       — Mission Control "Open in {CLI}" / "Resume in {CLI}".
 *  - `reattach`      — bind a panel to a live delegate PTY's conversation.
 *  - `race-watch`    — one panel per racer plus the race tab strip.
 *  - `fresh`         — a brand-new empty session (duplicate panel, open or
 *                      create a worktree pinned panel). */
export type AdmitIntent =
  | { kind: "resume-run"; runId: string; convo: Conversation }
  | { kind: "fork"; convo: Conversation }
  | { kind: "focus-resume"; convo: Conversation }
  | {
      kind: "handoff";
      provider: ProviderId;
      resumeSessionId?: string | null;
      initialTask?: string | null;
      cwd?: string;
    }
  | {
      kind: "reattach";
      provider: ProviderId;
      conversationId: string;
      resumeSessionId?: string | null;
      cwd?: string;
    }
  | { kind: "race-watch"; racers: RaceAdmitMember[]; focusActive: boolean }
  | { kind: "fresh"; provider?: ProviderId; model?: string; cwd?: string };

/** What the fleet needs from its host. Panel geometry (create/remove with rect
 *  seeding and persistence) stays in the layout module; surface reveal (view
 *  switch + panel visibility) stays in App — both are injected so this hook
 *  never imports host state and stays a plain function under test. */
export type AiPanelFleetDeps = {
  /** Layout's appendAiPanel: create the panel record + rect, return its id. */
  createPanel: (seed?: PanelSeed) => string;
  /** The panel a single-session admission should land in, or `null` to open a
   *  new one. Three of the four AI surfaces render exactly one panel (Focus,
   *  the anchored column, a grid cell), so appending there opens a session
   *  nobody sees; the host answers with its slot instead. Free (floating)
   *  mode renders the whole fleet and answers `null`. */
  slotForAdmission: (intent: AdmitIntent) => string | null;
  /** Point an existing panel at what this admission needs — the provider and
   *  worktree a fresh panel would have been seeded with. The displaced
   *  Conversation is not lost: it stays in the store and in the panel's
   *  history. */
  reseatPanel: (panelId: string, seed: PanelSeed) => void;
  /** Layout's closeAiPanel: drop the panel record + rect. */
  removePanel: (panelId: string) => void;
  focusPanel: (panelId: string) => void;
  /** Bring the AI surface on screen for this admission (setView + reveal the
   *  panel if hidden). Called for every admit, before de-dupe — matching the
   *  old rituals, which switched views even when focusing an existing panel.
   *  It takes the whole intent because the surface an admission needs is not
   *  a function of its kind alone: an interactive delegate session cannot be
   *  rendered in Focus (`admissionNeedsWorkbench`). */
  revealSurface: (intent: AdmitIntent) => void;
  /** Live panel ids, so a remembered identity → panel binding is validated
   *  before de-duping onto a panel that has since closed. */
  openPanelIds: () => string[];
  /** The panel whose persisted session is already bound to this conversation
   *  (the one that spawned the PTY, or an earlier reattach) — reattach must
   *  never open a second terminal onto the same live session. */
  panelBoundToConversation: (conversationId: string) => string | null;
};

/** The stable identity an intent carries, if any. The de-dupe rule is uniform:
 *  admitting an identity that is already open focuses its panel instead of
 *  stacking a duplicate. Intents that start something new (`fork`, `fresh`,
 *  each `race-watch` racer's first admission) have no identity to collide on. */
function admitIdentity(intent: AdmitIntent): string | null {
  switch (intent.kind) {
    case "resume-run":
      return `run:${intent.runId}`;
    case "handoff":
      return intent.resumeSessionId ? `cli:${intent.resumeSessionId}` : null;
    case "reattach":
      return `convo:${intent.conversationId}`;
    default:
      return null;
  }
}

export type FleetController = {
  admit: (intent: AdmitIntent) => string;
  release: (panelId: string) => void;
  endRaceWatch: () => void;
};

/** The membership verbs, factored out of the hook so they are testable without
 *  React: `dispatch` folds into the reducer, `getState` reads the fold back,
 *  and every host effect goes through `deps`. */
export function createFleetController(
  deps: AiPanelFleetDeps,
  dispatch: (action: AiPanelFleetAction) => void,
  getState: () => AiPanelFleetState,
): FleetController {
  // identity → panelId. Session-only: after a reload nothing is admitted yet.
  const registry = new Map<string, string>();

  /** The panel this admission lands in. A one-slot surface hands back the
   *  panel it is already rendering, so the session appears where the user is
   *  looking instead of in a panel that surface will never draw; anything
   *  else opens a fresh one. `reseat` is what the reused panel is repointed
   *  at when that differs from a new panel's seed — a resumed Conversation
   *  carries its own provider and model and pushes them up on load, so
   *  writing them here too would race it.
   *
   *  A reused seat also drops every identity that pointed at it: the panel no
   *  longer holds that run, and de-duping a later click onto it would focus a
   *  panel showing something else entirely. */
  const takeSeat = (
    intent: AdmitIntent,
    seed: PanelSeed,
    reseat: PanelSeed = seed,
  ): { panelId: string; reused: boolean } => {
    const slot = deps.slotForAdmission(intent);
    if (!slot) return { panelId: deps.createPanel(seed), reused: false };
    for (const [identity, id] of registry) {
      if (id === slot) registry.delete(identity);
    }
    deps.reseatPanel(slot, reseat);
    return { panelId: slot, reused: true };
  };

  const admit = (intent: AdmitIntent): string => {
    deps.revealSurface(intent);
    const identity = admitIdentity(intent);
    if (identity) {
      const existing = registry.get(identity);
      if (existing) {
        if (deps.openPanelIds().includes(existing)) {
          deps.focusPanel(existing);
          return existing;
        }
        registry.delete(identity);
      }
    }
    if (intent.kind === "reattach") {
      // The spawning panel predates the fleet's registry — ask the persisted
      // panel sessions too. Two surfaces sharing one PTY would mirror each
      // other (the "two synchronized terminals" bug).
      const bound = deps.panelBoundToConversation(intent.conversationId);
      if (bound) {
        registry.set(`convo:${intent.conversationId}`, bound);
        deps.focusPanel(bound);
        return bound;
      }
    }
    switch (intent.kind) {
      case "resume-run": {
        const { panelId } = takeSeat(intent, { cwd: intent.convo.cwd ?? undefined });
        registry.set(`run:${intent.runId}`, panelId);
        dispatch({ type: "resume-targeted", panelId, convo: intent.convo });
        return panelId;
      }
      case "focus-resume":
      case "fork": {
        const { panelId } = takeSeat(
          intent,
          {
            provider: intent.convo.provider,
            model: intent.convo.model ?? undefined,
            cwd: intent.convo.cwd ?? undefined,
          },
          // The forked Conversation configures the panel itself as it loads;
          // only its worktree pin has to be applied ahead of that.
          { cwd: intent.convo.cwd ?? undefined },
        );
        dispatch({ type: "resume-targeted", panelId, convo: intent.convo });
        return panelId;
      }
      case "handoff": {
        const { panelId, reused } = takeSeat(intent, {
          provider: intent.provider,
          cwd: intent.cwd,
        });
        // A handoff is delivered through mount-time props, so a reused panel
        // has to remount to receive it.
        if (reused) dispatch({ type: "seat-bumped", panelId });
        if (identity) registry.set(identity, panelId);
        dispatch({
          type: "handoffs-queued",
          handoffs: [{
            panelId,
            provider: intent.provider,
            resumeSessionId: intent.resumeSessionId ?? null,
            initialTask: intent.initialTask ?? null,
            conversationId: null,
          }],
        });
        return panelId;
      }
      case "reattach": {
        const { panelId, reused } = takeSeat(intent, {
          provider: intent.provider,
          cwd: intent.cwd,
        });
        if (reused) dispatch({ type: "seat-bumped", panelId });
        registry.set(`convo:${intent.conversationId}`, panelId);
        dispatch({
          type: "handoffs-queued",
          handoffs: [{
            panelId,
            provider: intent.provider,
            resumeSessionId: intent.resumeSessionId ?? null,
            initialTask: null,
            conversationId: intent.conversationId,
          }],
        });
        return panelId;
      }
      case "race-watch": {
        const handoffs: PendingAiPanel[] = [];
        const tabs: RaceWatchTab[] = [];
        for (const racer of intent.racers) {
          const panelId = deps.createPanel({
            provider: racer.provider,
            model: racer.model,
            cwd: racer.cwd,
            rect: racer.rect,
          });
          // A racer's run resumes into its race panel, not a duplicate.
          registry.set(`run:${racer.runId}`, panelId);
          handoffs.push({
            panelId,
            provider: racer.provider,
            resumeSessionId: null,
            initialTask: null,
            conversationId: racer.runId,
          });
          tabs.push({
            panelId,
            label: racer.label,
            runId: racer.runId,
            provider: racer.provider,
          });
        }
        dispatch({
          type: "race-watch-started",
          handoffs,
          tabs,
          focusActiveTabId: intent.focusActive ? tabs[0]?.panelId ?? null : null,
        });
        return tabs[0]?.panelId ?? "";
      }
      case "fresh": {
        // On a one-slot surface the panel on screen is repointed rather than
        // a hidden one appended; the seat bump remounts it, so its session
        // restores for the new folder (a new worktree starts a new thread).
        const { panelId, reused } = takeSeat(intent, {
          provider: intent.provider,
          model: intent.model,
          cwd: intent.cwd,
        });
        if (reused) dispatch({ type: "seat-bumped", panelId });
        return panelId;
      }
    }
  };

  /** One verb for "this panel is gone": membership (layout record), every
   *  queue keyed by the panel id, its settings maps, and its identity
   *  registrations all clear together — so closing a panel can never strand a
   *  pending handoff (the endFocusRaceWatch leak). */
  const release = (panelId: string) => {
    deps.removePanel(panelId);
    for (const [identity, id] of registry) {
      if (id === panelId) registry.delete(identity);
    }
    dispatch({ type: "panel-closed", panelId });
  };

  /** Leave a race-tab view: release every watched racer's panel (the runs keep
   *  going headless in Rust) and clear the tab strip. */
  const endRaceWatch = () => {
    const tabs = getState().raceWatchTabs;
    if (tabs.length === 0) return;
    for (const tab of tabs) release(tab.panelId);
    dispatch({ type: "race-watch-cleared" });
  };

  return { admit, release, endRaceWatch };
}

export function useAiPanelFleet(deps: AiPanelFleetDeps) {
  const [state, dispatch] = useReducer(aiPanelFleetReducer, initialAiPanelFleetState);

  // The controller is created once; deps and state are read through refs so
  // its verbs always see the current render's closures and the latest fold.
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const stateRef = useRef(state);
  stateRef.current = state;
  const controllerRef = useRef<FleetController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createFleetController(
      {
        createPanel: (seed) => depsRef.current.createPanel(seed),
        slotForAdmission: (intent) => depsRef.current.slotForAdmission(intent),
        reseatPanel: (panelId, seed) => depsRef.current.reseatPanel(panelId, seed),
        removePanel: (panelId) => depsRef.current.removePanel(panelId),
        focusPanel: (panelId) => depsRef.current.focusPanel(panelId),
        revealSurface: (intent) => depsRef.current.revealSurface(intent),
        openPanelIds: () => depsRef.current.openPanelIds(),
        panelBoundToConversation: (conversationId) =>
          depsRef.current.panelBoundToConversation(conversationId),
      },
      dispatch,
      () => stateRef.current,
    );
  }
  const controller = controllerRef.current;

  const admit = useCallback((intent: AdmitIntent) => controller.admit(intent), [controller]);
  const release = useCallback((panelId: string) => controller.release(panelId), [controller]);
  const endRaceWatch = useCallback(() => controller.endRaceWatch(), [controller]);

  return {
    ...state,
    admit,
    release,
    endRaceWatch,
    pendingForPanel: (panelId: string) => state.pendingByPanel[panelId] ?? null,
    /** How many times this panel has been reused for another admission — the
     *  host folds it into the panel's React key. */
    seatFor: (panelId: string) => state.seatByPanel[panelId] ?? 0,
    consumeHandoff: (panelId: string) =>
      dispatch({ type: "handoff-consumed", panelId }),
    /** `continueWith` carries the history reader's composed text: the panel
     *  resumes the conversation first, then the turn is sent into it. */
    targetResume: (panelId: string, convo: Conversation, continueWith?: string) => {
      const text = continueWith?.trim();
      dispatch({
        type: "resume-targeted",
        panelId,
        convo,
        continueWith: text ? { text, nonce: Date.now() } : undefined,
      });
    },
    consumeResume: (panelId: string) =>
      dispatch({ type: "resume-consumed", panelId }),
    selectRaceTab: (panelId: string | null) =>
      dispatch({ type: "race-tab-selected", panelId }),
    queueRaceFollowUp: (text: string) =>
      dispatch({ type: "race-follow-up-queued", text, nonce: Date.now() }),
    consumeFollowUp: (panelId: string) =>
      dispatch({ type: "follow-up-consumed", panelId }),
    clearRaceWatch: () => dispatch({ type: "race-watch-cleared" }),
    reportPanelModels: (panelId: string, models: string[]) =>
      dispatch({ type: "panel-models-reported", panelId, models }),
    setPanelReviewOverride: (panelId: string, required: boolean) =>
      dispatch({ type: "review-override-set", panelId, required }),
    setPanelCommandsOverride: (panelId: string, enabled: boolean) =>
      dispatch({ type: "commands-override-set", panelId, enabled }),
    queueIsolatedStart: (panelId: string, start: IsolatedRunStart) =>
      dispatch({ type: "isolated-start-queued", panelId, start }),
    consumeIsolatedStart: (panelId: string) =>
      dispatch({ type: "isolated-start-consumed", panelId }),
  };
}
