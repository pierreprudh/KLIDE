import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Terminal } from "@xterm/xterm";
import { openExternal } from "../../externalLink";
import { errMessage } from "../../errors";
import type { HostTarget, MachineSetupAction } from "../../ipc/machines";
import { plainSetupOutput, setupPrompt, setupSignIn } from "./machineSetupPrompts";
import { MachineSetupWaiting } from "./MachineSetupWaiting";
import { GhostButton } from "./controls";
import { CheckIcon } from "../../icons";

const DetailsTerminal = lazy(() => import("./MachineSetupTerminal"));
const progress: Record<MachineSetupAction, string> = { isolate: "Creating isolated environment", installSandbox: "Installing Docker Sandboxes", sandboxLogin: "Signing in to Docker", connect: "Connecting to your machine", authorize: "Enabling background access", prepare: "Installing requirements", signIn: "Waiting for Claude sign-in", gitHub: "Waiting for GitHub sign-in", clone: "Cloning your project" };

export default function MachineSetupSession({ machineId, workspaceRoot, action, target, onDone }: {
  machineId: string; workspaceRoot: string | null; action: MachineSetupAction; target?: HostTarget;
  onDone: (success: boolean, output: string) => void;
}) {
  const [id] = useState(() => `machine-setup-${crypto.randomUUID()}`);
  const [output, setOutput] = useState("");
  const [finished, setFinished] = useState(false);
  const [showDetails, setShowDetails] = useState(action === "gitHub");
  const [interactive, setInteractive] = useState(false);
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [answered, setAnswered] = useState<string | null>(null);
  const [terminal, setTerminal] = useState<Terminal | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const log = useRef<HTMLPreElement>(null);
  const done = useRef(onDone);
  done.current = onDone;
  const parsed = finished || answered === output ? null : setupPrompt(output);
  const signIn = setupSignIn(output, action);
  useEffect(() => { setValue(""); }, [parsed?.kind]);
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [output, showDetails]);
  useEffect(() => {
    let disposed = false;
    let exited = false;
    let buffer = "";
    let emulator: Terminal | null = null;
    let completionTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup: (() => void)[] = [];
    void (async () => {
      // Form prompts still need a terminal protocol peer: survey/gh waits for
      // cursor and size reports before consuming the user's answer. Keep one
      // emulator alive, including when its optional view is not mounted.
      const { Terminal } = await import("@xterm/xterm");
      if (disposed) return;
      const view = new Terminal({ rows: 24, cols: 80, scrollback: 1500 });
      emulator = view; setTerminal(view);
      const input = view.onData((data) => {
        if (!disposed && !exited) void invoke("pty_write", { id, data }).catch((reason) => { if (!disposed) setError(errMessage(reason)); });
      });
      cleanup.push(() => input.dispose());
      for (const [name, callback] of [
        ["pty:data", (event: { payload: { id: string; chunk: string } }) => {
          if (event.payload.id !== id || disposed) return;
          buffer = (buffer + event.payload.chunk).slice(-16384); setOutput(buffer);
          view.write(event.payload.chunk);
        }],
        ["machine-setup:exit", (event: { payload: { id: string; success: boolean } }) => {
          if (event.payload.id !== id || disposed) return;
          exited = true;
          setFinished(true); setValue("");
          if (event.payload.success && action === "gitHub") {
            // Only the remote login's successful exit verifies the code. Give
            // the receipt time to morph before setup advances to its next step.
            setVerified(true);
            completionTimer = setTimeout(() => { if (!disposed) done.current(true, buffer); }, 1200);
          } else done.current(event.payload.success, buffer);
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
    return () => { disposed = true; clearTimeout(completionTimer); cleanup.forEach((fn) => fn()); emulator?.dispose(); void invoke("machine_setup_close", { id }).catch(() => {}); };
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
  async function copyCode() {
    if (!signIn.deviceCode) return;
    setError("");
    try { await navigator.clipboard.writeText(signIn.deviceCode); setCopiedCode(signIn.deviceCode); }
    catch { setError("Could not copy the code. You can select it and copy it manually."); }
  }
  return <div className="klide-machine-session" data-details={showDetails} data-signin={action === "gitHub"}>
    {showDetails && (interactive && terminal ? <Suspense fallback={<MachineSetupWaiting>Opening interactive prompt</MachineSetupWaiting>}><DetailsTerminal id={id} terminal={terminal} /></Suspense> : <pre ref={log} className="klide-machine-log" aria-label="Setup details">{plainSetupOutput(output) || "Waiting for setup output…"}</pre>)}
    {(!showDetails || action === "gitHub") && !interactive && !finished && !signIn.deviceCode && <div className="klide-machine-session-card">
      {parsed?.kind === "trust" ? <><h4>Trust this machine?</h4><p>Check its SSH fingerprint before connecting.</p><code className="klide-machine-fingerprint">{parsed.fingerprint ?? "Open Details to review the fingerprint."}</code><div className="klide-machine-actions"><GhostButton disabled={submitting || !parsed.fingerprint} onClick={() => { void send("yes\r"); }}>Trust and connect</GhostButton><GhostButton disabled={submitting} onClick={() => { void send("no\r"); }}>Cancel</GhostButton></div></> :
      parsed && ["password", "passphrase", "code"].includes(parsed.kind) ? <form onSubmit={(event) => { event.preventDefault(); if (value) void send(`${value}\r`); }}>
        <label>{parsed.kind === "password" ? "Machine password" : parsed.kind === "passphrase" ? "SSH key passphrase" : "Authorization code"}<input key={parsed.kind} className="klide-field" type="password" value={value} onChange={(event) => setValue(event.target.value)} autoFocus autoComplete="off" disabled={submitting} /></label>
        <p>{parsed.kind === "code" ? "Paste the code from the sign-in page." : "Used for this connection only. Klide does not save it."}</p>
        <button type="submit" className="klide-button klide-button-secondary" disabled={submitting || !value}>Continue</button>
      </form> : parsed?.kind === "confirm" ? <><p>{parsed.message}</p><div className="klide-machine-actions"><GhostButton disabled={submitting} onClick={() => { void send("y\r"); }}>Continue</GhostButton><GhostButton disabled={submitting} onClick={() => { void send("n\r"); }}>No</GhostButton></div></> : parsed?.kind === "interactive" ? <><p>This step needs an interactive response.</p><GhostButton onClick={() => { setInteractive(true); setShowDetails(true); }}>Open interactive prompt</GhostButton></> : <MachineSetupWaiting>{progress[action]}</MachineSetupWaiting>}
      {parsed?.kind === "enter" && !signIn.url && !signIn.deviceCode && <GhostButton disabled={submitting} onClick={() => { void send("\r"); }}>Continue</GhostButton>}
    </div>}
    {(signIn.url || signIn.deviceCode || verified) && (!finished || verified) && <div className="klide-machine-session-card klide-machine-signin-panel" data-state={verified ? "verified" : "code"}>
      <div className="klide-machine-signin-content" aria-hidden={verified}>
        {signIn.deviceCode && <><h4>{action === "gitHub" ? "GitHub sign-in code" : "Sign-in code"}</h4><p>Enter this code on {action === "gitHub" ? "GitHub" : "the sign-in page"} in your browser.</p></>}
        <div className="klide-machine-browser-signin">
        {signIn.deviceCode && <output className="klide-machine-code" aria-label="Sign-in code" aria-live="polite"><span className="klide-machine-code-readable">{signIn.deviceCode}</span><span className="klide-machine-code-tiles" aria-hidden="true">{[...signIn.deviceCode].map((character, index) => <span className={character === "-" ? "klide-machine-code-separator" : "klide-machine-code-character"} key={index}>{character}</span>)}</span></output>}
        <div className="klide-machine-code-actions">
          {signIn.deviceCode && <GhostButton disabled={verified} onClick={() => { void copyCode(); }}>{copiedCode === signIn.deviceCode ? "Copied" : "Copy code"}</GhostButton>}
          {signIn.url && <GhostButton disabled={submitting || finished} onClick={() => { void openSignIn(); }}>{action === "gitHub" ? "Open GitHub" : "Open sign-in page"}</GhostButton>}
        </div>
        </div>
      </div>
      <div className="klide-machine-signin-verified" role="status" aria-hidden={!verified}><span className="klide-machine-signin-check" aria-hidden="true"><CheckIcon size={22} /></span><span><strong>GitHub verified</strong><span>You’re signed in on this machine.</span></span></div>
    </div>}
    {error && <p className="klide-add-machine-error" role="alert">{error}</p>}
    {(showDetails || parsed?.kind !== "interactive") && <div className="klide-machine-session-tools"><GhostButton onClick={() => { setInteractive(false); setShowDetails((shown) => !shown); }}>{showDetails ? "Hide details" : "Show details"}</GhostButton></div>}
  </div>;
}
