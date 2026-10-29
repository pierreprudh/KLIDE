export type CapacitySlotKind =
  | "api-orchestrator"
  | "api-worker"
  | "local-model"
  | "delegate-cli"
  | "worktree-writer"
  | "read-only-inspector";

export type CapacitySlot = {
  kind: CapacitySlotKind;
  label: string;
  limit: number;
  used: number;
  queued: number;
  reason: string;
};

export type CapacityState = {
  slots: Record<CapacitySlotKind, CapacitySlot>;
  updatedMs: number;
};

export type CapacityNeed = {
  kinds: CapacitySlotKind[];
  label: string;
};

export type CapacityDecision =
  | { ok: true; reservedKinds: CapacitySlotKind[] }
  | { ok: false; blockedBy: CapacitySlotKind; reason: string };

export type CapacityAction =
  | { type: "slot_configured"; slot: CapacitySlot; ts: number }
  | { type: "capacity_reserved"; kinds: CapacitySlotKind[]; ts: number }
  | { type: "capacity_released"; kinds: CapacitySlotKind[]; ts: number }
  | { type: "capacity_queued"; kinds: CapacitySlotKind[]; ts: number }
  | { type: "queue_released"; kinds: CapacitySlotKind[]; ts: number };

export const DEFAULT_CAPACITY_SLOTS: Record<CapacitySlotKind, CapacitySlot> = {
  "api-orchestrator": {
    kind: "api-orchestrator",
    label: "API orchestrators",
    limit: 1,
    used: 0,
    queued: 0,
    reason: "Keep expensive strategic runs serialized.",
  },
  "api-worker": {
    kind: "api-worker",
    label: "API workers",
    // Rust's admission limit (agent/worker_slots.rs API_WORKERS); a dispatch
    // over it waits in a fair queue, it is never refused.
    limit: 4,
    used: 0,
    queued: 0,
    reason: "Four run at once app-wide; the next one waits for a slot.",
  },
  "local-model": {
    kind: "local-model",
    label: "Local models",
    limit: 1,
    used: 0,
    queued: 0,
    reason: "Avoid overloading the local machine.",
  },
  "delegate-cli": {
    kind: "delegate-cli",
    label: "Delegate CLIs",
    // Not limited: a CLI runs on its own subscription (decided 2026-10-27).
    limit: Number.POSITIVE_INFINITY,
    used: 0,
    queued: 0,
    reason: "Not limited — each CLI runs on its own subscription.",
  },
  "worktree-writer": {
    kind: "worktree-writer",
    label: "Worktree writers",
    limit: 1,
    used: 0,
    queued: 0,
    reason: "Only one worker should write to the worktree at a time.",
  },
  "read-only-inspector": {
    kind: "read-only-inspector",
    label: "Read-only inspectors",
    limit: 4,
    used: 0,
    queued: 0,
    reason: "Read-only inspection is cheap to parallelize.",
  },
};

export function createCapacityState(input?: {
  slots?: Partial<Record<CapacitySlotKind, Partial<CapacitySlot>>>;
  nowMs?: number;
}): CapacityState {
  const overrides = input?.slots ?? {};
  const slots = Object.fromEntries(
    Object.entries(DEFAULT_CAPACITY_SLOTS).map(([kind, slot]) => [
      kind,
      { ...slot, ...overrides[kind as CapacitySlotKind] },
    ])
  ) as Record<CapacitySlotKind, CapacitySlot>;

  return {
    slots,
    updatedMs: input?.nowMs ?? Date.now(),
  };
}

/** What Rust's API worker pool holds right now (`agent_worker_capacity`). */
export type LiveWorkerUsage = { limit: number; running: number; queued: number };

/** Lay the live API worker pool over a planning state: the one slot kind
 *  Rust actually admits against reads its real occupancy, not zero. */
export function withLiveWorkerUsage(state: CapacityState, live: LiveWorkerUsage, nowMs = Date.now()): CapacityState {
  const slot = state.slots["api-worker"];
  return {
    slots: { ...state.slots, "api-worker": { ...slot, limit: live.limit, used: live.running, queued: live.queued } },
    updatedMs: nowMs,
  };
}

export function capacityReducer(state: CapacityState, action: CapacityAction): CapacityState {
  if (action.type === "slot_configured") {
    return {
      slots: {
        ...state.slots,
        [action.slot.kind]: action.slot,
      },
      updatedMs: action.ts,
    };
  }

  const mutate = (slot: CapacitySlot): CapacitySlot => {
    if (action.type === "capacity_reserved") return { ...slot, used: Math.min(slot.limit, slot.used + 1) };
    if (action.type === "capacity_released") return { ...slot, used: Math.max(0, slot.used - 1) };
    if (action.type === "capacity_queued") return { ...slot, queued: slot.queued + 1 };
    return { ...slot, queued: Math.max(0, slot.queued - 1) };
  };

  const slots = { ...state.slots };
  for (const kind of action.kinds) slots[kind] = mutate(slots[kind]);
  return { slots, updatedMs: action.ts };
}

export function canReserveCapacity(state: CapacityState, need: CapacityNeed): CapacityDecision {
  for (const kind of need.kinds) {
    const slot = state.slots[kind];
    if (slot.used >= slot.limit) {
      return {
        ok: false,
        blockedBy: kind,
        reason: `${slot.label} are full. ${slot.reason}`,
      };
    }
  }
  return { ok: true, reservedKinds: need.kinds };
}

export function capacityNeedFor(input: {
  workerKind: "native" | "delegate" | "local-model" | "api-model";
  writesFiles: boolean;
  orchestrator?: boolean;
  readOnlyInspector?: boolean;
}): CapacityNeed {
  const kinds: CapacitySlotKind[] = [];

  if (input.orchestrator) kinds.push("api-orchestrator");
  if (input.readOnlyInspector) kinds.push("read-only-inspector");
  if (input.workerKind === "api-model" && !input.orchestrator) kinds.push("api-worker");
  if (input.workerKind === "local-model") kinds.push("local-model");
  if (input.workerKind === "delegate") kinds.push("delegate-cli");
  if (input.writesFiles) kinds.push("worktree-writer");

  return {
    kinds,
    label: input.orchestrator ? "orchestrator run" : "worker run",
  };
}
