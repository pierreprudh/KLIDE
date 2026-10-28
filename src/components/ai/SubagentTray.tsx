// The Delegate's own sub-agents of this turn, above the composer (rules in
// turnSubagents.ts). A drawer on the composer's top edge: one row per
// sub-agent while they work, one line once they have all settled, and a
// row's own steps one click away.

import { useMemo, useState } from "react";
import { foldAgentEvents, foldedToMsgs } from "../../agent/foldEvents";
import type { ProviderId } from "../../agent/types";
import { ChevronIcon } from "../../icons";
import { renderMessageBody } from "./ChatMessage";
import { ProviderLogo } from "./icons";
import "./subagentTray.css";
import { childTranscriptRows } from "./subagentWatch";
import { traySummary, type TraySubagent } from "./turnSubagents";
import { useElapsed } from "./WorkingRow";

export function SubagentTray({ subagents }: { subagents: TraySubagent[] }) {
  const running = subagents.some((s) => s.status === "running");
  // Open while any of them works, folded to its header once all have settled;
  // a click overrides either until the next turn brings new sub-agents (the
  // panel keys the tray by them).
  const [pinned, setPinned] = useState<boolean | null>(null);
  const open = pinned ?? running;
  const [opened, setOpened] = useState<string | null>(null);
  const provider = subagents[0]?.provider;
  // The type only tells one row from another when the rows differ: three
  // `Explore`s say "Explore" three times and nothing else.
  const mixedKinds = new Set(subagents.map((s) => s.kind)).size > 1;
  return (
    <div
      className="ai-msg-in"
      style={{
        margin: "0 14px -1px",
        border: "1px solid var(--composer-border)",
        borderBottom: "none",
        borderRadius: "12px 12px 0 0",
        background: "var(--bg-elevated)",
        minWidth: 0,
      }}
    >
      <button
        type="button"
        onClick={() => setPinned(!open)}
        aria-expanded={open}
        style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 12px", border: "none", background: "transparent", color: "var(--fg-subtle)", font: "inherit", fontSize: 12, textAlign: "left", cursor: "pointer", minWidth: 0 }}
      >
        {provider && <ProviderLogo id={provider as ProviderId} size={12} />}
        <span style={{ color: "var(--fg)" }}>{subagents.length === 1 ? "Sub-agent" : `${subagents.length} sub-agents`}</span>
        <span style={{ color: "var(--fg-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{traySummary(subagents)}</span>
        <ChevronIcon open={open} size={12} style={{ marginLeft: "auto", flexShrink: 0, color: "var(--fg-dim)" }} />
      </button>
      {open && (
        <div style={{ maxHeight: 260, overflowY: "auto", padding: "0 0 6px" }}>
          {subagents.map((s) => (
            <TrayRow key={s.id} subagent={s} showKind={mixedKinds} open={opened === s.id} onToggle={() => setOpened((was) => (was === s.id ? null : s.id))} />
          ))}
        </div>
      )}
    </div>
  );
}

function TrayRow({ subagent: s, showKind, open, onToggle }: { subagent: TraySubagent; showKind: boolean; open: boolean; onToggle: () => void }) {
  const working = s.status === "running";
  const done = s.status === "completed";
  const rows = useMemo(
    () => (open && s.nested?.length ? childTranscriptRows(foldedToMsgs(foldAgentEvents(s.nested)), s.task) : []),
    [open, s.nested, s.task],
  );
  return (
    <div style={{ minWidth: 0 }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{ display: "grid", gridTemplateColumns: "14px minmax(0, max-content) minmax(0, 1fr) auto", alignItems: "center", columnGap: 10, width: "100%", padding: "4px 12px", border: "none", background: "transparent", font: "inherit", textAlign: "left", cursor: "pointer", minWidth: 0 }}
      >
        <SubagentMark status={s.status} />
        {/* One sweep across the name and the brief while it works — the
            Working row's shimmer, painted through the text. */}
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5, ...(working ? {} : { color: "var(--fg-dim)" }) }}>
          {/* The type goes once its sub-agent is done — folded away, never
              struck: what was done is the brief, not the kind of helper. Its
              own sweep, since a clip-to-text parent is dropped through a
              child that clips its overflow (WebKit). */}
          {showKind && (
            <span className={`klide-subagent-kind${working ? " ai-working-label" : ""}`} data-gone={done} style={working ? undefined : { color: "var(--fg-subtle)" }}>
              {s.kind}
            </span>
          )}
          <span className={working ? "ai-working-label" : "klide-subagent-brief"} data-done={done}>{s.task}</span>
        </span>
        {/* Its own column, outside the sweep: a clip-to-text parent paints
            through its children's glyphs, so the step would shimmer too. */}
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-dim)" }}>
          {working ? s.state?.activity : null}
        </span>
        <TrayStatusWord subagent={s} />
      </button>
      {open && (
        <div style={{ margin: "2px 12px 8px 36px", padding: "0 0 0 12px", borderLeft: "1px solid var(--border)", minWidth: 0 }}>
          {rows.length === 0 ? (
            <span style={{ fontSize: 12, color: "var(--fg-dim)" }}>No steps yet.</span>
          ) : (
            rows.map((row, i) => <div key={i}>{renderMessageBody(row, false, { nested: true })}</div>)
          )}
        </div>
      )}
    </div>
  );
}

/** A circle per sub-agent: a turning arc while it works; when it is done the
 *  ring unwinds as a check draws in. Failed keeps the ring in the danger
 *  colour; a sub-agent that stopped or ended without a report keeps a broken
 *  ring, because nothing said it finished. */
function SubagentMark({ status }: { status: TraySubagent["status"] }) {
  const state = status === "running" ? "running" : status === "completed" ? "done" : status === "failed" ? "failed" : "ended";
  return (
    <svg className="klide-subagent-mark" data-state={state} width={14} height={14} viewBox="0 0 14 14" aria-label={state} role="img">
      <circle className="klide-subagent-mark-track" cx={7} cy={7} r={6} fill="none" pathLength={100} />
      {state === "running" && <circle className="klide-subagent-mark-arc" cx={7} cy={7} r={6} fill="none" pathLength={100} strokeLinecap="round" />}
      {state === "done" && (
        <>
          <circle className="klide-subagent-mark-unwind" cx={7} cy={7} r={6} fill="none" pathLength={100} />
          <path className="klide-subagent-mark-check" d="M3.8 7.2 6 9.3 10.2 4.9" fill="none" pathLength={100} strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </svg>
  );
}

function TrayStatusWord({ subagent: s }: { subagent: TraySubagent }) {
  const elapsed = useElapsed(s.status === "running" ? s.state?.startedMs : undefined);
  const style = { fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-dim)", whiteSpace: "nowrap" as const };
  if (s.status === "running") return <span style={style}>{elapsed}</span>;
  // Done says itself: the check and the struck line. Only an outcome that
  // is not "done" needs a word.
  if (s.status === "completed") return null;
  const word = s.status === "failed" ? "Failed" : s.status === "stopped" ? "Stopped" : "Ended";
  return <span style={{ ...style, color: s.status === "failed" ? "var(--danger)" : "var(--fg-dim)" }}>{word}</span>;
}
