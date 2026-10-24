import { useMemo, type CSSProperties } from "react";
import { AiIcon, AttachIcon, ChevronIcon, ClockIcon, CompactIcon, DocumentIcon } from "../../icons";
import { formatSpan } from "../../time";
import { makerMark, modelBrandColor } from "../../modelIdentity";
import { isKnownProvider } from "../../agent/providers";
import type { AgentEvent } from "../../agent/types";
import { buildContextTrace, buildUsageTrace, type ContextTraceItem } from "../../agent/runTraceDetails";

function count(value?: number) { return value === undefined ? "—" : value.toLocaleString(); }
function shortCount(value?: number) { return value === undefined ? "—" : value >= 1000 ? `${parseFloat((value / 1000).toFixed(1))}k` : value.toLocaleString(); }
function dollars(value?: number) { return value === undefined ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value); }
function offset(ts: number, start: number) { const ms = Math.max(0, ts - start); return ms < 1000 ? `+${Math.round(ms)}ms` : ms < 60_000 ? `+${parseFloat((ms / 1000).toFixed(1))}s` : `+${formatSpan(ms)}`; }

function DetailMetrics({ values }: { values: [string, string][] }) {
  return <dl className="trace-metrics trace-details-metrics">{values.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function Trend({ label, values, format }: { label: string; values: { label: string; value: number }[]; format: (value: number) => string }) {
  const max = Math.max(...values.map(point => point.value)) || 1;
  const x = (i: number) => 20 + (values.length === 1 ? 0.5 : i / (values.length - 1)) * 680;
  const y = (value: number) => 100 - value / max * 78;
  return <figure className="trace-trend">
    <figcaption><strong>{label}</strong><span>{format(values[values.length - 1].value)}</span></figcaption>
    <svg viewBox="0 0 720 120" role="img" aria-label={`${label}: ${values.map(point => `${point.label}, ${format(point.value)}`).join("; ")}`}>
      {[22, 61, 100].map(top => <line key={top} x1="20" x2="700" y1={top} y2={top} className="trace-trend-grid" />)}
      <polyline points={values.map((point, i) => `${x(i)},${y(point.value)}`).join(" ")} className="trace-trend-line" />
      {values.map((point, i) => <circle key={i} cx={x(i)} cy={y(point.value)} r="3.5" className="trace-trend-point"><title>{point.label}: {format(point.value)}</title></circle>)}
    </svg>
    <div className="trace-trend-labels"><span>{values[0].label}</span><span>{values[values.length - 1].label}</span></div>
  </figure>;
}

function ContextIcon({ kind }: { kind: ContextTraceItem["kind"] }) {
  const Icon = kind === "snapshot" ? DocumentIcon : kind === "compaction" ? CompactIcon : kind === "input" ? AiIcon : AttachIcon;
  return <Icon size={15} />;
}

export function RunContextTrace({ events, start }: { events: AgentEvent[]; start: number }) {
  const items = useMemo(() => buildContextTrace(events), [events]);
  const inputs = items.filter(item => item.kind === "input");
  const snapshots = items.filter(item => item.kind === "snapshot");
  const sourceCount = new Set(snapshots.flatMap(item => item.sources.filter(source => source.kind !== "Omitted").map(source => `${source.kind}:${source.label}`))).size;
  const latestInput = inputs[inputs.length - 1];
  const latestSnapshot = snapshots[snapshots.length - 1];
  if (!items.length) return <div className="trace-details-empty"><DocumentIcon size={22} /><strong>No context data recorded</strong><p>This run has no context snapshots, injections, compaction events, or reported input tokens.</p></div>;
  return <div className="trace-details">
    <DetailMetrics values={[["Latest input", shortCount(latestInput?.size)], ["Supplied estimate", shortCount(latestSnapshot?.size)], ["Sources", snapshots.length ? String(sourceCount) : "—"], ["Compactions", String(items.filter(item => item.kind === "compaction").length)]]} />
    {inputs.length > 0 && <Trend label="Reported input per response" values={inputs.map(item => ({ label: item.label.replace("Model input · ", ""), value: item.size! }))} format={value => `${count(value)} tokens`} />}
    <p className="trace-detail-note">Open an event to inspect its recorded content. Supplied context and compaction sizes are estimates; reported model input also includes history and tool results.{latestInput?.window ? ` Recorded context window: ${count(latestInput.window)} tokens.` : ""}</p>
    <ol className="trace-context-list" aria-label="Context events">
      {items.map(item => <li key={item.id}><details>
        <summary><span className={`trace-context-icon is-${item.kind}`}><ContextIcon kind={item.kind} /></span><span className="trace-context-name">{item.label}<small>{item.kind === "snapshot" ? `${item.sources.filter(source => source.kind !== "Omitted").length} sources recorded` : item.kind === "injection" ? `${item.detail.length.toLocaleString()} characters` : item.estimated ? "Estimated context after compaction" : "Reported by the provider"}</small></span><span className="trace-context-size">{item.size !== undefined ? <>{item.estimated ? "≈ " : ""}{count(item.size)}<small>tokens</small></> : "—"}</span><time>{offset(item.ts, start)}</time><span className="trace-context-chevron" aria-hidden="true"><ChevronIcon size={10} /></span></summary>
        <div className="trace-context-content">
          {item.sources.length > 0 && <ul className="trace-context-sources">{item.sources.map((source, index) => <li key={index}><details><summary><span>{source.kind}</span><strong>{source.label}</strong></summary><pre>{source.detail || "No additional content recorded."}</pre></details></li>)}</ul>}
          {item.detail && <><span className="trace-detail-label">{item.kind === "snapshot" ? "Recalled memory supplied to the model" : item.kind === "compaction" ? "Compaction summary" : "Recorded content"}</span><pre>{item.detail}</pre></>}
          {!item.sources.length && !item.detail && <p>No additional details recorded.</p>}
        </div>
      </details></li>)}
    </ol>
  </div>;
}

export function RunUsageTrace({ events, start }: { events: AgentEvent[]; start: number }) {
  const usage = useMemo(() => buildUsageTrace(events), [events]);
  const maxTokens = Math.max(1, ...usage.rows.map(row => (row.input ?? 0) + (row.output ?? 0)));
  const costPoints = usage.rows.filter(row => row.cost !== undefined).map(row => ({ label: row.label, value: row.cumulativeCost! }));
  if (!usage.rows.length) return <div className="trace-details-empty"><ClockIcon size={22} /><strong>No usage data recorded</strong><p>Token and cost entries appear when a model response, image description, or compaction is recorded.</p></div>;
  return <div className="trace-details">
    <DetailMetrics values={[["Input tokens", shortCount(usage.input)], ["Output tokens", shortCount(usage.output)], ["Cache reads", shortCount(usage.cacheRead)], ["Recorded cost", dollars(usage.cost)]]} />
    {costPoints.length > 0 ? <Trend label="Cumulative recorded cost" values={costPoints} format={dollars} /> : <p className="trace-detail-note">No cost was recorded for this run. Missing cost does not mean the model was free.</p>}
    <p className="trace-detail-note">Totals include recorded values only, including compaction and image descriptions when available. Cache reads and writes are part of input tokens.{usage.costCoverage < usage.rows.length ? ` Cost is available for ${usage.costCoverage} of ${usage.rows.length} entries; missing amounts are excluded.` : " Recorded cost may include estimates."}</p>
    <div className="trace-usage-scroll"><table className="trace-usage-table"><caption>Token usage and cost per response</caption><thead><tr><th scope="col">Response</th><th scope="col">Input / output</th><th scope="col">Cache read</th><th scope="col">Cost</th><th scope="col">Cumulative</th></tr></thead><tbody>
      {usage.rows.map(row => {
        const color = modelBrandColor(row.model, row.provider);
        const knownProvider = row.provider && isKnownProvider(row.provider) ? row.provider : undefined;
        const mark = makerMark(row.model, knownProvider, 15) ?? (row.kind === "compaction" ? <CompactIcon size={15} /> : <AiIcon size={15} />);
        return <tr key={row.id} style={{ "--trace-row-color": color } as CSSProperties}>
          <th scope="row"><span className="trace-usage-identity">{mark}<span>{row.label}<small title={row.model}>{row.model ?? (row.kind === "compaction" ? "Model not recorded" : "Unknown model")} · {offset(row.ts, start)}</small></span></span></th>
          <td><span className="trace-token-values"><span title="Input tokens">{count(row.input)}</span><span title="Output tokens">{count(row.output)}</span></span><span className="trace-token-bar" aria-hidden="true"><span className="trace-token-input" style={{ width: `${(row.input ?? 0) / maxTokens * 100}%` }} /><span className="trace-token-output" style={{ width: `${(row.output ?? 0) / maxTokens * 100}%` }} /></span></td>
          <td title={`Cache writes: ${count(row.cacheWrite)}`}>{count(row.cacheRead)}{row.cacheWrite !== undefined && <small className="trace-cache-write">{count(row.cacheWrite)} written</small>}</td>
          <td>{dollars(row.cost)}</td><td>{dollars(row.cumulativeCost)}</td>
        </tr>;
      })}
    </tbody></table></div>
    <div className="trace-usage-legend"><span><i className="trace-token-input" />Input</span><span><i className="trace-token-output" />Output</span><span>— Not recorded</span></div>
  </div>;
}
