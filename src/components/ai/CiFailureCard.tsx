import { useEffect, useState } from "react";
import type { CiWatchPrompt } from "../../agent/ciWatchPrompt";
import { openExternal } from "../../externalLink";
import { ciFailureStands, ciWatchGet, type CiWatchFired, type CiWatchNow } from "../../ipc/ciWatch";
import { listen } from "@tauri-apps/api/event";
import { DotGridLoader } from "./icons";
import { canStartCiFix, startCiFix } from "../../ciFixNavigation";
import { notify } from "../../toast";
import { ChevronIcon } from "../../icons";
import { LinkMark } from "../linkMark";
import { openGitPr } from "../../gitNavigation";
import "./ciFailureCard.css";

/** The message a CI watch firing opened its Run with, drawn as what it is:
 *  a failed check on one of your PRs. Same family as the GitHub observer
 *  card — the GitHub mark beside the PR, a failed indicator beside the
 *  checks — with the log one click away instead of filling the thread. The
 *  instruction sentence the Run read is not shown: the card is the request.
 *  The watch keeps following the commit, so a re-run that passes turns the
 *  card green and puts "Fix it" away. */
export function CiFailureCard({ ci, workspaceRoot, runId, onFix }: { ci: CiWatchPrompt; workspaceRoot?: string | null; runId?: string | null; onFix?: () => void }) {
  const [open, setOpen] = useState(false);
  const fired = useFiring(workspaceRoot, runId);
  const now = fired?.now ?? null;
  const fix = onFix ?? (fired && canStartCiFix() && ciFailureStands(now) ? () => startCiFix(fired) : undefined);
  const go = (url: string) => void openExternal(url).catch(error => notify(String(error), { tone: "error" }));
  const names = ci.checks.map(c => c.name);
  // One failed check: its job is the page worth opening. Several: the PR lists them.
  const online = ci.checks.length === 1 ? ci.checks[0].url : ci.url;
  const status = statusLine(names.length === 0 ? "Checks" : names.join(", "), now);
  return (
    <section className={`ci-card ci-card-${status.tone}`} aria-label={`CI failed on pull request #${ci.number}`}>
      <span className="ci-card-mark" aria-hidden="true"><LinkMark site="github" size={26} /></span>
      <div className="ci-card-head">
        <button type="button" className="ci-card-pr" onClick={() => go(ci.url)} title="Open the pull request">
          PR #{ci.number}<span className="ci-card-arrow" aria-hidden="true">↗</span>
        </button>
        <span className="ci-card-title">{ci.title}</span>
      </div>
      {now === "running"
        ? <span className="ci-card-indicator-slot"><DotGridLoader size={16} label="Checks running" /></span>
        : <span className="ci-card-indicator" aria-hidden="true">{status.tone === "passed" ? "✓" : status.tone === "failed" ? "!" : ""}</span>}
      <div className="ci-card-status" role="status" aria-live="polite">
        <span className="ci-card-failed">{status.text}</span>
        <span className="ci-card-sha" title="The commit the checks ran on">{ci.sha}</span>
      </div>
      <div className="ci-card-actions">
        {workspaceRoot && (
          <button type="button" className="ci-card-action" onClick={() => openGitPr(workspaceRoot, ci.number)} title="Open this pull request in the Git panel">
            Open in Git panel<span className="ci-card-arrow" aria-hidden="true">↗</span>
          </button>
        )}
        <button type="button" className="ci-card-action" onClick={() => go(online)} title={online === ci.url ? "Open the pull request on GitHub" : `Open the failed ${ci.checks[0].name} job on GitHub`}>
          Open in GitHub<span className="ci-card-arrow" aria-hidden="true">↗</span>
        </button>
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

type Tone = "failed" | "passed" | "neutral";

/** The card's one status line — the failure as fired, or what became of it. */
export function statusLine(checks: string, now: CiWatchNow | null): { text: string; tone: Tone } {
  switch (now) {
    case "running": return { text: `${checks} running again…`, tone: "neutral" };
    case "passed": return { text: `${checks} passed`, tone: "passed" };
    case "failing": return { text: `${checks} failed again`, tone: "failed" };
    case "moved": return { text: "Newer commit pushed", tone: "neutral" };
    case "closed": return { text: "PR closed", tone: "neutral" };
    default: return { text: `${checks} failed`, tone: "failed" };
  }
}

/** The watch firing that started this Run — what "Fix it" needs. Absent when
 *  the watch was turned off since (its firings went with it). */
function useFiring(workspaceRoot?: string | null, runId?: string | null): CiWatchFired | null {
  const [fired, setFired] = useState<CiWatchFired | null>(null);
  useEffect(() => {
    if (!workspaceRoot || !runId) return;
    let alive = true;
    const load = () => ciWatchGet(workspaceRoot)
      .then(info => { if (alive) setFired(info.fired.find(f => f.runId === runId) ?? null); })
      .catch(() => {});
    void load();
    // The app emits this when the watch's poll changes a firing (ci_watch.rs).
    const off = listen("ci-watch:fired", () => void load());
    return () => { alive = false; void off.then(f => f()).catch(() => {}); };
  }, [workspaceRoot, runId]);
  return fired;
}
