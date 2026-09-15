import { useEffect, useMemo, useState, type ComponentProps } from "react";
import { onCoordinationChanged, readCoordinationSnapshot, type CoordinationRunSnapshot } from "../../agent/coordination";
import { createListenerScope } from "../../tauriEvents";
import { conversationMark } from "../../modelIdentity";
import { PeerLink } from "./PeerLink";
import { peerName } from "./coordinationPeers";
import { shellAgentsOf } from "./shellAgentEvidence";
import type { Msg } from "./types";

export function AgentActivity({ msgs, ...props }: ComponentProps<typeof PeerLink> & { msgs: Msg[] }) {
  const { workspaceRoot, selfId } = props;
  const [children, setChildren] = useState<{ key: string; runs: CoordinationRunSnapshot[] }>({ key: "", runs: [] });
  const key = `${workspaceRoot}\0${selfId}`;
  useEffect(() => {
    if (!workspaceRoot) return;
    let disposed = false;
    let revision = 0;
    const refresh = async () => {
      const request = ++revision;
      try {
        const snapshot = await readCoordinationSnapshot(workspaceRoot);
        if (!disposed && request === revision) setChildren({ key, runs: snapshot.runs.filter((r) => r.registration.parentRunId === selfId) });
      } catch { if (!disposed && request === revision) setChildren({ key, runs: [] }); }
    };
    void refresh();
    const scope = createListenerScope();
    scope.add(onCoordinationChanged((event) => { if (event.workspaceRoot === workspaceRoot) void refresh(); }));
    return () => { disposed = true; scope.dispose(); };
  }, [workspaceRoot, selfId, key]);
  const runs = children.key === key ? children.runs : [];
  const peers = [...new Set([...props.peers, ...runs.map((r) => r.registration.runId)])].filter((id) => id !== selfId);
  const shellAgents = useMemo(() => shellAgentsOf(msgs), [msgs]);
  const index = new Map(props.index);
  for (const run of runs) if (!index.has(run.registration.runId)) index.set(run.registration.runId, { title: run.registration.label ?? run.registration.runId, provider: null, model: null });
  if (!peers.length && !shellAgents.length) return null;
  return <details className="ai-agent-activity" key={key}>
    <summary>
      <span>Agents · {peers.length + shellAgents.length}</span>
      {peers.slice(0, 3).map((id) => <span key={id} className="ai-agent-activity-name">{conversationMark(index.get(id)?.model, index.get(id)?.provider, 13)?.node}{peerName(id, index)}</span>)}
      {peers.length > 3 && <span>+{peers.length - 3}</span>}
      {shellAgents.map((name) => <span key={name} className="ai-agent-activity-name">{conversationMark(name === "Codex" ? "codex" : "claude", null, 13)?.node}{name}</span>)}
    </summary>
    <div className="ai-agent-activity-card">
      <strong>Agents in this conversation</strong>
      {peers.map((id) => <div key={id} className="ai-agent-activity-row">
        <span>{peerName(id, index)}<small>{runs.find((r) => r.registration.runId === id)?.state ?? "Message peer"}</small></span>
        <PeerLink {...props} peers={[id]} index={index} active={false} />
      </div>)}
      {shellAgents.map((name) => <div key={name} className="ai-agent-activity-row">
        <span className="ai-agent-activity-name">{conversationMark(name === "Codex" ? "codex" : "claude", null, 16)?.node}{name}</span><span>via shell</span>
      </div>)}
      {shellAgents.length > 0 && <p>CLI requests appear in the transcript. Their live status, messages, and usage are not tracked here.</p>}
      <p>Response metrics cover the parent model only.</p>
    </div>
  </details>;
}
