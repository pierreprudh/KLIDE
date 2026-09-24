import { LinkMark } from "../linkMark";
import { useEffect, useState } from "react";
import type { Observer } from "../../agent/observers";
import { githubObserverLabel, githubObserverDetail, readGithubObserver, type GithubObserver } from "../../agent/githubObserver";
import { openGitPr } from "../../gitNavigation";
import { openExternal } from "../../externalLink";
import { notify } from "../../toast";

/** Polls only while mounted. The native observer still owns the completion
 * notification, including when the user navigates away from this conversation. */
export function GithubObserverCard({ observer, runId, onStop }: { observer: Observer; runId: string; onStop: () => void }) {
  const [watch, setWatch] = useState<GithubObserver | null>(null);
  const [stale, setStale] = useState(false);
  const running = observer.status.state === "running";
  const stopped = observer.status.state === "signalled";
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let retries = 0;
    async function refresh() {
      try {
        const next = await readGithubObserver(runId, observer.id);
        if (!alive) return;
        setWatch(next); setStale(false);
        if (!stopped && (running || next.status !== "completed") && (running || retries++ < 3)) timer = setTimeout(refresh, 8000);
      } catch {
        if (!alive) return;
        setStale(true);
        if (!stopped && (running || retries++ < 3)) timer = setTimeout(refresh, 15000);
      }
    }
    if (!stopped) void refresh();
    return () => { alive = false; clearTimeout(timer); };
  }, [runId, observer.id, running, stopped]);
  const label = stopped ? "Watching stopped" : stale ? "Status unavailable" : watch ? githubObserverLabel(watch) : "Checking GitHub…";
  const openOnline = () => {
    if (watch) void openExternal(watch.prUrl || watch.url).catch(error => notify(String(error), { tone: "error" }));
  };
  return <section className="github-observer" aria-label="GitHub Actions observer">
    <LinkMark site="github" size={36} />
    <div style={{ minWidth: 0 }}>
      <div className="github-observer-line" role="status" aria-live="polite">
        <span>{watch?.prNumber ? `PR #${watch.prNumber}` : `Run #${observer.githubWatch?.runId}`}</span>
        <span style={{ color: label === "Checks failed" ? "var(--danger)" : "var(--fg-subtle)" }}>{label}</span>
        {watch && !stale && !stopped && <span className="github-observer-meta">{githubObserverDetail(watch)}{watch.prState === "merged" ? " · PR merged" : watch.prState === "closed" ? " · PR closed" : watch.prHeadSha && watch.prHeadSha !== watch.headSha ? " · Earlier commit" : ""}</span>}
      </div>
      <div className="github-observer-actions">
        {watch?.prNumber && watch.localRepo === watch.repo && <button className="github-observer-action" onClick={() => openGitPr(watch.cwd, watch.prNumber!)}>Open in Git panel ↗</button>}
        {watch && <button className="github-observer-action" onClick={openOnline}>View online ↗</button>}
        {running && <button onClick={onStop} className="github-observer-action">Stop</button>}
      </div>
    </div>
  </section>;
}
