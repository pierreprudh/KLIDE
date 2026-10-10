import { useEffect, useMemo, useState, type ReactNode, type ComponentProps } from "react";
import { onCoordinationChanged, readCoordinationSnapshot, type CoordinationRunSnapshot } from "../../agent/coordination";
import { createListenerScope } from "../../tauriEvents";
import { conversationMark } from "../../modelIdentity";
import type { PeerLink } from "./PeerLink";
import { peerName, workerChildrenOf } from "./coordinationPeers";
import { shellAgentsOf } from "./shellAgentEvidence";
import { eyesName, eyesOf, eyesStats } from "./sight";
import { formatCost } from "../../runs";
import type { Conversation, Msg } from "./types";
import type { ProviderId } from "../../agent/types";
import { createPortal } from "react-dom";
import { usePortalMenu } from "../../hooks/usePortalMenu";
import { ProviderLogo } from "./icons";
import { AgentMark } from "../fileMarks";
import { StepMark } from "../TodoStrip";
import { loadConversations } from "./storedConversations";
import { METRIC_GAP, participantStats, workerRunStats } from "./participantStats";
import { fetchAgentRunsCached, fetchRunOrigins, type Run, type RunOrigin } from "../../runs";

type ParticipantRow = { name: string; mark: ReactNode; status: string; outcome?: "done" | "failed"; stats: () => string; children?: ReactNode };

