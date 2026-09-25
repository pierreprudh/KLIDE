import { invoke } from "@tauri-apps/api/core";
export type GithubObserver = {
  runId: number; attempt: number; url: string; status: string; conclusion: string | null;
  headSha: string; repo: string; cwd: string; localRepo: string | null;
  prHeadSha: string | null; prNumber: number | null; prUrl: string | null; prState: string | null;
  jobs: { name: string; status: string; conclusion: string | null; startedAt?: string | null; completedAt?: string | null }[];
};
export const readGithubObserver = (runId: string, shellId: string): Promise<GithubObserver> => invoke("agent_observer_github", { runId, shellId });
export function githubObserverNeedsRefresh(watch: GithubObserver): boolean {
  return watch.status !== "completed" || (watch.prNumber !== null && watch.prState !== "merged" && watch.prState !== "closed");
}
/** Wall-clock span of this attempt's jobs; parallel jobs are not summed. */
export function githubObserverDuration(watch: GithubObserver): string | null {
  if (watch.status !== "completed" || !watch.jobs.length) return null;
  const jobs = watch.jobs.filter(job => job.conclusion !== "skipped");
  if (!jobs.length) return null;
  const starts = jobs.map(job => Date.parse(job.startedAt ?? ""));
  const ends = jobs.map(job => Date.parse(job.completedAt ?? ""));
  if (starts.some((start, i) => !Number.isFinite(start) || !Number.isFinite(ends[i]) || ends[i] < start)) return null;
  const seconds = Math.floor((Math.max(...ends) - Math.min(...starts)) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
export function githubObserverLabel(watch: GithubObserver): string {
  if (watch.status !== "completed") return "Checks running";
  switch (watch.conclusion) {
    case "success": return "Checks passed";
    case "cancelled": return "Checks cancelled";
    case "skipped": return "Checks skipped";
    case "neutral": return "Checks neutral";
    case "failure": case "timed_out": case "startup_failure": return "Checks failed";
    case "action_required": return "Action required";
    default: return "Checks finished";
  }
}

export function githubObserverDetail(watch: GithubObserver): string {
  const failed = watch.jobs.filter(job => ["failure", "timed_out", "action_required", "startup_failure"].includes(job.conclusion ?? ""));
  if (failed.length) return failed.length === 1 ? failed[0].name : `${failed.length} failed checks`;
  if (!watch.jobs.length) return "";
  const complete = watch.jobs.filter(job => job.status === "completed").length;
  return `${complete}/${watch.jobs.length}`;
}
