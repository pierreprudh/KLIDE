import { useCallback, useReducer, useRef } from "react";
import type { Conversation } from "../components/ai/types";
import type { PendingAiPanel } from "../components/ai/panelHost";

export type RaceWatchTab = { panelId: string; label: string };
export type RaceFollowUp = { text: string; nonce: number };

export type AiPanelFleetState = {
  pendingByPanel: Record<string, PendingAiPanel>;
  resumeTarget: { panelId: string; convo: Conversation } | null;
  raceWatchTabs: RaceWatchTab[];
  focusActiveTabId: string | null;
  followUpsByPanel: Record<string, RaceFollowUp>;
};

export const initialAiPanelFleetState: AiPanelFleetState = {
  pendingByPanel: {},
  resumeTarget: null,
  raceWatchTabs: [],
  focusActiveTabId: null,
  followUpsByPanel: {},
};

export type AiPanelFleetAction =
  | { type: "handoffs-queued"; handoffs: PendingAiPanel[] }
  | { type: "handoff-consumed"; panelId: string }
  | { type: "resume-targeted"; panelId: string; convo: Conversation }
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
  | { type: "race-watch-cleared" };

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
 * tabs, and follow-ups cannot drift into mutually inconsistent states. */
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
      };
    case "resume-consumed":
      return state.resumeTarget?.panelId === action.panelId
        ? { ...state, resumeTarget: null }
        : state;
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
        raceWatchTabs: tabs,
        focusActiveTabId: active,
        followUpsByPanel: omitPanel(state.followUpsByPanel, action.panelId),
      };
    }
    case "race-watch-cleared":
      return {
        ...state,
        raceWatchTabs: [],
        focusActiveTabId: null,
        followUpsByPanel: {},
      };
  }
}

export function useAiPanelFleet() {
  const [state, dispatch] = useReducer(aiPanelFleetReducer, initialAiPanelFleetState);
  const resumedPanelByRunRef = useRef<Map<string, string>>(new Map());

  const panelForResumedRun = useCallback((runId: string, openPanelIds: string[]) => {
    const panelId = resumedPanelByRunRef.current.get(runId);
    if (!panelId) return null;
    if (openPanelIds.includes(panelId)) return panelId;
    resumedPanelByRunRef.current.delete(runId);
    return null;
  }, []);

  return {
    ...state,
    pendingForPanel: (panelId: string) => state.pendingByPanel[panelId] ?? null,
    queueHandoffs: (handoffs: PendingAiPanel[]) =>
      dispatch({ type: "handoffs-queued", handoffs }),
    consumeHandoff: (panelId: string) =>
      dispatch({ type: "handoff-consumed", panelId }),
    targetResume: (panelId: string, convo: Conversation) =>
      dispatch({ type: "resume-targeted", panelId, convo }),
    consumeResume: (panelId: string) =>
      dispatch({ type: "resume-consumed", panelId }),
    registerResumedRun: (runId: string, panelId: string) =>
      resumedPanelByRunRef.current.set(runId, panelId),
    panelForResumedRun,
    startRaceWatch: (
      handoffs: PendingAiPanel[],
      tabs: RaceWatchTab[],
      focusActiveTabId: string | null,
    ) =>
      dispatch({
        type: "race-watch-started",
        handoffs,
        tabs,
        focusActiveTabId,
      }),
    selectRaceTab: (panelId: string | null) =>
      dispatch({ type: "race-tab-selected", panelId }),
    queueRaceFollowUp: (text: string) =>
      dispatch({ type: "race-follow-up-queued", text, nonce: Date.now() }),
    consumeFollowUp: (panelId: string) =>
      dispatch({ type: "follow-up-consumed", panelId }),
    closeFleetPanel: (panelId: string) =>
      dispatch({ type: "panel-closed", panelId }),
    clearRaceWatch: () => dispatch({ type: "race-watch-cleared" }),
  };
}
