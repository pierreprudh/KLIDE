export type BudgetPreset = "lean" | "balanced" | "maximum" | "custom";

export type BudgetStatus = "within-budget" | "near-limit" | "exceeded" | "needs-approval";

export type BudgetEnvelope = {
  preset: BudgetPreset;
  maxCostUsd: number | null;
  maxDurationMs: number | null;
  maxRetries: number;
  askBeforeEscalation: boolean;
};

export type BudgetLedger = {
  id: string;
  missionId: string;
  envelope: BudgetEnvelope;
  spentCostUsd: number;
  spentDurationMs: number;
  retryCount: number;
  escalationCount: number;
  status: BudgetStatus;
  entries: BudgetEntry[];
  createdMs: number;
  updatedMs: number;
};

export type BudgetEntry = {
  id: string;
  taskId?: string;
  runId?: string;
  label: string;
  costUsd: number;
  durationMs: number;
  kind: "estimate" | "spend" | "refund" | "retry" | "escalation";
  ts: number;
};

export type BudgetDecision =
  | { ok: true; status: BudgetStatus; remainingCostUsd: number | null; remainingDurationMs: number | null }
  | { ok: false; status: BudgetStatus; reason: string; remainingCostUsd: number | null; remainingDurationMs: number | null };

export type BudgetAction =
  | { type: "entry_recorded"; entry: BudgetEntry }
  | { type: "envelope_updated"; envelope: BudgetEnvelope; ts: number }
  | { type: "retry_recorded"; taskId?: string; ts: number }
  | { type: "escalation_recorded"; taskId?: string; ts: number };

export const BUDGET_PRESETS: Record<Exclude<BudgetPreset, "custom">, BudgetEnvelope> = {
  lean: {
    preset: "lean",
    maxCostUsd: 1,
    maxDurationMs: 20 * 60_000,
    maxRetries: 1,
    askBeforeEscalation: true,
  },
  balanced: {
    preset: "balanced",
    maxCostUsd: 5,
    maxDurationMs: 60 * 60_000,
    maxRetries: 2,
    askBeforeEscalation: true,
  },
  maximum: {
    preset: "maximum",
    maxCostUsd: 20,
    maxDurationMs: 3 * 60 * 60_000,
    maxRetries: 4,
    askBeforeEscalation: false,
  },
};

export function createBudgetLedger(input: {
  missionId: string;
  id?: string;
  envelope?: BudgetEnvelope;
  preset?: Exclude<BudgetPreset, "custom">;
  nowMs?: number;
}): BudgetLedger {
  const nowMs = input.nowMs ?? Date.now();
  const envelope = input.envelope ?? BUDGET_PRESETS[input.preset ?? "balanced"];
  return {
    id: input.id ?? makeId("budget"),
    missionId: input.missionId,
    envelope,
    spentCostUsd: 0,
    spentDurationMs: 0,
    retryCount: 0,
    escalationCount: 0,
    status: "within-budget",
    entries: [],
    createdMs: nowMs,
    updatedMs: nowMs,
  };
}

export function budgetReducer(ledger: BudgetLedger, action: BudgetAction): BudgetLedger {
  if (action.type === "envelope_updated") {
    const next = { ...ledger, envelope: action.envelope, updatedMs: action.ts };
    return { ...next, status: deriveBudgetStatus(next) };
  }

  if (action.type === "retry_recorded") {
    const entry = createBudgetEntry({
      taskId: action.taskId,
      label: "Retry",
      kind: "retry",
      costUsd: 0,
      durationMs: 0,
      ts: action.ts,
    });
    const next = {
      ...ledger,
      retryCount: ledger.retryCount + 1,
      entries: [...ledger.entries, entry],
      updatedMs: action.ts,
    };
    return { ...next, status: deriveBudgetStatus(next) };
  }

  if (action.type === "escalation_recorded") {
    const entry = createBudgetEntry({
      taskId: action.taskId,
      label: "Escalation",
      kind: "escalation",
      costUsd: 0,
      durationMs: 0,
      ts: action.ts,
    });
    const next = {
      ...ledger,
      escalationCount: ledger.escalationCount + 1,
      entries: [...ledger.entries, entry],
      updatedMs: action.ts,
    };
    return { ...next, status: deriveBudgetStatus(next) };
  }

  const signedCost = action.entry.kind === "refund" ? -action.entry.costUsd : action.entry.costUsd;
  const signedDuration = action.entry.kind === "refund" ? -action.entry.durationMs : action.entry.durationMs;
  const next = {
    ...ledger,
    spentCostUsd: Math.max(0, ledger.spentCostUsd + signedCost),
    spentDurationMs: Math.max(0, ledger.spentDurationMs + signedDuration),
    entries: [...ledger.entries, action.entry],
    updatedMs: action.entry.ts,
  };
  return { ...next, status: deriveBudgetStatus(next) };
}

