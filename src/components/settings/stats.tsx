// Usage stats — the Stats section: histogram, donut, provider grouping,
// cost/token metrics over agent runs. Extracted from SettingsPanel.tsx.

import { useCallback, useMemo, useState, type CSSProperties } from "react";
import { ProviderLogo } from "../ai/icons";
import type { ProviderId } from "../../agent/types";
import {
  ActivityHeatmap,
  formatCompact,
  mondayOfWeek,
  msToKey,
  startOfDay,
} from "../ActivityHeatmap";
import {
  SOURCE_LABEL,
  fetchAgentRunsCached,
  peekAgentRunsCache,
  type Run,
  type RunSource,
} from "../../runs";
import { Panel, SettingBlock } from "./controls";

export type StatsMetric = "conversations" | "tokens" | "cost";

// Chart-ramp steps assigned stably per AI provider id OR delegate source, so
// a provider keeps the same hue across renders and metric switches. Spaced
// steps (1/3/5/7) keep neighbours distinguishable; providers not listed here
// fall to the neutral ramp instead.
export const PROVIDER_BRAND_COLOR: Record<string, string> = {
  anthropic: "var(--chart-1)",
  "claude-code": "var(--chart-1)",
  mistral: "var(--chart-3)",
  openrouter: "var(--chart-5)",
  omp: "var(--chart-7)",
};

// Graduated neutral steps for providers with no brand hue. Cycled by order of
// appearance so two "neutral" providers still read apart in the donut.
export const NEUTRAL_STEPS = [
  "var(--fg-strong)",
  "color-mix(in srgb, var(--fg-subtle) 80%, var(--bg))",
  "color-mix(in srgb, var(--fg-subtle) 54%, var(--bg))",
  "color-mix(in srgb, var(--fg-subtle) 34%, var(--bg))",
];

// The id we colour a group by: a Klide group wears its AI provider's colour
// (so Klide·Anthropic is Anthropic orange); an external CLI wears its own.
export function groupProviderId(g: ProviderGroup): string {
  return g.source === "klide" ? g.provider ?? "klide" : g.source;
}

// One stable colour per group: brand hue when known, else the next neutral
// step. Computed over the whole (sorted) list so neutral assignment is
// deterministic and collision-free within a render.
export function assignGroupColors(groups: ProviderGroup[]): Map<string, string> {
  const out = new Map<string, string>();
  let neutral = 0;
  for (const g of groups) {
    const brand = PROVIDER_BRAND_COLOR[groupProviderId(g)];
    out.set(g.key, brand ?? NEUTRAL_STEPS[neutral++ % NEUTRAL_STEPS.length]);
  }
  return out;
}

// Opacity steps for model segments within one provider's bar — first model
// wears the full tint, later ones fade toward the background.
export const SEGMENT_MIX = [100, 70, 48, 32, 20, 12];

export function runTokens(r: Run): number {
  return (r.inputTokens ?? 0) + (r.outputTokens ?? 0);
}

export function runCost(r: Run): number {
  return r.costUsd ?? 0;
}

// The breakdown key a run belongs to: a Klide run splits by its AI provider,
// an external CLI is one group. Shared by the provider breakdown and the
// stacked histogram so their colours line up.
export function groupKeyOf(r: Run): string {
  return r.source === "klide" ? `klide:${r.provider ?? ""}` : r.source;
}

// $1.2k / $12.34 / $0.0042 — compact for totals, but keeps sub-dollar
// costs legible (local/cheap models land in fractions of a cent).
export function formatUsd(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n > 0) return `$${n.toFixed(n >= 0.01 ? 3 : 4)}`;
  return "$0";
}

export function prettyProvider(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

// Round a max up to a "nice" round number (1/2/2.5/5 × 10ⁿ) so the histogram's
// top gridline lands on a readable value instead of the raw data maximum.
export function niceCeil(x: number): number {
  if (x <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / mag;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * mag;
}

/**
 * A number that reads compact ("1.2M") and flips to the exact amount
 * ("1,234,567") on click. Hover shows the exact value either way.
 */
export function PreciseNumber({ value, suffix }: { value: number; suffix?: string }) {
  const [precise, setPrecise] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setPrecise((p) => !p)}
      title={`${value.toLocaleString("en-US")}${suffix ? ` ${suffix}` : ""}`}
      style={{
        background: "none",
        border: "none",
        padding: 0,
        margin: 0,
        cursor: "pointer",
        font: "inherit",
        color: "inherit",
      }}
    >
      {precise ? value.toLocaleString("en-US") : formatCompact(value)}
      {suffix ? ` ${suffix}` : ""}
    </button>
  );
}

