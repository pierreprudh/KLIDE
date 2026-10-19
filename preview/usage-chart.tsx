// Throwaway page for the stacked usage chart in Settings › Stats (and API keys)
// without launching Tauri. Fake runs over the last six months, four groups.
//
//   http://localhost:1420/preview/usage-chart.html?theme=dark&metric=tokens
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "../src/styles/tokens.css";
import { UsageHistogram, assignGroupColors, type ProviderGroup, type StatsMetric } from "../src/components/settings/stats";
import type { Run } from "../src/runs";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "klide-light";
const metric = (params.get("metric") ?? "conversations") as StatsMetric;

let seed = 4396;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const kinds = [
  { source: "claude-code", provider: null, w: 5 },
  { source: "klide", provider: "anthropic", w: 3 },
  { source: "codex", provider: null, w: 2 },
  { source: "klide", provider: "ollama", w: 1.4 },
  { source: "klide", provider: "openrouter", w: 1 },
  { source: "klide", provider: "mistral", w: 0.7 },
] as const;
const runs: Run[] = [];
for (let d = 0; d < 180; d++) {
  const day = Date.now() - d * 86_400_000;
  const weekend = [0, 6].includes(new Date(day).getDay());
  for (const k of kinds) {
    const n = Math.round(k.w * (weekend ? 0.4 : 1) * rand() * 2);
    for (let i = 0; i < n; i++)
      runs.push({
        id: `${d}-${k.source}-${i}`,
        source: k.source,
        provider: k.provider,
        model: "m",
        createdMs: day - rand() * 3_600_000,
        inputTokens: Math.round(rand() * 40_000),
        outputTokens: Math.round(rand() * 8_000),
        costUsd: rand() * 0.6,
      } as unknown as Run);
  }
}
const groups = kinds.map((k) => ({
  key: k.source === "klide" ? `klide:${k.provider}` : k.source,
  label: k.source === "klide" ? `Klide · ${k.provider}` : k.source,
  source: k.source,
  provider: k.provider,
})) as unknown as ProviderGroup[];
const colors = assignGroupColors(groups);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div style={{ background: "var(--bg)", minHeight: "100vh", padding: 32, fontFamily: "var(--font-ui)" }}>
    <div className="klide-surface" style={{ maxWidth: 640 }}>
      <div style={{ padding: "14px 18px" }}>
        <UsageHistogram
          runs={runs}
          metric={metric}
          groupOrder={groups.map((g) => ({
            key: g.key,
            label: g.label,
            color: colors.get(g.key)!,
            logo: g.source === "klide" ? g.provider! : g.source,
          }))}
        />
      </div>
    </div>
  </div>,
);

// ?scrub=0.7 parks the pointer at that fraction of the plot, for screenshots.
const scrub = params.get("scrub");
if (scrub)
  setTimeout(() => {
    const plot = document.querySelector<HTMLElement>('[style*="crosshair"]');
    if (!plot) return;
    const r = plot.getBoundingClientRect();
    const x = r.left + r.width * Number(scrub);
    plot.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x, clientY: r.top + 40 }));
  }, 800);
