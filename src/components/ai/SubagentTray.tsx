// The Delegate's own sub-agents of this turn, above the composer (rules in
// turnSubagents.ts). A drawer on the composer's top edge: one row per
// sub-agent while they work, one line once they have all settled, and a
// row's own steps one click away.

import { useMemo, useState } from "react";
import { foldAgentEvents, foldedToMsgs } from "../../agent/foldEvents";
import type { ProviderId } from "../../agent/types";
import { ChevronIcon } from "../../icons";
import { renderMessageBody } from "./ChatMessage";
import { DotGridLoader, ProviderLogo } from "./icons";
import { childTranscriptRows } from "./subagentWatch";
import { traySummary, type TraySubagent } from "./turnSubagents";
import { formatElapsed, useElapsed } from "./WorkingRow";

export function SubagentTray({ subagents }: { subagents: TraySubagent[] }) {
  const running = subagents.some((s) => s.status === "running");
  // Open while any of them works, folded to its header once all have settled;
  // a click overrides either until the next turn brings new sub-agents (the
  // panel keys the tray by them).
  const [pinned, setPinned] = useState<boolean | null>(null);
  const open = pinned ?? running;
  const [opened, setOpened] = useState<string | null>(null);
  const provider = subagents[0]?.provider;
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
            <TrayRow key={s.id} subagent={s} open={opened === s.id} onToggle={() => setOpened((was) => (was === s.id ? null : s.id))} />
          ))}
        </div>
      )}
    </div>
  );
}

function TrayRow({ subagent: s, open, onToggle }: { subagent: TraySubagent; open: boolean; onToggle: () => void }) {
  const working = s.status === "running";
  const rows = useMemo(
    () => (open && s.nested?.length ? childTranscriptRows(foldedToMsgs(foldAgentEvents(s.nested)), s.task) : []),
    [open, s.nested, s.task],
  );
  const steps = s.state?.steps ?? s.nested?.filter((e) => e.type === "observed_tool_call").length ?? 0;
  return (
    <div style={{ minWidth: 0 }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{ display: "grid", gridTemplateColumns: "14px max-content minmax(0, 1fr) auto", alignItems: "center", columnGap: 10, width: "100%", padding: "4px 12px", border: "none", background: "transparent", font: "inherit", textAlign: "left", cursor: "pointer", minWidth: 0 }}
      >
        <span style={{ display: "inline-flex", justifyContent: "center" }}>
          {working ? <DotGridLoader size={10} label={`${s.kind} running`} /> : null}
        </span>
        <span style={{ fontSize: 12.5, fontWeight: 500, color: working ? "var(--fg-strong)" : "var(--fg-subtle)" }}>{s.kind}</span>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5, color: working ? "var(--fg)" : "var(--fg-dim)" }}>
          {s.task}
          {working && s.state?.activity && (
            <span style={{ marginLeft: 8, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-dim)" }}>{s.state.activity}</span>
          )}
        </span>
        <TrayStatusWord subagent={s} steps={steps} />
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

function TrayStatusWord({ subagent: s, steps }: { subagent: TraySubagent; steps: number }) {
  const elapsed = useElapsed(s.status === "running" ? s.state?.startedMs : undefined);
  const style = { fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-dim)", whiteSpace: "nowrap" as const };
  if (s.status === "running") return <span style={style}>{elapsed}</span>;
  const took = s.state?.startedMs !== undefined && s.state.endedMs !== undefined ? formatElapsed(s.state.endedMs - s.state.startedMs) : null;
  const word = s.status === "completed" ? "Done" : s.status === "failed" ? "Failed" : s.status === "stopped" ? "Stopped" : "Ended";
  const detail = [steps > 0 ? `${steps} ${steps === 1 ? "step" : "steps"}` : null, took].filter(Boolean).join(" · ");
  return (
    <span style={{ ...style, color: s.status === "failed" ? "var(--danger, var(--fg-subtle))" : "var(--fg-dim)" }}>
      {word}{detail ? ` · ${detail}` : ""}
    </span>
  );
}