export type ProviderGroup = {
  key: string;
  label: string;
  color: string;
  source: RunSource;
  provider: string | null;
  conversations: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  models: { name: string; conversations: number; tokens: number; cost: number }[];
};

// The breakdown rows wear real brand marks: external CLIs use their tool's
// logo id directly; Klide groups use the AI provider's (ollama, anthropic…).
export function GroupLogo({ group, size = 16 }: { group: ProviderGroup; size?: number }) {
  const id = group.source === "klide" ? group.provider ?? "ollama" : group.source;
  return <ProviderLogo id={id as ProviderId} size={size} />;
}

export function MetricToggle({
  value,
  onChange,
}: {
  value: StatsMetric;
  onChange: (m: StatsMetric) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Stats metric"
      style={{
        display: "inline-flex",
        border: "1px solid var(--border-strong)",
        borderRadius: 6,
        overflow: "hidden",
      }}
    >
      {(["conversations", "tokens", "cost"] as const).map((m) => (
        <button
          key={m}
          type="button"
          role="tab"
          aria-selected={value === m}
          onClick={() => onChange(m)}
          style={{
            padding: "4px 10px",
            fontSize: 11,
            fontWeight: 500,
            border: "none",
            cursor: "pointer",
            background: value === m ? "var(--bg-hover)" : "transparent",
            color: value === m ? "var(--fg-strong)" : "var(--fg-subtle)",
          }}
        >
          {m === "conversations" ? "Conversations" : m === "tokens" ? "Tokens" : "Cost"}
        </button>
      ))}
    </div>
  );
}

