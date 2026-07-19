// Delegated tasks — Mission Control's todo list (Devin-style). A task starts
// life as a queued todo; "send an agent" dispatches a delegate CLI (claude /
// codex) that works on it async in the workspace while you observe / take
// over / stop. State lives at module level rather than in React so a running
// task survives switching views — the PTY on the Rust side outlives any
// component. Mission Control reads this store via useSyncExternalStore.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { readValidatedArray } from "./persistedStore";
import type { RunStatus } from "./runs";
import { isDelegateId, type DelegateId } from "./delegates";

// Every delegate can be dispatched to a task. Derives from the one delegate
// list so a new delegate is offerable without editing this file.
export type TaskSource = DelegateId;

export type TaskSession = {
  id: string;
  title: string;
  // null until an agent is sent — a plain todo wears the Klide mark.
  source: TaskSource | null;
  // The model the user picked in the dispatch dropdown. null when undispatched
  // or when the caller didn't pass a model (the CLI falls back to its own
  // default in that case). Persisted on the session so the detail pane can
  // re-show what the run was launched with.
  model: string | null;
  status: RunStatus;
  cwd: string | null;
  startedMs: number;
};

const TASKS_KEY = "klide.tasks";
const MAX_TASKS = 100;

function isRunStatus(value: unknown): value is RunStatus {
  return (
    value === "running" ||
    value === "waiting" ||
    value === "queued" ||
    value === "done" ||
    value === "cancelled" ||
    value === "error"
  );
}

function safeStatus(status: unknown): RunStatus {
  // PTY sessions are process-local. After an app restart, a previously
  // running task is only a durable work record, not a live terminal.
  if (status === "running" || status === "waiting") return "done";
  return isRunStatus(status) ? status : "queued";
}

function safeSource(source: unknown): TaskSource | null {
  return typeof source === "string" && isDelegateId(source) ? source : null;
}

function readTasks(): TaskSession[] {
  return readValidatedArray(
    TASKS_KEY,
    (task): task is Partial<TaskSession> & { id: string; title: string } =>
      !!task &&
      typeof task === "object" &&
      typeof (task as Partial<TaskSession>).id === "string" &&
      typeof (task as Partial<TaskSession>).title === "string",
  )
    .map((task) => ({
      id: task.id,
      title: task.title,
      source: safeSource(task.source),
      model: typeof task.model === "string" ? task.model : null,
      status: safeStatus(task.status),
      cwd: typeof task.cwd === "string" ? task.cwd : null,
      startedMs: typeof task.startedMs === "number" ? task.startedMs : Date.now(),
    }))
    .sort((a, b) => b.startedMs - a.startedMs)
    .slice(0, MAX_TASKS);
}

function persistTasks() {
  try {
    localStorage.setItem(TASKS_KEY, JSON.stringify(sessions.slice(0, MAX_TASKS)));
  } catch {
    /* storage full or unavailable */
  }
}

let sessions: TaskSession[] = readTasks();
// Raw PTY output per dispatched task, so re-opening a task replays its
// scrollback instead of showing a blank terminal.
const buffers = new Map<string, string>();
const subscribers = new Set<() => void>();

function emitChange() {
  for (const fn of subscribers) fn();
}

function patch(id: string, fields: Partial<TaskSession>) {
  if (!sessions.some((s) => s.id === id)) return;
  sessions = sessions.map((s) => (s.id === id ? { ...s, ...fields } : s));
  persistTasks();
  emitChange();
}

// One app-wide listener pair, attached lazily on first use. Data chunks only
// feed the replay buffer (the open terminal streams them itself); the exit
// event is what flips a task from running → done.
let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  void listen<{ sessionId: string; data: string }>("delegate-pty:data", (e) => {
    const { sessionId, data } = e.payload;
    // Ignore sessions we didn't start (e.g. AiPanel's own delegates).
    const existing = buffers.get(sessionId);
    if (existing === undefined) return;
    // TUI redraws accumulate fast — keep only the most recent output, or a
    // long-running agent grows the buffer (and every append) without bound.
    // Replays may open mid-escape-sequence; xterm recovers within a frame.
    const MAX_BUFFER = 200_000;
    let next = existing + data;
    if (next.length > MAX_BUFFER) next = next.slice(next.length - MAX_BUFFER);
    buffers.set(sessionId, next);
  });
  void listen<{ sessionId: string }>("delegate-pty:exit", (e) => {
    const id = e.payload.sessionId;
    if (buffers.has(id)) patch(id, { status: "done", startedMs: Date.now() });
  });
}

