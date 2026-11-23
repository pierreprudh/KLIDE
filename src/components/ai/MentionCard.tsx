import type { MentionTurn } from "../../agent/klideBotLook";
import { openExternal } from "../../externalLink";
import { notify } from "../../toast";
import { LinkMark } from "../linkMark";
import { openGitPr } from "../../gitNavigation";
import "./ciFailureCard.css";

/** The opening message of a klide-bot "Look into it", drawn as what it is: a
 *  question on one of your PRs. The CI failure card's family — the GitHub
 *  mark beside the PR, the asker beside the question. The instructions the
 *  model read are not shown: the card is the request. */
export function MentionCard({ turn, workspaceRoot }: { turn: MentionTurn; workspaceRoot?: string | null }) {
  const go = (url: string) => void openExternal(url).catch(error => notify(String(error), { tone: "error" }));
  return (
    <section className="ci-card" aria-label={`@${turn.author} asked about pull request #${turn.number}`}>
      <span className="ci-card-mark" aria-hidden="true"><LinkMark site="github" size={26} /></span>
      <div className="ci-card-head">
        <button type="button" className="ci-card-pr" onClick={() => go(turn.url)} title="Open the pull request">
          PR #{turn.number}<span className="ci-card-arrow" aria-hidden="true">↗</span>
        </button>
        <span className="ci-card-title">{turn.title}</span>
      </div>
      <span className="ci-card-asker" aria-hidden="true">@</span>
      <div className="ci-card-status">
        <span className="ci-card-ask"><span className="ci-card-author">{turn.author}</span> {turn.ask}</span>
      </div>
      <div className="ci-card-actions">
        {workspaceRoot && (
          <button type="button" className="ci-card-action" onClick={() => openGitPr(workspaceRoot, turn.number)} title="Open this pull request in the Git panel">
            Open in Git panel<span className="ci-card-arrow" aria-hidden="true">↗</span>
          </button>
        )}
        <button type="button" className="ci-card-action" onClick={() => go(turn.url)} title="Open the pull request on GitHub">
          Open in GitHub<span className="ci-card-arrow" aria-hidden="true">↗</span>
        </button>
      </div>
    </section>
  );
}
