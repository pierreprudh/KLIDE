import { MissionWorkflowIcon } from "../../icons";
import { useEffect, useState } from "react";
import { listDurableMissions, type DurableMissionBundle } from "../../agent/durableMissions";
import { defaultModelForProvider } from "../../agent/providers";
import { MissionCard } from "../ai/MissionCard";
import { errMessage } from "../../errors";

/** A recovery door for Missions whose originating conversation is closed. */
export function MissionLibrary({ workspaceRoot, onOpenRun, coordinatorRunId }: { workspaceRoot: string | null; onOpenRun?: (runId: string) => void; coordinatorRunId?: string }) {
  const [bundles, setBundles] = useState<DurableMissionBundle[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!workspaceRoot) { setBundles([]); return; }
    let live = true;
    let firstRead = true;
    const read = async () => {
      try {
        const all = await listDurableMissions(workspaceRoot);
        const next = coordinatorRunId ? all.filter((bundle) => bundle.mission.coordinatorRunId === coordinatorRunId) : all;
        if (live) { setBundles(next); setError(null);
          if (coordinatorRunId && firstRead) setSelected(next[0]?.mission.id ?? null);
          firstRead = false; }
      } catch (error) { if (live) setError(errMessage(error)); }
    };
    setSelected(null);
    setBundles([]);
    void read();
    const timer = window.setInterval(() => void read(), 5000);
    return () => { live = false; window.clearInterval(timer); };
  }, [workspaceRoot, coordinatorRunId]);
  if (!bundles.length && !error) return null;
  if (coordinatorRunId) return <section aria-label="Mission side panel" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
    {error && <div role="alert">Couldn’t read Missions — {error}</div>}
    {bundles.map(bundle => <MissionCard key={bundle.mission.id} variant="sidebar" workspaceRoot={workspaceRoot} onOpenRun={onOpenRun} receipt={{ missionId: bundle.mission.id, title: bundle.mission.title, route: bundle.tasks.find(task => task.dispatch)?.dispatch }} />)}
  </section>;
  return <section style={{ padding: "8px 4px 14px" }}>
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--fg-subtle)", marginBottom: 8 }}><MissionWorkflowIcon size={16} />Missions</div>
    {error && <div role="alert">Couldn’t read Missions — {error}</div>}
    {bundles.map((bundle) => <div key={bundle.mission.id} style={{ marginBottom: 8 }}>
      <button className="klide-button" aria-expanded={selected === bundle.mission.id} onClick={() => setSelected((current) => current === bundle.mission.id ? null : bundle.mission.id)}>{bundle.mission.title}</button>
      {selected === bundle.mission.id && <MissionCard workspaceRoot={workspaceRoot} onOpenRun={onOpenRun} receipt={{ missionId: bundle.mission.id, title: bundle.mission.title, route: bundle.tasks.find((task) => task.dispatch)?.dispatch ?? { workerKind: "harness", provider: "ollama", model: defaultModelForProvider("ollama"), requireDiffReview: true } }} />}
    </div>)}
  </section>;
}
