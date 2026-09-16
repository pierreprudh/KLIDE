import { useEffect, useMemo, useState, type ReactNode, type ComponentProps } from "react";
import { onCoordinationChanged, readCoordinationSnapshot, type CoordinationRunSnapshot } from "../../agent/coordination";
import { createListenerScope } from "../../tauriEvents";
import { conversationMark } from "../../modelIdentity";
import type { PeerLink } from "./PeerLink";
import { peerName, workerChildrenOf } from "./coordinationPeers";
import { shellAgentsOf } from "./shellAgentEvidence";
import type { Conversation, Msg } from "./types";
import type { ProviderId } from "../../agent/types";
import { createPortal } from "react-dom";
import { usePortalMenu } from "../../hooks/usePortalMenu";
import { ProviderLogo } from "./icons";
import { AgentMark } from "../fileMarks";
import { loadConversations } from "./storedConversations";
import { participantStats } from "./participantStats";

function Participant({ name, mark, status, stats, children }: {
  name: string; mark: ReactNode; status: string; stats: () => string; children?: ReactNode;
}) {
  const menu = usePortalMenu({ closeOnOutsideClick: true, computePos: (rect) => ({
    left: Math.max(12, Math.min(rect.right - 380, window.innerWidth - 392)),
    bottom: window.innerHeight - rect.top + 10,
  }) });
  const [line, setLine] = useState("");
  useEffect(() => {
    if (!menu.open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { menu.close(); menu.triggerRef.current?.focus(); } };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [menu.open, menu.close]);
  return <>
    <button ref={menu.triggerRef} type="button" className="ai-agent-avatar" title={name}
      aria-label={`${name} — show stats`} aria-expanded={menu.open}
      onClick={() => { if (menu.open) menu.close(); else { setLine(stats()); menu.openMenu(); } }}>{mark}</button>
    {menu.open && menu.pos && createPortal(<div ref={menu.menuRef} className="ai-agent-stats-card" style={menu.pos} role="dialog" aria-label={`${name} stats`}>
      <div className="ai-agent-stats-heading"><span className="ai-agent-activity-name">{mark}<strong>{name}</strong></span><span>{status}</span>{children}</div>
      <div className="ai-agent-stats-line" title={line}>{line}</div>
    </div>, document.body)}
  </>;
}

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
  // A worker child has no stored conversation of its own, so the index knows
  // nothing about it; the spawn call in this transcript says which Delegate
  // it ran as, and that is the mark it should wear.
  const workers = useMemo(() => workerChildrenOf(msgs, selfId), [msgs, selfId]);
  for (const run of runs) if (!index.has(run.registration.runId)) index.set(run.registration.runId, { title: run.registration.label ?? run.registration.runId, provider: (workers.get(run.registration.runId) as ProviderId | undefined) ?? null, model: null });
  if (!peers.length && !shellAgents.length) return null;
  return <div className="ai-agent-activity" key={key} role="group" aria-label="Agents in this conversation">
    {peers.map((id) => <Participant key={id} name={peerName(id, index)}
      mark={conversationMark(index.get(id)?.model, index.get(id)?.provider, 16)?.node ?? <AgentMark size={16} />}
      status={runs.find((r) => r.registration.runId === id)?.state ?? "Message peer"}
      stats={() => participantStats(loadConversations<Conversation>().find((conversation) => conversation.id === id)?.msgs ?? [])}>
      <button type="button" className="ai-agent-open" disabled={!props.onOpen} onClick={() => props.onOpen?.(id)} aria-label={`Open ${peerName(id, index)}`} title="Open conversation">↗</button>
    </Participant>)}
    {shellAgents.map((name) => <Participant key={name} name={name}
      mark={<ProviderLogo id={name === "Codex" ? "codex" : "claude-code"} size={16} />}
      status="via shell" stats={() => {
        const count = msgs.reduce((total, msg) => total + (msg.role === "assistant" ? (msg.toolCalls ?? []).filter((call) => shellAgentsOf([{ role: "assistant", content: "", toolCalls: [call] }]).includes(name)).length : 0), 0);
        return `${count} ${count === 1 ? "request" : "requests"} · Usage unavailable`;
      }} />)}
  </div>;
}