export function createBudgetEntry(input: Omit<BudgetEntry, "id"> & { id?: string }): BudgetEntry {
  return {
    id: input.id ?? makeId("budget-entry"),
    taskId: input.taskId,
    runId: input.runId,
    label: input.label,
    costUsd: input.costUsd,
    durationMs: input.durationMs,
    kind: input.kind,
    ts: input.ts,
  };
}

export function canSpendBudget(
  ledger: BudgetLedger,
  estimate: { costUsd?: number | null; durationMs?: number | null; retry?: boolean; escalation?: boolean }
): BudgetDecision {
  const remainingCostUsd = remainingCost(ledger);
  const remainingDurationMs = remainingDuration(ledger);
  const costUsd = estimate.costUsd ?? 0;
  const durationMs = estimate.durationMs ?? 0;

  if (remainingCostUsd !== null && costUsd > remainingCostUsd) {
    return {
      ok: false,
      status: "needs-approval",
      reason: "Estimated cost exceeds the approved budget.",
      remainingCostUsd,
      remainingDurationMs,
    };
  }

  if (remainingDurationMs !== null && durationMs > remainingDurationMs) {
    return {
      ok: false,
      status: "needs-approval",
      reason: "Estimated duration exceeds the approved time budget.",
      remainingCostUsd,
      remainingDurationMs,
    };
  }

  if (estimate.retry && ledger.retryCount >= ledger.envelope.maxRetries) {
    return {
      ok: false,
      status: "needs-approval",
      reason: "Retry budget is exhausted.",
      remainingCostUsd,
      remainingDurationMs,
    };
  }

  if (estimate.escalation && ledger.envelope.askBeforeEscalation) {
    return {
      ok: false,
      status: "needs-approval",
      reason: "Escalation requires approval for this budget preset.",
      remainingCostUsd,
      remainingDurationMs,
    };
  }

  return {
    ok: true,
    status: deriveBudgetStatus(ledger),
    remainingCostUsd,
    remainingDurationMs,
  };
}

export function deriveBudgetStatus(ledger: BudgetLedger): BudgetStatus {
  const costRatio = ratio(ledger.spentCostUsd, ledger.envelope.maxCostUsd);
  const durationRatio = ratio(ledger.spentDurationMs, ledger.envelope.maxDurationMs);
  const highestRatio = Math.max(costRatio, durationRatio);

  if (highestRatio > 1 || ledger.retryCount > ledger.envelope.maxRetries) return "exceeded";
  if (highestRatio >= 0.85 || ledger.retryCount === ledger.envelope.maxRetries) return "near-limit";
  return "within-budget";
}

export function remainingCost(ledger: BudgetLedger): number | null {
  if (ledger.envelope.maxCostUsd === null) return null;
  return Math.max(0, ledger.envelope.maxCostUsd - ledger.spentCostUsd);
}

export function remainingDuration(ledger: BudgetLedger): number | null {
  if (ledger.envelope.maxDurationMs === null) return null;
  return Math.max(0, ledger.envelope.maxDurationMs - ledger.spentDurationMs);
}

function ratio(value: number, limit: number | null): number {
  if (limit === null || limit <= 0) return 0;
  return value / limit;
}

function makeId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `${prefix}:${crypto.randomUUID()}`;
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}
