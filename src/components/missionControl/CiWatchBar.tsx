// Mission Control › Scheduled — "Watch CI". The one switch for the CI watch
// trigger (agent/ci_watch.rs): when a check fails on one of your open PRs in
// this project, the scheduled service starts a read-only Run that reads the
// failed log and proposes a fix. The Run uses the model the switch was turned
// on with; nothing is edited until you open the Run.

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ciWatchGet, ciWatchSet, type CiWatchFired, type CiWatchInfo } from "../../ipc/ciWatch";
import { providerName } from "../../agent/providers";
import type { ProviderId } from "../../agent/types";
import type { HarnessSettings } from "../../settingsStore";
import { modelLabel } from "../ai/ModelPicker";
import { scheduledRunInput } from "../Scheduled";
import { Toggle } from "../settings/controls";
import { relativeTime } from "../../time";
import { errMessage } from "../../errors";
import { createListenerScope } from "../../tauriEvents";

type Props = {
  workspaceRoot: string; provider: ProviderId; model: string;
  settings: HarnessSettings; onOpenRun: (id: string) => void;
};

const projectName = (root: string) => root.split(/[\\/]/).filter(Boolean).pop() ?? "this project";

export function CiWatchBar({ workspaceRoot, provider, model, settings, onOpenRun }: Props) {
  const [info, setInfo] = useState<CiWatchInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const scope = createListenerScope();
    const refresh = () => void ciWatchGet(workspaceRoot).then(next => { if (!disposed) setInfo(next); }).catch(() => {});
    refresh();
    scope.add(listen<CiWatchFired>("ci-watch:fired", refresh));
    const timer = setInterval(refresh, 30_000);
    return () => { disposed = true; clearInterval(timer); scope.dispose(); };
  }, [workspaceRoot]);

  async function change(on: boolean) {
    setBusy(true); setError(null);
    try {
      const input = on ? await scheduledRunInput({ root: workspaceRoot, provider, model, mode: "plan", text: "", settings }) : null;
      setInfo(await ciWatchSet(workspaceRoot, input));
    } catch (e) { setError(errMessage(e)); }
    finally { setBusy(false); }
  }

  const on = !!info?.enabled;
  const meta = on && info
    ? [
        `${providerName(info.provider as ProviderId)} · ${modelLabel(info.model ?? "")}`,
        info.lastError ? null : info.lastPollAt ? `checked ${relativeTime(info.lastPollAt)}` : "first check within 2 minutes",
      ].filter(Boolean).join(" · ")
    : null;

  return <section className="ci-watch" aria-label="Watch CI">
    <div className="ci-watch-row">
      <div className="ci-watch-text">
        <h2>Watch CI on my pull requests</h2>
        <p>When a check fails on one of your open PRs in {projectName(workspaceRoot)}, Kit reads the log and proposes a fix. Read-only — you review it.</p>
        {meta ? <p className="ci-watch-meta">{meta}</p> : null}
        {info?.lastError ? <p className="ci-watch-error" role="alert">{info.lastError}</p> : null}
        {error ? <p className="ci-watch-error" role="alert">{error}</p> : null}
      </div>
      <span aria-busy={busy}><Toggle checked={on} onChange={v => { if (!busy) void change(v); }} label="Watch CI on my pull requests" /></span>
    </div>
    {on && info && info.fired.length > 0 ? <ul className="ci-watch-fired">
      {info.fired.slice(0, 5).map(f => <li key={f.key}>
        <span className="ci-watch-pr">#{f.prNumber} {f.prTitle}</span>
        <span className="ci-watch-checks">{f.error ? `Couldn't start: ${f.error}` : f.checks.join(", ")}</span>
        <span className="ci-watch-when">{relativeTime(f.at)}</span>
        {f.runId ? <button type="button" className="ci-watch-open" onClick={() => onOpenRun(f.runId!)}>Open</button> : null}
      </li>)}
    </ul> : null}
  </section>;
}
