// Mission Control › Scheduled — klide-bot, a Triggers row beside Watch CI.
// The bots live in GitHub Actions (klide-bot.yml answers @klide-bot,
// review.yml reviews each PR), both on Klide's own agent (`klide run`). What
// they run on is two repository variables; this pane reads and sets them.

import { useEffect, useState } from "react";
import { klideBotSetModel, klideBotSettings, splitBotModel, type BotKind, type BotSettings } from "../../ipc/klideBot";
import { listProviderModels } from "../../ipc/aiProviders";
import { providerName } from "../../agent/providers";
import { providerDefaultModel } from "../../agent/providerCatalog";
import type { ProviderId } from "../../agent/types";
import { ModelPicker } from "../ai/ModelPicker";
import { InlineMenu } from "../FocusMode";
import { ProviderLogo } from "../ai/icons";
import { Toggle } from "../settings/controls";
import { LinkMark } from "../linkMark";
import { openExternal } from "../../externalLink";
import { errMessage } from "../../errors";

/** The list selection that means "klide-bot", never a schedule id. */
export const KLIDE_BOT_ID = "__klide-bot__";

export type KlideBot = ReturnType<typeof useKlideBot>;

export function useKlideBot(workspaceRoot: string | null) {
  const [settings, setSettings] = useState<BotSettings | null>(null);
  const [busy, setBusy] = useState<BotKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setSettings(null); setError(null);
    if (!workspaceRoot) return;
    let live = true;
    klideBotSettings(workspaceRoot).then(s => { if (live) setSettings(s); }).catch(e => { if (live) setError(errMessage(e)); });
    return () => { live = false; };
  }, [workspaceRoot]);
  async function set(bot: BotKind, model: string | null) {
    if (!workspaceRoot || busy) return;
    setBusy(bot); setError(null);
    try { setSettings(await klideBotSetModel(workspaceRoot, bot, model)); }
    catch (e) { setError(errMessage(e)); }
    finally { setBusy(null); }
  }
  return { settings, busy, error, set };
}

function botStatus(bot: KlideBot): string {
  const s = bot.settings;
  if (!s) return bot.error ? "Unavailable" : "…";
  const on = [s.answerModel, s.reviewModel].filter(Boolean).length;
  return on === 0 ? "Off" : s.keyedProviders.length === 0 ? "Needs a key" : "On GitHub";
}

export function KlideBotListRow({ bot, current, onSelect }: { bot: KlideBot; current: boolean; onSelect: () => void }) {
  return <button type="button" className="scheduled-list-row" aria-current={current ? "page" : undefined} onClick={onSelect}>
    <span className="klide-bot-mark" aria-hidden="true"><LinkMark site="github" size={16} /></span>
    <span className="scheduled-list-row-top"><strong>klide-bot</strong><span data-failed={botStatus(bot) === "Needs a key" || undefined}>{botStatus(bot)}</span></span>
    <span className="scheduled-list-row-meta">{bot.settings?.repo ?? "GitHub"}</span>
  </button>;
}

/** One bot: on/off, then the Provider and model its workflow runs. */
function BotRow({ bot, kind, title, caption, installed, value }: {
  bot: KlideBot; kind: BotKind; title: string; caption: string; installed: boolean; value: string | null;
}) {
  const keyed = bot.settings?.keyedProviders ?? [];
  const parsed = splitBotModel(value);
  const provider = parsed?.provider ?? keyed[0] ?? "openrouter";
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    setModels([]);
    void listProviderModels(provider as ProviderId).then(list => { if (live) setModels(list); }).catch(() => {});
    return () => { live = false; };
  }, [provider]);
  const busy = bot.busy !== null;
  const turnOn = () => {
    const p = keyed[0] ?? "openrouter";
    void bot.set(kind, `${p}/${providerDefaultModel(p) ?? ""}`);
  };
  return <section className="klide-bot-row" aria-label={title}>
    <div className="klide-bot-row-head">
      <div><strong>{title}</strong><span>{installed ? caption : "Its workflow isn't in this project's main branch yet."}</span></div>
      <span aria-busy={bot.busy === kind}><Toggle checked={!!value} label={title}
        onChange={on => { if (busy) return; if (!on) void bot.set(kind, null); else if (installed && keyed.length) turnOn(); }} /></span>
    </div>
    {value && <div className="ci-watch-agent" role="group" aria-label={`${title} model`}>
      <InlineMenu
        label="Provider"
        display={providerName(provider as ProviderId)}
        leading={<ProviderLogo id={provider as ProviderId} size={13} />}
        options={keyed.map(p => ({ value: p, label: providerName(p as ProviderId), icon: <ProviderLogo id={p as ProviderId} size={13} /> }))}
        selected={provider}
        onSelect={v => { if (!busy && typeof v === "string" && v !== provider) void bot.set(kind, `${v}/${providerDefaultModel(v) ?? ""}`); }}
      />
      <ModelPicker provider={provider as ProviderId} model={parsed?.model ?? ""} availableModels={models}
        onChange={m => { if (!busy && m !== parsed?.model) void bot.set(kind, `${provider}/${m}`); }} direction="down" disabled={busy} />
    </div>}
  </section>;
}

export function KlideBotDetail({ bot }: { bot: KlideBot }) {
  const s = bot.settings;
  return <>
    <div className="scheduled-detail-heading"><h2>klide-bot on GitHub</h2></div>
    <div className="scheduled-detail-scroll klide-scroll-slim">
      <div className="scheduled-timing">
        <span>{botStatus(bot)}</span>
        {s ? <span className="scheduled-cadence">{s.repo}</span> : null}
        {s ? <span className="scheduled-cadence">Posts as {s.appIdentity ? "klide-bot[bot]" : "GitHub Actions"}</span> : null}
      </div>
      {s ? <>
        <BotRow bot={bot} kind="answer" title="Answers @klide-bot" installed={s.answerInstalled} value={s.answerModel}
          caption="A comment that mentions @klide-bot on a PR or issue gets a read-only answer in the thread." />
        <BotRow bot={bot} kind="review" title="Reviews pull requests" installed={s.reviewInstalled} value={s.reviewModel}
          caption="Each pull request is reviewed against .github/review/REVIEW.md and gets a pass or fail status." />
        {s.keyedProviders.length === 0
          ? <p className="scheduled-error" role="status">No model key on {s.repo}. Add one as a repository secret: <code>gh secret set OPENROUTER_API_KEY</code> (or <code>DEEPSEEK_API_KEY</code>).</p>
          : null}
        <h3>How it runs</h3>
        <p className="scheduled-instructions">Both run in GitHub Actions on Klide's own agent (<code>klide run</code>), read-only: they read the code and answer, and never edit, run commands or push. The model is a repository variable, so a change here applies to the next comment or push. A free OpenRouter model costs nothing; keys stay GitHub secrets and never pass through Klide.</p>
        <button type="button" className="klide-bot-actions-link" onClick={() => void openExternal(`https://github.com/${s.repo}/actions`)}>Open runs on GitHub<span aria-hidden="true"> ↗</span></button>
      </> : <p className="scheduled-instructions">{bot.error ?? "Reading the repository's settings…"}</p>}
      {s && bot.error ? <p className="scheduled-error" role="alert">{bot.error}</p> : null}
    </div>
  </>;
}
