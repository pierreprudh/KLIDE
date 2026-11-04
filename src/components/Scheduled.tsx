import { createPortal } from "react-dom";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { createListenerScope } from "../tauriEvents";
import { createSchedule, updateSchedule, listSchedules, scheduleAction, scheduleHistory, localScheduleTime, mergeScheduleRows, scheduleServiceStatus, enableScheduleService, type ScheduleService, type Schedule, type ScheduledRun } from "../agent/schedules";
import { stopAgentRun } from "../agent/client";
import { PROVIDER_CATALOG, isAutoProvider, providerDefinition, providerName } from "../agent/providers";
import type { AgentMode, ProviderId, StartAgentRunInput } from "../agent/types";
import type { HarnessSettings } from "../settingsStore";
import { listProviderModels } from "../ipc/aiProviders";
import { ProviderLogo } from "./ai/icons";
import { ModelPicker, modelLabel } from "./ai/ModelPicker";
import { routedSelection } from "../agent/harnessSource";
import { switchModelForProvider } from "./ai/rememberedModel";
import { buildSystemPrompt } from "./ai/system-prompt";
import { allFavModels } from "../favModels";
import { enabledRunSkills, loadFilesystemSkills, loadSkills, mergeFilesystemSkills } from "../skills";
import { readWorkspaceTextFile } from "../workspaceFs";
import { errMessage } from "../errors";
import { ChevronIcon, ClockIcon, MoreIcon, NewTaskIcon, OpenInEditorIcon, PauseIcon, PlayIcon } from "../icons";
import { ScheduleSelect, type ScheduleSelectOption } from "./ScheduleSelect";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { useCustomProviders } from "../hooks/useCustomProviders";
import { formatSpan } from "../time";
import "./scheduled.css";

type Props = {
  workspaceRoot: string | null; defaultProvider: ProviderId; defaultModel: string;
  harnessSettings: HarnessSettings; initialSelectedId?: string | null; selectionVersion?: number;
  onOpenRun: (id: string) => void;
};

const when = (ms: number) => new Date(ms).toLocaleString();
const shortWhen = (ms: number) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const workspaceName = (root: string | null) => root?.split(/[\\/]/).filter(Boolean).pop() ?? "Workspace";
const statusName = (status: Schedule["status"]) => ({ pending: "Scheduled", dispatching: "Starting", running: "Running", completed: "Completed", failed: "Failed", paused: "Paused", cancelled: "Cancelled" })[status];
const cadence = (ms: number | null) => ms === null ? "Once" : ms === 3_600_000 ? "Every hour" : ms === 86_400_000 ? "Every 24 hours" : ms === 604_800_000 ? "Every 7 days" : `Every ${ms / 60_000} minutes`;

