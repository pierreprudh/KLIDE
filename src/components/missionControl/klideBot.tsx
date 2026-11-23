// Mission Control › Scheduled — klide-bot, the second trigger beside Watch CI.
// A `@klide-bot` comment on one of your PRs is brought to you: a notification
// while Klide is open, and a card here. "Look into it" opens Kit in a worktree
// at the PR's head; nothing runs or posts by itself.
import { klideBotGet, klideBotSet, type KlideBotInfo } from "../../ipc/klideBot";
import type { ProviderId } from "../../agent/types";
import type { HarnessSettings } from "../../settingsStore";
import { relativeTime } from "../../time";
import { openExternal } from "../../externalLink";
import { ProviderModelMark } from "../../modelIdentity";
import { mentionAsk } from "../../agent/klideBotLook";
import { canLookIntoMention, lookIntoMention } from "../../klideBotNavigation";
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
  return <TriggerDetail trigger={bot} project={project} title={KLIDE_BOT_TITLE} status={triggerStatus(bot, "Listening")} mode="Work, when you ask" emptyHint="Open a project to hear about @klide-bot on its pull requests.">
    <p className="scheduled-instructions">When someone with write access writes <code>@klide-bot</code> in a comment on one of your open pull requests in {project}, you get a notification while Klide is open. Look into it opens this agent in a worktree at the pull request's head, with the thread and diff attached. Nothing runs or posts until you choose to.</p>
  </TriggerDetail>;
}

export function KlideBotHistory({ bot }: { bot: KlideBot }) {
  const mentions = bot.info?.mentions ?? [];
  if (!mentions.length) return <p className="scheduled-pane-empty">{bot.on ? "No mentions yet." : "Turn on to hear about @klide-bot on your pull requests."}</p>;
  const canLook = canLookIntoMention();
  return <ol className="ci-fires bot-cards">{mentions.map(m => <li key={m.key} className="bot-card">
    <span className="ci-fire-head">
      {m.provider ? <ProviderModelMark provider={m.provider as ProviderId} model={m.model} size={18} /> : null}
      <span className="ci-fire-title">#{m.prNumber} {m.prTitle}</span>
      <span className="ci-fire-time">{relativeTime(m.at)}</span>
    </span>
    <span className="bot-card-comment">@{m.author}: {mentionAsk(m) || m.excerpt}</span>
    <div className="bot-card-foot">
      {m.commentUrl ? <button type="button" className="bot-card-link" onClick={() => void openExternal(m.commentUrl)}>View on GitHub</button> : null}
      {canLook ? <button type="button" className="bot-card-look" title="Opens Kit in a worktree at the pull request's head"
        onClick={() => lookIntoMention(m)}>Look into it</button> : null}
    </div>
  </li>)}</ol>;
}
