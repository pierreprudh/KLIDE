import { describe, expect, it } from "vitest";
import { canReserveCapacity, capacityNeedFor, createCapacityState, withLiveWorkerUsage } from "./capacityPlanner";

const apiWorker = capacityNeedFor({ workerKind: "api-model", writesFiles: false });

describe("live API worker usage", () => {
  it("reads Rust's pool instead of an empty planning state", () => {
    const state = withLiveWorkerUsage(createCapacityState({ nowMs: 0 }), { limit: 4, running: 4, queued: 2 }, 5);
    expect(state.slots["api-worker"]).toMatchObject({ limit: 4, used: 4, queued: 2 });
    expect(state.updatedMs).toBe(5);
    const decision = canReserveCapacity(state, apiWorker);
    expect(decision).toMatchObject({ ok: false, blockedBy: "api-worker" });
  });

  it("admits while the pool has room", () => {
    const state = withLiveWorkerUsage(createCapacityState({ nowMs: 0 }), { limit: 4, running: 3, queued: 0 });
    expect(canReserveCapacity(state, apiWorker).ok).toBe(true);
  });

  it("matches Rust's limits: four API workers, no Delegate CLI limit", () => {
    const state = createCapacityState({ nowMs: 0 });
    expect(state.slots["api-worker"].limit).toBe(4);
    const busy = createCapacityState({ slots: { "delegate-cli": { used: 50 } }, nowMs: 0 });
    expect(canReserveCapacity(busy, capacityNeedFor({ workerKind: "delegate", writesFiles: false })).ok).toBe(true);
  });
});
