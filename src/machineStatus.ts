// Remote machine readiness, checked ahead of time.
//
// The picker must open instantly, like an environment switch, so nobody waits
// on an SSH round trip to see it. Focus asks for a refresh when the start stage
// appears (and the menu asks again when opened); the last answer stays on
// screen while a new one is fetched. One check in flight per (machine,
// workspace) at a time.
import { machineCheck, type MachineStatus } from "./ipc/machines";
import { errMessage } from "./errors";

export type MachineCheck =
  | { state: "checking"; last: MachineStatus | null }
  | { state: "done"; status: MachineStatus; at: number }
  | { state: "failed"; error: string; at: number };

const checks = new Map<string, MachineCheck>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();
/** A fresh answer is reused for this long before a refresh asks again. */
const FRESH_MS = 20_000;

const key = (id: string, root: string | null) => `${id}\u0000${root ?? ""}`;

export function machineStatusCheck(id: string, root: string | null): MachineCheck | undefined {
  return checks.get(key(id, root));
}

/** The last status we know, even while a newer one is being fetched. */
export function lastKnownStatus(check: MachineCheck | undefined): MachineStatus | null {
  if (!check) return null;
  if (check.state === "done") return check.status;
  if (check.state === "checking") return check.last;
  return null;
}

export function refreshMachineStatus(id: string, root: string | null, opts?: { force?: boolean }): void {
  const k = key(id, root);
  if (inFlight.has(k)) return;
  const prev = checks.get(k);
  if (!opts?.force && prev && prev.state !== "checking" && Date.now() - prev.at < FRESH_MS) return;
  inFlight.add(k);
  checks.set(k, { state: "checking", last: lastKnownStatus(prev) });
  announce();
  machineCheck(id, root)
    .then((status) => checks.set(k, { state: "done", status, at: Date.now() }))
    .catch((e) => checks.set(k, { state: "failed", error: errMessage(e), at: Date.now() }))
    .finally(() => {
      inFlight.delete(k);
      announce();
    });
}

let version = 0;

/** Bumps on every change — a `useSyncExternalStore` snapshot. */
export function machineStatusVersion(): number {
  return version;
}

function announce(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeMachineStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
