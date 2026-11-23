import { useEffect, useState } from "react";
import type { CiWatchPrompt } from "../../agent/ciWatchPrompt";
import { openExternal } from "../../externalLink";
import { ciWatchGet, type CiWatchFired } from "../../ipc/ciWatch";
import { canStartCiFix, startCiFix } from "../../ciFixNavigation";
import { notify } from "../../toast";
import { ChevronIcon } from "../../icons";
import { LinkMark } from "../linkMark";
import "./ciFailureCard.css";

/** The message a CI watch firing opened its Run with, drawn as what it is:
 *  a failed check on one of your PRs. Same family as the GitHub observer
 *  card — the GitHub mark beside the PR, a failed indicator beside the
 *  checks — with the log one click away instead of filling the thread. The
 *  instruction sentence the Run read is not shown: the card is the request. */
export function CiFailureCard({ ci, workspaceRoot, runId, onFix }: { ci: CiWatchPrompt; workspaceRoot?: string | null; runId?: string | null; onFix?: () => void }) {
  const [open, setOpen] = useState(false);
  const fired = useFiring(workspaceRoot, runId);
  const fix = onFix ?? (fired && canStartCiFix() ? () => startCiFix(fired) : undefined);
  const go = (url: string) => void openExternal(url).catch(error => notify(String(error), { tone: "error" }));
  const names = ci.checks.map(c => c.name);
  const failed = names.length === 0 ? "Checks failed" : `${names.join(", ")} failed`;
  return (
    <section className="ci-card" aria-label={`CI failed on pull request #${ci.number}`}>
      <span className="ci-card-mark" aria-hidden="true"><LinkMark site="github" size={26} /></span>
      <div className="ci-card-head">
        <button type="button" className="ci-card-pr" onClick={() => go(ci.url)} title="Open the pull request">
          PR #{ci.number}<span className="ci-card-arrow" aria-hidden="true">↗</span>
        </button>
        <span className="ci-card-title">{ci.title}</span>
      </div>
      <span className="ci-card-indicator" aria-hidden="true">!</span>
      <div className="ci-card-status">
        <span className="ci-card-failed">{failed}</span>
        <span className="ci-card-sha" title="The commit the checks ran on">{ci.sha}</span>
      </div>
      <div className="ci-card-actions">
        {ci.checks.map(c => (
          <button key={c.url} type="button" className="ci-card-action" onClick={() => go(c.url)} title={`Open the ${c.name} job`}>
            {ci.checks.length > 1 ? c.name : "Open job"}<span className="ci-card-arrow" aria-hidden="true">↗</span>
          </button>
        ))}
        {ci.log && (
          <button type="button" className="ci-card-action" aria-expanded={open} onClick={() => setOpen(o => !o)}>
            {open ? "Hide log" : "Show log"}<ChevronIcon open={open} size={12} />
          </button>
        )}
        {fix && <button type="button" className="ci-card-action ci-card-fix" onClick={fix} title="Fix it in a worktree at the failing commit — every edit is reviewed">Fix it</button>}
      </div>
      {/* Opens at the bottom: the excerpt ends at the last `##[error]`, which is the failure. */}
      {open && ci.log && <pre className="ci-card-log" ref={el => { if (el) el.scrollTop = el.scrollHeight; }}>{ci.log}</pre>}
    </section>
  );
}

/** The watch firing that started this Run — what "Fix it" needs. Absent when
 *  the watch was turned off since (its firings went with it). */
function useFiring(workspaceRoot?: string | null, runId?: string | null): CiWatchFired | null {
  const [fired, setFired] = useState<CiWatchFired | null>(null);
  useEffect(() => {
    if (!workspaceRoot || !runId) return;
    let alive = true;
    ciWatchGet(workspaceRoot)
      .then(info => { if (alive) setFired(info.fired.find(f => f.runId === runId) ?? null); })
      .catch(() => {});
    return () => { alive = false; };
  }, [workspaceRoot, runId]);
  return fired;
}
