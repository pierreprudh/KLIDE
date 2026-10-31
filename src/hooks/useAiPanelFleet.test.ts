import { describe, expect, it } from "vitest";
import type { Conversation } from "../components/ai/types";
import type { PendingAiPanel } from "../components/ai/panelHost";
import {
  aiPanelFleetReducer,
  createFleetController,
  initialAiPanelFleetState,
  type AdmitIntent,
  type AiPanelFleetAction,
  type AiPanelFleetState,
  type PanelSeed,
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

/** Several actions in order — the continuation cases are all about sequence. */
function reduceAll(
  state: AiPanelFleetState,
  ...actions: Parameters<typeof aiPanelFleetReducer>[1][]
): AiPanelFleetState {
  return actions.reduce(aiPanelFleetReducer, state);
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
        { panelId: "ai-a", label: "A", runId: "run-a", provider: "ollama" as const },
        { panelId: "ai-b", label: "B", runId: "run-b", provider: "anthropic" as const },
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

  it("keeps a panel's seat until it closes — only a reseat moves it", () => {
    const seated = reduceAll(
      initialAiPanelFleetState,
      { type: "seat-bumped", panelId: "ai-main" },
      { type: "isolated-start-consumed", panelId: "ai-main" },
      { type: "handoff-consumed", panelId: "ai-main" },
    );

    // A consumed queue entry must not rotate the React key back and remount
    // the panel that just adopted the session.
    expect(seated.seatByPanel["ai-main"]).toBe(1);
  });

  it("closes every queue for a panel and advances the active race tab atomically", () => {
    const state: AiPanelFleetState = {
      pendingByPanel: { "ai-a": handoff("ai-a"), "ai-b": handoff("ai-b") },
      resumeTarget: { panelId: "ai-a", convo: convo("run-1") },
      raceWatchTabs: [
        { panelId: "ai-a", label: "A", runId: "run-a", provider: "ollama" as const },
        { panelId: "ai-b", label: "B", runId: "run-b", provider: "anthropic" as const },
      ],
      focusActiveTabId: "ai-a",
      followUpsByPanel: {
        "ai-a": { text: "test", nonce: 1 },
        "ai-b": { text: "test", nonce: 1 },
      },
      pendingContinuation: null,
      modelsByPanel: { "ai-a": ["llama3.1:8b"], "ai-b": ["qwen2.5:7b"] },
      reviewOverrideByPanel: { "ai-a": false },
      commandsOverrideByPanel: { "ai-a": true },
      isolatedStartByPanel: { "ai-a": { text: "go", attachments: [] } },
      seatByPanel: { "ai-a": 2, "ai-b": 1 },
    };

    const closed = reduce(state, { type: "panel-closed", panelId: "ai-a" });

    expect(closed.pendingByPanel["ai-a"]).toBeUndefined();
    expect(closed.resumeTarget).toBeNull();
    expect(closed.raceWatchTabs).toEqual([{ panelId: "ai-b", label: "B", runId: "run-b", provider: "anthropic" as const }]);
    expect(closed.focusActiveTabId).toBe("ai-b");
    expect(closed.followUpsByPanel["ai-a"]).toBeUndefined();
    // The settings maps live in the fleet precisely so a close clears them.
    expect(closed.modelsByPanel).toEqual({ "ai-b": ["qwen2.5:7b"] });
    expect(closed.reviewOverrideByPanel).toEqual({});
    expect(closed.commandsOverrideByPanel).toEqual({});
    expect(closed.isolatedStartByPanel).toEqual({});
    expect(closed.seatByPanel).toEqual({ "ai-b": 1 });
  });
});

