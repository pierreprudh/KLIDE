import { useEffect, useState } from "react";
import { machineGithubAccounts, machineGithubLogout, machineRepositoryConnect, machineRepositoryContext, type RepositoryContext } from "../../ipc/machines";
import { errMessage } from "../../errors";
import { GhostButton } from "./controls";

export default function RemoteRepositoryAccess({ machineId, workspaceRoot, ready, onChange }: {
  machineId: string; workspaceRoot: string; ready: boolean; onChange: () => void;
}) {
  const [context, setContext] = useState<RepositoryContext | null>(null);
  const [accounts, setAccounts] = useState<string[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [allowPush, setAllowPush] = useState(false);
  useEffect(() => {
    let disposed = false;
    setBusy(true); setError("");
    void Promise.all([machineRepositoryContext(workspaceRoot), machineGithubAccounts(machineId)]).then(([ctx, logins]) => {
      if (!disposed) { setContext(ctx); setAccounts(logins); }
    }).catch((reason) => { if (!disposed) setError(errMessage(reason)); }).finally(() => { if (!disposed) setBusy(false); });
    return () => { disposed = true; };
  }, [machineId, workspaceRoot]);
  async function connect() {
    setBusy(true); setError(""); setNote("");
    try { setNote(await machineRepositoryConnect(machineId, workspaceRoot, ready ? null : allowPush)); }
    catch (reason) { setError(errMessage(reason)); }
    finally { setBusy(false); onChange(); }
  }
  async function disconnect(login: string) {
    setBusy(true); setError("");
    try { await machineGithubLogout(machineId, login); setAccounts(await machineGithubAccounts(machineId)); onChange(); }
    catch (reason) { setError(errMessage(reason)); }
    finally { setBusy(false); }
  }
  return <div className="klide-repository-access">
    <p>Use a deploy key for <strong>{context?.repository ?? "this repository"}</strong> only. Your personal GitHub login stays on this Mac.</p>
    <p>Others using this OS account can access this repo, but this key does not sign them into your GitHub account.</p>
    {accounts.length > 0 ? <div className="klide-repository-account-warning"><p>Disconnect the personal login on this shared account first.</p>{accounts.map((login) => <GhostButton key={login} disabled={busy} onClick={() => { void disconnect(login); }}>Disconnect {login}</GhostButton>)}</div> : <>
    {context && <p className="klide-repository-author">Git author: {context.authorName || "not configured"}{context.authorEmail ? ` · ${context.authorEmail}` : ""}. Applied to the chosen checkout only.</p>}
    {!ready && <label className="klide-repository-push"><input type="checkbox" checked={allowPush} disabled={busy} onChange={(event) => setAllowPush(event.target.checked)} />Allow pushing to this repository</label>}
    <div className="klide-machine-actions"><GhostButton disabled={busy || !context || accounts.length > 0} onClick={() => { void connect(); }}>{busy ? "Checking repository access…" : ready ? "Verify repository access" : "Connect this repository"}</GhostButton></div>
    </>}
    {note && <p role="status">{note}</p>}{error && <p role="alert" className="klide-add-machine-error">{error}</p>}
  </div>;
}
