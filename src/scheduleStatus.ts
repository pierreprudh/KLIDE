// Nominate clock-started Runs for the existing app-wide attention and rail
// watchers, including when their conversation has no mounted panel.
import { listen } from "@tauri-apps/api/event";
import { listSchedules, type Schedule } from "./agent/schedules";
import { createListenerScope } from "./tauriEvents";
import { getKlideConvos, publishKlideConvo } from "./klideConvos";
import { notify } from "./toast";
import { errMessage } from "./errors";
import { openSchedule } from "./scheduleNavigation";

const runIds = new Set<string>();
export function isScheduledRun(id: string): boolean { return runIds.has(id); }

export function watchScheduleStatus(): () => void {
  const scope = createListenerScope();
  let stopped = false;
  const seen = new Map<string, Schedule["status"]>();
  const revisions = new Map<string, number>();
  const apply = (row: Schedule) => {
    if (stopped) return;
    if (row.revision !== undefined) {
      if ((revisions.get(row.id) ?? -1) >= row.revision) return;
      revisions.set(row.id, row.revision);
    }
    const previous = seen.get(row.id);
    seen.set(row.id, row.status);
    if (row.runId) runIds.add(row.runId);
    if (row.activeRunId) {
      const runId = row.activeRunId;
      runIds.add(runId);
      const convo = getKlideConvos().find(c => c.id === runId);
      publishKlideConvo({
        ...convo,
        id: runId, title: convo?.title ?? row.name,
        status: "running", provider: row.provider, model: row.model,
        cwd: row.workspaceRoot, branch: convo?.branch ?? null,
        messages: convo?.messages ?? [], updatedMs: Date.now(),
      });
    }
    // Live Run failures already reach the existing outcome watcher. Admission
    // failures and uncertain crash recovery have no Run event to report them.
    if (row.status === "failed" && previous !== "running" && previous !== "failed") {
      notify(`Scheduled message needs attention — ${row.error ?? row.text}`, {
        tone: "error", action: { label: "Open schedule", run: () => openSchedule(row.id) },
      });
    }
  };
  const registration = listen<Schedule>("schedule:changed", e => apply(e.payload));
  scope.add(registration);
  void registration.then(() => listSchedules()).then(rows => {
    for (const row of rows) apply(row);
  }).catch(error => { if (!stopped) notify(`Couldn't restore schedules: ${errMessage(error)}`, { tone: "error" }); });
  return () => { stopped = true; scope.dispose(); };
}