describe("resuming a conversation with a continuation", () => {
  it("holds the text back until the panel has loaded the conversation", () => {
    const armed = reduce(initialAiPanelFleetState, {
      type: "resume-targeted",
      panelId: "ai-main",
      convo: convo("c1"),
      continueWith: { text: "and now the other half", nonce: 7 },
    });

    // The whole point: nothing is sendable yet. Handing the panel a follow-up
    // in this same pass would put the turn in the outgoing conversation.
    expect(armed.followUpsByPanel).toEqual({});
    expect(armed.resumeTarget?.convo.id).toBe("c1");
    expect(armed.pendingContinuation).toEqual({
      panelId: "ai-main",
      text: "and now the other half",
      nonce: 7,
    });

    const released = reduce(armed, { type: "resume-consumed", panelId: "ai-main" });

    expect(released.resumeTarget).toBeNull();
    expect(released.pendingContinuation).toBeNull();
    expect(released.followUpsByPanel).toEqual({
      "ai-main": { text: "and now the other half", nonce: 7 },
    });
  });

  it("leaves a plain resume with nothing to send", () => {
    const state = reduceAll(
      initialAiPanelFleetState,
      { type: "resume-targeted", panelId: "ai-main", convo: convo("c1") },
      { type: "resume-consumed", panelId: "ai-main" },
    );

    expect(state.followUpsByPanel).toEqual({});
    expect(state.pendingContinuation).toBeNull();
  });

  it("drops a continuation whose panel closes before the resume lands", () => {
    const state = reduceAll(
      initialAiPanelFleetState,
      {
        type: "resume-targeted",
        panelId: "ai-main",
        convo: convo("c1"),
        continueWith: { text: "never sent", nonce: 7 },
      },
      { type: "panel-closed", panelId: "ai-main" },
      // A late consume from the unmounting panel must not resurrect the turn.
      { type: "resume-consumed", panelId: "ai-main" },
    );

    expect(state.pendingContinuation).toBeNull();
    expect(state.followUpsByPanel).toEqual({});
  });

  it("re-targeting the reader clears a continuation that never landed", () => {
    const state = reduceAll(
      initialAiPanelFleetState,
      {
        type: "resume-targeted",
        panelId: "ai-main",
        convo: convo("c1"),
        continueWith: { text: "abandoned", nonce: 7 },
      },
      // Opened a different conversation instead, with no text this time.
      { type: "resume-targeted", panelId: "ai-main", convo: convo("c2") },
      { type: "resume-consumed", panelId: "ai-main" },
    );

    expect(state.followUpsByPanel).toEqual({});
  });

  it("keeps a race fan-out independent of a parked continuation", () => {
    const state = reduceAll(
      initialAiPanelFleetState,
      {
        type: "race-watch-started",
        handoffs: [],
        tabs: [
          { panelId: "ai-a", label: "A", runId: "run-a", provider: "ollama" as const },
          { panelId: "ai-b", label: "B", runId: "run-b", provider: "anthropic" as const },
        ],
        focusActiveTabId: "ai-a",
      },
      {
        type: "resume-targeted",
        panelId: "ai-main",
        convo: convo("c1"),
        continueWith: { text: "continue", nonce: 7 },
      },
      { type: "race-follow-up-queued", text: "ask both", nonce: 9 },
    );

    expect(state.followUpsByPanel).toEqual({
      "ai-a": { text: "ask both", nonce: 9 },
      "ai-b": { text: "ask both", nonce: 9 },
    });
    expect(state.pendingContinuation?.text).toBe("continue");
  });
});

// ── admit / release ────────────────────────────────────────────────────

/** Drives the controller against the real reducer with a fake layout module:
 *  panels are ids in an array, geometry doesn't exist here. */