export function subscribeTasks(fn: () => void): () => void {
  wire();
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

export function getTaskSessions(): TaskSession[] {
  return sessions;
}

export function getTaskBuffer(id: string): string {
  return buffers.get(id) ?? "";
}

// The agent used for the previous dispatch — quick-send defaults to it so
// landing an agent on a todo is one click.
export function lastAgent(): TaskSource {
  const stored = localStorage.getItem("klide-last-agent");
  return stored && isDelegateId(stored) ? stored : "claude-code";
}

// The model last used for a given source, persisted separately per source so
// switching from Claude Sonnet to Codex gpt-5.4 to OpenCode minimax-m3 lands
// each new dispatch on the right model. Empty string means "let the CLI pick".
export function lastModel(source: TaskSource): string {
  return localStorage.getItem(`klide-last-model-${source}`) ?? "";
}

// Add a todo. Nothing runs yet — it sits in Queued until an agent is sent.
export function addTask(title: string, workspaceRoot: string | null): TaskSession {
  wire();
  const task: TaskSession = {
    id: crypto.randomUUID(),
    title,
    source: null,
    model: null,
    status: "queued",
    cwd: workspaceRoot,
    startedMs: Date.now(),
  };
  sessions = [task, ...sessions];
  persistTasks();
  emitChange();
  return task;
}

export async function startTask(
  source: TaskSource,
  title: string,
  workspaceRoot: string | null
): Promise<TaskSession> {
  const task = addTask(title, workspaceRoot);
  await dispatchTask(task.id, source);
  return getTaskSessions().find((s) => s.id === task.id) ?? task;
}

// Send an agent to a todo: spawn the delegate CLI in the task's workspace with
// the todo text as its first prompt. `model` is optional — the Rust side
// skips the model flag when None so each CLI falls back to its own default.
// Flips queued → running; on failure the task flips to error (and can be
// re-dispatched).
export async function dispatchTask(
  id: string,
  source: TaskSource,
  model?: string
): Promise<void> {
  const task = sessions.find((s) => s.id === id);
  if (!task || task.status === "running") return;
  localStorage.setItem("klide-last-agent", source);
  // Only persist non-empty selections so a quick-send with no model chosen
  // doesn't clobber a previously-saved preference.
  if (model && model.trim()) {
    localStorage.setItem(`klide-last-model-${source}`, model.trim());
  }
  buffers.set(id, "");
  patch(id, {
    source,
    model: model && model.trim() ? model.trim() : null,
    status: "running",
    startedMs: Date.now(),
  });
  try {
    await invoke("delegate_pty_spawn", {
      sessionId: id,
      provider: source,
      workspaceRoot: task.cwd,
      task: task.title,
      model: model && model.trim() ? model.trim() : null,
      parentRunId: id, // task is its own parent (task spawns delegate with same session id)
    });
  } catch (err) {
    patch(id, { status: "error" });
    throw err;
  }
}

// Interrupt a running task (Ctrl-C + exit on the Rust side). The PTY exit
// event confirms the flip to done; we set it eagerly so the UI reacts at once.
export async function stopTask(id: string): Promise<void> {
  await invoke("delegate_pty_stop", { sessionId: id });
  patch(id, { status: "done" });
}

export function renameTask(id: string, title: string): void {
  const nextTitle = title.trim();
  if (!nextTitle) return;
  patch(id, { title: nextTitle });
}

// Drop a task off the board (todos you no longer want, finished runs).
// Running tasks must be stopped first.
export function removeTask(id: string): void {
  const task = sessions.find((s) => s.id === id);
  if (!task || task.status === "running") return;
  sessions = sessions.filter((s) => s.id !== id);
  buffers.delete(id);
  persistTasks();
  emitChange();
}
