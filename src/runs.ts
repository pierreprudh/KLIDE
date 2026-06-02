// Mission Control's data layer. A "run" is one agent session. KIDE aggregates
// runs from every agentic tool you use — its own AI panel plus external CLIs
// (Claude Code, Codex) whose session logs the Rust `list_agent_runs` command
// reads off disk. The board is read-only for now; steering/resume come later.

import { invoke } from "@tauri-apps/api/core";

export type RunSource = "claude-code" | "codex" | "klide";
export type RunStatus = "running" | "waiting" | "queued" | "done" | "error";

export type Run = {
  id: string;
  path: string;
  source: RunSource;
  title: string;
  status: RunStatus;
  model: string | null;
  project: string | null;
  cwd: string | null;
  branch: string | null;
  messageCount: number;
  updatedMs: number;
};

// One readable turn of a run's conversation (from `read_agent_run`).
export type RunMessage = { role: "user" | "assistant"; text: string };

// Shape returned by the Rust command (serde camelCase).
type AgentRunDto = {
  id: string;
  path: string;
  source: string;
  title: string;
  model: string | null;
  cwd: string | null;
  project: string | null;
  gitBranch: string | null;
  updatedMs: number;
  messageCount: number;
  status: string;
};

export const STATUS_ORDER: RunStatus[] = [
  "running",
  "waiting",
  "queued",
  "done",
  "error",
];

export const STATUS_LABEL: Record<RunStatus, string> = {
  running: "Active",
  waiting: "Needs you",
  queued: "Queued",
  done: "Done",
  error: "Failed",
};

// Quiet, theme-aware tones. Amber matches the AI panel's context meter; danger
// reuses the existing token; success is a restrained desaturated green.
export const STATUS_COLOR: Record<RunStatus, string> = {
  running: "var(--accent)",
  waiting: "#A15C00",
  queued: "var(--fg-subtle)",
  done: "#3E7C5A",
  error: "var(--danger, #B42318)",
};

export const SOURCE_LABEL: Record<RunSource, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  klide: "Klide",
};

// A subtle per-source tint for the row badge — distinct but never loud.
export const SOURCE_COLOR: Record<RunSource, string> = {
  "claude-code": "#B6713F",
  codex: "#3E7C5A",
  klide: "var(--accent)",
};

function toSource(raw: string): RunSource {
  return raw === "claude-code" || raw === "codex" ? raw : "klide";
}

function toStatus(raw: string): RunStatus {
  return STATUS_ORDER.includes(raw as RunStatus) ? (raw as RunStatus) : "done";
}

function fromDto(a: AgentRunDto): Run {
  return {
    id: a.id,
    path: a.path,
    source: toSource(a.source),
    title: a.title?.trim() || "Untitled session",
    status: toStatus(a.status),
    model: a.model ?? null,
    project: a.project ?? null,
    cwd: a.cwd ?? null,
    branch: a.gitBranch ?? null,
    messageCount: a.messageCount ?? 0,
    updatedMs: a.updatedMs ?? 0,
  };
}

// Pull a page of real runs from the backend (newest first). Throws if the
// command is unavailable (e.g. running outside Tauri) — callers fall back to
// the seed. Pages are offset-based so loading more never re-parses earlier runs.
export async function fetchAgentRuns(limit = 10, offset = 0): Promise<Run[]> {
  const rows = await invoke<AgentRunDto[]>("list_agent_runs", { limit, offset });
  return rows.map(fromDto);
}

// Read a single run's conversation (the detail pane's résumé). Throws if the
// command is unavailable; callers handle the empty/error state.
export async function fetchRunMessages(run: Run): Promise<RunMessage[]> {
  return invoke<RunMessage[]>("read_agent_run", {
    path: run.path,
    source: run.source,
  });
}

// Illustrative fallback so the board is never blank in a non-Tauri dev preview.
export function seedRuns(): Run[] {
  const now = Date.now();
  const min = 60_000;
  return [
    {
      id: "seed-1",
      path: "seed://claude-code/1",
      source: "claude-code",
      title: "Add a dark-mode toggle to the settings panel",
      status: "running",
      model: "claude-opus-4-8",
      project: "KIDE",
      cwd: "/Users/you/KIDE",
      branch: "main",
      messageCount: 24,
      updatedMs: now - 6_000,
    },
    {
      id: "seed-2",
      path: "seed://codex/2",
      source: "codex",
      title: "Refactor the terminal panel resize handle",
      status: "done",
      model: "gpt-5.5",
      project: "KIDE",
      cwd: "/Users/you/KIDE",
      branch: "main",
      messageCount: 11,
      updatedMs: now - 38 * min,
    },
  ];
}

export function relativeTime(ts: number): string {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}