function makeFleet(opts?: {
  panelBoundToConversation?: (conversationId: string) => string | null;
  /** A one-slot surface (Focus, the anchored column, a grid cell) answers
   *  with the panel it is already rendering; the default is free mode, which
   *  renders the whole fleet and always opens a new panel. */
  slotForAdmission?: (intent: AdmitIntent) => string | null;
}) {
  let state = initialAiPanelFleetState;
  const open: string[] = [];
  let counter = 0;
  const revealed: string[] = [];
  const focused: string[] = [];
  const seeds: (PanelSeed | undefined)[] = [];
  const reseated: { panelId: string; seed: PanelSeed }[] = [];
  const dispatch = (action: AiPanelFleetAction) => {
    state = aiPanelFleetReducer(state, action);
  };
  const controller = createFleetController(
    {
      createPanel: (seed) => {
        const id = `panel-${++counter}`;
        open.push(id);
        seeds.push(seed);
        return id;
      },
      removePanel: (panelId) => {
        const idx = open.indexOf(panelId);
        if (idx >= 0) open.splice(idx, 1);
      },
      focusPanel: (panelId) => focused.push(panelId),
      slotForAdmission: (intent) => opts?.slotForAdmission?.(intent) ?? null,
      reseatPanel: (panelId, seed) => {
        reseated.push({ panelId, seed });
      },
      revealSurface: (intent) => revealed.push(intent.kind),
      openPanelIds: () => [...open],
      panelBoundToConversation: opts?.panelBoundToConversation ?? (() => null),
    },
    dispatch,
    () => state,
  );
  return {
    ...controller,
    dispatch,
    open,
    revealed,
    focused,
    seeds,
    reseated,
    get state() {
      return state;
    },
  };
}

describe("fleet admission", () => {
  it("admits a resumed run once — the second admit focuses the first panel", () => {
    const fleet = makeFleet();

    const first = fleet.admit({ kind: "resume-run", runId: "run-1", convo: convo("run-1") });
    const second = fleet.admit({ kind: "resume-run", runId: "run-1", convo: convo("run-1") });

    expect(second).toBe(first);
    expect(fleet.open).toEqual([first]);
    expect(fleet.focused).toEqual([first]);
    // The surface is still revealed on the de-duped admit (the old rituals
    // switched back to the workbench before their duplicate check too).
    expect(fleet.revealed).toEqual(["resume-run", "resume-run"]);
    expect(fleet.state.resumeTarget?.panelId).toBe(first);
  });

  it("re-admits a run whose panel has since been released", () => {
    const fleet = makeFleet();

    const first = fleet.admit({ kind: "resume-run", runId: "run-1", convo: convo("run-1") });
    fleet.release(first);
    const second = fleet.admit({ kind: "resume-run", runId: "run-1", convo: convo("run-1") });

    expect(second).not.toBe(first);
    expect(fleet.open).toEqual([second]);
  });

  it("de-dupes a CLI resume handoff on its session id, but never a fresh task", () => {
    const fleet = makeFleet();

    const a = fleet.admit({ kind: "handoff", provider: "codex", resumeSessionId: "sess-1" });
    const b = fleet.admit({ kind: "handoff", provider: "codex", resumeSessionId: "sess-1" });
    const c = fleet.admit({ kind: "handoff", provider: "codex", initialTask: "fix the tests" });
    const d = fleet.admit({ kind: "handoff", provider: "codex", initialTask: "fix the tests" });

    expect(b).toBe(a);
    expect(d).not.toBe(c);
    expect(fleet.open).toEqual([a, c, d]);
  });

  it("reattach lands on the panel already bound to the conversation", () => {
    const fleet = makeFleet({
      panelBoundToConversation: (id) => (id === "convo-live" ? "panel-spawner" : null),
    });

    const target = fleet.admit({
      kind: "reattach",
      provider: "claude-code",
      conversationId: "convo-live",
    });

    expect(target).toBe("panel-spawner");
    expect(fleet.open).toEqual([]);
    expect(fleet.focused).toEqual(["panel-spawner"]);
    expect(fleet.state.pendingByPanel).toEqual({});
  });

  it("seeds a fork panel from its conversation's provider, model, and worktree pin", () => {
    const fleet = makeFleet();

    const panelId = fleet.admit({
      kind: "fork",
      convo: { ...convo("c1"), provider: "ollama", model: "llama3.1:8b", cwd: "/wt/fork-1" },
    });

    expect(fleet.seeds[0]).toEqual({
      provider: "ollama",
      model: "llama3.1:8b",
      cwd: "/wt/fork-1",
    });
    expect(fleet.state.resumeTarget?.panelId).toBe(panelId);
  });
});

