import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { type Machine, type MachineStatus, type MachineSetupAction, type HostTarget, machineRepositoryConfigure, machineRepositoryContext } from "../../ipc/machines";
import { errMessage } from "../../errors";
import { canVisitMachineSetupStep, machineSetupStep, type SetupStep } from "./machineSetupSteps";
import { MachineSetupWaiting } from "./MachineSetupWaiting";
import { machineSetupFailure } from "./machineSetupFailure";
import { machineProjectClonePath } from "./machineProjectPath";
import { MachineSshFields } from "./MachineSshFields";
import { canConnectSshAddress } from "./machineSshAddress";
import { machineGithubState } from "./machineChecklistState";
import { MachineSetupChecklist } from "./MachineSetupChecklist";
import { GhostButton } from "./controls";
const SetupSession = lazy(() => import("./MachineSetupSession"));
const FolderExplorer = lazy(() => import("./RemoteFolderExplorer"));
const Credentials = lazy(() => import("./MachineCredentials").then((module) => ({ default: module.MachineCredentials })));
const RepositoryAccess = lazy(() => import("./RemoteRepositoryAccess"));

export function MachineSetup({ machine, status, checking, workspaceRoot, onCheck, onInstall, onProject, onConnection, onClose }: {
  machine: Machine; status: MachineStatus | null; checking: boolean; workspaceRoot: string | null;
  onCheck: () => void; onInstall: () => Promise<boolean>;
  onProject: (path: string) => Promise<void>; onClose: () => void;
  onConnection: (host: string) => Promise<void>;
}) {
  const automaticStep = machineSetupStep(status, !!workspaceRoot);
  const [selectedStep, setSelectedStep] = useState<SetupStep | null>(null);
  const [action, setAction] = useState<MachineSetupAction | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [running, setRunning] = useState(false);
  const [working, setWorking] = useState(false);
  const [installingHost, setInstallingHost] = useState(false);
  const [actionStep, setActionStep] = useState<SetupStep | null>(null);
  const step = running && actionStep ? actionStep : selectedStep && canVisitMachineSetupStep(selectedStep, status, !!workspaceRoot) ? selectedStep : automaticStep;
  const checkRef = useRef(onCheck); checkRef.current = onCheck;
  const [progress, setProgress] = useState("");
  const [note, setNote] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [path, setPath] = useState(machine.checkouts?.[workspaceRoot ?? ""] ?? "~/code");
  const [projectName, setProjectName] = useState(workspaceRoot?.split("/").filter(Boolean).pop() ?? "project");
  const [loadingProjectName, setLoadingProjectName] = useState(false);
  const [offlineTarget, setOfflineTarget] = useState("linux:x86_64");
  const [host, setHost] = useState(machine.sshHost);
  const savedCheckout = machine.checkouts?.[workspaceRoot ?? ""];
  useEffect(() => { setHost(machine.sshHost); }, [machine.sshHost]);
  useEffect(() => { setPath(savedCheckout ?? "~/code"); }, [savedCheckout, workspaceRoot]);
  useEffect(() => {
    let disposed = false;
    setProjectName(workspaceRoot?.split("/").filter(Boolean).pop() ?? "project");
    if (!workspaceRoot || status?.setup.githubScope !== "repository") { setLoadingProjectName(false); return; }
    setLoadingProjectName(true);
    void machineRepositoryContext(workspaceRoot).then((context) => {
      if (!disposed) setProjectName(context.repository.split("/").pop()!);
    }).catch(() => { /* Non-GitHub projects use the local project folder name. */ })
      .finally(() => { if (!disposed) setLoadingProjectName(false); });
    return () => { disposed = true; };
  }, [workspaceRoot, status?.setup.githubScope]);
  const clonePath = machineProjectClonePath(path, projectName, status?.target?.os === "windows");
  const target = status?.target;
  const selectedTarget = target ?? { os: offlineTarget.split(":")[0], arch: offlineTarget.split(":")[1] } as HostTarget;
  const githubState = machineGithubState(status);
  const system = target?.os === "macos" ? "macOS" : target?.os === "windows" ? "Windows" : "Linux";
  const busy = checking || running || working;
  useEffect(() => { setAction(null); setRunning(false); setNote(""); }, [step]);
  useEffect(() => {
    if ((!running && !working) || checking || status?.setup.connection !== "connected") return;
    const timer = window.setTimeout(() => checkRef.current(), 2500);
    return () => window.clearTimeout(timer);
  }, [running, working, checking, status]);
  function start(next: MachineSetupAction) { setActionStep(step); setNote(""); setAttempt((value) => value + 1); setRunning(true); setAction(next); }
  async function connect(next: "connect" | "authorize" = "connect") {
    if (!canConnectSshAddress(host)) { setNote("Enter the remote account’s username before connecting."); return; }
    setNote(""); setProgress("Saving SSH connection"); setWorking(true);
    try {
      if (host.trim() !== machine.sshHost) await onConnection(host.trim());
      start(next);
    } catch (reason) { setNote(errMessage(reason)); }
    finally { setWorking(false); }
  }
  async function complete(success: boolean, output: string) {
    setRunning(false);
    if (!success) { setNote(machineSetupFailure(action!, output)); return; }
    if (action === "authorize") { start("connect"); return; }
    if (action === "connect") setNote("SSH connected. Background tasks also require an unlocked SSH key accepted by this account.");
    if (action === "prepare") {
      if (status?.setup.host === "ready") { setSelectedStep(null); onCheck(); }
      else if (await installHost()) setSelectedStep(null);
    } else { setSelectedStep(null); onCheck(); }
  }
  async function installHost() {
    setProgress("Downloading and installing the Klide helper"); setWorking(true); setInstallingHost(true);
    try { return await onInstall(); } finally { setInstallingHost(false); setWorking(false); }
  }
  async function download() {
    setProgress("Downloading setup files"); setWorking(true); setNote("");
    try { await invoke("machine_prepare_host", { target: selectedTarget }); setNote("Setup files are saved on this Mac. Turn on the machine and continue here when you’re ready."); }
    catch (reason) { setNote(errMessage(reason)); }
    finally { setWorking(false); }
  }
  async function saveProject() {
    setProgress("Saving the remote folder"); setWorking(true); setNote("");
    try {
      if (status?.setup.githubScope == null) throw new Error("Restart Klide to load repository-only setup.");
      if (workspaceRoot && status?.setup.githubScope === "repository") await machineRepositoryConfigure(machine.id, workspaceRoot, path.trim());
      await onProject(path.trim());
    }
    catch (reason) { setNote(errMessage(reason)); }
    finally { setWorking(false); }
  }
  async function cloneProject() {
    setWorking(true); setNote("");
    try { if (status?.setup.githubScope == null) throw new Error("Restart Klide to load repository-only setup."); await onProject(clonePath); start("clone"); }
    catch (reason) { setNote(errMessage(reason)); }
    finally { setWorking(false); }
  }
  async function saveCurrentStep() {
    if (step === "connection" && host.trim() !== machine.sshHost) {
      if (!canConnectSshAddress(host)) throw new Error("Enter the remote account’s username before saving.");
      await onConnection(host.trim());
    }
    if (step === "project" && path.trim() !== (savedCheckout ?? status?.checkout)) {
      if (!path.trim()) throw new Error("Enter a remote folder before saving.");
      await onProject(path.trim());
    }
  }
  async function changeStep(next: SetupStep) {
    setProgress("Saving machine setup"); setWorking(true); setNote("");
    try { await saveCurrentStep(); setSelectedStep(next); }
    catch (reason) { setNote(errMessage(reason)); }
    finally { setWorking(false); }
  }
  async function saveAndClose() {
    setProgress("Saving machine setup"); setWorking(true); setNote("");
    try {
      await saveCurrentStep();
      onClose();
    } catch (reason) { setNote(errMessage(reason)); }
    finally { setWorking(false); }
  }
  return <section className="klide-machine-setup" aria-label={`Set up ${machine.label ?? machine.id}`}>
    <MachineSetupChecklist status={status} workspace={!!workspaceRoot} active={step} action={running ? action : installingHost ? "host" : null} busy={busy} onSelect={(next) => { void changeStep(next); }} />
    <div className="klide-machine-setup-pane">
    <div className="klide-machine-setup-copy" aria-live="polite">
      {step === "connection" && status?.setup.connection === "unsupported" && <><h3>Machine not supported yet</h3><p role="alert">{status.caption}</p><p>Available hosts: Linux on Intel / AMD, macOS on Apple silicon or Intel, and Windows on Intel / AMD.</p></>}
      {step === "connection" && status?.setup.connection !== "unsupported" && <><h3>Connect to your machine</h3><p>Use the account you sign in with on this machine.</p><MachineSshFields value={host} onChange={setHost} disabled={busy} />{!action && advanced && <label className="klide-machine-project">Machine system<select className="klide-field" value={target ? `${target.os}:${target.arch}` : offlineTarget} disabled={busy || !!target} onChange={(e) => setOfflineTarget(e.target.value)}><option value="linux:x86_64">Linux · Intel / AMD</option><option value="macos:aarch64">macOS · Apple silicon</option><option value="macos:x86_64">macOS · Intel</option><option value="windows:x86_64">Windows · Intel / AMD</option></select></label>}<div className="klide-machine-actions" hidden={running}><GhostButton disabled={busy || !canConnectSshAddress(host)} onClick={() => { void connect(); }}>Connect with SSH</GhostButton>{selectedTarget.os !== "windows" && <GhostButton disabled={busy || !canConnectSshAddress(host)} onClick={() => { void connect("authorize"); }}>Enable background access</GhostButton>}{!action && advanced && <GhostButton disabled={busy} onClick={() => { void download(); }}>Prepare setup files on this Mac</GhostButton>}</div>{!action && <GhostButton disabled={busy} onClick={() => setAdvanced((open) => !open)}>{advanced ? "Hide advanced options" : "Advanced options"}</GhostButton>}</>}
      {step === "software" && <><h3>Prepare this machine</h3><p>Install missing components on {system}. Your work and logins stay on this machine.</p><p>{target?.os === "macos" ? "Apple silicon and Intel Macs · Git needs Apple Command Line Tools." : target?.os === "windows" ? "Native Windows over OpenSSH · Git and GitHub CLI use winget." : "Ubuntu 24.04+ / Debian 13+ · Intel / AMD."}</p><div className="klide-machine-actions" hidden={running}><GhostButton disabled={busy} onClick={() => start("prepare")}>Install and continue</GhostButton>{status?.setup.claude !== "missing" && <GhostButton disabled={busy} onClick={() => { void installHost(); }}>Install Klide helper only</GhostButton>}</div></>}
      {step === "signIn" && <Suspense fallback={<MachineSetupWaiting>Loading credential choices</MachineSetupWaiting>}><Credentials machine={machine} status={status} disabled={busy} onSignIn={() => start("signIn")} onProtect={() => start("protectKeys")} onCheck={onCheck} /></Suspense>}
      {step === "github" && <><h3>{status?.setup.githubScope === "repository" ? "Repository access" : "Connect GitHub"}</h3>{status?.setup.githubScope === "repository" && workspaceRoot ? <Suspense fallback={<MachineSetupWaiting>Checking repository access</MachineSetupWaiting>}><RepositoryAccess machineId={machine.id} workspaceRoot={workspaceRoot} ready={githubState === "ready"} onChange={onCheck} /></Suspense> : status?.setup.githubScope === "repository" ? <p>Open a project to connect access for that repository only. Personal GitHub login is not stored on this machine.</p> : status?.setup.githubScope == null ? <p>Restart Klide to load repository-only setup. Personal GitHub sign-in is unavailable in this older running app.</p> : <><p>{githubState === "missing" ? "GitHub CLI is not installed. It is optional for running Claude Code." : githubState === "unknown" ? "Check GitHub availability on this machine." : githubState === "ready" ? "GitHub is signed in on this machine. You can reconnect your account here." : "GitHub CLI is already installed. Sign in to use private repositories."}</p><div className="klide-machine-actions" hidden={running}>{githubState === "missing" ? <GhostButton disabled={busy || !canVisitMachineSetupStep("software", status, !!workspaceRoot)} onClick={() => { void changeStep("software"); }}>Installation options</GhostButton> : githubState === "unknown" ? <GhostButton disabled={busy} onClick={onCheck}>Check GitHub</GhostButton> : <GhostButton disabled={busy} onClick={() => start("gitHub")}>Sign in to GitHub</GhostButton>}</div></>}</>}
      {step === "project" && <><h3>Choose the remote project</h3>{browsing ? <Suspense fallback={<MachineSetupWaiting>Opening remote folders</MachineSetupWaiting>}><FolderExplorer machineId={machine.id} onChoose={(folder) => { setPath(folder); setBrowsing(false); }} onCancel={() => setBrowsing(false)} /></Suspense> : <><p>Choose where to create the project folder, or select an existing checkout.</p><label className="klide-machine-project">Remote folder<input className="klide-field" value={path} onChange={(e) => setPath(e.target.value)} disabled={busy} placeholder="~/code" /></label><GhostButton disabled={busy} onClick={() => { if (status?.setup.githubScope == null) setNote("Restart Klide to load remote folder browsing."); else setBrowsing(true); }}>Browse folders</GhostButton><div className="klide-machine-actions" hidden={running}><GhostButton disabled={busy || !path.trim()} onClick={() => { void saveProject(); }}>Use this folder</GhostButton><GhostButton disabled={busy || loadingProjectName || !path.trim()} onClick={() => { void cloneProject(); }}>Clone project here</GhostButton>{status?.setup.githubScope !== "account" ? <GhostButton disabled={busy} onClick={() => { void changeStep("github"); }}>Repository access</GhostButton> : <GhostButton disabled={busy} onClick={() => start("gitHub")}>Sign in to GitHub</GhostButton>}</div>{!running && !loadingProjectName && path.trim() && <p>Clone destination: <strong>{clonePath}</strong></p>}<p>{status?.setup.githubScope === "repository" ? "Git author identity and repository access are saved to this checkout only." : "Private repositories use the remote machine’s Git credentials."}</p></>}</>}
      {step === "ready" && <><h3>{workspaceRoot ? "Ready for remote tasks" : "Machine ready"}</h3><p>{workspaceRoot ? "Select this machine in “Where it runs”, then pick Claude Code or Kit on one of its API keys. Reopen the conversation later to replay its output and stream live progress." : "Open a local project, then return here to choose its remote folder."} The remote machine must stay on.</p><GhostButton disabled={busy} onClick={onClose}>Done</GhostButton></>}
      {(working || checking) && <MachineSetupWaiting>{working ? progress : "Checking the machine"}</MachineSetupWaiting>}
      {note && <p role="status">{note}</p>}
    </div>
    {action && <Suspense fallback={<MachineSetupWaiting>Starting setup</MachineSetupWaiting>}><SetupSession key={attempt} machineId={machine.id} workspaceRoot={workspaceRoot} action={action} target={action === "authorize" ? selectedTarget : undefined} onDone={(success, output) => { void complete(success, output); }} /></Suspense>}
    <div className="klide-machine-actions klide-machine-setup-footer">{running ? <GhostButton onClick={() => { setAction(null); setRunning(false); setNote("Setup cancelled. Your saved connection is kept."); }}>Cancel setup</GhostButton> : <GhostButton disabled={busy} onClick={onCheck}>{checking ? "Checking…" : "Check again"}</GhostButton>}{step !== "ready" && <GhostButton disabled={running || working} onClick={() => { void saveAndClose(); }}>Save for later</GhostButton>}</div>
    </div>
  </section>;
}
