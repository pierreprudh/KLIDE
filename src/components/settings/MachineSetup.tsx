import { lazy, Suspense, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { type Machine, type MachineStatus, type MachineSetupAction } from "../../ipc/machines";
import { errMessage } from "../../errors";
import { machineSetupStep, type SetupStep } from "./machineSetupSteps";
import { MachineSetupWaiting } from "./MachineSetupWaiting";
import { GhostButton } from "./controls";
const SetupTerminal = lazy(() => import("./MachineSetupTerminal"));
const steps: { id: SetupStep; label: string }[] = [{ id: "connection", label: "Connect" }, { id: "software", label: "Install" }, { id: "signIn", label: "Sign in" }, { id: "project", label: "Project" }, { id: "ready", label: "Ready" }];

export function MachineSetup({ machine, status, checking, workspaceRoot, onCheck, onInstall, onProject, onClose }: {
  machine: Machine; status: MachineStatus | null; checking: boolean; workspaceRoot: string | null;
  onCheck: () => void; onInstall: () => Promise<boolean>;
  onProject: (path: string) => Promise<void>; onClose: () => void;
}) {
  const step = machineSetupStep(status, !!workspaceRoot);
  const [action, setAction] = useState<MachineSetupAction | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [running, setRunning] = useState(false);
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState("");
  const [note, setNote] = useState("");
  const [path, setPath] = useState(status?.checkout ?? machine.checkouts?.[workspaceRoot ?? ""] ?? `~/code/${workspaceRoot?.split("/").filter(Boolean).pop() ?? "project"}`);
  const busy = checking || running || working;
  function start(next: MachineSetupAction) { setNote(""); setAttempt((value) => value + 1); setRunning(true); setAction(next); }
  async function complete(success: boolean) {
    setRunning(false);
    if (!success) { setNote("Setup stopped. Review the terminal output, then retry when you’re ready."); return; }
    if (action === "prepare") {
      setProgress("Downloading and installing the Klide helper"); setWorking(true);
      try { await onInstall(); } finally { setWorking(false); }
    } else onCheck();
  }
  async function download() {
    setProgress("Downloading setup files"); setWorking(true); setNote("");
    try { await invoke("machine_prepare_host"); setNote("Setup files are saved on this Mac. Turn on the machine and continue here when you’re ready."); }
    catch (reason) { setNote(errMessage(reason)); }
    finally { setWorking(false); }
  }
  async function saveProject() {
    setProgress("Saving the remote folder"); setWorking(true); setNote("");
    try { await onProject(path.trim()); }
    catch (reason) { setNote(errMessage(reason)); }
    finally { setWorking(false); }
  }
  return <section className="klide-machine-setup" aria-label={`Set up ${machine.label ?? machine.id}`}>
    <ol className="klide-machine-steps" aria-label="Setup progress">{steps.filter((s) => workspaceRoot || s.id !== "project").map((s) => <li key={s.id} aria-current={s.id === step ? "step" : undefined}>{s.label}</li>)}</ol>
    <div aria-live="polite">
      {step === "connection" && <><h3>Connect to {machine.sshHost}</h3><p>Your setup is saved. Turn on the machine to continue. Confirm the SSH fingerprint or unlock your key in the terminal below.</p><p>Klide uses your SSH config and keys. An unlocked SSH key or agent is required for background connections.</p><div className="klide-machine-actions"><GhostButton disabled={busy} onClick={() => start("connect")}>Connect with SSH</GhostButton><GhostButton disabled={busy} onClick={() => { void download(); }}>Prepare setup files on this Mac</GhostButton></div></>}
      {step === "software" && <><h3>Prepare this machine</h3><p>Install the Linux prerequisites, Claude Code and Klide’s matching helper. Tasks will keep running here when your Mac is off.</p><p>Ubuntu 24.04+ / Debian 13+ · x86_64. The terminal may ask for sudo. Your remote logins stay on this machine.</p><details><summary>Installation commands</summary><code>sudo apt-get update &amp;&amp; sudo apt-get install -y git curl gh libwebkit2gtk-4.1-0<br />curl -fsSL https://claude.ai/install.sh | bash</code></details><div className="klide-machine-actions"><GhostButton disabled={busy} onClick={() => start("prepare")}>Install and continue</GhostButton>{status?.setup.claude !== "missing" && <GhostButton disabled={busy} onClick={() => { setProgress("Downloading and installing the Klide helper"); setWorking(true); void onInstall().finally(() => setWorking(false)); }}>Install Klide helper only</GhostButton>}</div></>}
      {step === "signIn" && <><h3>Sign in to Claude Code</h3><p>Use the link shown in the terminal to sign in, then return here to finish. This login belongs to the remote machine.</p><GhostButton disabled={busy} onClick={() => start("signIn")}>Sign in on this machine</GhostButton></>}
      {step === "project" && <><h3>Choose the remote project</h3><p>Use an existing Git checkout, or save a destination and clone this project’s origin there.</p><label className="klide-machine-project">Remote folder<input className="klide-field" value={path} onChange={(e) => setPath(e.target.value)} disabled={busy} placeholder="~/code/project" /></label><div className="klide-machine-actions"><GhostButton disabled={busy || !path.trim()} onClick={() => { void saveProject(); }}>Use this folder</GhostButton><GhostButton disabled={busy || path.trim() !== status?.checkout} onClick={() => start("clone")}>Clone project here</GhostButton><GhostButton disabled={busy} onClick={() => start("gitHub")}>Sign in to GitHub</GhostButton></div><p>Private repositories use the remote machine’s Git credentials.</p></>}
      {step === "ready" && <><h3>{workspaceRoot ? "Ready for remote tasks" : "Machine ready"}</h3><p>{workspaceRoot ? "Select this machine in “Where it runs” when starting a Claude Code conversation. Reopen the conversation later to replay its output and stream live progress." : "Open a local project, then return here to choose its remote folder."} The remote machine must stay on.</p><GhostButton disabled={busy} onClick={onClose}>Done</GhostButton></>}
      {(working || checking || running) && <MachineSetupWaiting>{working ? progress : checking ? "Checking the machine" : action === "connect" ? "Waiting for SSH connection" : "Complete the prompts in the remote terminal"}</MachineSetupWaiting>}
      {note && <p role="status">{note}</p>}
    </div>
    {action && <Suspense fallback={<MachineSetupWaiting>Opening remote terminal</MachineSetupWaiting>}><SetupTerminal key={attempt} machineId={machine.id} workspaceRoot={workspaceRoot} action={action} onDone={(success) => { void complete(success); }} /></Suspense>}
    <div className="klide-machine-actions">{running ? <GhostButton onClick={() => { setAction(null); setRunning(false); setNote("Setup terminal closed. Check the connection to see what completed."); }}>Close setup terminal</GhostButton> : <GhostButton disabled={busy} onClick={onCheck}>{checking ? "Checking…" : "Check again"}</GhostButton>}{step !== "ready" && <GhostButton disabled={running || working} onClick={onClose}>Save for later</GhostButton>}</div>
  </section>;
}
