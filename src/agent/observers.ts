import { invoke } from "@tauri-apps/api/core";
import { clearObserverCards } from "./observerCards";

export type Observer = {
  restored?: boolean;
  id: string;
  command: string;
  cwd?: string;
  githubWatch?: { runId: number; repo: string | null } | null;
  status: { state: "running" } | { state: "exited"; code: number } | { state: "signalled" };
  startedMs: number;
  endedMs: number | null;
  notifyOnExit: boolean;
};

export function observerLabel(observer: Observer): string {
  if (observer.status.state === "running") return "Watching in background";
  if (observer.status.state === "signalled") return "Observer stopped";
  return observer.status.code === 0 ? "Command finished" : `Command failed (exit ${observer.status.code})`;
}

export const listObservers = (runId: string): Promise<Observer[]> => invoke("agent_list_observers", { runId });
/** A deleted conversation stops the observers that outlived its last reply. */
export const releaseConversation = (runId: string): Promise<void> => {
  clearObserverCards(runId);
  return invoke("agent_release_conversation", { runId });
};
export const stopObserver = (runId: string, shellId: string): Promise<void> => invoke("agent_stop_observer", { runId, shellId });
