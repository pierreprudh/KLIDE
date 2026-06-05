// Mission Control's data layer. A "run" is one agent session. KIDE aggregates
// runs from every agentic tool you use — its own AI panel plus external CLIs
// (Claude Code, Codex) whose session logs the Rust `list_agent_runs` command
// reads off disk. The board is read-only for now; steering/resume come later.

import { invoke } from "@tauri-apps/api/core";

export type RunSource = "claude-code" | "codex" | "opencode" | "klide";
export type RunStatus = "running" | "waiting" | "queued" | "done" | "cancelled" | "error";

// What this row actually represents on the board. Tasks are Mission Control
// todos (queued or dispatched to an external agent); convos are Klide's own
// AI panel chat sessions; runs are on-disk sessions pulled from
// ~/.claude, ~/.codex, or the opencode DB.
export type RunKind = "task" | "convo" | "run";

export type Run = {
  id: string;
  path: string;
  source: RunSource;
  kind: RunKind;
  title: string;
  status: RunStatus;
  model: string | null;
  /** Klide runs carry their AI provider id (ollama, anthropic…); external CLIs don't. */
  provider?: string | null;
  project: string | null;
  cwd: string | null;
  branch: string | null;
  messageCount: number;
  /** Real token usage summed from the session log; absent when the source doesn't record it. */
  inputTokens?: number;
  outputTokens?: number;
  updatedMs: number;
  createdMs: number;
  /** When this run was spawned by another run (e.g. @explore sub-agent). */
  parentId?: string;
};

// One readable turn of a run's conversation (from `read_agent_run`).
export type RunMessage = { role: "user" | "assistant"; text: string };

// Shape returned by the Rust command (serde camelCase).
type AgentRunDto = {
  id: string;
  path: string;
  source: string;
  title: string;
  provider?: string;
  model: string | null;
  cwd: string | null;
  project: string | null;
  gitBranch: string | null;
  createdMs?: number;
  updatedMs: number;
  messageCount: number;
  inputTokens?: number;
  outputTokens?: number;
  status: string;
  parentId?: string;
};

export const STATUS_ORDER: RunStatus[] = [
  "running",
  "waiting",
  "queued",
  "done",
  "cancelled",
  "error",
];

export const STATUS_LABEL: Record<RunStatus, string> = {
  running: "Active",
  waiting: "Needs you",
  queued: "Queued",
  done: "Done",
  cancelled: "Stopped",
  error: "Failed",
};

// Quiet, theme-aware tones. Amber matches the AI panel's context meter; danger
// reuses the existing token; success is a restrained desaturated green.
export const STATUS_COLOR: Record<RunStatus, string> = {
  running: "var(--accent)",
  waiting: "#A15C00",
  queued: "var(--fg-subtle)",
  done: "#3E7C5A",
  cancelled: "var(--fg-subtle)",
  error: "var(--danger, #B42318)",
};

export const SOURCE_LABEL: Record<RunSource, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  klide: "Klide",
};

// A subtle per-source tint for the row badge — distinct but never loud.
export const SOURCE_COLOR: Record<RunSource, string> = {
  "claude-code": "#D97757",
  codex: "var(--fg-strong)",
  // Matches the opencode brand mark's neutral graphite (the logo uses
  // #211E1E on the outer square). Quieter than Claude/Codex so the paid
  // `opencode-go/*` runs don't shout on the board.
  opencode: "#3A3A3A",
  klide: "var(--accent)",
};

function toSource(raw: string): RunSource {
  return raw === "claude-code" || raw === "codex" || raw === "opencode" ? raw : "klide";
}

function toStatus(raw: string): RunStatus {
  return STATUS_ORDER.includes(raw as RunStatus) ? (raw as RunStatus) : "done";
}

function fromDto(a: AgentRunDto): Run {
  return {
    id: a.id,
    path: a.path,
    source: toSource(a.source),
    kind: "run",
    title: a.title?.trim() || "Untitled session",
    status: toStatus(a.status),
    model: a.model ?? null,
    provider: a.provider ?? null,
    project: a.project ?? null,
    cwd: a.cwd ?? null,
    branch: a.gitBranch ?? null,
    messageCount: a.messageCount ?? 0,
    inputTokens: a.inputTokens ?? 0,
    outputTokens: a.outputTokens ?? 0,
    updatedMs: a.updatedMs ?? 0,
    createdMs: a.createdMs ?? a.updatedMs ?? 0,
    parentId: a.parentId,
  };
}

