import { afterEach, expect, it, vi } from "vitest";
import { clearObserverCards, mergeObserverCards, readObserverCards, saveObserverCard } from "./observerCards";
import type { Observer } from "./observers";
import type { GithubObserver } from "./githubObserver";

afterEach(() => vi.unstubAllGlobals());
it("restores cards and their status without restoring a running process", () => {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  });
  const observer: Observer = { id: "shell-1", command: "gh run watch 120", githubWatch: { runId: 120, repo: null }, status: { state: "running" }, startedMs: 1, endedMs: null, notifyOnExit: true };
  const watch = { status: "completed", conclusion: "success" } as GithubObserver;
  saveObserverCard("conversation", observer, watch);
  expect(mergeObserverCards("conversation", [observer])).toEqual([observer]);
  expect(mergeObserverCards("conversation", [])).toEqual([{ ...observer, restored: true }]);
  expect(readObserverCards("conversation")[0].watch).toEqual(watch);
  expect(mergeObserverCards("other", [])).toEqual([]);
  clearObserverCards("conversation");
  expect(mergeObserverCards("conversation", [])).toEqual([]);
});
