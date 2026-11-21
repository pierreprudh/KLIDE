// Mission Control › Scheduled — Watch CI, drawn in the Scheduled page's own
// three panes: a row in the list, its settings in the detail pane, its
// firings under Run history. The trigger itself is agent/ci_watch.rs: when a
// check fails on one of your open PRs in this project, the scheduled service
// starts a read-only Run, on the agent picked here, that reads the failed log
// and proposes a fix. Nothing is edited until you open the Run.

import { useEffect, useState } from "react";
import { ciWatchGet, ciWatchSet, type CiWatchFired, type CiWatchInfo } from "../../ipc/ciWatch";
import type { ProviderId } from "../../agent/types";
import type { HarnessSettings } from "../../settingsStore";
import { relativeTime } from "../../time";
import { TriggerDetail, TriggerListRow, triggerStatus, useTrigger, type Trigger } from "./trigger";
import { ErrorIcon } from "../../icons";
import { ProviderModelMark } from "../../modelIdentity";
import { readAgentRunEvents } from "../../agent/client";
import { ciDiagnosis, ciVerdict } from "../../agent/ciFix";
import { canStartCiFix, startCiFix } from "../../ciFixNavigation";

/** The list selection that means "Watch CI", never a schedule id. */
export const CI_WATCH_ID = "__ci-watch__";
export const CI_WATCH_TITLE = "Watch CI on my pull requests";

const CI_API = { get: ciWatchGet, set: ciWatchSet, event: "ci-watch:pending" };

export type CiWatch = Trigger<CiWatchInfo>;

export function useCiWatch(workspaceRoot: string | null, defaultProvider: ProviderId, defaultModel: string, settings: HarnessSettings): CiWatch {
  return useTrigger(CI_API, workspaceRoot, defaultProvider, defaultModel, settings);
}

export function CiWatchListRow({ watch, project, current, onSelect }: { watch: CiWatch; project: string; current: boolean; onSelect: () => void }) {
  return <TriggerListRow trigger={watch} name="Watch CI" status={triggerStatus(watch)} current={current} onSelect={onSelect}
    meta={<>My pull requests<span aria-hidden="true"> · </span>{project}</>} />;
}

export function CiWatchDetail({ watch, project }: { watch: CiWatch; project: string | null }) {
  return <TriggerDetail trigger={watch} project={project} title={CI_WATCH_TITLE} status={triggerStatus(watch)} emptyHint="Open a project to watch its pull requests.">
    <p className="scheduled-instructions">When a check fails on one of your open pull requests in {project}, this agent reads the failed log and proposes the smallest fix. It runs read-only. Fix it then works in a fresh worktree at the failing commit, and you review every edit before it lands. Each failing commit starts one Run, and failures from before you turned this on are skipped.</p>
  </TriggerDetail>;
}

/** Kit's verdict for each firing, read from its Run once it has settled. */
function useVerdicts(fired: CiWatchFired[]): Map<string, string | null> {
  const [verdicts, setVerdicts] = useState(() => new Map<string, string | null>());
  const ids = fired.map(f => f.runId).filter((id): id is string => !!id).join(",");
  useEffect(() => {
    let live = true;
    for (const id of ids ? ids.split(",") : []) {
      if (verdicts.get(id)) continue;
      void readAgentRunEvents(id).then(events => {
        // Still working: no verdict yet, and the row says so.
        const settled = events.some(e => e.type === "run_result" || e.type === "run_error");
        const verdict = settled ? ciVerdict(ciDiagnosis(events)) : null;
        if (live) setVerdicts(prev => new Map(prev).set(id, verdict));
      }).catch(() => {});
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
  return verdicts;
}

export function CiWatchHistory({ watch, onOpenRun }: { watch: CiWatch; onOpenRun: (id: string) => void }) {
  const fired = watch.info?.fired ?? [];
  const verdicts = useVerdicts(fired);
  if (!fired.length) return <p className="scheduled-pane-empty">{watch.on ? "No failing checks yet." : "Turn on to watch your pull requests."}</p>;
  return <ol className="ci-fires">{fired.map(f => {
    const verdict = f.runId ? verdicts.get(f.runId) : undefined;
    return <li key={f.key}>
      <button type="button" className="ci-fire" disabled={!f.runId} aria-label={`Open Run · #${f.prNumber} ${f.prTitle}`}
        onClick={() => f.runId && onOpenRun(f.runId)}>
        <span className="ci-fire-head">
          {f.provider ? <ProviderModelMark provider={f.provider as ProviderId} model={f.model} size={18} /> : null}
          <span className="ci-fire-title">#{f.prNumber} {f.prTitle}</span>
          <span className="ci-fire-time" data-failed={f.error ? true : undefined}>{f.error ? "Not started" : relativeTime(f.at)}</span>
        </span>
        <span className="ci-fire-checks">{f.checks.map(c => <span key={c}><ErrorIcon size={12} />{c}</span>)}</span>
        {f.error
          ? <span className="ci-fire-verdict">{f.error}</span>
          : <span className="ci-fire-verdict" data-pending={verdict === null ? true : undefined}>{verdict === null ? "Kit is looking into it…" : verdict ?? ""}</span>}
      </button>
      {f.runId && canStartCiFix() && <button type="button" className="ci-watch-fix" title="Fix it in a worktree at the failing commit — every edit is reviewed" onClick={() => startCiFix(f)}>Fix it</button>}
    </li>;
  })}</ol>;
}
