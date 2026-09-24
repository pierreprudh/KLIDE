import { describe, expect, it } from "vitest";
import { githubObserverLabel, githubObserverDetail, githubObserverDuration, type GithubObserver } from "./githubObserver";
const run = { status: "completed", conclusion: "success", prState: "open" } as GithubObserver;
it("uses the elapsed span of parallel checks and hides unavailable durations", () => {
  const job = { name: "test", status: "completed", conclusion: "success", startedAt: "2026-09-24T10:00:00Z", completedAt: "2026-09-24T10:02:43Z" };
  const watch = { ...run, jobs: [job, { ...job, completedAt: "2026-09-24T10:01:00Z" }] };
  expect(githubObserverDuration(watch)).toBe("2m 43s");
  expect(githubObserverDuration({ ...watch, status: "in_progress" })).toBeNull();
  expect(githubObserverDuration({ ...run, jobs: [{ ...job, completedAt: null }] })).toBeNull();
  expect(githubObserverDuration({ ...run, jobs: [] })).toBeNull();
});
describe("GitHub observer outcomes", () => {
  it("never treats a cancelled, skipped, or neutral run as a pass", () => {
    expect(githubObserverLabel({ ...run, conclusion: "cancelled" })).toBe("Checks cancelled");
    expect(githubObserverLabel({ ...run, conclusion: "skipped" })).toBe("Checks skipped");
    expect(githubObserverLabel({ ...run, conclusion: "neutral" })).toBe("Checks neutral");
  });
  it("does not confuse CI success with PR merge or deployment", () => {
    expect(githubObserverLabel(run)).toBe("Checks passed");
    expect(githubObserverLabel({ ...run, prState: "merged", status: "in_progress" })).toBe("Checks running");
    expect(githubObserverLabel({ ...run, conclusion: "timed_out" })).toBe("Checks failed");
  });
});

it("names failed checks instead of displaying a completed count as success", () => {
  expect(githubObserverDetail({ ...run, jobs: [{name: "Rust tests", status: "completed", conclusion: "failure"}] })).toBe("Rust tests");
  expect(githubObserverDetail({ ...run, jobs: [] })).toBe("");
});
