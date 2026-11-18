import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openExternal } from "../../externalLink";
import { errMessage } from "../../errors";
import type { HostTarget, MachineSetupAction } from "../../ipc/machines";
import { plainSetupOutput, setupPrompt, setupSignIn } from "./machineSetupPrompts";
import { MachineSetupWaiting } from "./MachineSetupWaiting";
import { GhostButton } from "./controls";

const DetailsTerminal = lazy(() => import("./MachineSetupTerminal"));
const progress: Record<MachineSetupAction, string> = { connect: "Connecting to your machine", authorize: "Enabling background access", prepare: "Installing requirements", signIn: "Waiting for Claude sign-in", gitHub: "Waiting for GitHub sign-in", clone: "Cloning your project" };

export default function MachineSetupSession({ machineId, workspaceRoot, action, target, onDone }: {
  machineId: string; workspaceRoot: string | null; action: MachineSetupAction; target?: HostTarget;
  onDone: (success: boolean, output: string) => void;
}) {
  const [id] = useState(() => `machine-setup-${crypto.randomUUID()}`);
  const [output, setOutput] = useState("");
  const [finished, setFinished] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [interactive, setInteractive] = useState(false);
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [answered, setAnswered] = useState<string | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  const parsed = finished || answered === output ? null : setupPrompt(output);
  const signIn = setupSignIn(output, action);
  useEffect(() => { setValue(""); }, [parsed?.kind]);
  useEffect(() => {
    let disposed = false;
    let buffer = "";
    const cleanup: (() => void)[] = [];
    void (async () => {
      for (const [name, callback] of [
        ["pty:data", (event: { payload: { id: string; chunk: string } }) => {
          if (event.payload.id !== id || disposed) return;
          buffer = (buffer + event.payload.chunk).slice(-16384); setOutput(buffer);
        }],
        ["machine-setup:exit", (event: { payload: { id: string; success: boolean } }) => {
          if (event.payload.id !== id || disposed) return;
          setFinished(true); setValue(""); done.current(event.payload.success, buffer);
        }],
      ] as const) {
        const unlisten = await listen(name, callback as (event: { payload: unknown }) => void);
        if (disposed) { unlisten(); return; }
        cleanup.push(unlisten);
      }
      if (disposed) return;
      await invoke("machine_setup_spawn", { id: machineId, terminalId: id, action, workspaceRoot, rows: 24, cols: 80, target: action === "authorize" ? target ?? null : null });
      if (disposed) await invoke("machine_setup_close", { id });
    })().catch((reason) => { if (!disposed) { setError(errMessage(reason)); setFinished(true); done.current(false, errMessage(reason)); } });
    return () => { disposed = true; cleanup.forEach((fn) => fn()); void invoke("machine_setup_close", { id }).catch(() => {}); };
  }, [id, machineId, workspaceRoot, action, target?.os, target?.arch]);

  async function send(data: string) {
    if (finished || submitting) return;
    setSubmitting(true); setError(""); setValue("");
    try { await invoke("pty_write", { id, data }); setAnswered(output); }
    catch (reason) { setError(errMessage(reason)); }
    finally { setSubmitting(false); }
  }
  async function openSignIn() {
    if (!signIn.url) return;
    setError("");
    try { if (!await openExternal(signIn.url)) { setError("Could not open the sign-in page. Try again."); return; } if (parsed?.kind === "enter") await send("\r"); }
    catch (reason) { setError(errMessage(reason)); }
  }
  return <div className="klide-machine-session" data-details={showDetails}>
    {!showDetails && !finished && <div className="klide-machine-session-card">
      {parsed?.kind === "trust" ? <><h4>Trust this machine?</h4><p>Check its SSH fingerprint before connecting.</p><code className="klide-machine-fingerprint">{parsed.fingerprint ?? "Open Details to review the fingerprint."}</code><div className="klide-machine-actions"><GhostButton disabled={submitting || !parsed.fingerprint} onClick={() => { void send("yes\r"); }}>Trust and connect</GhostButton><GhostButton disabled={submitting} onClick={() => { void send("no\r"); }}>Cancel</GhostButton></div></> :
      parsed && ["password", "passphrase", "code"].includes(parsed.kind) ? <form onSubmit={(event) => { event.preventDefault(); if (value) void send(`${value}\r`); }}>
        <label>{parsed.kind === "password" ? "Machine password" : parsed.kind === "passphrase" ? "SSH key passphrase" : "Authorization code"}<input key={parsed.kind} className="klide-field" type="password" value={value} onChange={(event) => setValue(event.target.value)} autoFocus autoComplete="off" disabled={submitting} /></label>
        <p>{parsed.kind === "code" ? "Paste the code from the sign-in page." : "Used for this connection only. Klide does not save it."}</p>
        <button type="submit" className="klide-button klide-button-secondary" disabled={submitting || !value}>Continue</button>
      </form> : parsed?.kind === "confirm" ? <><p>{parsed.message}</p><div className="klide-machine-actions"><GhostButton disabled={submitting} onClick={() => { void send("y\r"); }}>Continue</GhostButton><GhostButton disabled={submitting} onClick={() => { void send("n\r"); }}>No</GhostButton></div></> : parsed?.kind === "interactive" ? <><p>This step needs an interactive response.</p><GhostButton onClick={() => { setInteractive(true); setShowDetails(true); }}>Open interactive prompt</GhostButton></> : <MachineSetupWaiting>{progress[action]}</MachineSetupWaiting>}
      {signIn.url && <div className="klide-machine-browser-signin">{signIn.deviceCode && <p>Sign-in code: <code>{signIn.deviceCode}</code></p>}<GhostButton disabled={submitting} onClick={() => { void openSignIn(); }}>Open sign-in page</GhostButton></div>}
      {parsed?.kind === "enter" && !signIn.url && <GhostButton disabled={submitting} onClick={() => { void send("\r"); }}>Continue</GhostButton>}
    </div>}
    {error && <p className="klide-add-machine-error" role="alert">{error}</p>}
    {showDetails && (interactive ? <Suspense fallback={<MachineSetupWaiting>Opening interactive prompt</MachineSetupWaiting>}><DetailsTerminal id={id} output={output} onInput={(data) => { if (!finished) void invoke("pty_write", { id, data }).catch((reason) => setError(errMessage(reason))); }} /></Suspense> : <pre className="klide-machine-log" aria-label="Setup details">{plainSetupOutput(output) || "Waiting for setup output…"}</pre>)}
    {(showDetails || parsed?.kind !== "interactive") && <div className="klide-machine-session-tools"><GhostButton onClick={() => { setInteractive(false); setShowDetails((shown) => !shown); }}>{showDetails ? "Hide details" : "Show details"}</GhostButton></div>}
  </div>;
}
