import { describe, expect, it } from "vitest";
import {
  GOAL_POLICIES,
  MODE_CHOICES,
  effectiveMode,
  goalPolicyOf,
  initialMode,
  modeLabel,
  nextGoalPolicy,
} from "./autonomyLadder";

describe("the mode menu", () => {
  it("offers Plan and Work, in that order — Chat is a collapse, not a pick", () => {
    expect(MODE_CHOICES.map((c) => c.mode)).toEqual(["plan", "goal"]);
    expect(MODE_CHOICES.map((c) => c.label)).toEqual(["Plan", "Work"]);
  });

  it("calls the goal tier Work and the collapse Chat", () => {
    expect(modeLabel("goal")).toBe("Work");
    expect(modeLabel("plan")).toBe("Plan");
    expect(modeLabel("chat")).toBe("Chat");
  });

  it("opens on Work unless the last pick was Plan", () => {
    expect(initialMode(null)).toBe("goal");
    expect(initialMode("goal")).toBe("goal");
    expect(initialMode("plan")).toBe("plan");
    // Left over from the three-row menu: there is no Chat row to land on.
    expect(initialMode("chat")).toBe("goal");
    expect(initialMode("build")).toBe("goal");
  });

  it("gives every choice a label and a description", () => {
    for (const c of MODE_CHOICES) {
      expect(c.label).toBeTruthy();
      expect(c.description).toBeTruthy();
    }
  });
});

describe("the goal policy cycle", () => {
  it("orders review → auto-accept → full auto, and only the top rung silences commands", () => {
    expect(GOAL_POLICIES.map((p) => p.key)).toEqual(["review", "auto", "full"]);
    expect(GOAL_POLICIES.map((p) => p.review)).toEqual([true, false, false]);
    expect(GOAL_POLICIES.map((p) => p.commands)).toEqual([false, false, true]);
  });

  it("cycles one step per click and wraps back to reviewing", () => {
    expect(nextGoalPolicy("review").key).toBe("auto");
    expect(nextGoalPolicy("auto").key).toBe("full");
    expect(nextGoalPolicy("full").key).toBe("review");
  });

  it("names the policy the gate flags spell", () => {
    expect(goalPolicyOf(true, false).key).toBe("review");
    expect(goalPolicyOf(false, false).key).toBe("auto");
    expect(goalPolicyOf(false, true).key).toBe("full");
  });

  it("reads an off-ladder combo as review — the safest gate wins", () => {
    expect(goalPolicyOf(true, true).key).toBe("review");
  });
});

describe("effectiveMode", () => {
  it("collapses Goal to Chat when the model cannot call tools", () => {
    // Otherwise the run silently does nothing.
    expect(
      effectiveMode({ mode: "goal", modelSupportsTools: false, providerDelegatesWork: false })
    ).toBe("chat");
  });

  it("keeps Goal for a delegate, whose CLI runs its own tools", () => {
    // The clause FocusMode's copy of this rule was missing. Klide's view of
    // "does this model support tools" does not apply to a delegate.
    expect(
      effectiveMode({ mode: "goal", modelSupportsTools: false, providerDelegatesWork: true })
    ).toBe("goal");
  });

  it("leaves the non-tool modes alone", () => {
    for (const mode of ["chat", "plan"] as const) {
      expect(effectiveMode({ mode, modelSupportsTools: false, providerDelegatesWork: false })).toBe(
        mode
      );
    }
  });

  it("is a no-op when the model does support tools", () => {
    expect(
      effectiveMode({ mode: "goal", modelSupportsTools: true, providerDelegatesWork: false })
    ).toBe("goal");
  });
});
