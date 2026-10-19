// Usage stats — the Stats section: histogram, donut, provider grouping,
// cost/token metrics over agent runs. Extracted from SettingsPanel.tsx.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { DotGridLoader, ProviderLogo, providerChartColor } from "../ai/icons";
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

// A provider's chart hue comes from the one brand table in ai/icons.tsx
// (`providerChartColor`), keyed by the registry row's brand, so a provider
// keeps the same hue across renders and metric switches; brands without a
// step fall to the neutral ramp below.

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
// deterministic and collision-free within a render. Two groups of one brand
// (Claude Code and Klide · Anthropic) would stack as one bar, so the second
// wears its hue lighter.
export function assignGroupColors(groups: ProviderGroup[]): Map<string, string> {
  const out = new Map<string, string>();
  const brandUses = new Map<string, number>();
  let neutral = 0;
  for (const g of groups) {
    const brand = providerChartColor(groupProviderId(g));
    if (!brand) {
      out.set(g.key, NEUTRAL_STEPS[neutral++ % NEUTRAL_STEPS.length]);
      continue;
    }
    const n = brandUses.get(brand) ?? 0;
    brandUses.set(brand, n + 1);
    out.set(g.key, n === 0 ? brand : `color-mix(in srgb, ${brand} ${Math.max(30, 100 - n * 45)}%, var(--bg-elevated))`);
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

// Round a max up to a "nice" round number (1/2/2.5/5 × 10ⁿ); half of it is
// the chart's gridline step.
export function niceCeil(x: number): number {
  if (x <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / mag;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * mag;
}

export function prettyProvider(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
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

// The stacked usage chart: a window of days (or weeks) as columns, each a
// stack of rounded per-group segments with a hairline gap between them. Run
// the pointer along the plot and one column is ringed while a tooltip glides
// beside it; the rest fade back. Day / Week regrows the bars.
type HistogramScale = "Day" | "Week";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const SCALE_SPAN: Record<HistogramScale, number> = { Day: 30, Week: 26 };
const STACK_H = 150; // the axis top, px
const PLOT_H = STACK_H + 14; // room for the ring above, the baseline below
const BAR_FOOT = 8; // bars stand this far above the plot's bottom edge
const SEG_GAP = 2; // hairline between stacked segments
const GUTTER = 52; // value labels to the right of the bars
const TIP_W = 196;
const TIP_ROWS = 6;
const EMPTY_SEG = { conversations: 0, tokens: 0, cost: 0 };

const shortDate = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });

function bucketLabel(startMs: number, scale: HistogramScale): string {
  if (scale === "Day") return shortDate(startMs);
  const end = startMs + 6 * DAY_MS;
  return new Date(startMs).getMonth() === new Date(end).getMonth()
    ? `${shortDate(startMs)} – ${new Date(end).getDate()}`
    : `${shortDate(startMs)} – ${shortDate(end)}`;
}

function ScaleSwitch({
  value,
  onChange,
}: {
  value: HistogramScale;
  onChange: (s: HistogramScale) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Chart scale"
      style={{
        position: "relative",
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        padding: 2,
        borderRadius: 9,
        background: "color-mix(in srgb, var(--fg-strong) 6%, transparent)",
        flexShrink: 0,
      }}
    >
      <span
        aria-hidden
        style={{
          position: "absolute",
          top: 2,
          bottom: 2,
          left: 2,
          width: "calc(50% - 2px)",
          borderRadius: 7,
          background: "var(--bg-elevated)",
          boxShadow: "0 0 0 1px var(--border)",
          transform: value === "Week" ? "translateX(100%)" : "none",
          transition: "transform 220ms var(--ease-out)",
        }}
      />
      {(["Day", "Week"] as const).map((s) => (
        <button
          key={s}
          type="button"
          role="tab"
          aria-selected={value === s}
          onClick={() => onChange(s)}
          style={{
            position: "relative",
            height: 24,
            padding: "0 10px",
            border: "none",
            borderRadius: 7,
            background: "transparent",
            font: "inherit",
            fontSize: 11.5,
            cursor: "pointer",
            color: value === s ? "var(--fg-strong)" : "var(--fg-subtle)",
            transition: "color var(--motion-fast) var(--ease-out)",
          }}
        >
          {s}
        </button>
      ))}
    </div>
  );
}

export function UsageHistogram({
  runs,
  metric,
  groupOrder,
  keyOf = groupKeyOf,
}: {
  runs: Run[];
  metric: StatsMetric;
  // Stacked segments, sorted largest-first, each with its colour. Keys must
  // match what `keyOf` returns so segments line up with the tooltip rows.
  // `logo` is a Provider id or brand key; the legend draws its mark.
  groupOrder: { key: string; color: string; label: string; logo?: string }[];
  // How a run maps to a stack key — by provider (default) or by model when a
  // single provider is in focus.
  keyOf?: (r: Run) => string;
}) {
  const [scale, setScale] = useState<HistogramScale>("Day");
  const [active, setActive] = useState<number | null>(null);
  const [grown, setGrown] = useState(false);
  const [plotW, setPlotW] = useState(0);
  // A legend row under the pointer picks one group out of every column.
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const span = SCALE_SPAN[scale];

  // Bars rise from zero on first paint, then animate height on every change.
  useEffect(() => {
    const id = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Columns are laid out in px, so the plot's width is measured, not assumed.
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setPlotW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const buckets = useMemo(() => {
    const step = scale === "Day" ? DAY_MS : WEEK_MS;
    const floor = scale === "Day" ? startOfDay : mondayOfWeek;
    const first = floor(Date.now()) - (span - 1) * step;
    const buckets = Array.from({ length: span }, (_, i) => ({
      // Rebuilt from the calendar, not `first + i * step`, so a DST change
      // inside the window doesn't shift a bucket off midnight.
      startMs: floor(first + i * step + step / 2),
      groups: {} as Record<string, { conversations: number; tokens: number; cost: number }>,
    }));
    for (const r of runs) {
      // Round, not floor: a DST day is 23 or 25 hours long.
      const idx = Math.round((floor(r.createdMs) - first) / step);
      if (idx < 0 || idx >= span) continue;
      const gk = keyOf(r);
      const gb = buckets[idx].groups[gk] ?? (buckets[idx].groups[gk] = { ...EMPTY_SEG });
      gb.conversations += 1;
      gb.tokens += runTokens(r);
      gb.cost += runCost(r);
    }
    return buckets;
  }, [runs, keyOf, scale, span]);

  const segValue = (gb: { conversations: number; tokens: number; cost: number }) =>
    metric === "tokens" ? gb.tokens : metric === "cost" ? gb.cost : gb.conversations;
  const fmtVal = (v: number) =>
    metric === "cost" ? formatUsd(v) : Math.round(v).toLocaleString("en-US");
  const fmtAxis = (v: number) =>
    metric === "cost"
      ? formatUsd(v)
      : metric === "tokens"
        ? formatCompact(v).replace(/\.0(?=[kMB])/, "")
        : v.toLocaleString("en-US", { maximumFractionDigits: 1 });

  // Each column's segments bottom-up: the largest group anchors the base.
  const columns = buckets.map((b) =>
    [...groupOrder]
      .reverse()
      .map((g) => ({ key: g.key, color: g.color, v: segValue(b.groups[g.key] ?? EMPTY_SEG) }))
      .filter((s) => s.v > 0),
  );
  const totals = columns.map((segs) => segs.reduce((s, x) => s + x.v, 0));
  const total = totals.reduce((s, x) => s + x, 0);
  const maxTotal = Math.max(...totals);
  const maxSegs = Math.max(1, ...columns.map((c) => c.length));
  // The tallest column reaches the top of the plot; gridlines sit on round
  // values beneath it (62 → a line at 50; 20 → lines at 10 and 20).
  const axisTop = maxTotal;
  const gridStep = niceCeil(maxTotal) / 2;
  const gridLines =
    maxTotal > 0
      ? Array.from({ length: Math.floor(maxTotal / gridStep + 1e-9) }, (_, k) => (k + 1) * gridStep)
      : [];
  const unitPx = maxTotal > 0 ? (STACK_H - SEG_GAP * (maxSegs - 1)) / axisTop : 0;

  // The legend: each group's share of the window, largest first.
  const legend = groupOrder
    .map((g) => ({ ...g, v: columns.reduce((s, c) => s + (c.find((x) => x.key === g.key)?.v ?? 0), 0) }))
    .filter((g) => g.v > 0)
    .sort((a, b) => b.v - a.v);

  const layout = columns.map((segs) => {
    let y = 0;
    const out = segs.map((s) => {
      const h = Math.max(2, s.v * unitPx);
      const seg = { ...s, bottom: y, h };
      y += h + SEG_GAP;
      return seg;
    });
    return { segs: out, top: segs.length ? y - SEG_GAP : 0 };
  });

  const barsW = Math.max(0, plotW - GUTTER);
  const gap = barsW > 0 ? Math.max(1, Math.min(6, (barsW - 3 * span) / (span - 1))) : 4;
  const barW = barsW > 0 ? (barsW - gap * (span - 1)) / span : 0;
  const radius = Math.min(2.5, barW / 2);
  const colLeft = (i: number) => i * (barW + gap);

  // The ring and tooltip glide between columns, but appear in place: the
  // first column the pointer lands on shouldn't slide in from column 0.
  const prevActive = useRef<number | null>(null);
  const glide = prevActive.current !== null && active !== null;
  useEffect(() => {
    prevActive.current = active;
  }, [active]);

  const pick = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const w = r.width - GUTTER;
    if (w <= 0) return;
    const i = Math.floor(((e.clientX - r.left) / w) * span);
    setActive(Math.max(0, Math.min(span - 1, i)));
  };

  const scrubbing = active !== null && active < span;
  // Leaving the plot fades the ring and tooltip out where they stood, so they
  // keep drawing the last column until the fade is done.
  const lastShown = useRef(0);
  if (scrubbing) lastShown.current = active;
  const shown = Math.min(lastShown.current, span - 1);
  const ab = buckets[shown];
  const ringTop = layout[shown].top;
  const right = colLeft(shown) + barW + 8;
  const tipX =
    right + TIP_W <= barsW || colLeft(shown) - 8 - TIP_W < 0
      ? Math.min(right, Math.max(0, barsW - TIP_W))
      : colLeft(shown) - 8 - TIP_W;
  const glideMs = glide ? "260ms" : "0ms";

  const title = metric === "cost" ? "Spend" : metric === "tokens" ? "Tokens" : "Conversations";
  const unit = metric === "cost" ? "" : metric === "tokens" ? "tokens" : "conversations";
  const figure = fmtVal(total);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: "var(--fg-strong)", fontSize: 13.5, lineHeight: "18px" }}>{title}</div>
          <div
            style={{
              color: "var(--fg-subtle)",
              fontSize: 12,
              lineHeight: "16px",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            Last {span} {scale === "Day" ? "days" : "weeks"}
          </div>
        </div>
        <ScaleSwitch value={scale} onChange={setScale} />
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: -4 }}>
        {/* Keyed on the figure so a new total re-enters digit by digit. */}
        <span
          aria-label={figure}
          style={{
            color: "var(--fg-strong)",
            fontSize: 30,
            lineHeight: "32px",
            letterSpacing: "-0.03em",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {figure.split("").map((ch, i) => (
            <span key={`${figure}-${i}`} aria-hidden className="klide-digit-in" style={{ ["--i" as string]: i }}>
              {ch}
            </span>
          ))}
        </span>
        {unit && <span style={{ color: "var(--fg-subtle)", fontSize: 13 }}>{unit}</span>}
      </div>

      <div
        ref={plotRef}
        onPointerDown={(e) => {
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* capture is a nicety */
          }
          pick(e);
        }}
        onPointerMove={pick}
        onPointerUp={(e) => {
          try {
            e.currentTarget.releasePointerCapture(e.pointerId);
          } catch {
            /* capture is a nicety */
          }
          if (e.pointerType !== "mouse") setActive(null);
        }}
        onPointerCancel={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
        style={{ position: "relative", height: PLOT_H, touchAction: "none", cursor: "crosshair" }}
      >
        {[0, ...gridLines.map((v) => v / axisTop)].map((f) => (
          <div
            key={f}
            aria-hidden
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: f === 0 ? BAR_FOOT - 3 : BAR_FOOT + f * STACK_H,
              display: "flex",
              alignItems: "center",
              gap: 8,
              transform: f === 0 ? "none" : "translateY(50%)",
              pointerEvents: "none",
            }}
          >
            <span
              style={{
                flex: 1,
                height: 0,
                borderTop: f === 0 ? "1px solid var(--border)" : "1px dashed var(--border)",
              }}
            />
            <span
              style={{
                width: GUTTER - 8,
                color: "var(--fg-subtle)",
                fontSize: 11,
                lineHeight: "14px",
                fontVariantNumeric: "tabular-nums",
                whiteSpace: "nowrap",
                visibility: f === 0 ? "hidden" : "visible",
              }}
            >
              {fmtAxis(axisTop * f)}
            </span>
          </div>
        ))}
        {plotW > 0 &&
          layout.map((col, i) => {
            const on = i === active;
            return (
              <div
                key={`${scale}-${i}`}
                style={{ position: "absolute", top: 0, bottom: 0, left: colLeft(i), width: barW }}
              >
                {col.segs.length === 0 ? (
                  // An empty day keeps the rhythm of the row with a stub.
                  <span
                    style={{
                      position: "absolute",
                      left: 0,
                      right: 0,
                      bottom: BAR_FOOT,
                      height: 2,
                      borderRadius: radius,
                      background: "color-mix(in srgb, var(--fg-dim) 30%, transparent)",
                    }}
                  />
                ) : (
                  col.segs.map((s) => (
                    <span
                      key={s.key}
                      style={{
                        position: "absolute",
                        left: 0,
                        right: 0,
                        bottom: BAR_FOOT + (grown ? s.bottom : 0),
                        height: grown ? s.h : 0,
                        borderRadius: radius,
                        background:
                          (scrubbing && !on) || (focusKey !== null && s.key !== focusKey)
                            ? `color-mix(in srgb, ${s.color} 30%, var(--bg-elevated))`
                            : s.color,
                        transition: `height 600ms var(--ease-out) ${i * 14}ms, bottom 600ms var(--ease-out) ${i * 14}ms, background-color 160ms ease`,
                      }}
                    />
                  ))
                )}
              </div>
            );
          })}

        <span
          aria-hidden
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            boxSizing: "border-box",
            width: barW + 6,
            height: ringTop + 6,
            transform: `translate(${colLeft(shown) - 3}px, ${PLOT_H - BAR_FOOT - ringTop - 3}px)`,
            border: "1.5px solid var(--fg-subtle)",
            borderRadius: radius + 3,
            pointerEvents: "none",
            opacity: scrubbing ? 1 : 0,
            transition: `opacity 160ms ease, transform ${glideMs} var(--ease-out), height ${glideMs} var(--ease-out)`,
          }}
        />

        <div
          aria-hidden={!scrubbing}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            zIndex: 5,
            width: TIP_W,
            boxSizing: "border-box",
            transform: `translateX(${tipX}px)`,
            display: "flex",
            flexDirection: "column",
            gap: 4,
            padding: "9px 11px",
            background: "var(--bg-elevated)",
            border: "1px solid color-mix(in srgb, var(--fg-strong) 12%, var(--bg-elevated))",
            borderRadius: 10,
            fontSize: 12.5,
            lineHeight: "17px",
            pointerEvents: "none",
            opacity: scrubbing ? 1 : 0,
            transition: `opacity 160ms ease, transform ${glideMs} var(--ease-out)`,
          }}
        >
          {plotW > 0 &&
            (() => {
              const rows = [...layout[shown].segs].sort((a, b) => b.v - a.v);
              const top = rows.slice(0, TIP_ROWS);
              return (
                <>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 6,
                      marginBottom: 2,
                      color: "var(--fg-subtle)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <span>{bucketLabel(ab.startMs, scale)}</span>
                    <span style={{ color: "var(--fg-strong)", fontVariantNumeric: "tabular-nums" }}>
                      {fmtVal(totals[shown])}
                    </span>
                  </div>
                  {rows.length === 0 && <div style={{ color: "var(--fg-subtle)" }}>No activity</div>}
                  {top.map((r) => (
                    <div key={r.key} style={{ display: "flex", alignItems: "center", gap: 7, whiteSpace: "nowrap" }}>
                      <i
                        aria-hidden
                        style={{ width: 9, height: 9, borderRadius: 3, flex: "none", background: r.color }}
                      />
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", color: "var(--fg)" }}>
                        {groupOrder.find((g) => g.key === r.key)?.label ?? r.key}
                      </span>
                      <span style={{ color: "var(--fg-strong)", fontVariantNumeric: "tabular-nums" }}>
                        {fmtVal(r.v)}
                      </span>
                    </div>
                  ))}
                  {rows.length > top.length && (
                    <div style={{ color: "var(--fg-subtle)", paddingLeft: 14 }}>
                      +{rows.length - top.length} more
                    </div>
                  )}
                </>
              );
            })()}
        </div>
      </div>

      {/* Five dates under their columns: the ends, and three between. */}
      <div style={{ position: "relative", height: 14, marginTop: -8, marginRight: GUTTER }}>
        {plotW > 0 &&
          [0, 0.25, 0.5, 0.75, 1].map((f) => {
            const i = Math.round(f * (span - 1));
            return (
              <span
                key={f}
                style={{
                  position: "absolute",
                  left: colLeft(i) + barW / 2,
                  transform: f === 0 ? "translateX(-6px)" : f === 1 ? "translateX(calc(-100% + 6px))" : "translateX(-50%)",
                  color: "var(--fg-subtle)",
                  fontSize: 11,
                  lineHeight: "14px",
                  fontVariantNumeric: "tabular-nums",
                  whiteSpace: "nowrap",
                }}
              >
                {shortDate(buckets[i].startMs)}
              </span>
            );
          })}
      </div>

      {legend.length > 0 && (
        <div
          onMouseLeave={() => setFocusKey(null)}
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
            gap: "2px 20px",
            marginTop: 2,
            paddingTop: 12,
            borderTop: "1px solid var(--border)",
          }}
        >
          {legend.map((g) => (
            <div
              key={g.key}
              onMouseEnter={() => setFocusKey(g.key)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 0",
                fontSize: 12.5,
                lineHeight: "17px",
                cursor: "default",
                opacity: focusKey !== null && focusKey !== g.key ? 0.5 : 1,
                transition: "opacity var(--motion-fast) var(--ease-out)",
              }}
            >
              <i aria-hidden style={{ width: 10, height: 10, borderRadius: 3, flex: "none", background: g.color }} />
              {g.logo && <ProviderLogo id={g.logo as ProviderId} size={14} />}
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: "var(--fg)",
                }}
              >
                {g.label}
              </span>
              <span style={{ color: "var(--fg-strong)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                {metric === "cost" ? formatUsd(g.v) : formatCompact(Math.round(g.v))}
              </span>
              <span
                style={{
                  width: 34,
                  textAlign: "right",
                  color: "var(--fg-subtle)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {total > 0 ? Math.round((g.v / total) * 100) : 0}%
              </span>
            </div>
          ))}
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
              <DotGridLoader size={22} label="Reading session logs" />
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
            providerChartColor(isKlide ? r.provider ?? "" : r.source) ?? "var(--fg-subtle)",
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
              groupOrder={groups.map((g) => ({
                key: g.key,
                color: colorOf(g),
                label: g.label,
                logo: g.source === "klide" ? g.provider ?? "ollama" : g.source,
              }))}
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

