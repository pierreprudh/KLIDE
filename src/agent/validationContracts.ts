export type ValidationCheckKind =
  | "typecheck"
  | "test"
  | "lint"
  | "format"
  | "diff-scope"
  | "semantic-review"
  | "visual"
  | "human"
  | "budget";

export type ValidationReviewer = "klide" | "orchestrator" | "delegate" | "user";

export type ValidationCheckStatus = "pending" | "running" | "passed" | "failed" | "waived" | "skipped";

export type ValidationCheck = {
  id: string;
  kind: ValidationCheckKind;
  label: string;
  required: boolean;
  status: ValidationCheckStatus;
  command?: string;
  reviewer?: ValidationReviewer;
  message?: string;
  updatedMs: number;
};

export type ValidationContractStatus = "pending" | "running" | "passed" | "failed" | "waived";

export type ValidationContract = {
  id: string;
  taskId: string;
  checks: ValidationCheck[];
  status: ValidationContractStatus;
  createdMs: number;
  updatedMs: number;
};

export type ValidationState = {
  contracts: Record<string, ValidationContract>;
};

export type ValidationAction =
  | { type: "contract_created"; contract: ValidationContract }
  | {
      type: "check_status_changed";
      contractId: string;
      checkId: string;
      status: ValidationCheckStatus;
      message?: string;
      ts: number;
    }
  | { type: "contract_waived"; contractId: string; message?: string; ts: number };

export type ValidationSummary = {
  total: number;
  required: number;
  passed: number;
  failed: number;
  running: number;
  pending: number;
  waived: number;
  blockingFailures: ValidationCheck[];
};

export const EMPTY_VALIDATION_STATE: ValidationState = {
  contracts: {},
};

export function createValidationCheck(
  input: Omit<ValidationCheck, "id" | "status" | "updatedMs"> & {
    id?: string;
    status?: ValidationCheckStatus;
    updatedMs?: number;
  }
): ValidationCheck {
  return {
    id: input.id ?? makeId("check"),
    kind: input.kind,
    label: input.label,
    required: input.required,
    status: input.status ?? "pending",
    command: input.command,
    reviewer: input.reviewer,
    message: input.message,
    updatedMs: input.updatedMs ?? Date.now(),
  };
}

export function createValidationContract(input: {
  id?: string;
  taskId: string;
  checks: ValidationCheck[];
  createdMs?: number;
  updatedMs?: number;
}): ValidationContract {
  const now = Date.now();
  const updatedMs = input.updatedMs ?? input.createdMs ?? now;
  const contract: ValidationContract = {
    id: input.id ?? makeId("validation"),
    taskId: input.taskId,
    checks: input.checks,
    status: "pending",
    createdMs: input.createdMs ?? now,
    updatedMs,
  };
  return { ...contract, status: deriveValidationStatus(contract.checks) };
}

export function validationReducer(
  state: ValidationState = EMPTY_VALIDATION_STATE,
  action: ValidationAction
): ValidationState {
  if (action.type === "contract_created") {
    return {
      contracts: {
        ...state.contracts,
        [action.contract.id]: action.contract,
      },
    };
  }

  const contract =
    action.type === "check_status_changed" || action.type === "contract_waived"
      ? state.contracts[action.contractId]
      : undefined;
  if (!contract) return state;

  if (action.type === "contract_waived") {
    return {
      contracts: {
        ...state.contracts,
        [contract.id]: {
          ...contract,
          checks: contract.checks.map((check) =>
            check.status === "passed"
              ? check
              : { ...check, status: "waived", message: action.message ?? check.message, updatedMs: action.ts }
          ),
          status: "waived",
          updatedMs: action.ts,
        },
      },
    };
  }

  const checks = contract.checks.map((check) =>
    check.id === action.checkId
      ? {
          ...check,
          status: action.status,
          message: action.message ?? check.message,
          updatedMs: action.ts,
        }
      : check
  );

  return {
    contracts: {
      ...state.contracts,
      [contract.id]: {
        ...contract,
        checks,
        status: deriveValidationStatus(checks),
        updatedMs: action.ts,
      },
    },
  };
}

export function deriveValidationStatus(checks: ValidationCheck[]): ValidationContractStatus {
  if (checks.some((check) => check.required && check.status === "failed")) return "failed";
  if (checks.some((check) => check.status === "running")) return "running";
  if (checks.length > 0 && checks.every((check) => check.status === "waived" || check.status === "skipped")) {
    return "waived";
  }
  if (checks.length > 0 && checks.every((check) => check.status === "passed" || check.status === "waived" || check.status === "skipped")) {
    return "passed";
  }
  return "pending";
}

export function summarizeValidation(contract: ValidationContract | null | undefined): ValidationSummary {
  const checks = contract?.checks ?? [];
  const blockingFailures = checks.filter((check) => check.required && check.status === "failed");
  return {
    total: checks.length,
    required: checks.filter((check) => check.required).length,
    passed: checks.filter((check) => check.status === "passed").length,
    failed: checks.filter((check) => check.status === "failed").length,
    running: checks.filter((check) => check.status === "running").length,
    pending: checks.filter((check) => check.status === "pending").length,
    waived: checks.filter((check) => check.status === "waived").length,
    blockingFailures,
  };
}

export function defaultValidationChecks(input: {
  taskId: string;
  risk: "low" | "medium" | "high";
  writesFiles: boolean;
  needsVisualReview?: boolean;
  nowMs?: number;
}): ValidationCheck[] {
  const nowMs = input.nowMs ?? Date.now();
  const checks: ValidationCheck[] = [
    createValidationCheck({
      id: `${input.taskId}:budget`,
      kind: "budget",
      label: "Budget stayed inside approved limits",
      required: true,
      updatedMs: nowMs,
    }),
  ];

  if (input.writesFiles) {
    checks.push(
      createValidationCheck({
        id: `${input.taskId}:diff-scope`,
        kind: "diff-scope",
        label: "Changed files match task scope",
        required: true,
        reviewer: "klide",
        updatedMs: nowMs,
      }),
      createValidationCheck({
        id: `${input.taskId}:typecheck`,
        kind: "typecheck",
        label: "Typecheck passes",
        required: input.risk !== "low",
        command: "npm run build",
        updatedMs: nowMs,
      })
    );
  }

  if (input.risk === "high") {
    checks.push(
      createValidationCheck({
        id: `${input.taskId}:semantic-review`,
        kind: "semantic-review",
        label: "Strong model reviews output against intent",
        required: true,
        reviewer: "orchestrator",
        updatedMs: nowMs,
      }),
      createValidationCheck({
        id: `${input.taskId}:human`,
        kind: "human",
        label: "User approves final result",
        required: true,
        reviewer: "user",
        updatedMs: nowMs,
      })
    );
  }

  if (input.needsVisualReview) {
    checks.push(
      createValidationCheck({
        id: `${input.taskId}:visual`,
        kind: "visual",
        label: "Visual smoke review passes",
        required: input.risk !== "low",
        reviewer: "klide",
        updatedMs: nowMs,
      })
    );
  }

  return checks;
}

function makeId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `${prefix}:${crypto.randomUUID()}`;
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}
