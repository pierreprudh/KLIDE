import { describe, expect, it } from "vitest";
import { githubObserverLabel, githubObserverDetail, type GithubObserver } from "./githubObserver";
const run = { status: "completed", conclusion: "success", prState: "open" } as GithubObserver;
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