// ── one-slot surfaces ──────────────────────────────────────────────────
// Focus, the anchored column and a grid cell each render exactly one AI
// panel. Appending there opened a session nothing drew — the "Resume in
// Claude Code does nothing" bug.

describe("admission into a surface with one AI slot", () => {
  const oneSlot = () => makeFleet({ slotForAdmission: () => "ai-main" });

  it("lands the handoff in the slot on screen instead of a panel nobody renders", () => {
    const fleet = oneSlot();

    const panelId = fleet.admit({
      kind: "handoff",
      provider: "claude-code",
      resumeSessionId: "sess-1",
    });

    expect(panelId).toBe("ai-main");
    expect(fleet.open).toEqual([]);
    expect(fleet.reseated).toEqual([
      { panelId: "ai-main", seed: { provider: "claude-code", cwd: undefined } },
    ]);
    expect(fleet.state.pendingByPanel["ai-main"]?.resumeSessionId).toBe("sess-1");
  });

  it("bumps the reused panel's seat, because a handoff arrives on mount", () => {
    const fleet = oneSlot();

    fleet.admit({ kind: "handoff", provider: "codex", resumeSessionId: "sess-1" });
    fleet.admit({ kind: "reattach", provider: "claude-code", conversationId: "convo-live" });

    expect(fleet.state.seatByPanel["ai-main"]).toBe(2);
  });

  it("leaves the seat alone for a resumed run, which repoints a mounted panel", () => {
    const fleet = oneSlot();

    fleet.admit({ kind: "resume-run", runId: "run-1", convo: convo("run-1") });

    expect(fleet.state.seatByPanel["ai-main"]).toBeUndefined();
    expect(fleet.state.resumeTarget?.panelId).toBe("ai-main");
  });

  it("reseats a fork to its worktree only — the conversation configures the rest", () => {
    const fleet = oneSlot();

    fleet.admit({
      kind: "fork",
      convo: { ...convo("c1"), provider: "ollama", model: "llama3.1:8b", cwd: "/wt/fork-1" },
    });

    expect(fleet.reseated).toEqual([{ panelId: "ai-main", seed: { cwd: "/wt/fork-1" } }]);
  });

  it("drops the identity a reused slot no longer holds", () => {
    const fleet = oneSlot();

    const first = fleet.admit({ kind: "handoff", provider: "codex", resumeSessionId: "sess-1" });
    fleet.admit({ kind: "handoff", provider: "codex", resumeSessionId: "sess-2" });
    // Re-clicking the first run must re-admit it, not focus a slot that has
    // since been handed to sess-2.
    fleet.admit({ kind: "handoff", provider: "codex", resumeSessionId: "sess-1" });

    expect(first).toBe("ai-main");
    expect(fleet.state.pendingByPanel["ai-main"]?.resumeSessionId).toBe("sess-1");
    expect(fleet.state.seatByPanel["ai-main"]).toBe(3);
  });

  it("carries a Continue in Focus into the slot Focus renders", () => {
    const fleet = makeFleet({
      // Focus is one slot wherever the admission started from.
      slotForAdmission: (intent) => (intent.kind === "focus-resume" ? "ai-main" : null),
    });

    const panelId = fleet.admit({
      kind: "focus-resume",
      convo: { ...convo("run-1"), provider: "claude-code", cwd: "/repo" },
    });

    expect(panelId).toBe("ai-main");
    expect(fleet.open).toEqual([]);
    // The conversation configures the panel as it loads; only the worktree
    // pin is applied ahead of it.
    expect(fleet.reseated).toEqual([{ panelId: "ai-main", seed: { cwd: "/repo" } }]);
    expect(fleet.state.resumeTarget?.convo.id).toBe("run-1");
    // It repoints a mounted panel — no remount, so no seat bump.
    expect(fleet.state.seatByPanel["ai-main"]).toBeUndefined();
  });

  it("repoints the panel on screen for a new worktree run instead of a hidden one", () => {
    const fleet = oneSlot();

    const panelId = fleet.admit({ kind: "fresh", cwd: "/repo-worktrees/wt-1" });

    expect(panelId).toBe("ai-main");
    expect(fleet.open).toEqual([]);
    expect(fleet.reseated).toEqual([
      { panelId: "ai-main", seed: { provider: undefined, model: undefined, cwd: "/repo-worktrees/wt-1" } },
    ]);
    // Remounted, so its session restores for the worktree, not the old thread.
    expect(fleet.state.seatByPanel["ai-main"]).toBe(1);
  });

  it("still opens new panels for a race", () => {
    const fleet = oneSlot();

    fleet.admit({
      kind: "race-watch",
      focusActive: true,
      racers: [
        { runId: "r1", provider: "ollama", label: "A" },
        { runId: "r2", provider: "ollama", label: "B" },
      ],
    });

    expect(fleet.open).toEqual(["panel-1", "panel-2"]);
    expect(fleet.reseated).toEqual([]);
  });
});

