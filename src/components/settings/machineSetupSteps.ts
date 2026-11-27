import type { MachineStatus } from "../../ipc/machines";
export type SetupStep = "connection" | "software" | "signIn" | "github" | "project" | "ready";
const order: SetupStep[] = ["connection", "software", "signIn", "github", "project", "ready"];
/** Completed steps remain editable; later steps still require their prerequisites. */
export function canVisitMachineSetupStep(step: SetupStep, status: MachineStatus | null, hasWorkspace: boolean): boolean {
  if (step === "project" && !hasWorkspace) return false;
  if (step === "github" || step === "signIn") return status?.setup.connection === "connected";
  return order.indexOf(step) <= order.indexOf(machineSetupStep(status, hasWorkspace));
}
export function machineCredentialsReady(status: MachineStatus | null): boolean {
  return status?.setup.credentials ? status.setup.credentials === "ready" : status?.setup.claude === "ready";
}
/** Later steps remain unknown until SSH succeeds. A cached fact is never readiness. */
export function machineSetupStep(status: MachineStatus | null, hasWorkspace: boolean): SetupStep {
  if (!status || status.setup.connection !== "connected") return "connection";
  // An API key is enough to work: Kit runs without Claude Code installed.
  if (status.setup.host !== "ready" || ((status.setup.claude === "missing" || status.setup.claude === "unknown") && !status.setup.apiKeys?.length)) return "software";
  if (!machineCredentialsReady(status)) return "signIn";
  if (hasWorkspace && status.setup.project !== "ready") return "project";
  return status.ready ? "ready" : "connection";
}
