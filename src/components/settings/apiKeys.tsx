// API keys + balance — keychain-backed provider keys, per-provider budget
// donuts, the credits meter and top-up affordances. Extracted from
// SettingsPanel.tsx.

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  listProviderModels,
  readProviderKeyStatus,
  type ProviderKeyStatus,
} from "../../ipc/aiProviders";
import { DotGridLoader, ProviderLogo } from "../ai/icons";
import type { ProviderId } from "../../agent/types";
import { notify } from "../../toast";
import { fetchAgentRunsCached, peekAgentRunsCache, type Run } from "../../runs";
import { GhostButton, LinkButton, Panel, PencilIcon, Row, StatusText } from "./controls";
import { DonutChart, PROVIDER_BRAND_COLOR, UsageHistogram, formatUsd, runCost } from "./stats";

// API providers whose keys live in the OS keychain (managed from the API tab).
export const API_KEY_PROVIDERS: {
  id: string;
  title: string;
  envVar: string;
  placeholder: string;
}[] = [
  { id: "anthropic", title: "Anthropic", envVar: "ANTHROPIC_API_KEY", placeholder: "sk-ant-..." },
  { id: "openai", title: "OpenAI", envVar: "OPENAI_API_KEY", placeholder: "sk-..." },
  { id: "mistral", title: "Mistral", envVar: "MISTRAL_API_KEY", placeholder: "..." },
  { id: "xai", title: "xAI Grok", envVar: "XAI_API_KEY", placeholder: "xai-..." },
  { id: "openrouter", title: "OpenRouter", envVar: "OPENROUTER_API_KEY", placeholder: "sk-or-..." },
];

export type KeyStatus = ProviderKeyStatus;

// One provider's key control: shows where the key comes from (keychain / env /
// none), lets you paste a new one (saved into the keychain via Rust), and clear
// it. The key value never lives in React state once saved — only its status.
// At-a-glance coverage above the key rows: how many hosted providers have a key,
// plus a gentle "start here" nudge when none are set (the new-user state).
export function ApiKeySummary() {
  const [configured, setConfigured] = useState<number | null>(null);
  const total = API_KEY_PROVIDERS.length;
  useEffect(() => {
    let alive = true;
    void (async () => {
      let n = 0;
      await Promise.all(
        API_KEY_PROVIDERS.map(async (p) => {
          try {
            const st = await readProviderKeyStatus(p.id);
            if (st.hasKey) n += 1;
          } catch { /* ignore */ }
        }),
      );
      if (alive) setConfigured(n);
    })();
    return () => { alive = false; };
  }, []);
  if (configured === null) return null;
  return (
    <div style={{ margin: "0 0 12px", fontSize: 12.5, color: "var(--fg-subtle)", lineHeight: 1.5 }}>
      <b style={{ fontWeight: 600, color: "var(--fg-strong)" }}>{configured} of {total}</b> providers configured.
      {configured === 0 && " Add one key below to start chatting with hosted models — or use Ollama/MLX locally with no key."}
    </div>
  );
}

// Live prepaid balance, USD. `null` fields where the provider only reports
// usage (no cap). The whole object is null for providers that don't expose a
// balance over the API — today only OpenRouter does.
export type ProviderCredits = { total: number | null; used: number | null; remaining: number | null };

