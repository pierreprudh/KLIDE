// How many scheduled tasks are in the failed state right now — what Mission
// Control's row and its Scheduled tab say ("1 failed"). Read from the schedule
// store, kept current from the same `schedule:changed` event the app-wide
// watcher (src/scheduleStatus.ts) follows, and read whole again when the window
// comes back to the front — a removed schedule is simply absent from the list.
// No polling.

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { listSchedules, type Schedule } from "../agent/schedules";
import { createListenerScope } from "../tauriEvents";

/** Latest status per schedule, newer revisions only — a late event for an
 *  older revision never overwrites a newer one. */
export function applyScheduleRow(
  statuses: Map<string, { status: Schedule["status"]; revision: number }>,
  row: Pick<Schedule, "id" | "status" | "revision">,
): boolean {
  const revision = row.revision ?? 0;
  const known = statuses.get(row.id);
  if (known && known.revision > revision) return false;
  if (known && known.revision === revision && known.status === row.status) return false;
  statuses.set(row.id, { status: row.status, revision });
  return true;
}

export function countFailed(statuses: Map<string, { status: Schedule["status"] }>): number {
  let failed = 0;
  for (const { status } of statuses.values()) if (status === "failed") failed++;
  return failed;
}

export function useFailedScheduleCount(): number {
  const [failed, setFailed] = useState(0);
  useEffect(() => {
    const scope = createListenerScope();
    const statuses = new Map<string, { status: Schedule["status"]; revision: number }>();
    let stopped = false;
    const apply = (rows: Pick<Schedule, "id" | "status" | "revision">[]) => {
      if (stopped) return;
      let changed = false;
      for (const row of rows) changed = applyScheduleRow(statuses, row) || changed;
      if (changed) setFailed(countFailed(statuses));
    };
    const reload = () => {
      void listSchedules().then((rows) => {
        if (stopped) return;
        const present = new Set(rows.map((row) => row.id));
        for (const id of [...statuses.keys()]) if (!present.has(id)) statuses.delete(id);
        for (const row of rows) applyScheduleRow(statuses, row);
        setFailed(countFailed(statuses));
      }).catch(() => {});
    };
    const registration = listen<Schedule>("schedule:changed", (e) => apply([e.payload]));
    scope.add(registration);
    void registration.then(reload);
    window.addEventListener("focus", reload);
    return () => { stopped = true; scope.dispose(); window.removeEventListener("focus", reload); };
  }, []);
  return failed;
}