// Pull a page of real runs from the backend (newest first). Throws if the
// command is unavailable (e.g. running outside Tauri) — callers fall back to
// the seed. Pages are offset-based so loading more never re-parses earlier runs.
export async function fetchAgentRuns(limit = 10, offset = 0): Promise<Run[]> {
  const [external, klide] = await Promise.allSettled([
    invoke<AgentRunDto[]>("list_agent_runs", { limit, offset }),
    invoke<AgentRunDto[]>("agent_list_runs", { limit, offset }),
  ]);
  const rows = [
    ...(external.status === "fulfilled" ? external.value : []),
    ...(klide.status === "fulfilled" ? klide.value : []),
  ];
  if (rows.length === 0 && external.status === "rejected" && klide.status === "rejected") {
    throw external.reason;
  }
  return rows
    .map(fromDto)
    .sort((a, b) => b.updatedMs - a.updatedMs)
    .slice(0, limit);
}

// Read a single run's conversation (the detail pane's résumé). Throws if the
// command is unavailable; callers handle the empty/error state.
export async function fetchRunMessages(run: Run): Promise<RunMessage[]> {
  if (run.source === "klide") {
    const events = await invoke<any[]>("agent_read_run", { runId: run.id });
    return events
      .flatMap((event): RunMessage[] => {
        if (event.type === "user_message") {
          return [{ role: "user", text: event.text ?? "" }];
        }
        if (event.type === "assistant_message") {
          const text = Array.isArray(event.content)
            ? event.content
                .filter((block: any) => block?.type === "text")
                .map((block: any) => String(block.text ?? ""))
                .join("")
            : "";
          return text.trim() ? [{ role: "assistant", text }] : [];
        }
        return [];
      })
      .filter((m) => m.text.trim());
  }
  if (run.source === "opencode") {
    // OpenCode stores its history in SQLite (opencode.db), so the read path
    // takes the session id instead of a file path on disk.
    return invoke<RunMessage[]>("read_opencode_run", { sessionId: run.id });
  }
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
      id: "seed-klide-1",
      path: "seed://klide/1",
      source: "klide",
      kind: "run",
      title: "Tour the project and report current state",
      status: "done",
      model: "llama3.1:8b",
      project: "KIDE",
      cwd: "/Users/you/KIDE",
      branch: "main",
      messageCount: 6,
      updatedMs: now - 4 * min,
      createdMs: now - 30 * min,
    },
    {
      id: "ses_seed_3",
      path: "ses_seed_3",
      source: "opencode",
      kind: "run",
      title: "Explore codebase architecture",
      status: "done",
      model: "opencode-go/minimax-m3",
      project: "KIDE",
      cwd: "/Users/you/KIDE",
      branch: "main",
      messageCount: 8,
      updatedMs: now - 8 * min,
      createdMs: now - 30 * min,
      parentId: "seed-klide-1",
    },
    {
      id: "seed-klide-2",
      path: "seed://klide/2",
      source: "klide",
      kind: "run",
      title: "Add a dark-mode toggle to the settings panel",
      status: "running",
      model: "llama3.1:8b",
      project: "KIDE",
      cwd: "/Users/you/KIDE",
      branch: "main",
      messageCount: 24,
      updatedMs: now - 6_000,
      createdMs: now - 12 * min,
    },
    {
      id: "seed-claude-1",
      path: "seed://claude-code/1",
      source: "claude-code",
      kind: "run",
      title: "Implement the color scheme tokens",
      status: "done",
      model: "claude-opus-4-8",
      project: "KIDE",
      cwd: "/Users/you/KIDE",
      branch: "main",
      messageCount: 14,
      updatedMs: now - 2 * min,
      createdMs: now - 12 * min,
      parentId: "seed-klide-2",
    },
    {
      id: "seed-opencode-1",
      path: "seed://opencode/1",
      source: "opencode",
      kind: "run",
      title: "Find CSS variable usage across components",
      status: "done",
      model: "opencode-go/minimax-m3",
      project: "KIDE",
      cwd: "/Users/you/KIDE",
      branch: "main",
      messageCount: 5,
      updatedMs: now - 5 * min,
      createdMs: now - 12 * min,
      parentId: "seed-klide-2",
    },
    {
      id: "seed-2",
      path: "seed://codex/2",
      source: "codex",
      kind: "run",
      title: "Refactor the terminal panel resize handle",
      status: "done",
      model: "gpt-5.5",
      project: "KIDE",
      cwd: "/Users/you/KIDE",
      branch: "main",
      messageCount: 11,
      updatedMs: now - 38 * min,
      createdMs: now - 38 * min,
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
