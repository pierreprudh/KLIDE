// Mission Control › Scheduled — klide-bot, the second trigger beside Watch CI.
// A `@klide-bot` comment on one of your PRs starts a read-only Run; its answer
// waits here as a draft, and Post sends it as a reply under your account.
import { useState } from "react";
import { klideBotGet, klideBotSet, type KlideBotInfo } from "../../ipc/klideBot";
import { postKlideBotReply } from "../../klideBotPost";
import type { ProviderId } from "../../agent/types";
import type { HarnessSettings } from "../../settingsStore";
import { relativeTime } from "../../time";
import { openExternal } from "../../externalLink";
import { ProviderModelMark } from "../../modelIdentity";
import { TriggerDetail, TriggerListRow, triggerStatus, useTrigger, type Trigger } from "./trigger";

export const KLIDE_BOT_ID = "__klide-bot__";
export const KLIDE_BOT_TITLE = "klide-bot on my pull requests";

const API = { get: klideBotGet, set: klideBotSet, event: "klide-bot:pending" };

export type KlideBot = Trigger<KlideBotInfo>;

export function useKlideBot(workspaceRoot: string | null, defaultProvider: ProviderId, defaultModel: string, settings: HarnessSettings): KlideBot {
  return useTrigger(API, workspaceRoot, defaultProvider, defaultModel, settings);
}

export function KlideBotListRow({ bot, project, current, onSelect }: { bot: KlideBot; project: string; current: boolean; onSelect: () => void }) {
  return <TriggerListRow trigger={bot} name="klide-bot" status={triggerStatus(bot, "Listening")} current={current} onSelect={onSelect}
    meta={<>@klide-bot on my PRs<span aria-hidden="true"> · </span>{project}</>} />;
}

export function KlideBotDetail({ bot, project }: { bot: KlideBot; project: string | null }) {
  return <TriggerDetail trigger={bot} project={project} title={KLIDE_BOT_TITLE} status={triggerStatus(bot, "Listening")} emptyHint="Open a project to answer @klide-bot on its pull requests.">
    <p className="scheduled-instructions">When someone with write access writes <code>@klide-bot</code> in a comment on one of your open pull requests in {project}, this agent reads the code and drafts a reply, following the repository's own rules. It runs read-only. Nothing is posted until you press Post: the reply goes out under your GitHub account, signed “— klide-bot”. Comments from before you turned this on are skipped.</p>
  </TriggerDetail>;
}

/** The first line of a draft, plain. */
function firstLine(text: string): string {
  const line = text.split("\n").map(l => l.replace(/^#+\s*|[*_`>]/g, "").trim()).find(Boolean) ?? "";
  return line.length > 120 ? `${line.slice(0, 119).trimEnd()}…` : line;
}

export function KlideBotHistory({ bot, onOpenRun }: { bot: KlideBot; onOpenRun: (id: string) => void }) {
  const [posted, setPosted] = useState<Record<string, string>>({});
  const mentions = bot.info?.mentions ?? [];
  if (!mentions.length) return <p className="scheduled-pane-empty">{bot.on ? "No mentions yet." : "Turn on to answer @klide-bot on your pull requests."}</p>;
  return <ol className="ci-fires">{mentions.map(m => {
    const url = m.postedUrl ?? posted[m.key];
    const status = m.error ? "Not answered" : url ? "Posted" : m.draft ? "Draft ready" : "Answering…";
    return <li key={m.key}>
      <button type="button" className="ci-fire" disabled={!m.runId} aria-label={`Open Run · #${m.prNumber} ${m.prTitle}`}
        onClick={() => m.runId && onOpenRun(m.runId)}>
        <span className="ci-fire-head">
          {m.provider ? <ProviderModelMark provider={m.provider as ProviderId} model={m.model} size={18} /> : null}
          <span className="ci-fire-title">#{m.prNumber} {m.prTitle}</span>
          <span className="ci-fire-time" data-failed={m.error ? true : undefined}>{m.error ? status : relativeTime(m.at)}</span>
        </span>
        <span className="ci-fire-checks"><span className="klide-bot-comment">@{m.author}: {m.excerpt}</span></span>
        {m.error
          ? <span className="ci-fire-verdict">{m.error}</span>
          : <span className="ci-fire-verdict" data-pending={!m.draft ? true : undefined}>{m.draft ? firstLine(m.draft) : "Kit is answering…"}</span>}
      </button>
      {m.draft && !url && <button type="button" className="ci-watch-fix" title="Post this reply under your GitHub account, signed — klide-bot"
        onClick={() => void postKlideBotReply(m).then(u => { if (u) setPosted(p => ({ ...p, [m.key]: u })); })}>Post</button>}
      {url && <button type="button" className="ci-watch-fix" title={url}
        onClick={() => void openExternal(url)}>Posted ↗</button>}
    </li>;
  })}</ol>;
}
