// Mission Control › Scheduled — Watch CI, drawn in the Scheduled page's own
// three panes: a row in the list, its settings in the detail pane, its
// firings under Run history. The trigger itself is agent/ci_watch.rs: when a
// check fails on one of your open PRs in this project, the scheduled service
// starts a read-only Run, on the agent picked here, that reads the failed log
// and proposes a fix. Nothing is edited until you open the Run.

import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ciFailureStands, ciNowLabel, ciWatchGet, ciWatchSet, type CiWatchFired, type CiWatchInfo } from "../../ipc/ciWatch";
import { isAutoProvider, providerName } from "../../agent/providers";
import type { ProviderId } from "../../agent/types";
import type { HarnessSettings } from "../../settingsStore";
import { listProviderModels } from "../../ipc/aiProviders";
import { ModelPicker } from "../ai/ModelPicker";
import { switchModelForProvider } from "../ai/rememberedModel";
import { InlineMenu, buildProviderOptions, useKeylessProviders } from "../FocusMode";
import { ProviderLogo } from "../ai/icons";
import { useCustomProviders } from "../../hooks/useCustomProviders";
import { useLlamaSetupMode } from "../../hooks/useLlamaSetupMode";
import { useMissingDelegateClis } from "../../hooks/useMissingDelegateClis";
import { openSettingsSection } from "../../settingsNavigation";
import { scheduledRunInput } from "../../agent/scheduledRunInput";
import { Toggle } from "../settings/controls";
import { relativeTime } from "../../time";
import { errMessage } from "../../errors";
import { createListenerScope } from "../../tauriEvents";
import { ErrorIcon } from "../../icons";
import { ProviderModelMark } from "../../modelIdentity";
import { readAgentRunEvents } from "../../agent/client";
import { ciDiagnosis, ciVerdict } from "../../agent/ciFix";
import { canStartCiFix, startCiFix } from "../../ciFixNavigation";

/** The list selection that means "Watch CI", never a schedule id. */
export const CI_WATCH_ID = "__ci-watch__";
export const CI_WATCH_TITLE = "Watch CI on my pull requests";

export type CiWatch = ReturnType<typeof useCiWatch>;

export function useCiWatch(workspaceRoot: string | null, defaultProvider: ProviderId, defaultModel: string, settings: HarnessSettings) {
  const [info, setInfo] = useState<CiWatchInfo | null>(null);
  const [provider, setProvider] = useState<ProviderId>(defaultProvider);
  const [model, setModel] = useState(defaultModel);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceRoot) { setInfo(null); return; }
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

  // Off, the pickers follow the composer's choice; on, they show the watch's.
  useEffect(() => {
    if (info?.enabled) return;
    setProvider(defaultProvider);
    setModel(defaultModel);
  }, [defaultProvider, defaultModel, info?.enabled]);

  useEffect(() => {
    let disposed = false;
    setModels([]);
    if (!isAutoProvider(provider)) void listProviderModels(provider).then(list => { if (!disposed) setModels(list); }).catch(() => {});
    return () => { disposed = true; };
  }, [provider]);

  async function save(on: boolean, nextProvider = provider, nextModel = model) {
    if (!workspaceRoot) return;
    setBusy(true); setError(null);
    try {
      const input = on ? await scheduledRunInput({ root: workspaceRoot, provider: nextProvider, model: nextModel, mode: "plan", text: "", settings }) : null;
      setInfo(await ciWatchSet(workspaceRoot, input));
    } catch (e) { setError(errMessage(e)); }
    finally { setBusy(false); }
  }

  return {
    workspaceRoot, info, provider, model, models, busy, error,
    on: !!info?.enabled,
    setOn: (on: boolean) => { if (!busy) void save(on); },
    pickProvider: (next: ProviderId) => {
      const nextModel = switchModelForProvider(next);
      setProvider(next); setModel(nextModel);
      if (info?.enabled) void save(true, next, nextModel);
    },
    pickModel: (next: string) => {
      setModel(next);
      if (info?.enabled) void save(true, provider, next);
    },
  };
}

/** One word for the list row and the detail's status line. */
export function ciWatchStatus(watch: CiWatch): string {
  if (!watch.on) return "Off";
  return watch.info?.lastError ? "Needs attention" : "Watching";
}

export function CiWatchListRow({ watch, project, current, onSelect }: { watch: CiWatch; project: string; current: boolean; onSelect: () => void }) {
  return <button type="button" className="scheduled-list-row" aria-current={current ? "page" : undefined} onClick={onSelect}>
    <ProviderModelMark provider={watch.provider} model={watch.model} size={18} />
    <span className="scheduled-list-row-top"><strong>Watch CI</strong><span data-failed={watch.info?.lastError ? true : undefined}>{ciWatchStatus(watch)}</span></span>
    <span className="scheduled-list-row-meta">My pull requests<span aria-hidden="true"> · </span>{project}</span>
  </button>;
}

