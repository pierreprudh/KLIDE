import { LinkMark } from "../linkMark";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Observer } from "../../agent/observers";
import { githubObserverLabel, githubObserverDetail, readGithubObserver, type GithubObserver } from "../../agent/githubObserver";
import { openGitPr } from "../../gitNavigation";
import { openExternal } from "../../externalLink";
import { notify } from "../../toast";

/** Polls only while mounted. The native observer still owns the completion
 * notification, including when the user navigates away from this conversation. */
export type ObserverSidebar = { target: HTMLElement | null; folded: boolean; onUnfold: () => void };

export function GithubObserverCard({ observer, runId, onStop, sidebar }: { observer: Observer; runId: string; onStop: () => void; sidebar?: ObserverSidebar }) {
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
  const prLabel = watch?.prNumber ? `PR #${watch.prNumber}` : `Run #${observer.githubWatch?.runId}`;
  const detail = watch && !stale && !stopped ? githubObserverDetail(watch) : "";
  const state = watch?.prState === "merged" ? "PR merged" : watch?.prState === "closed" ? "PR closed" : watch?.prHeadSha && watch.prHeadSha !== watch.headSha ? "Earlier commit" : "";
  const tone = label === "Checks failed" ? "failed" : label === "Checks passed" || state === "PR merged" ? "passed" : "neutral";
  const openOnline = () => {
    if (watch) void openExternal(watch.prUrl || watch.url).catch(error => notify(String(error), { tone: "error" }));
  };
  const card = (inSidebar: boolean) => <section className={`github-observer github-observer-${tone}${inSidebar ? " github-observer-sidebar" : ""}`} aria-label={inSidebar ? "GitHub Actions in side panel" : "GitHub Actions observer"}>
    <LinkMark site="github" size={36} />
    <span className="github-observer-pr">{prLabel}</span>
    <div className="github-observer-content">
      <div className="github-observer-line" role="status" aria-live="polite">
        <span className="github-observer-status">{label}</span>
        <span className="github-observer-detail">{detail}</span>
        <span className="github-observer-state">{state}</span>
      </div>
      <div className="github-observer-actions">
        {watch?.prNumber && watch.localRepo === watch.repo && <button className="github-observer-action" onClick={() => openGitPr(watch.cwd, watch.prNumber!)}>Open in Git panel ↗</button>}
        {watch && <button className="github-observer-action github-observer-online" onClick={openOnline}>View online ↗</button>}
        {running && <button onClick={onStop} className="github-observer-action github-observer-stop">Stop</button>}
      </div>
    </div>
  </section>;
  return <>
    {card(false)}
    {sidebar?.target && createPortal(sidebar.folded
      ? <button type="button" className="github-observer-mark" onClick={sidebar.onUnfold}
          aria-label={`Show GitHub watcher — ${label}`} title={label}><LinkMark site="github" size={22} /></button>
      : card(true), sidebar.target)}
  </>;
}