function Participant({ name, mark, status, outcome, stats, children, rows }: {
  name: string; mark: ReactNode; status: string;
  /** How the run ended, said by a mark at the end of the metrics line — the
   *  plan's own filled check for done, a muted cross for failed — never a
   *  word, never a colour on the card. Absent while it is live or for a peer. */
  outcome?: "done" | "failed";
  stats: () => string; children?: ReactNode; rows?: ParticipantRow[];
}) {
  const menu = usePortalMenu({ closeOnOutsideClick: true, computePos: (rect) => ({
    left: Math.max(12, Math.min(rect.right - 380, window.innerWidth - 392)),
    bottom: window.innerHeight - rect.top + 10,
  }) });
  const [lines, setLines] = useState<string[]>([]);
  const entries = rows ?? [{ name, mark, status, outcome, stats, children }];
  useEffect(() => {
    if (!menu.open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { menu.close(); menu.triggerRef.current?.focus(); } };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [menu.open, menu.close]);
  return <>
    <button ref={menu.triggerRef} type="button" className="ai-agent-avatar" title={name}
      aria-label={`${name} — show stats`} aria-expanded={menu.open}
      onClick={() => { if (menu.open) menu.close(); else { setLines(entries.map((entry) => entry.stats())); menu.openMenu(); } }}>{mark}</button>
    {menu.open && menu.pos && createPortal(<div ref={menu.menuRef} className="ai-agent-stats-card" style={menu.pos} role="dialog" aria-label={`${name} stats${outcome ? `, ${outcome}` : ""}`}>
      {entries.map((entry, rowIndex) => <div key={rowIndex} style={{ paddingTop: rowIndex ? 12 : 0 }}>
      <div className="ai-agent-stats-heading"><span className="ai-agent-activity-name">{entry.mark}<strong>{entry.name}</strong></span><span>{entry.status}</span>{entry.children}</div>
      <div className="ai-agent-stats-line" data-metrics="1" title={(lines[rowIndex] ?? "").split(METRIC_GAP).join("  ")}>
        {(lines[rowIndex] ?? "").split(METRIC_GAP).map((part, i) => <span key={i}>{part}</span>)}
        {entry.outcome === "done" && <span aria-label="done" style={{ flexShrink: 0, display: "grid", placeItems: "center" }}><StepMark index={0} state="done" /></span>}
        {entry.outcome === "failed" && (
          <span aria-label="failed" style={{ flexShrink: 0, width: 14, height: 14, borderRadius: "50%", border: "1px solid var(--border-strong)", display: "grid", placeItems: "center", color: "var(--fg-dim)", fontSize: 9, lineHeight: 1 }}>×</span>
        )}
      </div>
      </div>)}
    </div>, document.body)}
  </>;
}

export function AgentActivity({ msgs, onOpenRun, ...props }: ComponentProps<typeof PeerLink> & {
  msgs: Msg[];
  /** Where a worker child opens: its row in Mission Control. A child is a Run
   *  with a transcript, not a conversation with a panel, so the arrow leads
   *  to the board; peers that are conversations keep `onOpen`. */
  onOpenRun?: (runId: string) => void;
}) {
  const { workspaceRoot, selfId } = props;
  // The children's run records, for the stats line: a worker has no stored
  // conversation, so its duration, messages, tokens and cost come from the
  // run ledger instead. Refreshed with the journal.
  const [runRecords, setRunRecords] = useState<Map<string, Run>>(() => new Map());
  const [origins, setOrigins] = useState<Map<string, RunOrigin>>(() => new Map());
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
        const childRuns = snapshot.runs.filter((r) => r.registration.parentRunId === selfId);
        if (!disposed && request === revision) setChildren({ key, runs: childRuns });
        try {
          const identities = await fetchRunOrigins(childRuns.map((r) => r.registration.runId));
          if (!disposed && request === revision) setOrigins(new Map(identities.map((origin) => [origin.runId, origin])));
        } catch { /* Keep the participants visible if identity lookup fails. */ }
      } catch { if (!disposed && request === revision) setChildren({ key, runs: [] }); }
      try {
        const recent = await fetchAgentRunsCached(60, 0, { force: true });
        if (!disposed && request === revision) setRunRecords(new Map(recent.map((run) => [run.id, run])));
      } catch { /* the ledger is a nicety here; the strip stands without it */ }
    };
    void refresh();
    const scope = createListenerScope();
    scope.add(onCoordinationChanged((event) => { if (event.workspaceRoot === workspaceRoot) void refresh(); }));
    return () => { disposed = true; scope.dispose(); };
  }, [workspaceRoot, selfId, key]);
  const runs = children.key === key ? children.runs : [];
  const peers = [...new Set([...props.peers, ...runs.map((r) => r.registration.runId)])].filter((id) => id !== selfId);
  const shellAgents = useMemo(() => shellAgentsOf(msgs), [msgs]);
  // The eyes that read a photo for this conversation's model (Rust
  // `agent::sight`) took part in it too, and wear their maker's mark.
  const eyes = useMemo(() => eyesOf(msgs), [msgs]);
  const index = new Map(props.index);
  // A worker child has no stored conversation of its own, so the index knows
  // nothing about it; the spawn call in this transcript says which Delegate
  // it ran as, and that is the mark it should wear.
  const workers = useMemo(() => workerChildrenOf(msgs, selfId), [msgs, selfId]);
  for (const run of runs) if (!index.has(run.registration.runId)) {
    const worker = workers.get(run.registration.runId);
    const record = runRecords.get(run.registration.runId);
    const origin = origins.get(run.registration.runId);
    index.set(run.registration.runId, {
      title: run.registration.label ?? run.registration.runId,
      provider: ((origin?.provider ?? record?.provider ?? worker?.provider) as ProviderId | undefined) ?? null,
      model: origin?.model ?? record?.model ?? worker?.model ?? null,
    });
  }
  const participantGroups = new Map<string, string[]>();
  for (const id of peers) {
    const identity = index.get(id);
    const label = conversationMark(identity?.model, identity?.provider, 16)?.label ?? "Klide agent";
    participantGroups.set(label, [...(participantGroups.get(label) ?? []), id]);
  }
  if (!peers.length && !shellAgents.length && !eyes.length) return null;
  return <div className="ai-agent-activity" key={key} role="group" aria-label="Agents in this conversation">
    {[...participantGroups.values()].map((ids) => {
      const id = ids[0];
      const rows: ParticipantRow[] = ids.map((peer) => {
        const child = runs.some((run) => run.registration.runId === peer);
        const state = runs.find((run) => run.registration.runId === peer)?.state;
        const open = child && onOpenRun ? () => onOpenRun(peer) : props.onOpen ? () => props.onOpen?.(peer) : undefined;
        return {
          name: peerName(peer, index),
          mark: conversationMark(index.get(peer)?.model, index.get(peer)?.provider, 16)?.node ?? <AgentMark size={16} />,
          status: [child ? undefined : "Message peer", index.get(peer)?.model].filter(Boolean).join(" "),
          outcome: state === "done" ? "done" : state === "failed" || state === "cancelled" ? "failed" : undefined,
          stats: () => {
            const record = child ? runRecords.get(peer) : undefined;
            return record ? workerRunStats(record) : participantStats(loadConversations<Conversation>().find((conversation) => conversation.id === peer)?.msgs ?? []);
          },
          children: <button type="button" className="ai-agent-open" disabled={!open} onClick={open} aria-label={`Open ${peerName(peer, index)}`} title={`Open ${peerName(peer, index)}`}><span aria-hidden="true">↗</span></button>,
        };
      });
      return <Participant key={id} {...rows[0]} name={rows.map((row) => row.name).join(", ")} rows={rows} />;
    })}
    {shellAgents.map((name) => <Participant key={name} name={name}
      mark={<ProviderLogo id={name === "Codex" ? "codex" : "claude-code"} size={16} />}
      status="via shell" stats={() => {
        const count = msgs.reduce((total, msg) => total + (msg.role === "assistant" ? (msg.toolCalls ?? []).filter((call) => shellAgentsOf([{ role: "assistant", content: "", toolCalls: [call] }]).includes(name)).length : 0), 0);
        return `${count} ${count === 1 ? "request" : "requests"} · Usage unavailable`;
      }} />)}
    {eyes.map((e) => <Participant key={`eyes:${e.provider}/${e.model}`} name={eyesName(e)}
      mark={conversationMark(e.model, (e.provider || null) as ProviderId | null, 16)?.node ?? <AgentMark size={16} />}
      status="Eyes" stats={() => {
        // The described photos say how many; the step rows say what it cost.
        const stats = eyesStats(msgs, e);
        const parts = [`${e.images} ${e.images === 1 ? "image" : "images"} described`];
        if (stats.tokens > 0) parts.push(`${stats.tokens.toLocaleString()} tokens`);
        const cost = formatCost(stats.costUsd);
        parts.push(cost ?? (stats.tokens > 0 ? "no list price" : "Usage unavailable"));
        return parts.join(METRIC_GAP);
      }} />)}
  </div>;
}