describe("fleet release", () => {
  it("release is one verb: membership and every per-panel queue and map clear together", () => {
    const fleet = makeFleet();

    const panelId = fleet.admit({
      kind: "handoff",
      provider: "codex",
      initialTask: "do the thing",
    });
    fleet.dispatch({ type: "panel-models-reported", panelId, models: ["m1"] });
    fleet.dispatch({ type: "review-override-set", panelId, required: false });
    fleet.dispatch({
      type: "isolated-start-queued",
      panelId,
      start: { text: "go", attachments: [] },
    });

    fleet.release(panelId);

    expect(fleet.open).toEqual([]);
    expect(fleet.state.pendingByPanel).toEqual({});
    expect(fleet.state.followUpsByPanel).toEqual({});
    expect(fleet.state.modelsByPanel).toEqual({});
    expect(fleet.state.reviewOverrideByPanel).toEqual({});
    expect(fleet.state.isolatedStartByPanel).toEqual({});
  });

  it("race admit then endRaceWatch leaves no orphaned queues (the pendingByPanel leak)", () => {
    const fleet = makeFleet();

    fleet.admit({
      kind: "race-watch",
      focusActive: true,
      racers: [
        { runId: "run-a", provider: "ollama", model: "m", cwd: "/wt/a", label: "A" },
        { runId: "run-b", provider: "ollama", model: "m", cwd: "/wt/b", label: "B" },
      ],
    });
    // Leaving before any panel consumed its handoff — the old path cleared the
    // tabs but left both entries stranded in pendingByPanel forever.
    expect(Object.keys(fleet.state.pendingByPanel)).toHaveLength(2);

    fleet.endRaceWatch();

    expect(fleet.open).toEqual([]);
    expect(fleet.state.pendingByPanel).toEqual({});
    expect(fleet.state.raceWatchTabs).toEqual([]);
    expect(fleet.state.focusActiveTabId).toBeNull();
    expect(fleet.state.followUpsByPanel).toEqual({});
  });

  it("a released racer's run can be race-watched again in a fresh panel", () => {
    const fleet = makeFleet();

    fleet.admit({
      kind: "race-watch",
      focusActive: false,
      racers: [{ runId: "run-a", provider: "ollama", label: "A" }],
    });
    fleet.endRaceWatch();
    fleet.admit({ kind: "resume-run", runId: "run-a", convo: convo("run-a") });

    // The registry entry died with the released panel — no focus on a ghost.
    expect(fleet.open).toHaveLength(1);
    expect(fleet.focused).toEqual([]);
  });
});