// Weekly histogram of the last 26 weeks. In tokens mode each bar stacks
// input (faded) under output (full accent); in conversations mode it's a
// plain count. Clicking a bar pins its exact numbers below the chart.
export function UsageHistogram({
  runs,
  metric,
  groupOrder,
  keyOf = groupKeyOf,
}: {
  runs: Run[];
  metric: StatsMetric;
  // Stacked segments, sorted largest-first, each with its colour. Keys must
  // match what `keyOf` returns so segments line up with the legend.
  groupOrder: { key: string; color: string; label: string }[];
  // How a run maps to a stack key — by provider (default) or by model when a
  // single provider is in focus.
  keyOf?: (r: Run) => string;
}) {
  const WEEKS = 26;
  const WEEK_MS = 7 * 86_400_000;
  const [selected, setSelected] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);

  const buckets = useMemo(() => {
    const startMonday = mondayOfWeek(startOfDay(Date.now())) - (WEEKS - 1) * WEEK_MS;
    const buckets = Array.from({ length: WEEKS }, (_, i) => ({
      startMs: startMonday + i * WEEK_MS,
      conversations: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      // Per-provider-group contribution, for the stacked segments.
      groups: {} as Record<string, { conversations: number; tokens: number; cost: number }>,
    }));
    for (const r of runs) {
      const idx = Math.floor((mondayOfWeek(r.createdMs) - startMonday) / WEEK_MS);
      if (idx < 0 || idx >= WEEKS) continue;
      const bk = buckets[idx];
      bk.conversations += 1;
      bk.inputTokens += r.inputTokens ?? 0;
      bk.outputTokens += r.outputTokens ?? 0;
      bk.cost += r.costUsd ?? 0;
      const gk = keyOf(r);
      const gb = bk.groups[gk] ?? (bk.groups[gk] = { conversations: 0, tokens: 0, cost: 0 });
      gb.conversations += 1;
      gb.tokens += runTokens(r);
      gb.cost += runCost(r);
    }
    return buckets;
  }, [runs, keyOf]);

  const segValue = (gb: { conversations: number; tokens: number; cost: number }) =>
    metric === "tokens" ? gb.tokens : metric === "cost" ? gb.cost : gb.conversations;

  const valueOf = (b: (typeof buckets)[number]) =>
    metric === "tokens" ? b.inputTokens + b.outputTokens : metric === "cost" ? b.cost : b.conversations;
  const max = Math.max(1, ...buckets.map(valueOf));
  const sel = selected != null ? buckets[selected] : null;

  // Round the axis top to a clean number and lay 4 evenly-spaced gridlines
  // (0 · ¼ · ½ · ¾ · top). Bars scale against this, not the raw max, so the
  // top of the tallest bar sits just under a labelled line.
  const axisTop = niceCeil(max);
  const fmtAxis = (v: number) =>
    metric === "cost" ? formatUsd(v) : metric === "tokens" ? formatCompact(v) : Math.round(v).toLocaleString("en-US");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ f, value: axisTop * f }));

  // One label at each month change, positioned by week index.
  const monthLabels = useMemo(() => {
    const labels: { i: number; name: string }[] = [];
    let last = -1;
    buckets.forEach((b, i) => {
      const month = new Date(b.startMs).getMonth();
      if (month !== last) {
        labels.push({ i, name: new Date(b.startMs).toLocaleDateString("en-US", { month: "short" }) });
        last = month;
      }
    });
    return labels;
  }, [buckets]);

  const weekLabel = (startMs: number) =>
    `Week of ${new Date(startMs).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

  const chartHeight = 120;
  const AXIS_W = 50;

  // The bar the readout describes: hover wins over a pinned click.
  const active = hovered ?? selected;
  const ab = active != null ? buckets[active] : null;

  // Per-week tooltip content: provider rows (largest-first) + total.
  const fmtVal = (v: number) =>
    metric === "cost" ? formatUsd(v) : metric === "tokens" ? formatCompact(v) : Math.round(v).toLocaleString("en-US");

  return (
    <div>
      {/* Axis gutter + plot area */}
      <div style={{ display: "flex" }}>
        <div style={{ width: AXIS_W, height: chartHeight, position: "relative", flexShrink: 0 }}>
          {ticks.map((t) => (
            <span
              key={t.f}
              style={{
                position: "absolute",
                bottom: `${t.f * 100}%`,
                right: 8,
                transform: "translateY(50%)",
                color: "var(--fg-subtle)",
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                whiteSpace: "nowrap",
              }}
            >
              {fmtAxis(t.value)}
            </span>
          ))}
        </div>

        <div style={{ position: "relative", flex: 1, height: chartHeight }}>
          {/* Gridlines */}
          {ticks.map((t) => (
            <div
              key={t.f}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: `${t.f * 100}%`,
                borderTop: "1px solid var(--border)",
                opacity: t.f === 0 ? 1 : 0.45,
              }}
            />
          ))}

          {/* Bars */}
          <div
            onMouseLeave={() => setHovered(null)}
            style={{
              position: "relative",
              display: "flex",
              alignItems: "flex-end",
              gap: 3,
              height: "100%",
            }}
          >
            {buckets.map((b, i) => {
              const total = valueOf(b);
              const isActive = i === active;
              // Stack provider segments bottom-up: render largest-last so the
              // biggest provider anchors the base (groupOrder is largest-first).
              const segs = [...groupOrder]
                .reverse()
                .map((g) => ({ color: g.color, v: segValue(b.groups[g.key] ?? { conversations: 0, tokens: 0, cost: 0 }) }))
                .filter((s) => s.v > 0);
              return (
                <div
                  key={b.startMs}
                  onMouseEnter={() => setHovered(i)}
                  onClick={() => setSelected((cur) => (cur === i ? null : i))}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    height: "100%",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "flex-end",
                    cursor: "pointer",
                    borderRadius: 3,
                    background: isActive ? "var(--bg-hover)" : "transparent",
                  }}
                >
                  {total > 0
                    ? segs.map((s, si) => (
                        <div
                          key={si}
                          style={{
                            height: `${(s.v / axisTop) * 100}%`,
                            minHeight: 1,
                            background: s.color,
                            // Round only the topmost (first-rendered) segment.
                            borderRadius: si === 0 ? "2px 2px 0 0" : 0,
                          }}
                        />
                      ))
                    : null}
                </div>
              );
            })}
          </div>

          {/* Hover tooltip — anchored over the active bar, inside the plot so
              it can't clip against the panel's overflow. */}
          {ab &&
            active != null &&
            (() => {
              const rows = groupOrder
                .map((g) => ({
                  label: g.label,
                  color: g.color,
                  v: segValue(ab.groups[g.key] ?? { conversations: 0, tokens: 0, cost: 0 }),
                }))
                .filter((r) => r.v > 0)
                .sort((a, b) => b.v - a.v);
              const total = valueOf(ab);
              const leftPct = ((active + 0.5) / WEEKS) * 100;
              const xShift = active <= 2 ? "0%" : active >= WEEKS - 3 ? "-100%" : "-50%";
              return (
                <div
                  style={{
                    position: "absolute",
                    top: 4,
                    left: `${leftPct}%`,
                    transform: `translateX(${xShift})`,
                    pointerEvents: "none",
                    zIndex: 5,
                    minWidth: 132,
                    maxWidth: 224,
                    padding: "7px 9px",
                    background: "var(--bg-elevated)",
                    border: "1px solid var(--border-strong)",
                    borderRadius: 7,
                    boxShadow: "var(--panel-shadow)",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                  }}
                >
                  <div
                    style={{
                      color: "var(--fg-strong)",
                      fontWeight: 600,
                      marginBottom: rows.length ? 6 : 0,
                    }}
                  >
                    {weekLabel(ab.startMs)}
                  </div>
                  {rows.length === 0 ? (
                    <div style={{ color: "var(--fg-subtle)" }}>No activity</div>
                  ) : (
                    <>
                      {rows.map((r) => (
                        <div
                          key={r.label}
                          style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 3 }}
                        >
                          <span
                            aria-hidden
                            style={{ width: 8, height: 8, borderRadius: 2, flexShrink: 0, background: r.color }}
                          />
                          <span
                            style={{
                              color: "var(--fg)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              flex: 1,
                            }}
                          >
                            {r.label}
                          </span>
                          <span style={{ color: "var(--fg-strong)", whiteSpace: "nowrap" }}>{fmtVal(r.v)}</span>
                        </div>
                      ))}
                      {rows.length > 1 && (
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: 10,
                            marginTop: 6,
                            paddingTop: 5,
                            borderTop: "1px solid var(--border)",
                            color: "var(--fg-subtle)",
                          }}
                        >
                          <span>Total</span>
                          <span style={{ color: "var(--fg-strong)" }}>{fmtVal(total)}</span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })()}
        </div>
      </div>

      {/* Month labels (aligned under the plot area) */}
      <div style={{ position: "relative", height: 16, marginTop: 4, marginLeft: AXIS_W }}>
        {monthLabels.map(({ i, name }) => (
          <span
            key={`${i}-${name}`}
            style={{
              position: "absolute",
              left: `${(i / WEEKS) * 100}%`,
              color: "var(--fg-subtle)",
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              whiteSpace: "nowrap",
            }}
          >
            {name}
          </span>
        ))}
      </div>

      {/* Provider legend — the bars stack by provider, in breakdown colours. */}
      {groupOrder.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "4px 14px",
            marginTop: 8,
            marginLeft: AXIS_W,
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: "var(--fg-subtle)",
          }}
        >
          {groupOrder.slice(0, 7).map((g) => (
            <span key={g.key} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span
                aria-hidden
                style={{ width: 8, height: 8, borderRadius: 2, flexShrink: 0, background: g.color }}
              />
              {g.label}
            </span>
          ))}
          {groupOrder.length > 7 && <span>+{groupOrder.length - 7} more</span>}
        </div>
      )}

      {/* Exact numbers for the clicked week */}
      {sel && (
        <div
          style={{
            marginTop: 10,
            paddingTop: 10,
            borderTop: "1px solid var(--border)",
            display: "flex",
            alignItems: "baseline",
            gap: 14,
            fontSize: 11.5,
            fontFamily: "var(--font-mono)",
          }}
        >
          <span style={{ color: "var(--fg-strong)", fontWeight: 600 }}>
            {weekLabel(sel.startMs)}
          </span>
          <span style={{ color: "var(--fg)" }}>
            {sel.conversations.toLocaleString("en-US")} conversations
          </span>
          <span style={{ color: "var(--fg)" }}>
            {sel.inputTokens.toLocaleString("en-US")} tokens in
          </span>
          <span style={{ color: "var(--fg)" }}>
            {sel.outputTokens.toLocaleString("en-US")} tokens out
          </span>
          {sel.cost > 0 && (
            <span style={{ color: "var(--fg)" }}>{formatUsd(sel.cost)}</span>
          )}
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => setSelected(null)}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
              color: "var(--fg-subtle)",
              fontSize: 11,
            }}
          >
            clear
          </button>
        </div>
      )}
    </div>
  );
}

// Inline-SVG donut: each slice's arc length is its share of the total, drawn
// as a stroke-dasharray on one concentric ring (no chart library). The center
// holds the grand total for the active metric.
export function DonutChart({
  segments,
  centerValue,
  centerLabel,
  size = 124,
}: {
  segments: { key: string; color: string; value: number; title: string }[];
  centerValue: string;
  centerLabel: string;
  size?: number;
}) {
  const stroke = Math.max(9, Math.round(size * 0.11));
  const radius = (size - stroke) / 2;
  const circ = 2 * Math.PI * radius;
  const c = size / 2;
  // Scale the centre type with the donut so a small (balance) donut and the
  // large (breakdown) donut both read cleanly.
  const valueFont = Math.max(10, Math.round(size * 0.14));
  const labelFont = Math.max(7, Math.round(size * 0.078));
  const total = segments.reduce((s, x) => s + x.value, 0);
  let acc = 0;
  const arcs =
    total > 0
      ? segments
          .filter((s) => s.value > 0)
          .map((s) => {
            const frac = s.value / total;
            const arc = { ...s, len: frac * circ, offset: acc * circ };
            acc += frac;
            return arc;
          })
      : [];
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`${centerLabel}: ${centerValue}`}
      style={{ flexShrink: 0 }}
    >
      <g transform={`rotate(-90 ${c} ${c})`}>
        <circle cx={c} cy={c} r={radius} fill="none" stroke="var(--bg)" strokeWidth={stroke} />
        {arcs.map((a) => (
          <circle
            key={a.key}
            cx={c}
            cy={c}
            r={radius}
            fill="none"
            stroke={a.color}
            strokeWidth={stroke}
            strokeDasharray={`${a.len} ${circ - a.len}`}
            strokeDashoffset={-a.offset}
          >
            <title>{a.title}</title>
          </circle>
        ))}
      </g>
      <text
        x={c}
        y={c - size * 0.025}
        textAnchor="middle"
        dominantBaseline="middle"
        style={{ fontFamily: "var(--font-mono)", fontSize: valueFont, fontWeight: 600, fill: "var(--fg-strong)" }}
      >
        {centerValue}
      </text>
      <text
        x={c}
        y={c + size * 0.11}
        textAnchor="middle"
        dominantBaseline="middle"
        style={{ fontFamily: "var(--font-mono)", fontSize: labelFont, letterSpacing: 0.3, fill: "var(--fg-subtle)" }}
      >
        {centerLabel}
      </text>
    </svg>
  );
}

// Pre-fetch / loading state for the stats panel. Mirrors the real layout
// (heatmap, histogram, provider rows) as placeholders, with a "Load stats"
// button over it — so the user triggers the (slow) log parse themselves and
// the wait reads as intentional. Placeholders shimmer only while loading.
export function StatsSkeleton({
  loading,
  onFetch,
}: {
  loading: boolean;
  onFetch: () => void;
}) {
  const bar = (width: number | string, height: number, extra?: CSSProperties) => (
    <div
      className={loading ? "klide-skeleton" : undefined}
      style={{
        width,
        height,
        borderRadius: 4,
        ...(loading
          ? {}
          : { background: "color-mix(in srgb, var(--fg-dim) 13%, transparent)" }),
        ...extra,
      }}
    />
  );
  // Deterministic, calm-looking histogram bar heights (percent of track).
  const histHeights = [
    30, 44, 38, 52, 60, 48, 66, 72, 58, 80, 70, 90, 84, 76, 64, 88, 78, 92, 70,
    60, 74, 82, 56, 68, 50, 62,
  ];
  return (
    <div style={{ position: "relative" }}>
      {/* The placeholder layout, dimmed and inert until the user loads it. */}
      <div
        aria-hidden
        style={{
          opacity: loading ? 1 : 0.55,
          pointerEvents: "none",
          transition: "opacity var(--motion-med) var(--ease-out)",
        }}
      >
      <SettingBlock title="Activity">
        <Panel>
          <div style={{ padding: "14px 18px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 16,
                marginBottom: 14,
              }}
            >
              {bar("min(60%, 360px)", 12)}
              {bar(108, 22, { borderRadius: 9999 })}
            </div>
            {bar("100%", 96, { borderRadius: 6 })}
          </div>
        </Panel>
      </SettingBlock>

      <SettingBlock title="Usage over time">
        <Panel>
          <div style={{ padding: "14px 18px" }}>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 96 }}>
              {histHeights.map((h, i) => (
                <div
                  key={i}
                  className={loading ? "klide-skeleton klide-rise" : undefined}
                  style={{
                    flex: 1,
                    height: `${h}%`,
                    borderRadius: 2,
                    // Stagger the rise so the bars cascade up on click.
                    ...(loading
                      ? { animationDelay: `${i * 26}ms` }
                      : {
                          background:
                            "color-mix(in srgb, var(--fg-dim) 13%, transparent)",
                        }),
                  }}
                />
              ))}
            </div>
          </div>
        </Panel>
      </SettingBlock>

      <SettingBlock title="Providers & models">
        <Panel>
          {[0, 1, 2].map((gi) => (
            <div
              key={gi}
              style={{
                padding: "14px 18px",
                borderBottom: gi < 2 ? "1px solid var(--border)" : "none",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 16,
                  marginBottom: 8,
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {bar(18, 18, { borderRadius: 4 })}
                  {bar(120, 13)}
                </span>
                {bar(150, 11)}
              </div>
              {bar(`${[88, 64, 40][gi]}%`, 6, { borderRadius: 3, marginBottom: 10 })}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {bar("70%", 11)}
                {bar("52%", 11)}
              </div>
            </div>
          ))}
        </Panel>
      </SettingBlock>
      </div>

      {/* Call-to-action layer: load button (idle) or progress (loading). */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "center",
          paddingTop: 96,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 12,
            textAlign: "center",
            padding: "20px 24px",
            maxWidth: 320,
          }}
        >
          {loading ? (
            <div
              className="ai-msg-in"
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 12,
              }}
            >
              <span className="ai-loader-orbit" aria-hidden>
                <span />
                <span />
                <span />
                <span />
              </span>
              <div style={{ color: "var(--fg-subtle)", fontSize: 12.5 }}>
                Reading session logs…
              </div>
            </div>
          ) : (
            <>
              <div style={{ color: "var(--fg-strong)", fontSize: 14, fontWeight: 600 }}>
                Session stats
              </div>
              <div style={{ color: "var(--fg-subtle)", fontSize: 12.5, lineHeight: 1.45 }}>
                Reading your agent logs takes a moment. Load them when you're ready.
              </div>
              <button
                type="button"
                onClick={onFetch}
                style={{
                  marginTop: 4,
                  background: "var(--control-primary-bg)",
                  color: "var(--control-primary-fg)",
                  border: "none",
                  borderRadius: "var(--radius-md)",
                  padding: "8px 18px",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Load stats
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function StatsSection() {
  // Render instantly from the session cache when it's warm — the parse of all
  // session logs is expensive, so we only pay it on a genuine cold open.
  // Don't auto-fetch on open — parsing every session log is slow, and an
  // unprompted wait reads as lag. Show the skeleton with a "Load stats" button
  // so the wait is the user's own action. A warm cache renders instantly.
  const cached = peekAgentRunsCache(1000, 0);
  const [runs, setRuns] = useState<Run[]>(cached ?? []);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(cached !== null);
  const [metric, setMetric] = useState<StatsMetric>("conversations");
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const all = await fetchAgentRunsCached(1000, 0);
      setRuns(all);
    } catch {
      // Outside Tauri (plain Vite) — leave the section empty.
    } finally {
      setLoading(false);
      setFetched(true);
    }
  }, []);

  // Stable weight fn so the heatmap's useMemo doesn't recompute every render.
  const tokenWeight = useCallback((r: Run) => runTokens(r), []);
  const costWeight = useCallback((r: Run) => runCost(r), []);

  const groups = useMemo<ProviderGroup[]>(() => {
    const map = new Map<string, ProviderGroup & { byModel: Map<string, { conversations: number; tokens: number; cost: number }> }>();
    for (const r of runs) {
      // Klide runs split by their AI provider (Ollama, Anthropic…);
      // external CLIs are one group each.
      const isKlide = r.source === "klide";
      const key = groupKeyOf(r);
      let g = map.get(key);
      if (!g) {
        g = {
          key,
          label: isKlide
            ? r.provider
              ? `Klide · ${prettyProvider(r.provider)}`
              : "Klide"
            : SOURCE_LABEL[r.source],
          // Base colour; the render reassigns via assignGroupColors so neutral
          // providers get distinct steps. This is only a sensible fallback.
          color:
            PROVIDER_BRAND_COLOR[isKlide ? r.provider ?? "" : r.source] ?? "var(--fg-subtle)",
          source: r.source,
          provider: r.provider ?? null,
          conversations: 0,
          tokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
          models: [],
          byModel: new Map(),
        };
        map.set(key, g);
      }
      const tokens = runTokens(r);
      const cost = runCost(r);
      g.conversations += 1;
      g.tokens += tokens;
      g.inputTokens += r.inputTokens ?? 0;
      g.outputTokens += r.outputTokens ?? 0;
      g.cost += cost;
      const model = r.model?.trim() || "unknown";
      const m = g.byModel.get(model) ?? { conversations: 0, tokens: 0, cost: 0 };
      m.conversations += 1;
      m.tokens += tokens;
      m.cost += cost;
      g.byModel.set(model, m);
    }
    const valueOf = (x: { conversations: number; tokens: number; cost: number }) =>
      metric === "tokens" ? x.tokens : metric === "cost" ? x.cost : x.conversations;
    return [...map.values()]
      .map(({ byModel, ...g }) => ({
        ...g,
        models: [...byModel.entries()]
          .map(([name, v]) => ({ name, ...v }))
          .sort((a, b) => valueOf(b) - valueOf(a)),
      }))
      .sort((a, b) => valueOf(b) - valueOf(a));
  }, [runs, metric]);

  const valueOf = (x: { conversations: number; tokens: number; cost: number }) =>
    metric === "tokens" ? x.tokens : metric === "cost" ? x.cost : x.conversations;
  const maxGroupValue = Math.max(1, ...groups.map(valueOf));
  const totalValue = groups.reduce((s, g) => s + valueOf(g), 0);
  const groupColors = assignGroupColors(groups);
  const colorOf = (g: ProviderGroup) => groupColors.get(g.key) ?? g.color;

  // Exact numbers for the clicked heatmap day.
  const dayDetail = useMemo(() => {
    if (!selectedDay) return null;
    let conversations = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cost = 0;
    for (const r of runs) {
      if (msToKey(r.createdMs) !== selectedDay) continue;
      conversations += 1;
      inputTokens += r.inputTokens ?? 0;
      outputTokens += r.outputTokens ?? 0;
      cost += r.costUsd ?? 0;
    }
    return { conversations, inputTokens, outputTokens, cost };
  }, [runs, selectedDay]);

  if (!fetched) {
    return <StatsSkeleton loading={loading} onFetch={load} />;
  }

  return (
    <>
      <SettingBlock title="Activity">
        <Panel>
          <div style={{ padding: "14px 18px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 16,
                marginBottom: 14,
              }}
            >
              <div style={{ color: "var(--fg-subtle)", fontSize: 12.5, lineHeight: 1.4 }}>
                Agent sessions across Klide, Claude Code, Codex and OpenCode over the last year.
              </div>
              <MetricToggle value={metric} onChange={setMetric} />
            </div>
            <div style={{ overflowX: "auto", paddingBottom: 4 }}>
              <ActivityHeatmap
                runs={runs}
                weeks={52}
                weight={metric === "tokens" ? tokenWeight : metric === "cost" ? costWeight : undefined}
                unit={metric === "cost" ? "USD" : metric}
                selectedDay={selectedDay}
                onSelectDay={setSelectedDay}
              />
            </div>
            {selectedDay && dayDetail && (
              <div
                style={{
                  marginTop: 10,
                  paddingTop: 10,
                  borderTop: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "baseline",
                  gap: 14,
                  fontSize: 11.5,
                  fontFamily: "var(--font-mono)",
                }}
              >
                <span style={{ color: "var(--fg-strong)", fontWeight: 600 }}>
                  {new Date(selectedDay + "T00:00:00").toLocaleDateString("en-US", {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </span>
                <span style={{ color: "var(--fg)" }}>
                  {dayDetail.conversations.toLocaleString("en-US")} conversations
                </span>
                <span style={{ color: "var(--fg)" }}>
                  {dayDetail.inputTokens.toLocaleString("en-US")} tokens in
                </span>
                <span style={{ color: "var(--fg)" }}>
                  {dayDetail.outputTokens.toLocaleString("en-US")} tokens out
                </span>
                {dayDetail.cost > 0 && (
                  <span style={{ color: "var(--fg)" }}>{formatUsd(dayDetail.cost)}</span>
                )}
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  onClick={() => setSelectedDay(null)}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    color: "var(--fg-subtle)",
                    fontSize: 11,
                  }}
                >
                  clear
                </button>
              </div>
            )}
          </div>
        </Panel>
      </SettingBlock>

      <SettingBlock title="Usage over time">
        <Panel>
          <div style={{ padding: "14px 18px" }}>
            <UsageHistogram
              runs={runs}
              metric={metric}
              groupOrder={groups.map((g) => ({ key: g.key, color: colorOf(g), label: g.label }))}
            />
          </div>
        </Panel>
      </SettingBlock>

      <SettingBlock title="Providers & models">
        <Panel>
          {!loading && groups.length === 0 && (
            <div style={{ padding: "14px 18px", color: "var(--fg-subtle)", fontSize: 12 }}>
              No agent sessions found yet. Run a conversation and come back.
            </div>
          )}
          {groups.length > 0 && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 22,
                padding: "18px 18px",
                borderBottom: "1px solid var(--border)",
                flexWrap: "wrap",
              }}
            >
              <DonutChart
                segments={groups.map((g) => ({
                  key: g.key,
                  color: colorOf(g),
                  value: valueOf(g),
                  title:
                    metric === "cost"
                      ? `${g.label}: ${formatUsd(g.cost)}`
                      : metric === "tokens"
                        ? `${g.label}: ${formatCompact(g.tokens)} tokens`
                        : `${g.label}: ${g.conversations} conversations`,
                }))}
                centerValue={metric === "cost" ? formatUsd(totalValue) : formatCompact(totalValue)}
                centerLabel={metric === "cost" ? "spend" : metric === "tokens" ? "tokens" : "convos"}
              />
              <div style={{ flex: 1, minWidth: 190, display: "flex", flexDirection: "column", gap: 7 }}>
                {groups.map((g) => {
                  const v = valueOf(g);
                  const pct = totalValue > 0 ? (v / totalValue) * 100 : 0;
                  return (
                    <div key={g.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                      <span
                        aria-hidden
                        style={{ width: 9, height: 9, borderRadius: 2, flexShrink: 0, background: colorOf(g) }}
                      />
                      <GroupLogo group={g} size={14} />
                      <span
                        style={{
                          color: "var(--fg)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {g.label}
                      </span>
                      <span style={{ flex: 1 }} />
                      <span
                        style={{
                          fontFamily: "var(--font-mono)",
                          color: "var(--fg-strong)",
                          fontSize: 11.5,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {metric === "cost" ? formatUsd(g.cost) : formatCompact(v)}
                      </span>
                      <span
                        style={{
                          fontFamily: "var(--font-mono)",
                          color: "var(--fg-subtle)",
                          fontSize: 11,
                          width: 36,
                          textAlign: "right",
                        }}
                      >
                        {pct.toFixed(0)}%
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {groups.map((g, gi) => {
            const groupValue = valueOf(g);
            const base = colorOf(g);
            return (
              <div
                key={g.key}
                style={{
                  padding: "14px 18px",
                  borderBottom: gi < groups.length - 1 ? "1px solid var(--border)" : "none",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 16,
                    marginBottom: 8,
                  }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <GroupLogo group={g} />
                    <span style={{ color: "var(--fg-strong)", fontSize: 13, fontWeight: 500 }}>
                      {g.label}
                    </span>
                  </span>
                  <span
                    style={{
                      color: "var(--fg-subtle)",
                      fontSize: 11.5,
                      fontFamily: "var(--font-mono)",
                      whiteSpace: "nowrap",
                      display: "inline-flex",
                      gap: 10,
                    }}
                  >
                    <PreciseNumber value={g.conversations} suffix="conversations" />
                    {g.tokens > 0 && (
                      <>
                        <span aria-hidden>·</span>
                        <PreciseNumber value={g.inputTokens} suffix="in" />
                        <span aria-hidden>·</span>
                        <PreciseNumber value={g.outputTokens} suffix="out" />
                      </>
                    )}
                    {g.cost > 0 && (
                      <>
                        <span aria-hidden>·</span>
                        <span style={{ color: "var(--fg-strong)" }}>{formatUsd(g.cost)}</span>
                      </>
                    )}
                  </span>
                </div>

                {/* Length = this provider's share of the top provider; segments = models. */}
                <div
                  style={{
                    height: 6,
                    borderRadius: 3,
                    background: "var(--bg)",
                    overflow: "hidden",
                    marginBottom: 10,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      height: "100%",
                      width: `${Math.max(1.5, (groupValue / maxGroupValue) * 100)}%`,
                      borderRadius: 3,
                      overflow: "hidden",
                    }}
                  >
                    {g.models.slice(0, SEGMENT_MIX.length).map((m, i) => (
                      <div
                        key={m.name}
                        style={{
                          width: `${(valueOf(m) / Math.max(1, groupValue)) * 100}%`,
                          background: `color-mix(in srgb, ${base} ${SEGMENT_MIX[i]}%, var(--bg-elevated))`,
                        }}
                      />
                    ))}
                  </div>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {g.models.slice(0, SEGMENT_MIX.length).map((m, i) => (
                    <div
                      key={m.name}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        fontSize: 11.5,
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 2,
                          flexShrink: 0,
                          background: `color-mix(in srgb, ${base} ${SEGMENT_MIX[i]}%, var(--bg-elevated))`,
                        }}
                      />
                      <span
                        style={{
                          color: "var(--fg)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {m.name}
                      </span>
                      <span style={{ flex: 1 }} />
                      <span style={{ color: "var(--fg-subtle)", whiteSpace: "nowrap" }}>
                        {metric === "tokens" ? (
                          <PreciseNumber value={m.tokens} suffix="tokens" />
                        ) : metric === "cost" ? (
                          formatUsd(m.cost)
                        ) : (
                          <PreciseNumber value={m.conversations} suffix="conv" />
                        )}
                      </span>
                    </div>
                  ))}
                  {g.models.length > SEGMENT_MIX.length && (
                    <div style={{ color: "var(--fg-subtle)", fontSize: 11, paddingLeft: 16 }}>
                      +{g.models.length - SEGMENT_MIX.length} more models
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </Panel>
      </SettingBlock>
    </>
  );
}

