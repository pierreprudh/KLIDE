// Mission Control › Scheduled — "Watch CI". The one switch for the CI watch
// trigger (agent/ci_watch.rs): when a check fails on one of your open PRs in
// this project, the scheduled service starts a read-only Run that reads the
// failed log and proposes a fix, on the agent and model picked here. Nothing
// is edited until you open the Run.

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ciWatchGet, ciWatchSet, type CiWatchFired, type CiWatchInfo } from "../../ipc/ciWatch";
import { isAutoProvider } from "../../agent/providers";
import type { ProviderId } from "../../agent/types";
import type { HarnessSettings } from "../../settingsStore";
import { listProviderModels } from "../../ipc/aiProviders";
import { ModelPicker } from "../ai/ModelPicker";
import { switchModelForProvider } from "../ai/rememberedModel";
import { ScheduleSelect } from "../ScheduleSelect";
import { agentSourceLabel, useAgentOptions } from "../agentOptions";
import { scheduledRunInput } from "../../agent/scheduledRunInput";
import { Toggle } from "../settings/controls";
import { relativeTime } from "../../time";
import { errMessage } from "../../errors";
import { createListenerScope } from "../../tauriEvents";

type Props = {
  workspaceRoot: string; provider: ProviderId; model: string;
  settings: HarnessSettings; onOpenRun: (id: string) => void;
};

const projectName = (root: string) => root.split(/[\\/]/).filter(Boolean).pop() ?? "this project";

export function CiWatchBar({ workspaceRoot, provider: defaultProvider, model: defaultModel, settings, onOpenRun }: Props) {
  const [info, setInfo] = useState<CiWatchInfo | null>(null);
  const [provider, setProvider] = useState<ProviderId>(defaultProvider);
  const [model, setModel] = useState(defaultModel);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agentOptions = useAgentOptions(provider);

  useEffect(() => {
    let disposed = false;
    const scope = createListenerScope();
    const refresh = (adopt: boolean) => void ciWatchGet(workspaceRoot).then(next => {
      if (disposed) return;
      setInfo(next);
      // A saved watch shows the agent it runs on, not today's default.
      if (adopt && next.enabled && next.provider) { setProvider(next.provider as ProviderId); setModel(next.model ?? ""); }
    }).catch(() => {});
    refresh(true);
    scope.add(listen<CiWatchFired>("ci-watch:fired", () => refresh(false)));
    const timer = setInterval(() => refresh(false), 30_000);
    return () => { disposed = true; clearInterval(timer); scope.dispose(); };
  }, [workspaceRoot]);

  useEffect(() => {
    let disposed = false;
    setModels([]);
    if (!isAutoProvider(provider)) void listProviderModels(provider).then(list => { if (!disposed) setModels(list); }).catch(() => {});
    return () => { disposed = true; };
  }, [provider]);

  async function save(on: boolean, nextProvider = provider, nextModel = model) {
    setBusy(true); setError(null);
    try {
      const input = on ? await scheduledRunInput({ root: workspaceRoot, provider: nextProvider, model: nextModel, mode: "plan", text: "", settings }) : null;
      setInfo(await ciWatchSet(workspaceRoot, input));
    } catch (e) { setError(errMessage(e)); }
    finally { setBusy(false); }
  }

  function pickProvider(next: ProviderId) {
    const nextModel = switchModelForProvider(next);
    setProvider(next); setModel(nextModel);
    if (info?.enabled) void save(true, next, nextModel);
  }

  function pickModel(next: string) {
    setModel(next);
    if (info?.enabled) void save(true, provider, next);
  }

  const on = !!info?.enabled;
  const status = on && info && !info.lastError
    ? info.lastPollAt ? `Checked ${relativeTime(info.lastPollAt)}` : "First check within 2 minutes"
    : null;

  return <section className="ci-watch" aria-label="Watch CI">
    <div className="ci-watch-row">
      <div className="ci-watch-text">
        <h2>Watch CI on my pull requests</h2>
        <p>When a check fails on one of your open PRs in {projectName(workspaceRoot)}, an agent reads the log and proposes a fix. Read-only — you review it.</p>
      </div>
      <span aria-busy={busy}><Toggle checked={on} onChange={v => { if (!busy) void save(v); }} label="Watch CI on my pull requests" /></span>
    </div>
    <div className="ci-watch-agent">
      <div className="ci-watch-provider" title={`${agentSourceLabel(provider)} · ${provider}`}>
        <ScheduleSelect label="Subscription / provider" value={provider} options={agentOptions} searchable compact disabled={busy} portalContainer={null} onChange={next => pickProvider(next as ProviderId)} />
      </div>
      <div className="ci-watch-model" role="group" aria-label="Model">
        <ModelPicker provider={provider} model={model} availableModels={models} onChange={pickModel} direction="down" bareHover disabled={busy} />
      </div>
      {status ? <span className="ci-watch-status">{status}</span> : null}
    </div>
    {info?.lastError ? <p className="ci-watch-error" role="alert">{info.lastError}</p> : null}
    {error ? <p className="ci-watch-error" role="alert">{error}</p> : null}
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
