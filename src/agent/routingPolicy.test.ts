import { describe, it, expect } from "vitest";
import {
  chooseAssignment,
  DEFAULT_ROUTING_POLICY,
  type RoutingPolicy,
  type RouteTaskInput,
} from "./routingPolicy";

// A low-risk, read-only plan task routes to the "local" tier (see
// chooseModelTier's final fallthrough), so we can assert the local tier's
// advisor without pinning the exact tier heuristics.
const LOCAL_TASK: RouteTaskInput = {
  taskId: "t1",
  title: "tidy a comment",
  mode: "plan",
  risk: "low",
  writesFiles: false,
};

describe("per-tier advisor plumbing", () => {
  it("defaults the assignment advisor to null so the run uses the global advisor", () => {
    const a = chooseAssignment({ ...LOCAL_TASK });
    expect(a.modelTier).toBe("local");
    expect(a.advisor).toBeNull();
  });

  it("carries the tier's advisor from policy.advisorByTier onto the assignment", () => {
    const policy: RoutingPolicy = {
      ...DEFAULT_ROUTING_POLICY,
      advisorByTier: {
        ...DEFAULT_ROUTING_POLICY.advisorByTier!,
        local: { provider: "anthropic", model: "claude-opus-4-8" },
      },
    };
    const a = chooseAssignment({ ...LOCAL_TASK }, policy);
    expect(a.advisor).toEqual({ provider: "anthropic", model: "claude-opus-4-8" });
  });
});