export function ApiKeyRow({
  id,
  title,
  envVar,
  placeholder,
  onChange,
}: {
  id: string;
  title: string;
  envVar: string;
  placeholder: string;
  onChange?: (provider: string) => void;
}) {
  const [status, setStatus] = useState<KeyStatus>({ hasKey: false, source: "none" });
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Post-save validation: "Saved" only means persisted, not that the key works.
  // We probe the provider's model list (the cheapest authenticated call) so a
  // bad key surfaces here, not silently at the first chat turn.
  const [verify, setVerify] = useState<"idle" | "checking" | "ok" | "fail">("idle");
  // Two ways to supply the key: "paste" → macOS Keychain (classic), or "ref"
  // → a `${VAR}` reference resolved from .env (same as self-hosted endpoints).
  const [method, setMethod] = useState<"paste" | "ref">("paste");

  const refresh = useCallback(async () => {
    try {
      const next = await readProviderKeyStatus(id);
      setStatus(next);
      // Reflect the saved method so reopening Settings shows how it's wired.
      if (next.source === "reference") setMethod("ref");
      else if (next.source === "keychain") setMethod("paste");
    } catch {
      setStatus({ hasKey: false, source: "none" });
    }
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save() {
    if (!value.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (method === "ref") {
        await invoke("ai_set_provider_key_reference", { provider: id, reference: value });
      } else {
        await invoke("ai_set_provider_key", { provider: id, key: value });
      }
      setValue("");
      await refresh();
      onChange?.(id);
      // Validate against the live provider before claiming success.
      setVerify("checking");
      try {
        const models = await listProviderModels(id);
        if (models.length > 0) {
          setVerify("ok");
          notify(`${title} key verified`, { tone: "success" });
        } else {
          setVerify("fail");
          notify(`${title} key saved, but the provider returned no models — double-check it.`, { tone: "warn" });
        }
      } catch (e) {
        setVerify("fail");
        setError(`Saved, but couldn't verify: ${e instanceof Error ? e.message : String(e)}`);
        notify(`${title} key saved, but verification failed — it may be invalid.`, { tone: "warn" });
      }
    } catch (e) {
      setError(String(e));
      notify(`Couldn't save ${title} key: ${e instanceof Error ? e.message : String(e)}`, { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (busy) return;
    if (!window.confirm(`Remove the ${title} key? You'll need to re-enter it to use ${title} again.`)) return;
    setBusy(true);
    setError(null);
    try {
      // Clear whichever method is currently providing the key.
      const cmd =
        status.source === "reference"
          ? "ai_clear_provider_key_reference"
          : "ai_clear_provider_key";
      await invoke(cmd, { provider: id });
      setVerify("idle");
      await refresh();
      onChange?.(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const statusText =
    verify === "checking" ? (
      <StatusText tone="idle">Checking…</StatusText>
    ) : verify === "ok" ? (
      <StatusText tone="ok">Verified</StatusText>
    ) : verify === "fail" ? (
      <StatusText tone="warn">Unverified</StatusText>
    ) : status.source === "keychain" ? (
      <StatusText tone="ok">Saved</StatusText>
    ) : status.source === "reference" ? (
      status.hasKey ? (
        <StatusText tone="ok">Linked</StatusText>
      ) : (
        <StatusText tone="warn">Unresolved</StatusText>
      )
    ) : status.source === "env" ? (
      <StatusText tone="warn">From env</StatusText>
    ) : (
      <StatusText tone="idle">Not set</StatusText>
    );

  const description = error
    ? error
    : status.source === "keychain"
    ? "Stored securely in your macOS Keychain."
    : status.source === "reference"
    ? status.hasKey
      ? "Resolved from a ${VAR} reference in your .env — no key stored in the app."
      : "Reference set, but it doesn't resolve. Add the variable to your project .env or ~/.klide/.env."
    : status.source === "env"
    ? `Using ${envVar} from the environment. Save here to move it into the Keychain (survives a packaged build).`
    : method === "ref"
    ? `Reference an env var (e.g. \${${envVar}}); the value stays in your .env, never in the app.`
    : `Paste a key to store it in your macOS Keychain, or export ${envVar}.`;

  return (
    <Row
      title={title}
      description={description}
      control={
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {statusText}
          <MethodToggle method={method} onChange={setMethod} />
          <input
            type={method === "ref" ? "text" : "password"}
            value={value}
            placeholder={method === "ref" ? `\${${envVar}}` : placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
            }}
            aria-label={method === "ref" ? `${title} env reference` : `${title} API key`}
            autoComplete="off"
            spellCheck={false}
            className="klide-field"
            style={{
              width: 190,
              height: 34,
              padding: "0 12px",
            }}
          />
          <LinkButton onClick={() => void save()}>
            {busy ? <DotGridLoader size={14} color="currentColor" label="Saving" /> : "Save"}
          </LinkButton>
          {(status.source === "keychain" || status.source === "reference") && (
            <GhostButton onClick={() => void clear()}>Clear</GhostButton>
          )}
        </div>
      }
    />
  );
}

// ── Per-provider balance calculator ──────────────────────────────────
// Providers without a live balance API (everyone but OpenRouter) can still
// show "how much is left": the user enters what they topped up, and we
// subtract the spend Klide has already tracked (sum of run costUsd for that
// provider). Top-up amounts are not secrets, so they live in localStorage.
export const BUDGET_KEY = (p: string) => `klide.budget.${p}`;

export function readBudget(p: string): number | null {
  try {
    const raw = localStorage.getItem(BUDGET_KEY(p));
    const n = raw == null ? NaN : parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function readAllBudgets(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of API_KEY_PROVIDERS) {
    const n = readBudget(p.id);
    if (n != null) out[p.id] = n;
  }
  return out;
}

export function writeBudget(p: string, n: number | null) {
  try {
    if (n != null && n > 0) localStorage.setItem(BUDGET_KEY(p), String(n));
    else localStorage.removeItem(BUDGET_KEY(p));
  } catch {
    /* private mode / quota — the figure just won't persist */
  }
}

export function providerColor(id: string): string {
  return PROVIDER_BRAND_COLOR[id] ?? "var(--accent)";
}

// One balance donut in the provider row: used vs left, with the remaining
// figure in the centre and the provider's logo + name beneath. Clicking the
// card selects the provider (swaps the chart below); the small pencil opens an
// inline top-up field so you can set/edit "$ added" without leaving the row.
// Memoised so selecting one provider doesn't re-render the other donuts.
export const BalanceDonut = memo(function BalanceDonut({
  provider,
  used,
  added,
  usageLoaded,
  selected,
  onSelect,
  onSetBudget,
}: {
  provider: { id: string; title: string };
  used: number;
  added: number | null;
  // Whether spend has been parsed yet. Before "Load usage" we don't know
  // `used`, so the donut shows the top-up amount, not a misleading $0-spent.
  usageLoaded: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
  onSetBudget: (id: string, n: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const remaining = added != null ? added - used : null;
  const color = providerColor(provider.id);
  const track = "color-mix(in srgb, var(--fg-subtle) 16%, var(--bg))";
  const segments = !usageLoaded
    ? [{ key: "budget", color: added != null ? color : track, value: 1, title: added != null ? `Topped up ${formatUsd(added)}` : "No top-up set" }]
    : added != null
      ? [
          { key: "used", color, value: used, title: `Used ${formatUsd(used)}` },
          {
            key: "left",
            color: track,
            value: Math.max(0, remaining ?? 0),
            title: `Left ${formatUsd(Math.max(0, remaining ?? 0))}`,
          },
        ]
      : [{ key: "empty", color: track, value: 1, title: "No top-up set" }];
  const centerValue = !usageLoaded
    ? added != null
      ? formatUsd(added)
      : "—"
    : added != null
      ? formatUsd(Math.max(0, remaining ?? 0))
      : "—";
  const centerLabel = usageLoaded ? "left" : added != null ? "added" : "set $";

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => onSelect(provider.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(provider.id);
        }
      }}
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        padding: "10px 4px",
        border: "1px solid",
        borderColor: selected ? "var(--border-strong)" : "transparent",
        borderRadius: 10,
        background: selected ? "var(--bg-hover)" : "transparent",
        cursor: "pointer",
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
      }}
    >
      <DonutChart size={84} segments={segments} centerValue={centerValue} centerLabel={centerLabel} />
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, maxWidth: "100%" }}>
        <ProviderLogo id={provider.id as ProviderId} size={14} />
        <span
          style={{
            color: selected ? "var(--fg-strong)" : "var(--fg)",
            fontSize: 12,
            fontWeight: 500,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {provider.title}
        </span>
      </span>

      {/* Inline top-up editor: a pencil/＋ chip that expands to a $ field. */}
      {editing ? (
        <span onClick={(e) => e.stopPropagation()}>
          <TopUpInput
            autoFocus
            added={added}
            onAdded={(n) => {
              onSetBudget(provider.id, n);
              setEditing(false);
            }}
            label={`${provider.title} amount added`}
          />
        </span>
      ) : (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            height: 24,
            padding: "0 8px",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "transparent",
            color: "var(--fg-subtle)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          <PencilIcon size={11} />
          {added != null ? `$${added}` : "Add $"}
        </button>
      )}
    </div>
  );
});

// Top-up entry — number field committing on blur / Enter.
export function TopUpInput({
  added,
  onAdded,
  label,
  autoFocus = false,
}: {
  added: number | null;
  onAdded: (n: number | null) => void;
  label: string;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState(added != null ? String(added) : "");
  useEffect(() => {
    setDraft(added != null ? String(added) : "");
  }, [added]);
  const commit = () => {
    const n = parseFloat(draft);
    onAdded(Number.isFinite(n) && n > 0 ? n : null);
  };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: 30,
        padding: "0 8px",
        gap: 2,
        border: "1px solid var(--border-strong)",
        borderRadius: 6,
        background: "var(--bg)",
      }}
    >
      <span style={{ color: "var(--fg-subtle)", fontFamily: "var(--font-mono)", fontSize: 12 }}>$</span>
      <input
        type="number"
        min={0}
        step="0.01"
        autoFocus={autoFocus}
        value={draft}
        placeholder="0.00"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        aria-label={label}
        style={{
          width: 72,
          height: 28,
          border: "none",
          background: "transparent",
          color: "var(--fg-strong)",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          outline: "none",
        }}
      />
    </span>
  );
}

// The "Balance" block: spend Klide tracked per provider, against a top-up the
// user enters. Loads runs once (same cache the Stats panel uses) and pulls
// any live balances on the side.
export function ProviderBalanceBlock() {
  // Parsing run history is the slow part, so we don't do it on tab open — the
  // user taps "Load usage" (or it's instant when the Stats cache is warm).
  const [runs, setRuns] = useState<Run[]>(() => peekAgentRunsCache(1000, 0) ?? []);
  const [loaded, setLoaded] = useState(() => peekAgentRunsCache(1000, 0) !== null);
  const [loading, setLoading] = useState(false);
  const [budgets, setBudgets] = useState<Record<string, number>>(() => readAllBudgets());
  const [live, setLive] = useState<Record<string, number>>({});
  // Provider id whose detail chart is showing, or null for the global view.
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const all = await fetchAgentRunsCached(1000, 0);
      setRuns(all);
      setLoaded(true);
    } catch {
      /* outside Tauri — nothing to load */
    } finally {
      setLoading(false);
    }
  }, []);

  // Live balances (OpenRouter) — only after usage is loaded, so opening the
  // tab stays quiet. Cheap + non-blocking; no-ops for providers without one.
  useEffect(() => {
    if (!loaded) return;
    let cancel = false;
    void (async () => {
      for (const p of API_KEY_PROVIDERS) {
        try {
          const c = await invoke<ProviderCredits | null>("ai_provider_credits", { provider: p.id });
          if (!cancel && c?.remaining != null) {
            setLive((prev) => ({ ...prev, [p.id]: c.remaining as number }));
          }
        } catch {
          /* no balance endpoint for this provider */
        }
      }
    })();
    return () => {
      cancel = true;
    };
  }, [loaded]);

  const usedByProvider = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of runs) {
      if (r.source !== "klide" || !r.provider) continue;
      m[r.provider] = (m[r.provider] ?? 0) + (r.costUsd ?? 0);
    }
    return m;
  }, [runs]);

  // Stable callbacks so the memoised donuts don't all re-render on every
  // selection / edit — only the one whose props actually changed does.
  const setBudget = useCallback((id: string, n: number | null) => {
    writeBudget(id, n);
    setBudgets((prev) => {
      const next = { ...prev };
      if (n != null && n > 0) next[id] = n;
      else delete next[id];
      return next;
    });
  }, []);

  const onSelect = useCallback((id: string) => {
    setSelected((cur) => (cur === id ? null : id));
  }, []);

  // Order by name, but providers with spend float to the front.
  const ordered = useMemo(
    () =>
      [...API_KEY_PROVIDERS].sort((a, b) => {
        const ua = (usedByProvider[a.id] ?? 0) > 0 ? 1 : 0;
        const ub = (usedByProvider[b.id] ?? 0) > 0 ? 1 : 0;
        if (ua !== ub) return ub - ua;
        return a.title.localeCompare(b.title);
      }),
    [usedByProvider],
  );

  const hostedIds = API_KEY_PROVIDERS.map((p) => p.id);
  const selProvider = selected ? API_KEY_PROVIDERS.find((p) => p.id === selected) ?? null : null;
  const selIndex = selected ? ordered.findIndex((p) => p.id === selected) : -1;
  const caretFrac = selIndex >= 0 && ordered.length ? (selIndex + 0.5) / ordered.length : null;

  // Global chart: hosted-provider runs, stacked by provider (brand colours).
  const globalRuns = useMemo(
    () => runs.filter((r) => r.source === "klide" && r.provider != null && hostedIds.includes(r.provider)),
    [runs],
  );
  const globalGroupOrder = useMemo(
    () =>
      ordered
        .filter((p) => (usedByProvider[p.id] ?? 0) > 0)
        .map((p) => ({ key: `klide:${p.id}`, color: providerColor(p.id), label: p.title })),
    [ordered, usedByProvider],
  );

  // Provider chart: that provider's runs, stacked by model (shades of its hue).
  const providerRuns = useMemo(
    () => (selected ? runs.filter((r) => r.source === "klide" && r.provider === selected) : []),
    [runs, selected],
  );
  const providerKeyOf = useCallback((r: Run) => r.model?.trim() || "unknown", []);
  const providerGroupOrder = useMemo(() => {
    if (!selected) return [];
    const totals = new Map<string, number>();
    for (const r of providerRuns) {
      const k = r.model?.trim() || "unknown";
      totals.set(k, (totals.get(k) ?? 0) + runCost(r));
    }
    const color = providerColor(selected);
    const STEPS = [100, 72, 50, 34, 22, 14];
    return [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([k], i) => ({
        key: k,
        label: k,
        color: `color-mix(in srgb, ${color} ${STEPS[i % STEPS.length]}%, var(--bg-elevated))`,
      }));
  }, [selected, providerRuns]);

  const totalUsed = Object.values(usedByProvider).reduce((s, v) => s + v, 0);

  return (
    <Panel>
      <div style={{ position: "relative", padding: "16px 14px 18px" }}>
        {/* Donut row */}
        <div style={{ display: "flex", gap: 6 }}>
          {ordered.map((p) => (
            <BalanceDonut
              key={p.id}
              provider={p}
              used={usedByProvider[p.id] ?? 0}
              added={budgets[p.id] ?? null}
              usageLoaded={loaded}
              selected={selected === p.id}
              onSelect={onSelect}
              onSetBudget={setBudget}
            />
          ))}
        </div>

        {/* Caret + chart card */}
        <div
          style={{
            position: "relative",
            marginTop: 16,
            border: "1px solid color-mix(in srgb, var(--border-strong) 72%, transparent)",
            borderRadius: "var(--radius-lg)",
            background: "var(--bg-elevated)",
            padding: "14px 16px",
          }}
        >
          {!loaded ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 10,
                padding: "16px 0",
              }}
            >
              <span style={{ color: "var(--fg-subtle)", fontSize: 12.5 }}>
                See how much of each provider's top-up you've spent.
              </span>
              <button
                type="button"
                onClick={() => void load()}
                disabled={loading}
                style={{
                  height: 32,
                  padding: "0 16px",
                  border: "1px solid var(--border-strong)",
                  borderRadius: 7,
                  background: "var(--bg)",
                  color: "var(--fg-strong)",
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: loading ? "default" : "pointer",
                }}
              >
                {loading ? "Loading…" : "Load usage"}
              </button>
            </div>
          ) : (
          <>
          {caretFrac != null && (
            <span
              aria-hidden
              style={{
                position: "absolute",
                top: -6,
                left: `${caretFrac * 100}%`,
                transform: "translateX(-50%) rotate(45deg)",
                width: 10,
                height: 10,
                background: "var(--bg-elevated)",
                borderLeft: "1px solid color-mix(in srgb, var(--border-strong) 72%, transparent)",
                borderTop: "1px solid color-mix(in srgb, var(--border-strong) 72%, transparent)",
              }}
            />
          )}

          {/* Header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              marginBottom: 14,
              flexWrap: "wrap",
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              {selProvider && <ProviderLogo id={selProvider.id as ProviderId} size={16} />}
              <span style={{ color: "var(--fg-strong)", fontSize: 13, fontWeight: 600 }}>
                {selProvider ? `${selProvider.title} usage` : "All API providers"}
              </span>
            </span>
            {selProvider ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11.5,
                    color: "var(--fg-subtle)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {formatUsd(usedByProvider[selProvider.id] ?? 0)} used
                  {budgets[selProvider.id] != null && (
                    <>
                      {" · "}
                      <span
                        style={{
                          color:
                            budgets[selProvider.id] - (usedByProvider[selProvider.id] ?? 0) < 0
                              ? "var(--danger)"
                              : "var(--fg-strong)",
                        }}
                      >
                        {formatUsd(budgets[selProvider.id] - (usedByProvider[selProvider.id] ?? 0))} left
                      </span>
                    </>
                  )}
                  {live[selProvider.id] != null && <> · {formatUsd(live[selProvider.id])} live</>}
                </span>
              </span>
            ) : (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--fg-subtle)" }}>
                {formatUsd(totalUsed)} used · click a provider for its breakdown
              </span>
            )}
          </div>

          {/* Chart */}
          {selProvider ? (
            providerGroupOrder.length > 0 ? (
              <UsageHistogram
                runs={providerRuns}
                metric="cost"
                groupOrder={providerGroupOrder}
                keyOf={providerKeyOf}
              />
            ) : (
              <div style={{ color: "var(--fg-subtle)", fontSize: 12, padding: "8px 0 14px" }}>
                No tracked spend for {selProvider.title} yet.
              </div>
            )
          ) : globalGroupOrder.length > 0 ? (
            <UsageHistogram runs={globalRuns} metric="cost" groupOrder={globalGroupOrder} />
          ) : (
            <div style={{ color: "var(--fg-subtle)", fontSize: 12, padding: "8px 0 14px" }}>
              No tracked API spend yet. Run a conversation against a hosted provider and come back.
            </div>
          )}
          </>
          )}
        </div>
      </div>
    </Panel>
  );
}