export function Scheduled(props: Props) {
  const [rows, setRows] = useState<Schedule[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(props.initialSelectedId ?? null);
  const [history, setHistory] = useState<ScheduledRun[]>([]);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [service, setService] = useState<ScheduleService | null>(null);
  const editorOpener = useRef<HTMLButtonElement | null>(null);
  const actionsTrigger = useRef<HTMLButtonElement | null>(null);
  const selected = rows.find(row => row.id === selectedId);

  useEffect(() => { if (props.initialSelectedId) { setSelectedId(props.initialSelectedId); setCreating(false); setEditing(false); } }, [props.initialSelectedId, props.selectionVersion]);
  useEffect(() => {
    let disposed = false;
    const scope = createListenerScope();
    const updates = new Map<string, Schedule>();
    const removed = new Set<string>();
    const changes = listen<Schedule>("schedule:changed", ({ payload }) => {
      if (disposed) return;
      updates.set(payload.id, payload);
      setRows(current => mergeScheduleRows(current, [payload]));
      setHistoryVersion(value => value + 1);
    });
    const removals = listen<Schedule>("schedule:removed", ({ payload }) => {
      if (disposed) return;
      removed.add(payload.id);
      setRows(current => current.filter(row => row.id !== payload.id));
    });
    scope.add(changes); scope.add(removals);
    void Promise.all([changes, removals]).then(() => listSchedules()).then(saved => {
      if (!disposed) setRows(mergeScheduleRows(saved, [...updates.values()]).filter(row => !removed.has(row.id)));
    }).catch(e => { if (!disposed) setError(errMessage(e)); }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; scope.dispose(); };
  }, []);
  useEffect(() => {
    let disposed = false;
    const scope = createListenerScope();
    const refresh = () => void scheduleServiceStatus().then(info => { if (!disposed) setService(info); }).catch(e => { if (!disposed) setError(errMessage(e)); });
    scope.add(listen<ScheduleService>("schedule:service", ({ payload }) => { if (!disposed) setService(payload); }));
    refresh();
    const timer = setInterval(refresh, 10_000);
    return () => { disposed = true; clearInterval(timer); scope.dispose(); };
  }, []);
  useEffect(() => { setHistory([]); setMenu(null); }, [selectedId]);
  useEffect(() => {
    if (!loading && !creating && !rows.some(row => row.id === selectedId) && rows.length) setSelectedId(rows[0].id);
  }, [rows, loading, creating, selectedId]);
  useEffect(() => {
    let disposed = false;
    if (selectedId) void scheduleHistory(selectedId).then(rows => { if (!disposed) setHistory(rows); }).catch(e => { if (!disposed) setError(errMessage(e)); });
    return () => { disposed = true; };
  }, [selectedId, historyVersion]);

  async function act(action: Parameters<typeof scheduleAction>[1]) {
    if (!selected) return;
    setBusy(true); setError(null);
    try {
      await scheduleAction(selected.id, action);
      const saved = await listSchedules();
      setRows(current => mergeScheduleRows(current.filter(row => action !== "remove" || row.id !== selected.id), saved));
      setHistoryVersion(value => value + 1);
      if (action === "remove") setSelectedId(null);
    } catch (e) { setError(errMessage(e)); }
    finally { setBusy(false); }
  }

  const editorOpen = creating || editing && !!selected;
  const menuItems: MenuItem[] = [];
  if (selected) {
    if (!selected.activeRunId) menuItems.push({ type: "item", label: "Edit schedule", onSelect: () => { editorOpener.current = actionsTrigger.current; setEditing(true); } });
    if (selected.activeRunId) menuItems.push({ type: "item", label: "Stop current Run", onSelect: () => {
      setBusy(true);
      void stopAgentRun(selected.activeRunId!).catch(e => setError(errMessage(e))).finally(() => setBusy(false));
    } });
    if (!["cancelled", "completed"].includes(selected.status)) menuItems.push({ type: "item", label: "Cancel schedule", onSelect: () => void act("cancel") });
    if (!selected.activeRunId) menuItems.push({ type: "separator" }, { type: "item", label: "Remove schedule", danger: true, onSelect: () => void act("remove") });
  }

  return <section className="scheduled-page shell-enter" aria-label="Scheduled">
    <header className="scheduled-header">
      <h1>Scheduled</h1>
      <button type="button" className="scheduled-new" onClick={e => { editorOpener.current = e.currentTarget; setCreating(true); setEditing(false); setMenu(null); setError(null); }}>
        <NewTaskIcon size={14} /> New schedule
      </button>
    </header>
    {error ? <p className="scheduled-error" role="alert">{error}</p> : null}
    <div className="scheduled-body">
      <nav className="scheduled-pane scheduled-list" aria-label="Schedules">
        <div className="scheduled-pane-heading"><h2>Schedules</h2>{rows.length > 0 && <span>{rows.length}</span>}</div>
        <div className="scheduled-list-scroll klide-scroll-slim">
          {loading ? <p className="scheduled-pane-empty">Loading…</p> : null}
          {rows.map(row => <button type="button" className="scheduled-list-row" key={row.id} aria-current={!creating && row.id === selectedId ? "page" : undefined}
            title={`${row.name}${row.workspaceRoot ? `\n${row.workspaceRoot}` : ""}`}
            onClick={() => { setSelectedId(row.id); setCreating(false); setEditing(false); setError(null); setMenu(null); }}>
            <span className="scheduled-list-row-top"><strong>{row.name}</strong><span data-failed={row.status === "failed" || undefined}>{statusName(row.status)}</span></span>
            <span className="scheduled-list-row-meta">{cadence(row.intervalMs)}<span aria-hidden="true"> · </span>{workspaceName(row.workspaceRoot)}</span>
          </button>)}
        </div>
        <div className="scheduled-local" title={service?.error ?? "The local service works with Klide closed. Your Mac must be awake and you must be logged in. Permissions wait until you reopen Klide."}>
          <ClockIcon size={12} /><span>{!service ? "Checking local service…" : service.installed && service.running && service.compatible ? "This Mac · service running" : service.error ? "Local service needs attention" : "Local service not enabled"}</span>
          {service?.supported && (!service.installed || !service.running || !service.compatible) && <button type="button" className="scheduled-service-enable" disabled={busy} onClick={() => {
            setBusy(true); void enableScheduleService().then(setService).catch(e => setError(errMessage(e))).finally(() => setBusy(false));
          }}>{service.error ? "Retry" : "Enable"}</button>}
        </div>
      </nav>
      <main className="scheduled-pane scheduled-detail">
        {selected ? <>
          <div className="scheduled-detail-heading">
            <h2>{selected.name}</h2>
            <div className="scheduled-toolbar">
              <button type="button" className="scheduled-run" disabled={busy} onClick={() => selected.activeRunId ? props.onOpenRun(selected.activeRunId) : void act(selected.status === "paused" ? "resume" : "run_now")}>
                <PlayIcon size={13} />{selected.activeRunId ? "Open Run" : selected.status === "paused" ? "Resume" : selected.status === "failed" ? "Retry now" : "Run now"}
              </button>
              {["pending", "running", "dispatching"].includes(selected.status) && <button type="button" className="scheduled-icon-button"
                disabled={busy} aria-label="Pause schedule" title="Pause schedule" onClick={() => void act("pause")}>
                <PauseIcon size={14} />
              </button>}
              <button type="button" ref={actionsTrigger} className="scheduled-icon-button" aria-label="Schedule actions" aria-haspopup="menu" aria-expanded={!!menu} disabled={busy}
                onClick={e => { const rect = e.currentTarget.getBoundingClientRect(); setMenu(menu ? null : { x: rect.right, y: rect.bottom + 4 }); }}><MoreIcon size={18} /></button>
            </div>
          </div>
          <div className="scheduled-detail-scroll klide-scroll-slim">
            <div className="scheduled-timing">
              <span>{selected.status === "pending" ? "Next run" : statusName(selected.status)}</span>
              {selected.status === "pending" && <time dateTime={new Date(selected.dueAt).toISOString()} title={when(selected.dueAt)}>{shortWhen(selected.dueAt)}</time>}
              <span className="scheduled-cadence">{cadence(selected.intervalMs)}</span>
            </div>
            <div className="scheduled-context" aria-label="Run settings">
              <span>{selected.target.kind === "local" ? "This Mac" : "Remote machine"}</span>
              <span title={selected.workspaceRoot ?? undefined}>{workspaceName(selected.workspaceRoot)}</span>
              <span>{providerName(selected.provider)}</span>
              <span>{modelLabel(routedSelection(selected.model)?.model ?? selected.model)}</span>
              <span>{selected.mode === "goal" ? "Work" : "Plan"}</span>
            </div>
            <h3>Instructions</h3>
            <p className="scheduled-instructions">{selected.text}</p>
            {selected.error ? <p className="scheduled-error" role="status">{selected.error}</p> : null}
          </div>
        </> : <div className="scheduled-empty"><strong>{loading ? "Loading schedules…" : "No schedules yet"}</strong><p>Choose New schedule to get started.</p></div>}
      </main>
      <aside className="scheduled-pane scheduled-history" aria-label="Run history">
        <div className="scheduled-pane-heading"><h2>Run history</h2>{history.length > 0 && <span>{history.length}</span>}</div>
        <div className="scheduled-history-scroll klide-scroll-slim">
          {!history.length ? <p className="scheduled-pane-empty">{selected ? "No runs yet." : "Select a schedule to see its runs."}</p> : <ol>{[...history].reverse().map(run => <li key={run.runId}>
            <button type="button" aria-label={`Open Run · ${shortWhen(run.startedAt)} · ${statusName(run.status)}`}
              title={`Scheduled ${when(run.scheduledAt)}${run.finishedAt ? ` · Finished ${when(run.finishedAt)}` : ""}`} onClick={() => props.onOpenRun(run.runId)}>
              <span className="scheduled-history-top"><time dateTime={new Date(run.startedAt).toISOString()}>{shortWhen(run.startedAt)}</time><span data-failed={run.status === "failed" || undefined}>{statusName(run.status)}</span></span>
              <span className="scheduled-history-bottom"><span>{run.finishedAt ? formatSpan(Math.max(0, run.finishedAt - run.startedAt)) : "In progress"}</span><OpenInEditorIcon size={12} /></span>
              {run.error && <span className="scheduled-history-error">{run.error}</span>}
            </button>
          </li>)}</ol>}
        </div>
      </aside>
    </div>
    {editorOpen && <ScheduleEditor key={creating ? "new" : selectedId} {...props} schedule={creating ? undefined : selected} returnFocusTo={editorOpener.current}
      onCancel={() => { setCreating(false); setEditing(false); }} onSaved={row => {
        setRows(current => mergeScheduleRows(current, [row])); setSelectedId(row.id); setCreating(false); setEditing(false);
      }} />}
    {menu && <ContextMenu x={menu.x} y={menu.y} align="end" items={menuItems} onClose={() => setMenu(null)} />}
  </section>;
}

function ScheduleEditor({ schedule, onSaved, onCancel, returnFocusTo, ...props }: Props & { schedule?: Schedule; returnFocusTo?: HTMLElement | null; onSaved: (row: Schedule) => void; onCancel: () => void }) {
  const [name, setName] = useState(schedule?.name ?? "");
  const [text, setText] = useState(schedule?.text ?? "");
  const [root, setRoot] = useState(schedule?.workspaceRoot ?? props.workspaceRoot ?? "");
  const [provider, setProvider] = useState<ProviderId>(schedule?.provider ?? props.defaultProvider);
  const [model, setModel] = useState(schedule?.model ?? props.defaultModel);
  const [mode, setMode] = useState<AgentMode>(schedule?.mode ?? "plan");
  const [due, setDue] = useState(() => localScheduleTime(new Date(schedule && schedule.dueAt > Date.now() ? schedule.dueAt : Date.now() + 3_600_000)));
  const [interval, setInterval] = useState(String(schedule?.intervalMs ?? 0));
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();
  const dueDate = new Date(due);
  const validDate = Number.isFinite(dueDate.getTime());
  const sourceGroup = providerDefinition(provider)?.group;
  const sourceLabel = sourceGroup === "subscription" ? "Subscription" : sourceGroup === "local" ? "Local model" : sourceGroup === "routed" ? "Automatic" : "API provider";
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone.replace(/_/g, " ");
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  const returnFocus = useRef(returnFocusTo ?? document.activeElement);
  const customProviders = useCustomProviders();
  const agentOptions: ScheduleSelectOption[] = [
    ...[{ id: "subscription", name: "Subscriptions", description: "Uses the agent’s saved login" }, { id: "hosted", name: "API providers", description: "Uses saved API credentials" }, { id: "local", name: "Local models", description: "Runs on this Mac" }, { id: "routed", name: "Automatic", description: "Chooses a model for the task" }].flatMap(group => PROVIDER_CATALOG.filter(row => row.group === group.id).map(row => ({ value: row.id, label: row.name, group: group.name, description: group.description, icon: <ProviderLogo id={row.id} size={18} /> }))),
    ...customProviders.map(row => ({ value: row.id, label: row.label, group: "Self-hosted", description: "Your configured endpoint", icon: <ProviderLogo id={row.id as ProviderId} size={18} /> })),
  ];
  if (!agentOptions.some(option => option.value === provider)) agentOptions.unshift({ value: provider, label: providerName(provider), icon: <ProviderLogo id={provider} size={18} /> });
  const repeatOptions: ScheduleSelectOption[] = [
    { value: "0", label: "Once", description: "One run at the chosen time" },
    { value: "3600000", label: "Every hour", description: "Repeats every 60 minutes" },
    { value: "86400000", label: "Every 24 hours", description: "Fixed interval from the first run" },
    { value: "604800000", label: "Every 7 days", description: "Fixed interval from the first run" },
  ];
  if (!repeatOptions.some(option => option.value === interval)) repeatOptions.unshift({ value: interval, label: cadence(Number(interval)) });
  useLayoutEffect(() => {
    if (!dialog) return;
    dialog.showModal();
    dialog.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    return () => {
      dialog.close();
      if (returnFocus.current instanceof HTMLElement && returnFocus.current.isConnected) returnFocus.current.focus();
    };
  }, [dialog]);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let disposed = false;
    setModels([]);
    if (!isAutoProvider(provider)) void listProviderModels(provider).then(models => { if (!disposed) setModels(models); }).catch(() => {});
    return () => { disposed = true; };
  }, [provider]);

  async function save() {
    setBusy(true); setError(null);
    try {
      const dueAt = new Date(due).getTime();
      if (!Number.isFinite(dueAt) || dueAt <= Date.now()) throw new Error("Choose a future start time");
      const settings = props.harnessSettings;
      const [skills, rules] = await Promise.all([
        loadFilesystemSkills(root).then(scanned => mergeFilesystemSkills(loadSkills(), scanned)),
        (async () => {
          for (const name of ["AGENTS.md", "CLAUDE.md"]) {
            try { return (await readWorkspaceTextFile(root, name)).slice(0, 6000).trim(); } catch { /* Try the next convention. */ }
          }
          return "";
        })(),
      ]);
      const input: StartAgentRunInput = {
        workspaceRoot: root, provider, model, mode, text, attachments: [],
        systemPrompt: buildSystemPrompt(root, true, skills, mode, mode !== "chat", rules, settings, model, provider),
        skills: enabledRunSkills(skills), maxParallelTools: settings.maxParallelTools,
        requireDiffReview: true, maxTurns: settings.maxTurns, commandTimeoutSecs: settings.commandTimeoutSecs,
        testAfterEditCommand: settings.testAfterEditCommand,
        numCtx: settings.contextWindows?.[model], reflectionLevel: settings.reflectionLevels?.[model],
        preferredModels: isAutoProvider(provider) ? allFavModels() : undefined,
      };
      const saved = schedule ? await updateSchedule(schedule.id, input, dueAt, Number(interval) || null, name.trim() || text.trim().split("\n")[0].slice(0, 80)) : await createSchedule(input, dueAt, Number(interval) || null, name.trim() || text.trim().split("\n")[0].slice(0, 80));
      if (alive.current) onSaved(saved);
    } catch (e) { if (alive.current) setError(errMessage(e)); }
    finally { if (alive.current) setBusy(false); }
  }
  return createPortal(<dialog ref={setDialog} className="scheduled-dialog" aria-labelledby={`${fieldId}-title`} onCancel={e => { e.preventDefault(); if (!busy) onCancel(); }}>
    <form className="scheduled-task-form" onSubmit={e => { e.preventDefault(); void save(); }}>
      <header className="scheduled-dialog-header"><div className="scheduled-dialog-heading"><h2 id={`${fieldId}-title`}><ClockIcon size={15} />{schedule ? "Edit scheduled task" : "Schedule a task"}</h2><p title={root}>{root ? workspaceName(root) : "Choose a workspace"}<span aria-hidden="true"> · </span>This Mac</p></div><button type="button" className="klide-cmd-esc" aria-label="Close schedule" disabled={busy} onClick={onCancel}>Esc</button></header>
      <div className="scheduled-dialog-scroll klide-scroll-slim">
        <div className="scheduled-task-prompt-heading"><label htmlFor={`${fieldId}-instructions`}>Instructions</label><span>{mode === "goal" ? "Edits with review" : mode === "chat" ? "No tools" : "Read only"}</span></div>
        <div className="scheduled-task-composer">
          <textarea id={`${fieldId}-instructions`} className="scheduled-task-instructions" aria-label="Instructions" required autoFocus rows={5} placeholder="What should the agent do each time?" value={text} onChange={e => setText(e.target.value)} disabled={busy} />
          <div className="scheduled-task-composer-toolbar">
            <div className="scheduled-task-agent" title={`${sourceLabel} · ${providerName(provider)}`}><ScheduleSelect label="Subscription / provider" value={provider} options={agentOptions} searchable compact disabled={busy} portalContainer={dialog} onChange={next => { setProvider(next as ProviderId); setModel(switchModelForProvider(next as ProviderId)); }} /><span className="scheduled-task-source">{sourceLabel}</span></div>
            <div className="scheduled-task-model" role="group" aria-label="Model"><ModelPicker provider={provider} model={model} availableModels={models} onChange={setModel} direction="down" fluid bareHover disabled={busy} portalContainer={dialog} /></div>
          </div>
        </div>
        <fieldset className="scheduled-task-timing" disabled={busy} aria-describedby={`${fieldId}-time-zone`}>
          <legend>Schedule</legend>
          <div className="scheduled-task-timing-grid">
            <div className="scheduled-task-timing-field"><span>Repeat</span><ScheduleSelect label="Repeat" value={interval} options={repeatOptions} onChange={setInterval} disabled={busy} portalContainer={dialog} /></div>
            <label>{interval === "0" ? "Date" : "Start date"}<input type="date" required value={due.split("T")[0]} onChange={e => setDue(`${e.target.value}T${due.split("T")[1] || "09:00"}`)} /></label>
            <label>Time<input type="time" required value={due.split("T")[1] ?? ""} onChange={e => setDue(`${due.split("T")[0]}T${e.target.value}`)} /></label>
          </div>
          <p id={`${fieldId}-time-zone`} className="scheduled-task-time-zone">{timezone} · local time</p>
        </fieldset>
        <details className="scheduled-task-advanced" open={!root || undefined}>
          <summary>Advanced<ChevronIcon size={12} /></summary>
          <div className="scheduled-task-group">
            <label className="scheduled-task-row"><span>Name</span><input value={name} onChange={e => setName(e.target.value)} placeholder="Use instructions as the name" disabled={busy} /></label>
            <div className="scheduled-task-row scheduled-task-workspace"><label htmlFor={`${fieldId}-workspace`}>Workspace</label><div><input id={`${fieldId}-workspace`} required value={root} title={root} onChange={e => setRoot(e.target.value)} placeholder="Choose a folder" disabled={busy} /><button type="button" className="scheduled-choose" disabled={busy} onClick={() => {
              void open({ directory: true, defaultPath: root || undefined }).then(path => { if (typeof path === "string" && alive.current) setRoot(path); }).catch(e => { if (alive.current) setError(errMessage(e)); });
            }}>Choose…</button></div></div>
            <div className="scheduled-task-row"><span>Mode</span><ScheduleSelect label="Mode" value={mode} compact disabled={busy} portalContainer={dialog} onChange={value => setMode(value as AgentMode)} options={[{value:"plan",label:"Plan",description:"Read files and report findings"},{value:"goal",label:"Work",description:"Propose edits for review"},...(mode === "chat" ? [{value:"chat",label:"Chat",description:"Answer without tools"}] : [])]} /></div>
            <div className="scheduled-task-row"><span>Run on<small>Mac awake and logged in</small></span><ScheduleSelect label="Run on" value="local" compact disabled={busy} portalContainer={dialog} onChange={() => {}} options={[{value:"local",label:"This Mac",description:"Continues with Klide closed"},{value:"remote",label:"VPS",description:"Coming with remote execution",disabled:true}]} /></div>
          </div>
          <p className="scheduled-task-hint">Runs continue with Klide closed. Approvals wait until you reopen it.</p>
        </details>

      </div>
      <footer className="scheduled-dialog-footer">
        {error && <p role="alert" className="scheduled-task-error">{error}</p>}
        <p className="scheduled-task-next">{validDate ? <><span>{interval === "0" ? "Runs once" : "First run"}</span>{shortWhen(dueDate.getTime())}</> : "Choose a start time"}</p>
        <div className="scheduled-dialog-actions"><button type="button" className="klide-button klide-button-secondary" disabled={busy} onClick={onCancel}>Cancel</button><button type="submit" className="klide-button klide-button-primary" disabled={busy || !text.trim() || !root.trim() || !model.trim()}>{busy ? "Saving…" : schedule ? "Save changes" : "Create task"}</button></div>
      </footer>
    </form>
  </dialog>, document.body);
}
