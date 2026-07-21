import { describe, expect, it } from "vitest";
import type { Conversation } from "../components/ai/types";
import type { PendingAiPanel } from "../components/ai/panelHost";
import {
  aiPanelFleetReducer,
  initialAiPanelFleetState,
  type AiPanelFleetState,
} from "./useAiPanelFleet";

const convo = (id: string): Conversation => ({
  id,
  title: id,
  msgs: [],
  updatedAt: 1,
});

const handoff = (panelId: string): PendingAiPanel => ({
  panelId,
  provider: "codex",
  resumeSessionId: null,
  initialTask: null,
  conversationId: null,
});

function reduce(state: AiPanelFleetState, action: Parameters<typeof aiPanelFleetReducer>[1]) {
  return aiPanelFleetReducer(state, action);
}

describe("AI panel fleet reducer", () => {
  it("merges simultaneous handoffs instead of clobbering an unconsumed panel", () => {
    const first = reduce(initialAiPanelFleetState, {
      type: "handoffs-queued",
      handoffs: [handoff("ai-1")],
    });
    const second = reduce(first, {
      type: "handoffs-queued",
      handoffs: [handoff("ai-2")],
    });

    expect(Object.keys(second.pendingByPanel)).toEqual(["ai-1", "ai-2"]);
  });

  it("only lets the targeted panel consume a resume", () => {
    const targeted = reduce(initialAiPanelFleetState, {
      type: "resume-targeted",
      panelId: "ai-2",
      convo: convo("run-1"),
    });

    expect(
      reduce(targeted, { type: "resume-consumed", panelId: "ai-1" }).resumeTarget,
    ).not.toBeNull();
    expect(
      reduce(targeted, { type: "resume-consumed", panelId: "ai-2" }).resumeTarget,
    ).toBeNull();
  });

  it("fans one follow-up out to every watched racer", () => {
    const watching = reduce(initialAiPanelFleetState, {
      type: "race-watch-started",
      handoffs: [handoff("ai-a"), handoff("ai-b")],
      tabs: [
        { panelId: "ai-a", label: "A" },
        { panelId: "ai-b", label: "B" },
      ],
      focusActiveTabId: "ai-a",
    });
    const queued = reduce(watching, {
      type: "race-follow-up-queued",
      text: "  compare tests  ",
      nonce: 42,
    });

    expect(queued.followUpsByPanel).toEqual({
      "ai-a": { text: "compare tests", nonce: 42 },
      "ai-b": { text: "compare tests", nonce: 42 },
    });
  });

  it("closes every queue for a panel and advances the active race tab atomically", () => {
    const state: AiPanelFleetState = {
      pendingByPanel: { "ai-a": handoff("ai-a"), "ai-b": handoff("ai-b") },
      resumeTarget: { panelId: "ai-a", convo: convo("run-1") },
      raceWatchTabs: [
        { panelId: "ai-a", label: "A" },
        { panelId: "ai-b", label: "B" },
      ],
      focusActiveTabId: "ai-a",
      followUpsByPanel: {
        "ai-a": { text: "test", nonce: 1 },
        "ai-b": { text: "test", nonce: 1 },
      },
    };

    const closed = reduce(state, { type: "panel-closed", panelId: "ai-a" });

    expect(closed.pendingByPanel["ai-a"]).toBeUndefined();
    expect(closed.resumeTarget).toBeNull();
    expect(closed.raceWatchTabs).toEqual([{ panelId: "ai-b", label: "B" }]);
    expect(closed.focusActiveTabId).toBe("ai-b");
    expect(closed.followUpsByPanel["ai-a"]).toBeUndefined();
  });
});