export function CiWatchDetail({ watch, project }: { watch: CiWatch; project: string | null }) {
  const customProviders = useCustomProviders();
  const keylessProviders = useKeylessProviders();
  const llamaSetupMode = useLlamaSetupMode();
  const missingDelegateClis = useMissingDelegateClis();
  const providerOptions = useMemo(
    () => buildProviderOptions(customProviders, keylessProviders, () => openSettingsSection("api"), llamaSetupMode, missingDelegateClis),
    [customProviders, keylessProviders, llamaSetupMode, missingDelegateClis],
  );
  const { info } = watch;
  // A watch belongs to a project; without one there is nothing to switch on.
  if (!project) return <div className="scheduled-empty"><strong>{CI_WATCH_TITLE}</strong><p>Open a project to watch its pull requests.</p></div>;
  return <>
    <div className="scheduled-detail-heading">
      <h2>{CI_WATCH_TITLE}</h2>
      <div className="scheduled-toolbar">
        <span aria-busy={watch.busy}><Toggle checked={watch.on} onChange={watch.setOn} label={CI_WATCH_TITLE} /></span>
      </div>
    </div>
    <div className="scheduled-detail-scroll klide-scroll-slim">
      <div className="scheduled-timing">
        <span>{ciWatchStatus(watch)}</span>
        {watch.on && !info?.lastError ? <span className="scheduled-cadence">{info?.lastPollAt ? `Checked ${relativeTime(info.lastPollAt)}` : "First check within 2 minutes"}</span> : null}
        <span className="scheduled-cadence">Every 2 minutes</span>
      </div>
      <div className="scheduled-context" aria-label="Run settings">
        <span>This Mac</span>
        <span title={watch.workspaceRoot ?? undefined}>{project}</span>
        <span>Plan</span>
      </div>
      <div className="ci-watch-agent" role="group" aria-label="Agent">
        <InlineMenu
          label="Provider"
          display={providerName(watch.provider)}
          leading={<ProviderLogo id={watch.provider} size={13} />}
          options={providerOptions}
          selected={watch.provider}
          onSelect={v => { if (!watch.busy && typeof v === "string" && !v.startsWith("__heading_")) watch.pickProvider(v as ProviderId); }}
        />
        <ModelPicker provider={watch.provider} model={watch.model} availableModels={watch.models} onChange={watch.pickModel} direction="down" disabled={watch.busy} />
      </div>
      <h3>What it does</h3>
      <p className="scheduled-instructions">When a check fails on one of your open pull requests in {project}, this agent reads the failed log and proposes the smallest fix. It runs read-only. Fix it then works in a fresh worktree at the failing commit, and you review every edit before it lands. Each failing commit starts one Run, and failures from before you turned this on are skipped.</p>
      {info?.lastError ? <p className="scheduled-error" role="status">{info.lastError}</p> : null}
      {watch.error ? <p className="scheduled-error" role="alert">{watch.error}</p> : null}
    </div>
  </>;
}

/** Kit's verdict for each firing, read from its Run once it has settled. */
function useVerdicts(fired: CiWatchFired[]): Map<string, string | null> {
  const [verdicts, setVerdicts] = useState(() => new Map<string, string | null>());
  const ids = fired.map(f => f.runId).filter((id): id is string => !!id).join(",");
  useEffect(() => {
    let live = true;
    for (const id of ids ? ids.split(",") : []) {
      if (verdicts.get(id)) continue;
      void readAgentRunEvents(id).then(events => {
        // Still working: no verdict yet, and the row says so.
        const settled = events.some(e => e.type === "run_result" || e.type === "run_error");
        const verdict = settled ? ciVerdict(ciDiagnosis(events)) : null;
        if (live) setVerdicts(prev => new Map(prev).set(id, verdict));
      }).catch(() => {});
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
  return verdicts;
}

export function CiWatchHistory({ watch, onOpenRun }: { watch: CiWatch; onOpenRun: (id: string) => void }) {
  const fired = watch.info?.fired ?? [];
  const verdicts = useVerdicts(fired);
  if (!fired.length) return <p className="scheduled-pane-empty">{watch.on ? "No failing checks yet." : "Turn on to watch your pull requests."}</p>;
  return <ol className="ci-fires">{fired.map(f => {
    const verdict = f.runId ? verdicts.get(f.runId) : undefined;
    return <li key={f.key}>
      <button type="button" className="ci-fire" disabled={!f.runId} aria-label={`Open Run · #${f.prNumber} ${f.prTitle}`}
        onClick={() => f.runId && onOpenRun(f.runId)}>
        <span className="ci-fire-head">
          {f.provider ? <ProviderModelMark provider={f.provider as ProviderId} model={f.model} size={18} /> : null}
          <span className="ci-fire-title">#{f.prNumber} {f.prTitle}</span>
          <span className="ci-fire-time" data-failed={f.error ? true : undefined}>{f.error ? "Not started" : relativeTime(f.at)}</span>
        </span>
        <span className="ci-fire-checks">{f.checks.map(c => <span key={c}><ErrorIcon size={12} />{c}</span>)}{f.now && <span className="ci-fire-now" data-now={f.now}>{ciNowLabel(f.now)}</span>}</span>
        {f.error
          ? <span className="ci-fire-verdict">{f.error}</span>
          : <span className="ci-fire-verdict" data-pending={verdict === null ? true : undefined}>{verdict === null ? "Kit is looking into it…" : verdict ?? ""}</span>}
      </button>
      {f.runId && canStartCiFix() && ciFailureStands(f.now) && <button type="button" className="ci-watch-fix" title="Fix it in a worktree at the failing commit — every edit is reviewed" onClick={() => startCiFix(f)}>Fix it</button>}
    </li>;
  })}</ol>;
}
