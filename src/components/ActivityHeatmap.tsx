import { useMemo } from "react";

type Props<T extends { createdMs: number }> = {
  /** All runs (klide + external) to compute the heatmap from. */
  runs: T[];
  /** Number of weeks to show (default 52). */
  weeks?: number;
  /**
   * How much a run contributes to its day's cell. Defaults to 1 — i.e. the
   * grid counts runs. Pass e.g. `(r) => r.inputTokens + r.outputTokens` to
   * color the grid by token volume instead.
   */
  weight?: (run: T) => number;
  /** Noun for tooltips and the summary line (default "runs"). */
  unit?: string;
  /** Date key ("YYYY-MM-DD") of the selected cell, if any. */
  selectedDay?: string | null;
  /** Cell click handler — called with the day key, or null when re-clicking the selection. */
  onSelectDay?: (key: string | null) => void;
};

// ── helpers (shared with the Settings stats section) ─────────────────
export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function msToKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Return the Monday of the week containing `ms`. */
export function mondayOfWeek(ms: number): number {
  const d = new Date(ms);
  const day = d.getDay(); // 0=Sun … 6=Sat
  const diff = day === 0 ? -6 : 1 - day; // shift to Monday
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 1234567 → "1.2M", 45600 → "45.6k" — keeps tooltips readable for tokens. */
export function formatCompact(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// ── intensity buckets ────────────────────────────────────────────────
// 5 levels: 0 (empty) → 4 (high activity).
// Derived from --accent via CSS color-mix so the grid follows the theme.
function intensityStyle(count: number, max: number): string {
  if (count === 0) return "var(--bg-elevated)";
  const ratio = count / max;
  if (ratio < 0.15) return "color-mix(in srgb, var(--accent) 15%, var(--bg))";
  if (ratio < 0.35) return "color-mix(in srgb, var(--accent) 30%, var(--bg))";
  if (ratio < 0.65) return "color-mix(in srgb, var(--accent) 55%, var(--bg))";
  return "var(--accent)";
}

// ── component ────────────────────────────────────────────────────────
export function ActivityHeatmap<T extends { createdMs: number }>({
  runs,
  weeks = 52,
  weight,
  unit = "runs",
  selectedDay,
  onSelectDay,
}: Props<T>) {
  const { grid, maxCount, byDay, totalDays, totalValue, longestStreak } = useMemo(() => {
    // Bucket runs by day, summing each run's weight (1 per run by default).
    const byDay = new Map<string, number>();
    for (const r of runs) {
      const key = msToKey(r.createdMs);
      byDay.set(key, (byDay.get(key) ?? 0) + (weight ? weight(r) : 1));
    }

    // Build the grid: 7 rows (days of week) × N columns (weeks).
    const today = startOfDay(Date.now());
    const mondayNow = mondayOfWeek(today);
    const startMonday = mondayNow - (weeks - 1) * 7 * 86_400_000;

    const grid: (string | null)[][] = []; // [week][dayOfWeek] → date key or null
    let maxCount = 0;

    for (let w = 0; w < weeks; w++) {
      const col: (string | null)[] = [];
      for (let d = 0; d < 7; d++) {
        const cellMs = startMonday + (w * 7 + d) * 86_400_000;
        if (cellMs > today) {
          col.push(null); // future
        } else {
          const key = msToKey(cellMs);
          const count = byDay.get(key) ?? 0;
          if (count > maxCount) maxCount = count;
          col.push(key);
        }
      }
      grid.push(col);
    }

    // Stats.
    let totalDays = 0;
    let totalValue = 0;
    let streak = 0;
    let longestStreak = 0;
    // Walk backwards from today to count streak and active days.
    for (let d = 0; d <= weeks * 7; d++) {
      const cellMs = today - d * 86_400_000;
      const key = msToKey(cellMs);
      const count = byDay.get(key) ?? 0;
      totalValue += count;
      if (count > 0) {
        totalDays++;
        streak++;
        if (streak > longestStreak) longestStreak = streak;
      } else {
        streak = 0;
      }
    }

    return { grid, maxCount, byDay, totalDays, totalValue, longestStreak };
  }, [runs, weeks, weight]);

  // Month labels: place a label at the first column where the month changes.
  const monthLabels = useMemo(() => {
    const labels: { col: number; name: string }[] = [];
    let lastMonth = -1;
    for (let w = 0; w < grid.length; w++) {
      // Use the first non-null cell in the column to determine the month.
      for (let d = 0; d < 7; d++) {
        const key = grid[w][d];
        if (key) {
          const month = new Date(key + "T00:00:00").getMonth();
          if (month !== lastMonth) {
            labels.push({ col: w, name: MONTH_NAMES[month] });
            lastMonth = month;
          }
          break;
        }
      }
    }
    return labels;
  }, [grid]);

  const cellSize = 12;
  const gap = 3;
  const step = cellSize + gap;
  const labelWidth = 28; // space for Mon/Wed/Fri labels
  const monthLabelHeight = 16;
  const gridWidth = weeks * step;

  return (
    <div style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
      {/* Month labels */}
      <div
        style={{
          position: "relative",
          marginLeft: labelWidth,
          height: monthLabelHeight,
          marginBottom: 2,
          width: gridWidth,
        }}
      >
        {monthLabels.map(({ col, name }) => (
          <span
            key={`${col}-${name}`}
            style={{
              position: "absolute",
              left: col * step,
              color: "var(--fg-subtle)",
              fontSize: 10,
              whiteSpace: "nowrap",
            }}
          >
            {name}
          </span>
        ))}
      </div>

      <div style={{ display: "flex", gap: 0 }}>
        {/* Day-of-week labels */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap,
            width: labelWidth,
            paddingTop: 0,
          }}
        >
          {DAY_NAMES.map((name, i) => (
            <span
              key={name}
              style={{
                height: cellSize,
                lineHeight: `${cellSize}px`,
                color: "var(--fg-subtle)",
                fontSize: 10,
                textAlign: "right",
                paddingRight: 4,
                // Only show Mon, Wed, Fri to reduce clutter.
                visibility: i % 2 === 0 ? "visible" : "hidden",
              }}
            >
              {name}
            </span>
          ))}
        </div>

        {/* Grid */}
        <div
          style={{
            display: "flex",
            gap,
          }}
        >
          {grid.map((col, w) => (
            <div key={w} style={{ display: "flex", flexDirection: "column", gap }}>
              {col.map((key, d) => (
                <div
                  key={d}
                  title={key ? `${key}: ${formatCompact(byDay.get(key) ?? 0)} ${unit}` : ""}
                  onClick={
                    key && onSelectDay
                      ? () => onSelectDay(key === selectedDay ? null : key)
                      : undefined
                  }
                  style={{
                    width: cellSize,
                    height: cellSize,
                    borderRadius: 2,
                    background: key
                      ? intensityStyle(byDay.get(key) ?? 0, maxCount || 1)
                      : "transparent",
                    border: key
                      ? key === selectedDay
                        ? "1px solid var(--fg-strong)"
                        : "1px solid var(--border)"
                      : "none",
                    // A quiet ring marks the selected day without resizing the cell.
                    boxShadow:
                      key && key === selectedDay
                        ? "0 0 0 1px var(--fg-strong)"
                        : "none",
                    cursor: key && onSelectDay ? "pointer" : key ? "default" : undefined,
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Summary line */}
      <div
        style={{
          marginTop: 10,
          display: "flex",
          gap: 16,
          color: "var(--fg-subtle)",
          fontSize: 11,
        }}
      >
        <span>{formatCompact(totalValue)} {unit}</span>
        <span>{totalDays} active days</span>
        <span>{longestStreak} day streak</span>
      </div>
    </div>
  );
}
