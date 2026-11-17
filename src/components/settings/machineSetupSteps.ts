import type { MachineStatus } from "../../ipc/machines";
export type SetupStep = "connection" | "software" | "signIn" | "project" | "ready";
/** Later steps remain unknown until SSH succeeds. A cached fact is never readiness. */
export function machineSetupStep(status: MachineStatus | null, hasWorkspace: boolean): SetupStep {
  if (!status || status.setup.connection !== "connected") return "connection";
  if (status.setup.host !== "ready" || status.setup.claude === "missing" || status.setup.claude === "unknown") return "software";
  if (status.setup.claude !== "ready") return "signIn";
  if (hasWorkspace && status.setup.project !== "ready") return "project";
  return status.ready ? "ready" : "connection";
}
