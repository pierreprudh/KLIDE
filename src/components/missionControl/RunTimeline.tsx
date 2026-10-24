import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { AiIcon, CheckIcon, ChevronIcon, ClockIcon, CloseIcon, DiagramIcon, ErrorIcon, OrchestratorIcon, PauseIcon, PlayIcon, ReplayIcon, SearchIcon } from "../../icons";
import { makerMark, modelBrandColor } from "../../modelIdentity";
import { isKnownProvider } from "../../agent/providers";
import { ProviderLogo, ToolIcon } from "../ai/icons";
import { formatSpan } from "../../time";
import { readAgentRunEvents } from "../../agent/client";
import type { AgentEvent } from "../../agent/types";
import { buildRunTimeline, timelineRuns, type TimelineSpan } from "../../agent/runTimeline";
import type { Run } from "../../runs";
import { buildUsageTrace } from "../../agent/runTraceDetails";
import { RunContextTrace, RunUsageTrace } from "./RunTraceDetails";
import "./runTimeline.css";

function durationLabel(ms: number) {
  return ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${parseFloat((ms / 1000).toFixed(1))}s` : formatSpan(ms);
}
function compactNumber(n: number) { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString(); }
function costLabel(n: number) { return `$${n < 0.01 && n > 0 ? n.toFixed(3) : n.toFixed(2)}`; }
function StepIcon({ kind, model, provider, label }: Pick<TimelineSpan, "kind" | "model" | "provider" | "label">) {
  const knownProvider = provider && isKnownProvider(provider) ? provider : undefined;
  const brand = makerMark(model, knownProvider, 14) ?? (knownProvider ? <ProviderLogo id={knownProvider} size={14} /> : null);
  const icon = kind === "model" ? brand ?? <AiIcon size={13} /> : kind === "worker" ? brand ?? <OrchestratorIcon size={13} /> : kind === "wait" ? <ClockIcon size={13} /> : <ToolIcon name={label} size={13} />;
  return <span className={`trace-step-icon is-${kind}`} style={model || provider ? { color: modelBrandColor(model, provider) } : undefined} title={model ?? provider}>{icon}</span>;
}

function SpanBar({ span, start, scale, cursor, aggregate = false }: { span: TimelineSpan; start: number; scale: number; cursor: number; aggregate?: boolean }) {
  const popoverId = useId();
  const popover = useRef<HTMLDivElement>(null);
  const end = Math.min(span.end ?? cursor, cursor);
  const elapsed = Math.max(0, end - span.start);
  const running = span.start <= cursor && (span.end === undefined || span.end > cursor);
  const status = running ? "running" : span.status;
  const completed = span.end !== undefined && span.end <= cursor;
  const statusLabel = status === "done" ? "Completed" : status === "error" ? "Failed" : status === "incomplete" ? "No finish recorded" : "Running";
  const left = Math.max(0, (span.start - start) / scale * 100);
  const width = Math.max(0, elapsed / scale * 100);
  const color = span.model || span.provider ? modelBrandColor(span.model, span.provider) : undefined;
  function place() {
    const r = popover.current?.previousElementSibling?.getBoundingClientRect();
    const p = popover.current;
    if (!r || !p) return;
    p.style.left = `${Math.max(12, Math.min(window.innerWidth - Math.min(328, window.innerWidth - 24) - 12, r.left))}px`;
    p.style.top = `${Math.max(12, Math.min(window.innerHeight - 440, r.bottom + 8))}px`;
  }
  return <>
    <button className={`trace-bar is-${span.kind} is-${status}${aggregate ? " is-aggregate" : ""}`}
      style={{ left: `${left}%`, width: `${width}%`, ...(color ? { "--trace-span-color": color, "--trace-span-ink": color === "var(--fg-strong)" ? "var(--bg)" : "#fff" } : {}) } as CSSProperties}
      aria-label={`Details for ${span.label}`} popoverTarget={popoverId} onClick={place} title={`${span.label} · ${durationLabel(elapsed)} · ${statusLabel}`}>
      {status === "error" ? <CloseIcon size={12} /> : running ? <span className="trace-running-mark" /> : null}
    </button>
    <div ref={popover} id={popoverId} popover="auto" className="trace-popover" role="dialog" aria-label={span.label}>
      <header><StepIcon {...span} /><strong>{span.label}</strong><span className={`trace-status is-${status}`}>{statusLabel}</span><button className="trace-icon-button trace-close" aria-label="Close step details" popoverTarget={popoverId} popoverTargetAction="hide"><CloseIcon size={15} /></button></header>
      <dl className="trace-popover-metrics">
        <div><dt>Duration</dt><dd>{durationLabel(elapsed)}</dd></div>
        <div><dt>Started</dt><dd>+{durationLabel(span.start - start)}</dd></div>
        {completed && span.cost !== undefined && <div><dt>Cost</dt><dd>{costLabel(span.cost)}</dd></div>}
        {completed && span.tokensIn !== undefined && <div><dt>Tokens in</dt><dd>{compactNumber(span.tokensIn)}</dd></div>}
        {completed && span.tokensOut !== undefined && <div><dt>Tokens out</dt><dd>{compactNumber(span.tokensOut)}</dd></div>}
      </dl>
      {status === "error" && <div className="trace-error-notice"><ErrorIcon size={16} />This step failed. See the recorded output below.</div>}
      <p className="trace-popover-caption">{span.observed ? "Observed delegate activity" : span.kind === "worker" ? "Dispatch to report, including delivery time" : span.kind === "model" ? "Measured provider response" : "Recorded activity"}</p>
      <pre>{span.detail || "No additional details recorded."}</pre>
    </div>
    {!aggregate && <span className="trace-span-caption" style={{ left: `calc(${left + width}% + 8px)` }}>{durationLabel(elapsed)}{completed && span.cost !== undefined ? ` · ${costLabel(span.cost)}` : ""}</span>}
  </>;
}

export function RunTimeline({ run, view = "timeline" }: { run: Run; view?: "timeline" | "context" | "usage" }) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(Date.now);
  const [retry, setRetry] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [column, setColumn] = useState(42);
  const [replay, setReplay] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const table = useRef<HTMLDivElement>(null);
  const conversationActive = run.status === "running" || run.status === "waiting";
  useEffect(() => {
    if (run.source !== "klide") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const snapshot = await readAgentRunEvents(run.id);
        if (!cancelled) { setEvents(snapshot); setNow(Date.now()); setError(false); }
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) {
          setLoading(false);
          if (conversationActive) timer = setTimeout(() => void refresh(), 2000);
        }
      }
    }
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [run.id, run.source, conversationActive, retry]);
  const runs = useMemo(() => timelineRuns(events), [events]);
  const latest = runs[runs.length - 1];
  const selected = runs.find(candidate => candidate.id === selectedRunId) ?? latest;
  const identity = selected?.events.find(event => event.type === "run_started");
  const active = conversationActive && selected === latest && !selected?.events.some(event => event.type === "run_result" || event.type === "run_error");
  const trace = useMemo(() => buildRunTimeline(selected?.events ?? [], active, now), [selected, active, now]);
  useEffect(() => { setReplay(null); setPlaying(false); setCollapsed(new Set()); }, [selected?.id]);
  const duration = Math.max(1, trace.end - trace.start);
  useEffect(() => {
    if (!playing || view !== "timeline") return;
    let previous = performance.now();
    const timer = setInterval(() => {
      const next = performance.now();
      const delta = (next - previous) * speed;
      previous = next;
      setReplay(value => Math.min(duration, (value ?? 0) + delta));
    }, 80);
    return () => clearInterval(timer);
  }, [playing, speed, duration, view]);
  useEffect(() => { setPlaying(false); }, [view]);
  useEffect(() => { if (replay !== null && replay >= duration) setPlaying(false); }, [replay, duration]);
  const cursor = trace.start + (replay ?? duration);
  const accounting = useMemo(() => buildUsageTrace((selected?.events ?? []).filter(event => event.ts <= cursor)), [selected, cursor]);
  const needle = query.trim().toLowerCase();
  const { rows, children, visible } = useMemo(() => {
    const visible = trace.spans.filter(s => s.start <= cursor);
    const matches = new Set(visible.filter(s => `${s.label} ${s.kind} ${s.observed ? "observed" : ""}`.toLowerCase().includes(needle)).map(s => s.id));
    // Search keeps each matching step's recorded parent visible.
    for (const span of visible) if (matches.has(span.id) && span.parentId) matches.add(span.parentId);
    const rows = visible.filter(s => matches.has(s.id));
    const children = new Map<string, TimelineSpan[]>();
    for (const span of rows) if (span.parentId) children.set(span.parentId, [...(children.get(span.parentId) ?? []), span]);
    return { rows, children, visible };
  }, [trace, cursor, needle]);
  if (run.source !== "klide") return <p className="run-timeline-note">This imported session has no structured trace data. Open Conversation to inspect its activity.</p>;
  if (loading) return <p className="run-timeline-note" role="status">Loading timeline…</p>;
  if (error && !events.length) return <p className="run-timeline-note" role="alert">Couldn’t read the timeline. <button onClick={() => setRetry(n => n + 1)}>Retry</button></p>;
  const rawStep = duration / 3;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const tickStep = ([1, 2, 5, 10].find(n => n * magnitude >= rawStep) ?? 10) * magnitude;
  const scale = Math.ceil(duration / tickStep) * tickStep;
  const ticks = Array.from({ length: Math.round(scale / tickStep) + 1 }, (_, i) => i * tickStep);
  const recordedCost = accounting.cost;
  const recordedTokens = (accounting.input ?? 0) + (accounting.output ?? 0);
  const stats = [
    ["Duration", durationLabel(replay ?? duration)], ["Cost", recordedCost === undefined ? "—" : costLabel(recordedCost)],
    ["Tokens", recordedTokens ? compactNumber(recordedTokens) : "—"], ["LLM calls", String(visible.filter(s => s.kind === "model").length)],
    ["Tool calls", String(visible.filter(s => s.kind === "tool").length)], ["Errors", String(visible.filter(s => s.status === "error" && (s.end ?? Infinity) <= cursor).length)],
  ];
  const rowIds = new Set(rows.map(span => span.id));
  function toggle(id: string) { setCollapsed(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  function renderRow(span: TimelineSpan, depth: number): React.ReactNode {
    const nested = children.get(span.id) ?? [];
    const closed = collapsed.has(span.id) && !needle;
    const failed = span.status === "error" && (span.end ?? Infinity) <= cursor;
    return <li key={span.id} className="trace-node" style={{ "--trace-depth": depth } as CSSProperties}>
      <div className={`trace-row${failed ? " is-failed" : ""}`}>
        <div className="trace-row-label">
          {nested.length ? <button className="trace-icon-button trace-disclosure" aria-label={`${closed ? "Expand" : "Collapse"} ${span.label}`} aria-expanded={!closed} onClick={() => toggle(span.id)}><ChevronIcon size={11} style={{ transform: closed ? "rotate(-90deg)" : "none" }} /></button> : <span className="trace-leaf-branch" aria-hidden="true" />}
          <span className="trace-step-mark"><StepIcon {...span} />{failed && <span className="trace-step-error"><ErrorIcon size={10} /></span>}</span><span className="trace-step-name" title={span.label}>{span.label}</span>
        </div>
        <div className="trace-row-track"><div className="trace-clock"><SpanBar span={span} start={trace.start} scale={scale} cursor={cursor} /></div></div>
      </div>
      {nested.length > 0 && !closed && <ul className="trace-children" style={{ "--trace-depth": depth + 1 } as CSSProperties}>{nested.map(child => renderRow(child, depth + 1))}</ul>}
    </li>;
  }
  const modelColor = modelBrandColor(identity?.model ?? run.model, identity?.provider ?? run.provider);
  return <section className="run-timeline" style={{ "--trace-model-color": modelColor, "--trace-model-ink": modelColor === "var(--fg-strong)" ? "var(--bg)" : "#fff" } as CSSProperties} aria-label={view === "context" ? "Run context trace" : view === "usage" ? "Run tokens and cost" : "Run timeline"} onKeyDown={event => { if (view === "timeline" && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") { event.preventDefault(); search.current?.focus(); } }}>
    <header className="trace-header"><div className="trace-run-heading"><strong>{view === "context" ? "Context" : view === "usage" ? "Tokens & cost" : "Trace"}</strong>{runs.length > 1 && <select aria-label="Recorded run" value={selectedRunId ?? "latest"} onChange={event => setSelectedRunId(event.target.value === "latest" ? null : Number(event.target.value))}>
      <option value="latest">Latest run · {runs.length}</option>
      {runs.slice(0, -1).map((recorded, index) => <option key={recorded.id} value={recorded.id}>Run {index + 1} · {new Date(recorded.startedAt).toLocaleString()}</option>)}
    </select>}</div>{view === "timeline" && <label className="trace-search"><SearchIcon size={14} /><input ref={search} type="search" aria-label="Search timeline steps" placeholder="Search" value={query} onChange={e => setQuery(e.target.value)} /><kbd>⌘F</kbd></label>}</header>
    {error && <p role="status" className="run-timeline-note">Refresh failed. Showing the last recorded activity.</p>}
    {view === "context" ? <RunContextTrace events={selected?.events ?? []} start={trace.start} /> : view === "usage" ? <RunUsageTrace events={selected?.events ?? []} start={trace.start} /> : <>
    <dl className="trace-metrics">{stats.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <div className="trace-table-scroll">
      <div ref={table} className="trace-table" style={{ "--trace-label-width": `${column}%`, "--trace-grid-size": `${tickStep / scale * 100}%` } as CSSProperties}>
        <div className="trace-axis"><span><DiagramIcon size={13} />Steps</span><div className="trace-row-track"><div className="trace-clock">{ticks.map(tick => <span key={tick} style={{ left: `${tick / scale * 100}%` }}>{tick === 0 ? "0s" : durationLabel(tick)}</span>)}</div></div></div>
        <ul className="trace-tree">
          <li>
            <div className="trace-row trace-root">
              <div className="trace-row-label"><button className="trace-icon-button trace-disclosure" aria-label={`${collapsed.has("root") && !needle ? "Expand" : "Collapse"} Orchestrator`} aria-expanded={!collapsed.has("root") || !!needle} onClick={() => toggle("root")}><ChevronIcon size={11} style={{ transform: collapsed.has("root") && !needle ? "rotate(-90deg)" : "none" }} /></button><StepIcon kind="model" label="Orchestrator" model={identity?.model ?? run.model ?? undefined} provider={identity?.provider ?? run.provider ?? undefined} /><strong className="trace-step-name">Orchestrator</strong></div>
              <div className="trace-row-track"><div className="trace-clock">{visible.map(span => <SpanBar key={span.id} span={span} start={trace.start} scale={scale} cursor={cursor} aggregate />)}<span className="trace-span-caption" style={{ left: `calc(${(replay ?? duration) / scale * 100}% + 8px)` }}>{durationLabel(replay ?? duration)}{recordedCost !== undefined ? ` · ${costLabel(recordedCost)}` : ""}</span></div></div>
            </div>
            {(!collapsed.has("root") || needle) && <ul className="trace-children" style={{ "--trace-depth": 1 } as CSSProperties}>{rows.filter(span => !span.parentId || !rowIds.has(span.parentId)).map(span => renderRow(span, 1))}</ul>}
          </li>
        </ul>
        {!rows.length && <p className="run-timeline-note">{needle ? "No steps match your search." : "Waiting for the first step…"}</p>}
        <div className="trace-column-resizer" role="separator" aria-label="Resize the step column" aria-orientation="vertical" aria-valuenow={Math.round(column)} aria-valuemin={28} aria-valuemax={65} tabIndex={0} style={{ left: `${column}%` }}
          onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setColumn(value => Math.max(28, Math.min(65, value + (event.key === "ArrowRight" ? 2 : -2)))); } }}
          onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const r = table.current?.getBoundingClientRect(); if (r) setColumn(Math.max(28, Math.min(65, (event.clientX - r.left) / r.width * 100))); }} />
        <div className="trace-playhead" aria-hidden="true" style={{ left: `calc(${column}% + (100% - ${column}% - 90px) * ${(replay ?? duration) / scale})` }}><i /></div>
      </div>
    </div>
    <footer className="trace-footer">
      <button className="trace-icon-button trace-play" aria-label={playing ? "Pause replay" : "Play replay"} onClick={() => { if (playing) setPlaying(false); else { if (replay === null || replay >= duration) setReplay(0); setPlaying(true); } }}>{playing ? <PauseIcon size={14} /> : <PlayIcon size={14} />}</button>
      <button className="trace-icon-button" aria-label="Replay from the start" onClick={() => { setReplay(0); setPlaying(true); }}><ReplayIcon size={15} /></button>
      <button className="trace-speed" aria-label={`Replay speed ${speed}x; click to double`} title="Click to double replay speed (1× → 2× → 4× → 8× → 1×)" onClick={() => setSpeed(value => value >= 8 ? 1 : value * 2)}>{speed}x</button>
      {replay !== null && <button className="trace-latest" onClick={() => { setPlaying(false); setReplay(null); }}>{active ? "Back to live" : "Show full trace"}</button>}
      <span className="trace-footer-state" title="Only recorded timing and usage are shown. Worker spans include report delivery time.">{active && replay === null ? <><span className="trace-live-dot" />Live</> : <><CheckIcon size={12} />Recorded</>}</span>
    </footer>
    </>}
  </section>;
}
