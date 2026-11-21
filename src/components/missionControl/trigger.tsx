// One event trigger in Mission Control › Scheduled — the switch, the agent it
// runs on, and its row in the list. Watch CI (ciWatch.tsx) and klide-bot
// (klideBot.tsx) are both this shape over their own Rust state; each brings
// its own wording and its own Run history.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { isAutoProvider, providerName } from "../../agent/providers";
import type { ProviderId, StartAgentRunInput } from "../../agent/types";
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
import { ProviderModelMark } from "../../modelIdentity";

/** What every trigger's Rust `*_get` / `*_set` answers with. */
export type TriggerInfo = {
  enabled: boolean; provider: string | null; model: string | null;
  enabledAt: number | null; lastPollAt: number | null; lastError: string | null;
};

export type TriggerApi<I extends TriggerInfo> = {
  get: (workspaceRoot: string) => Promise<I>;
  set: (workspaceRoot: string, input: StartAgentRunInput | null) => Promise<I>;
  /** Refresh as soon as this app event arrives, not only every 30 s. */
  event: string;
};

export type Trigger<I extends TriggerInfo> = ReturnType<typeof useTrigger<I>>;

export function useTrigger<I extends TriggerInfo>(api: TriggerApi<I>, workspaceRoot: string | null, defaultProvider: ProviderId, defaultModel: string, settings: HarnessSettings) {
  const [info, setInfo] = useState<I | null>(null);
  const [provider, setProvider] = useState<ProviderId>(defaultProvider);
  const [model, setModel] = useState(defaultModel);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceRoot) { setInfo(null); return; }
    let disposed = false;
    const scope = createListenerScope();
    const refresh = (adopt: boolean) => void api.get(workspaceRoot).then(next => {
      if (disposed) return;
      setInfo(next);
      // A saved trigger shows the agent it runs on, not today's default.
      if (adopt && next.enabled && next.provider) { setProvider(next.provider as ProviderId); setModel(next.model ?? ""); }
    }).catch(() => {});
    refresh(true);
    scope.add(listen(api.event, () => refresh(false)));
    const timer = setInterval(() => refresh(false), 30_000);
    return () => { disposed = true; clearInterval(timer); scope.dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceRoot]);

  // Off, the pickers follow the composer's choice; on, they show the trigger's.
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
      setInfo(await api.set(workspaceRoot, input));
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

type AnyTrigger = Trigger<TriggerInfo>;

/** One word for the list row and the detail's status line. */
export function triggerStatus(t: AnyTrigger, on = "Watching"): string {
  if (!t.on) return "Off";
  return t.info?.lastError ? "Needs attention" : on;
}

export function TriggerListRow({ trigger, name, meta, status, current, onSelect }: { trigger: AnyTrigger; name: string; meta: ReactNode; status: string; current: boolean; onSelect: () => void }) {
  return <button type="button" className="scheduled-list-row" aria-current={current ? "page" : undefined} onClick={onSelect}>
    <ProviderModelMark provider={trigger.provider} model={trigger.model} size={18} />
    <span className="scheduled-list-row-top"><strong>{name}</strong><span data-failed={trigger.info?.lastError ? true : undefined}>{status}</span></span>
    <span className="scheduled-list-row-meta">{meta}</span>
  </button>;
}

export function TriggerDetail({ trigger, project, title, status, emptyHint, children }: { trigger: AnyTrigger; project: string | null; title: string; status: string; emptyHint: string; children: ReactNode }) {
  const customProviders = useCustomProviders();
  const keylessProviders = useKeylessProviders();
  const llamaSetupMode = useLlamaSetupMode();
  const missingDelegateClis = useMissingDelegateClis();
  const providerOptions = useMemo(
    () => buildProviderOptions(customProviders, keylessProviders, () => openSettingsSection("api"), llamaSetupMode, missingDelegateClis),
    [customProviders, keylessProviders, llamaSetupMode, missingDelegateClis],
  );
  const { info } = trigger;
  // A trigger belongs to a project; without one there is nothing to switch on.
  if (!project) return <div className="scheduled-empty"><strong>{title}</strong><p>{emptyHint}</p></div>;
  return <>
    <div className="scheduled-detail-heading">
      <h2>{title}</h2>
      <div className="scheduled-toolbar">
        <span aria-busy={trigger.busy}><Toggle checked={trigger.on} onChange={trigger.setOn} label={title} /></span>
      </div>
    </div>
    <div className="scheduled-detail-scroll klide-scroll-slim">
      <div className="scheduled-timing">
        <span>{status}</span>
        {trigger.on && !info?.lastError ? <span className="scheduled-cadence">{info?.lastPollAt ? `Checked ${relativeTime(info.lastPollAt)}` : "First check within 2 minutes"}</span> : null}
        <span className="scheduled-cadence">Every 2 minutes</span>
      </div>
      <div className="scheduled-context" aria-label="Run settings">
        <span>This Mac</span>
        <span title={trigger.workspaceRoot ?? undefined}>{project}</span>
        <span>Plan</span>
      </div>
      <div className="ci-watch-agent" role="group" aria-label="Agent">
        <InlineMenu
          label="Provider"
          display={providerName(trigger.provider)}
          leading={<ProviderLogo id={trigger.provider} size={13} />}
          options={providerOptions}
          selected={trigger.provider}
          onSelect={v => { if (!trigger.busy && typeof v === "string" && !v.startsWith("__heading_")) trigger.pickProvider(v as ProviderId); }}
        />
        <ModelPicker provider={trigger.provider} model={trigger.model} availableModels={trigger.models} onChange={trigger.pickModel} direction="down" disabled={trigger.busy} />
      </div>
      <h3>What it does</h3>
      {children}
      {info?.lastError ? <p className="scheduled-error" role="status">{info.lastError}</p> : null}
      {trigger.error ? <p className="scheduled-error" role="alert">{trigger.error}</p> : null}
    </div>
  </>;
}
