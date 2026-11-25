import type { MachineSetupAction, MachineStatus } from "../../ipc/machines";
import type { SetupStep } from "./machineSetupSteps";

export type ChecklistRow = { step: SetupStep; label: string; caption: string; state: "done" | "waiting" | "needed" | "active" };
export type ChecklistAction = MachineSetupAction | "host";
export function machineGithubState(status: MachineStatus | null): NonNullable<MachineStatus["setup"]["github"]> {
  return status?.setup.github ?? (status?.facts.some((fact) => fact.label === "GitHub" && fact.tone === "ok") ? "ready" : "unknown");
}

export function machineSetupChecklist(status: MachineStatus | null, hasWorkspace: boolean, action: ChecklistAction | null): ChecklistRow[] {
  const setup = status?.setup;
  const connected = setup?.connection === "connected";
  const state = (ready: boolean, known: boolean): ChecklistRow["state"] => ready ? "done" : known ? "needed" : "waiting";
  const github = machineGithubState(status);
  const rows: ChecklistRow[] = [
    { step: "connection", label: "SSH connection", caption: connected ? "Connected" : "Connect machine", state: state(!!connected, !!status) },
    { step: "execution", label: "Execution", caption: setup?.execution === "missing" ? "Prepare isolation" : connected ? "Choose direct or isolated" : "Waiting", state: state(!!connected && setup?.execution !== "missing", !!connected) },
    { step: "software", label: "Klide helper", caption: setup?.host === "ready" ? "Installed" : setup?.host === "outdated" ? "Update needed" : connected ? "Not installed" : "Waiting", state: state(setup?.host === "ready", !!connected) },
    { step: "signIn", label: "Credentials", caption: setup?.claude === "ready" ? "Validated" : setup?.claude === "needsLogin" ? "Installed · sign in" : connected ? "Not installed" : "Waiting", state: state(setup?.claude === "ready", !!connected) },
    { step: "github", label: "GitHub", caption: setup?.githubScope === "repository" ? github === "ready" ? "Repository key configured" : "Repository access · optional" : github === "ready" ? "Signed in" : github === "needsLogin" ? "Installed · sign in" : github === "missing" ? "Not installed · optional" : "Not checked · optional", state: state(github === "ready", !!connected && github !== "unknown") },
    ...(hasWorkspace ? [{ step: "project" as const, label: "Project", caption: setup?.project === "ready" ? "Ready" : connected ? "Choose folder" : "Waiting", state: state(setup?.project === "ready", !!connected) }] : []),
    { step: "ready", label: "Ready to work", caption: status?.ready ? "All set" : "Setup remaining", state: status?.ready ? "done" : "waiting" },
  ];
  return rows.map((row) => {
    const active = (row.step === "connection" && (action === "connect" || action === "authorize")) ||
      (row.step === "execution" && (action === "isolate" || action === "installSandbox" || action === "sandboxLogin")) ||
      (row.step === "software" && action === "host") ||
      (action === "prepare" && ((row.step === "software" && row.state !== "done") || (row.step === "signIn" && setup?.claude === "missing") || (row.step === "github" && github === "missing"))) ||
      (row.step === "signIn" && action === "signIn" && row.state !== "done") ||
      (row.step === "github" && action === "gitHub" && row.state !== "done") || (row.step === "project" && action === "clone") || (row.step === "ready" && !!action);
    return active ? { ...row, state: "active", caption: row.step === "ready" ? "Finishing…" : row.step === "connection" ? "Connecting…" : action === "prepare" || action === "host" ? "Installing…" : action === "clone" ? "Cloning…" : "Signing in…" } : row;
  });
}
