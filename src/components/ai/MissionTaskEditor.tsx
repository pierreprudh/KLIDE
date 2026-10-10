import { useEffect, useState } from "react";
import type { DurableMissionTaskDispatch, DurableMissionTaskSpec, SaveDurableMissionTaskInput } from "../../agent/durableMissions";
import { wouldCreateCycle } from "../../agent/missionGraph";
import { defaultModelForProvider, isDelegateProvider } from "../../agent/providers";
import { providerGroupsWithCustom } from "../../agent/providers";
import type { ProviderId } from "../../agent/types";
import { listProviderModels } from "../../ipc/aiProviders";
import { useCustomProviders } from "../../hooks/useCustomProviders";
import { getCustomCliSync } from "../../customCli";
import { ModelPicker } from "./ModelPicker";

export function MissionTaskEditor({ task, tasks, route, busy, onSave, onRoute, onDirty }: {
  task: DurableMissionTaskSpec;
  tasks: DurableMissionTaskSpec[];
  route?: DurableMissionTaskDispatch;
  busy: boolean;
  onSave: (input: SaveDurableMissionTaskInput) => Promise<void>;
  onRoute: (route: DurableMissionTaskDispatch) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const custom = useCustomProviders();
  const providers = providerGroupsWithCustom(custom, getCustomCliSync()).flatMap((group) => group.items).filter((item) => item.available && item.id !== "auto");
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.bodyMarkdown);
  const [criteria, setCriteria] = useState(task.acceptanceCriteria.join("\n"));
  const [dependencies, setDependencies] = useState(task.dependencies);
  const [phase, setPhase] = useState(task.phase);
  const [risk, setRisk] = useState(task.risk);
  const [writesFiles, setWritesFiles] = useState(task.writesFiles);
  const [models, setModels] = useState<string[]>([]);
  const dirty = phase !== task.phase || risk !== task.risk || writesFiles !== task.writesFiles || title !== task.title || description !== task.bodyMarkdown || criteria !== task.acceptanceCriteria.join("\n") || dependencies.join("|") !== task.dependencies.join("|");
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  const provider = route?.provider as ProviderId | undefined;
  useEffect(() => {
    setModels([]);
    if (!provider) return;
    let live = true;
    void listProviderModels(provider).then((next) => { if (live) setModels(next); }).catch(() => {});
    return () => { live = false; };
  }, [provider]);
  const graph = tasks.map((other) => ({ id: other.id, dependencies: other.id === task.id ? dependencies : other.dependencies }));
  const inputStyle = { width: "100%", boxSizing: "border-box" as const, background: "var(--bg)", color: "var(--fg-strong)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "6px 8px", font: "inherit", fontSize: 12, lineHeight: 1.45 };
  return (
    <form className="mission-task-form" style={{ display: "grid", gap: 12, padding: "14px 16px", fontSize: 12 }} onSubmit={(event) => {
      event.preventDefault();
      const { schemaVersion: _schema, missionId: _mission, createdMs: _created, updatedMs: _updated, ...input } = task;
      void onSave({ ...input, title: title.trim(), bodyMarkdown: description, phase, risk, writesFiles, acceptanceCriteria: criteria.split("\n").map((line) => line.trim()).filter(Boolean), dependencies });
    }}>
      <label>Task name<input style={inputStyle} value={title} onChange={(event) => setTitle(event.target.value)} disabled={busy} required /></label>
      <label>Instructions<textarea style={inputStyle} rows={2} value={description} onChange={(event) => setDescription(event.target.value)} disabled={busy} /></label>
      <label>Acceptance criteria<span className="mission-task-hint">One criterion per line</span><textarea style={inputStyle} rows={2} value={criteria} onChange={(event) => setCriteria(event.target.value)} disabled={busy} required /></label>
      <div className="mission-task-options">
        <label>Phase <select style={{ ...inputStyle, width: "auto" }} value={phase} disabled={busy} onChange={(event) => setPhase(event.target.value as typeof phase)}>{["Understand", "Build", "Verify"].map((value) => <option key={value}>{value}</option>)}</select></label>
        <label>Risk <select style={{ ...inputStyle, width: "auto" }} value={risk} disabled={busy} onChange={(event) => setRisk(event.target.value as typeof risk)}>{["low", "medium", "high"].map((value) => <option key={value}>{value}</option>)}</select></label>
        <label className="mission-task-check"><input type="checkbox" checked={writesFiles} disabled={busy} onChange={(event) => setWritesFiles(event.target.checked)} /> Changes files</label>
      </div>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="mission-task-hint">Dependencies</legend>
        {tasks.filter((other) => other.id !== task.id).map((other) => {
          const linked = dependencies.includes(other.id);
          const cycle = !linked && wouldCreateCycle(graph, task.id, other.id);
          return <label key={other.id} className="mission-task-check" style={{ marginTop: 6, opacity: cycle ? 0.5 : 1 }} title={cycle ? "This dependency would create a cycle" : undefined}><input type="checkbox" checked={linked} disabled={cycle} onChange={() => setDependencies((current) => linked ? current.filter((id) => id !== other.id) : [...current, other.id])} /> {other.title}{cycle ? " · cycle" : ""}</label>;
        })}
      </fieldset>
      {route && provider && <>
        <div className="mission-task-worker-heading">Worker<span className="mission-task-hint">Applied on approval</span></div><div className="mission-task-worker-grid">
        <label>Provider<select style={inputStyle} value={provider} disabled={busy} onChange={(event) => {
          const next = event.target.value as ProviderId;
          onRoute({ ...route, provider: next, model: defaultModelForProvider(next), workerKind: isDelegateProvider(next) ? "delegate" : "harness" });
        }}>
          {providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          {!providers.some((item) => item.id === provider) && <option value={provider}>{provider}</option>}
        </select></label>
        <label>Model<ModelPicker provider={provider} model={route.model} availableModels={models} onChange={(model) => onRoute({ ...route, model })} direction="down" fluid disabled={busy} /></label></div>
        <label className="mission-task-check"><input type="checkbox" checked={route.requireDiffReview} disabled={busy} onChange={(event) => onRoute({ ...route, requireDiffReview: event.target.checked })} /> Review this worker’s edits</label>
      </>}
      <div style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: 4 }}><button type="submit" className="klide-button" disabled={busy || !dirty || !title.trim() || !criteria.trim()}>{busy ? "Saving…" : "Save task"}</button>{dirty && <button type="button" className="klide-button" disabled={busy} onClick={() => { setTitle(task.title); setDescription(task.bodyMarkdown); setCriteria(task.acceptanceCriteria.join("\n")); setDependencies(task.dependencies); setPhase(task.phase); setRisk(task.risk); setWritesFiles(task.writesFiles); }}>Discard edits</button>}</div>
    </form>
  );
}
