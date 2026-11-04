import { invoke } from "@tauri-apps/api/core";
import { toStartRunRequest } from "./client";
import type { StartAgentRunInput } from "./types";

export type ExecutionTarget = { kind: "local" } | { kind: "remote"; machine_id: string };
export type ScheduleService = {
  supported: boolean; installed: boolean; running: boolean; compatible: boolean;
  pid: number | null; error: string | null;
};

export type Schedule = {
  id: string;
  revision?: number;
  target: ExecutionTarget;
  name: string;
  runId: string | null;
  activeRunId: string | null;
  text: string;
  provider: StartAgentRunInput["provider"];
  model: string;
  mode: StartAgentRunInput["mode"];
  workspaceRoot: string | null;
  dueAt: number;
  intervalMs: number | null;
  status: "pending" | "dispatching" | "running" | "completed" | "failed" | "paused" | "cancelled";
  error: string | null;
};

export function createSchedule(input: StartAgentRunInput, dueAt: number, intervalMs: number | null, name?: string, target: ExecutionTarget = { kind: "local" }): Promise<Schedule> {
  return invoke("agent_schedule_create", { request: toStartRunRequest(input), dueAt, intervalMs, name, target });
}

export function updateSchedule(id: string, input: StartAgentRunInput, dueAt: number, intervalMs: number | null, name: string, target: ExecutionTarget = { kind: "local" }): Promise<Schedule> {
  return invoke("agent_schedule_update", { id, request: toStartRunRequest(input), dueAt, intervalMs, name, target });
}

export type ScheduledRun = {
  runId: string; scheduledAt: number; startedAt: number; finishedAt: number | null;
  status: Schedule["status"]; error: string | null;
  target: ExecutionTarget;
};

export function scheduleHistory(id: string): Promise<ScheduledRun[]> {
  return invoke("agent_schedule_history", { id });
}

export function listSchedules(runId?: string): Promise<Schedule[]> {
  return invoke("agent_schedule_list", { runId });
}

export function scheduleAction(id: string, action: "pause" | "resume" | "run_now" | "cancel" | "remove"): Promise<void> {
  return invoke("agent_schedule_action", { id, action });
}

export function scheduleServiceStatus(): Promise<ScheduleService> { return invoke("agent_schedule_service_status"); }
export function enableScheduleService(): Promise<ScheduleService> { return invoke("agent_schedule_service_enable"); }

/** A socket event and a desktop read may complete in either order. */
export function mergeScheduleRows(current: Schedule[], incoming: Schedule[]): Schedule[] {
  const rows = new Map(current.map(row => [row.id, row]));
  for (const row of incoming) {
    if ((rows.get(row.id)?.revision ?? -1) <= (row.revision ?? 0)) rows.set(row.id, row);
  }
  return [...rows.values()];
}

/** datetime-local uses the user's zone, while the saved clock uses UTC ms. */
export function localScheduleTime(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
