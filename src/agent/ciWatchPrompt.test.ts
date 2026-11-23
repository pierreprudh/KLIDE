import { expect, it } from "vitest";
import raw from "./ci_watch_prompt.fixture.txt?raw";
import { parseCiWatchPrompt } from "./ciWatchPrompt";

// The same sample `ci_watch.rs` asserts its prompt equals.
const fixture = raw.replace(/\n$/, "");

it("reads the CI watch's prompt back as facts", () => {
  expect(parseCiWatchPrompt(fixture)).toEqual({
    number: 597,
    title: "feat(klide-bot): answers in PR comments",
    url: "https://github.com/o/r/pull/597",
    sha: "24443c9",
    checks: [
      { name: "Rust tests", url: "https://github.com/o/r/actions/runs/1/job/2" },
      { name: "Frontend", url: "https://github.com/o/r/actions/runs/1/job/3" },
    ],
    log: "test x ... FAILED\n##[error]exit 101",
  });
});

it("treats the no-log placeholder as no log", () => {
  const text = fixture.replace("test x ... FAILED\n##[error]exit 101", "(no Actions log was available — use the check links above)");
  expect(parseCiWatchPrompt(text)?.log).toBe("");
});

it("leaves a person's own message about CI a message", () => {
  expect(parseCiWatchPrompt("CI failed on my pull request #12, can you look?")).toBeNull();
  expect(parseCiWatchPrompt(fixture.replace(/<\/?ci-log-1a2b>/g, ""))).toBeNull();
});