// Compact two-segment switch between the pasted-key (Keychain) and the
// env-reference (.env) methods. Quiet at rest; the active segment carries the
// accent tint, matching the picker chips elsewhere.
export function MethodToggle({
  method,
  onChange,
}: {
  method: "paste" | "ref";
  onChange: (m: "paste" | "ref") => void;
}) {
  const seg = (m: "paste" | "ref", label: string) => {
    const active = method === m;
    return (
      <button
        type="button"
        onClick={() => onChange(m)}
        aria-pressed={active}
        style={{
          height: 26,
          padding: "0 9px",
          border: "none",
          borderRadius: 6,
          background: active ? "var(--bg-elevated)" : "transparent",
          boxShadow: active ? "var(--shadow-raised)" : "none",
          color: active ? "var(--fg-strong)" : "var(--fg-subtle)",
          fontSize: 11.5,
          fontWeight: active ? 600 : 500,
          cursor: "pointer",
          transition: "background 120ms ease, color 120ms ease",
        }}
      >
        {label}
      </button>
    );
  };
  return (
    <div
      role="group"
      aria-label="Key method"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: 2,
        borderRadius: 8,
        background: "var(--bg-hover)",
        border: "1px solid var(--border)",
      }}
    >
      {seg("paste", "Paste")}
      {seg("ref", "Env ref")}
    </div>
  );
}
