import { describe, expect, it } from "vitest";
import type { Msg } from "./types";
import { groupToolRuns, pairToolResults, toolRunLabel, turnsAfterQuestions, questionVerdicts, dropVerdictMark, gradeAnswer, withoutAnswerKey, PLAN_MISSION_TOOL, USER_QUESTION_TOOL } from "./toolRuns";

const call = (name: string): Msg => ({
  role: "assistant",
  content: "",
  toolCalls: [{ name, args: {} }],
});
const reasoningCall = (name: string, content: string, thinking?: string): Msg => ({
  role: "assistant",
  content,
  thinking,
  toolCalls: [{ name, args: {} }],
});
const result = (name: string): Msg => ({
  role: "tool",
  content: "ok",
  toolName: name,
});
const says = (content: string): Msg => ({ role: "assistant", content });
const asks = (content: string): Msg => ({ role: "user", content });

/** A delegate writes one message per call, so a stretch of work arrives as a
 *  column of them. This is the shape the screenshot showed. */
function burst(name: string, n: number): Msg[] {
  return Array.from({ length: n }, () => [call(name), result(name)]).flat();
}

describe("groupToolRuns", () => {
  it("keeps a compaction mid-run inside the run, as one more step", () => {
    // Dogfood 2026-10-21: each mid-run compaction split the work into its own
    // "Worked for" line — three folds for one run.
    const marker: Msg = { role: "system", content: "Compacted", compaction: { count: 6, summary: "notes", source: "agent" } };
    const msgs: Msg[] = [asks("read them"), call("read_file"), result("read_file"), marker, call("read_file"), result("read_file"), says("done")];
    const runs = groupToolRuns(msgs);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ start: 1, end: 6, calls: 2 });
    // A Compact between turns — no answer follows it — keeps its own line.
    const between: Msg[] = [says("done"), marker, asks("again"), call("read_file"), result("read_file"), says("done")];
    expect(groupToolRuns(between)).toMatchObject([{ start: 3, end: 5 }]);
  });

  it("folds a compaction that opened the response with the answer's thought", () => {
    const marker: Msg = { role: "system", content: "Compacted", compaction: { count: 15, summary: "notes", source: "agent" } };
    const answer: Msg = { role: "assistant", content: "Your first message asked…", thinking: "Look in the notes.", thinkingMs: 9000 };
    const runs = groupToolRuns([asks("what was my first message?"), marker, answer]);
    expect(runs).toMatchObject([{ start: 1, end: 2, calls: 0, answer: 2, thinkingMs: 9000 }]);
    expect(toolRunLabel(runs[0]).label).toBe("Thought for 9.0s");
  });

  it("folds each stretch of tool work into its own run", () => {
    const msgs = [
      asks("fix and commit"),
      ...burst("Bash", 9),
      says("Now a regression test that reproduces exactly what your screenshot showed."),
      ...burst("Bash", 5),
    ];

    const runs = groupToolRuns(msgs);

    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ start: 1, end: 19, calls: 9, names: ["Bash"] });
    expect(runs[1]).toMatchObject({ start: 20, end: 30, calls: 5 });
  });

  it("ends a run at a sentence, because that sentence is the agent explaining itself", () => {
    const msgs = [...burst("Bash", 3), says("Found it."), ...burst("Bash", 3)];

    expect(groupToolRuns(msgs).map((r) => r.calls)).toEqual([3, 3]);
  });

  it("folds a turn that speaks and calls — its sentence is narration on the way, not the answer", () => {
    const speaking: Msg = { role: "assistant", content: "Reading it now.", toolCalls: [{ name: "Read", args: {} }] };

    expect(groupToolRuns([speaking, result("Read"), says("It reads the config.")])).toMatchObject([{ start: 0, end: 2, calls: 1 }]);
  });

  it("folds the answer's own reasoning in, and counts its span", () => {
    const answer: Msg = { role: "assistant", content: "Done.", thinking: "Everything checks out.", thinkingMs: 1100 };
    const thought: Msg = { role: "assistant", content: "", thinking: "next", thinkingMs: 700, toolCalls: [{ name: "Bash", args: {} }] };

    const [run] = groupToolRuns([asks("go"), thought, result("Bash"), answer]);

    expect(run).toMatchObject({ start: 1, end: 3, answer: 3, thinkingMs: 1800 });
  });

  it("leaves a lone thought before an answer alone — nothing was called", () => {
    const thought: Msg = { role: "assistant", content: "", thinking: "hmm", thinkingMs: 700 };
    expect(groupToolRuns([asks("go"), thought, says("Here.")])).toEqual([]);
  });

  it("keeps a turn that has said nothing yet inside the run, so the fold stays open while it streams", () => {
    const placeholder: Msg = { role: "assistant", content: "" };
    const [run] = groupToolRuns([asks("go"), ...burst("Bash", 2), placeholder]);
    expect(run).toMatchObject({ start: 1, end: 6, calls: 2 });
  });

  it("folds every reasoning-only encoding without treating it as prose", () => {
    const msgs = [
      reasoningCall("Read", "", "Inspect the workspace."),
      result("Read"),
      reasoningCall("Grep", "<think>Find the relevant symbol.</think>"),
      result("Grep"),
      reasoningCall("Bash", JSON.stringify({
        analysis: "Verify the change.",
        plan: "Run the focused tests.",
        commands: [{ tool_name: "Bash", arguments: { command: "npm test" } }],
      })),
      result("Bash"),
    ];

    expect(groupToolRuns(msgs)).toEqual([
      { start: 0, end: 6, calls: 3, names: ["Read", "Grep", "Bash"] },
    ]);
  });

  it("keeps a turn with inline thinking and narration inside the run — it still made a call", () => {
    const speaking = reasoningCall(
      "Read",
      "<think>Choose the next file.</think>Reading the implementation now.",
    );
    const msgs = [...burst("Bash", 3), speaking, result("Read"), ...burst("Grep", 3)];

    expect(groupToolRuns(msgs).map((run) => run.calls)).toEqual([7]);
  });

  it("keeps the distinct tool names, in the order they appear", () => {
    const msgs = [call("Bash"), result("Bash"), call("Read"), result("Read"), call("Bash"), result("Bash"), call("Grep"), result("Grep")];

    expect(groupToolRuns(msgs)[0].names).toEqual(["Bash", "Read", "Grep"]);
  });

  it("ends a run at a call that draws a card — the plan is the agent speaking", () => {
    // Four reads, then plan_mission: the card the planner's receipt draws must
    // not sit inside "5 tool calls" with the reads it followed.
    const msgs = [asks("plan it"), ...burst("read_file", 4), call(PLAN_MISSION_TOOL), result(PLAN_MISSION_TOOL)];
    const runs = groupToolRuns(msgs, pairToolResults(msgs));

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ start: 1, end: 9, calls: 4 });
  });

  it("ends a run at a question — asking the operator is not machinery", () => {
    // Three reads, then the question and its answer, then more reads: the
    // exchange stays in the conversation as a card, never inside "4 tool
    // calls" with the work around it.
    const msgs = [asks("go"), ...burst("read_file", 3), call(USER_QUESTION_TOOL), result(USER_QUESTION_TOOL), ...burst("read_file", 3)];
    const runs = groupToolRuns(msgs, pairToolResults(msgs));

    expect(runs.map((r) => [r.start, r.end])).toEqual([[1, 7], [9, 15]]);
  });

  it("keeps a delegation out of a run, so the watched row stays in view", () => {
    const msgs = [asks("go"), ...burst("Bash", 3), call("spawn_subagent"), result("spawn_subagent"), ...burst("Bash", 3)];
    const runs = groupToolRuns(msgs, pairToolResults(msgs));

    expect(runs.map((r) => [r.start, r.end])).toEqual([[1, 7], [9, 15]]);
  });

  it("folds however little work there was — one call on the way is still on the way", () => {
    expect(groupToolRuns(burst("Bash", 1))).toHaveLength(1);
    expect(groupToolRuns(burst("Bash", 3))).toHaveLength(1);
  });

  it("counts results as a run when their calls are no longer in view", () => {
    // Compaction can take the assistant turns and leave the results behind.
    const runs = groupToolRuns([result("Bash"), result("Bash"), result("Bash")]);

    expect(runs[0].calls).toBe(3);
  });

  it("sums the reasoning between the calls, so the row can say how long it thought", () => {
    const thought = (ms: number): Msg => ({ role: "assistant", content: "", thinking: "next", thinkingMs: ms, toolCalls: [{ name: "Bash", args: {} }] });
    const runs = groupToolRuns([asks("go"), thought(700), result("Bash"), thought(1400), result("Bash"), call("Bash"), result("Bash")]);

    expect(runs).toHaveLength(1);
    expect(runs[0].thinkingMs).toBe(2100);
  });

  it("leaves the span unknown when no turn measured one", () => {
    const [run] = groupToolRuns([asks("go"), ...burst("Bash", 3)]);
    expect(run.thinkingMs).toBeUndefined();
    expect(run.workedMs).toBeUndefined();
  });

  it("sums the wall time of the turns, for runs whose reasoning was never timed", () => {
    const landed = (ms: number): Msg => ({ role: "assistant", content: "", thinking: "whole", meta: { ms }, toolCalls: [{ name: "Bash", args: {} }] });
    const [run] = groupToolRuns([asks("go"), landed(20_000), result("Bash"), landed(21_000), result("Bash"), call("Bash"), result("Bash")]);

    expect(run.workedMs).toBe(41_000);
    expect(run.thinkingMs).toBeUndefined();
  });

  it("takes a delegate's span from the answer that closes its one measured turn", () => {
    const observed: Msg = { role: "tool", content: "ok", toolName: "read_file", observedBy: "hermes" };
    const answer: Msg = { role: "assistant", content: "Done.", meta: { ms: 30_100 } };
    const [run] = groupToolRuns([asks("go"), call("read_file"), observed, call("search_files"), observed, answer]);

    expect(run.workedMs).toBe(30_100);
    expect(toolRunLabel(run).label).toBe("Hermes worked for 30.1s");
    // Klide's own turns measure themselves; the answer's span is not theirs.
    const [own] = groupToolRuns([asks("go"), ...burst("Bash", 2), answer]);
    expect(own.workedMs).toBeUndefined();
  });
});

describe("toolRunLabel", () => {
  it("counts the calls, and names every distinct tool for the hover", () => {
    expect(toolRunLabel({ calls: 9, names: ["Bash", "Read", "Grep", "Edit"] })).toEqual({
      label: "9 tool calls",
      count: "9 tool calls",
      names: "Bash, Read, Grep, Edit",
    });
  });

  it("says one call in the singular", () => {
    expect(toolRunLabel({ calls: 1, names: ["Bash"] }).count).toBe("1 tool call");
  });

  it("leads with the time the work took, in a turn header's words", () => {
    expect(toolRunLabel({ calls: 35, names: [], workedMs: 41_000 }).label).toBe("Worked for 41.0s");
    // Tools ran, so the wall time is the honest span — the reasoning alone
    // would understate it.
    expect(toolRunLabel({ calls: 35, names: [], thinkingMs: 6300, workedMs: 41_000 }).label).toBe("Worked for 41.0s");
  });

  it("names the Delegate whose work it was", () => {
    expect(toolRunLabel({ calls: 2, names: [], thinkingMs: 6300, observedBy: "claude-code" }).label).toBe("Claude Code thought for 6.3s");
    expect(toolRunLabel({ calls: 2, names: [], observedBy: "hermes" }).label).toBe("2 tool calls");
  });

  it("falls back to the reasoning span, then to the count", () => {
    expect(toolRunLabel({ calls: 11, names: [], thinkingMs: 6300 }).label).toBe("Thought for 6.3s");
    expect(toolRunLabel({ calls: 11, names: [] }).label).toBe("11 tool calls");
  });
});

describe("pairToolResults", () => {
  const calls = (...specs: { name: string; id?: string }[]): Msg => ({
    role: "assistant",
    content: "",
    toolCalls: specs.map((c) => ({ ...c, args: {} })),
  });
  const speaks = (content: string, ...specs: { name: string; id?: string }[]): Msg => ({
    role: "assistant",
    content,
    toolCalls: specs.map((c) => ({ ...c, args: {} })),
  });
  const answer = (toolName: string, toolCallId?: string): Msg => ({ role: "tool", content: "ok", toolName, toolCallId });

  it("files each result under the call that asked for it, by id", () => {
    const msgs = [calls({ name: "read_file", id: "a" }, { name: "peek_value", id: "b" }), answer("peek_value", "b"), answer("read_file", "a")];
    const { byCall, claimed } = pairToolResults(msgs);

    expect(byCall.get(0)?.get("a")).toBe(2);
    expect(byCall.get(0)?.get("b")).toBe(1);
    expect([...claimed.keys()]).toEqual([1, 2]);
  });

  it("falls back to name order when the provider sent no ids", () => {
    const msgs = [calls({ name: "read_file" }, { name: "read_file" }), answer("read_file"), answer("read_file")];
    const { byCall } = pairToolResults(msgs);

    expect(byCall.get(0)?.get("#0")).toBe(1);
    expect(byCall.get(0)?.get("#1")).toBe(2);
  });

  it("stops at the first message that is not a result", () => {
    const msgs = [calls({ name: "grep", id: "a" }), says("found it"), answer("grep", "a")];
    const { byCall, claimed } = pairToolResults(msgs);

    expect(byCall.size).toBe(0);
    expect(claimed.size).toBe(0);
  });

  it("files a sentence's results with it inside the one run", () => {
    // The prose turn draws its own glob + grep rows; their results must not
    // seed a fold that counts them again right underneath.
    const msgs = [
      speaks("Let me find the Rust side.", { name: "glob", id: "g" }, { name: "grep", id: "r" }),
      answer("glob", "g"),
      answer("grep", "r"),
      ...burst("read_file", 3),
    ];
    const runs = groupToolRuns(msgs, pairToolResults(msgs));

    // The sentence made calls, so it is on the way too: one run from the top,
    // its results filed under it and the reads after them.
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ start: 0, calls: 5, names: ["glob", "grep", "read_file"] });
  });

  it("still counts orphan results as a run", () => {
    const msgs = [answer("Bash"), answer("Bash"), answer("Bash")];
    expect(groupToolRuns(msgs, pairToolResults(msgs))[0].calls).toBe(3);
  });
});

import { liveWorkLine, liveWorkSteps, workSummary } from "./toolRuns";

describe("liveWorkSteps — the run read as a thread while it works", () => {
  const pending = (name: string): Msg => ({ role: "tool", content: `Running ${name}...`, toolName: name });

  it("keeps every sentence, folds the finished calls between them to one step, and names the call in flight", () => {
    const msgs: Msg[] = [
      asks("how do they relate?"),
      reasoningCall("read_file", "I'll read both files.", "hm"),
      result("read_file"),
      call("grep"),
      result("grep"),
      reasoningCall("run_command", "Let me check how they're consumed.", "hm"),
      pending("run_command"),
    ];
    const steps = liveWorkSteps(msgs, 1, msgs.length);
    expect(steps).toEqual([
      { kind: "prose", index: 1 },
      { kind: "work", names: ["read_file", "grep"], calls: 2 },
      { kind: "prose", index: 5 },
      { kind: "work", names: ["run_command"], calls: 1, live: { name: "run_command", args: {} } },
    ]);
  });

  it("a call with no result yet is the live one; a stretch with none running has no live call", () => {
    const msgs: Msg[] = [call("read_file"), result("read_file"), call("grep")];
    const steps = liveWorkSteps(msgs, 0, msgs.length);
    expect(steps).toEqual([{ kind: "work", names: ["read_file", "grep"], calls: 2, live: { name: "grep", args: {} } }]);
    expect(liveWorkSteps(msgs, 0, 2)).toEqual([{ kind: "work", names: ["read_file"], calls: 1 }]);
  });

  it("a thought alone is not a step — thinking folds with the rows", () => {
    const msgs: Msg[] = [{ role: "assistant", content: "", thinking: "deciding" }, call("grep")];
    expect(liveWorkSteps(msgs, 0, msgs.length).map((s) => s.kind)).toEqual(["work"]);
  });
});

describe("the one line a stretch of calls reads as", () => {
  it("summarises finished work as verbs, deduplicated, in first-appearance order", () => {
    expect(workSummary(["read_file", "peek_value", "grep", "run_command", "web_search"])).toBe("Read files, searched files, ran commands, searched the web");
    expect(workSummary(["Bash", "Read", "Edit"])).toBe("Ran commands, read files, edited files");
    expect(workSummary(["frobnicate"])).toBe("Used frobnicate");
  });

  it("says what the running call does, with its one interesting argument", () => {
    expect(liveWorkLine({ name: "run_command", args: { command: "curl -L  https://x" } })).toBe("Running curl -L https://x");
    expect(liveWorkLine({ name: "read_file", args: { path: "src/toast.ts" } })).toBe("Reading src/toast.ts");
    expect(liveWorkLine({ name: "web_search", args: { query: "opencode v2" } })).toBe("Searching the web for opencode v2");
    expect(liveWorkLine({ name: "Bash", args: '{"command":"ls"}' })).toBe("Running ls");
    expect(liveWorkLine({ name: "memory_search", args: { query: "routing" } })).toBe("memory_search routing");
    expect(liveWorkLine({ name: "get_git_status", args: {} })).toBe("get_git_status…");
  });
});

describe("a sentence still arriving stays in the run", () => {
  const work: Msg[] = [asks("go"), call("read_file"), result("read_file")];

  it("extends the run through the streaming row instead of ending it there", () => {
    const msgs = [...work, says("Let me check the fixture…")];
    expect(groupToolRuns(msgs)).toMatchObject([{ start: 1, end: 3 }]);
    expect(groupToolRuns(msgs, undefined, { streaming: 3 })).toMatchObject([{ start: 1, end: 4 }]);
  });

  it("a settled sentence — the stream moved on — ends the run as before", () => {
    const msgs = [...work, says("Here is the answer.")];
    expect(groupToolRuns(msgs, undefined, { streaming: undefined })).toMatchObject([{ start: 1, end: 3 }]);
    expect(groupToolRuns(msgs, undefined, { streaming: 2 })).toMatchObject([{ start: 1, end: 3 }]);
  });

  it("a streaming row that already made a card ends the run, and one with no run before it is no run", () => {
    const speaking: Msg = { role: "assistant", content: "Handing this off.", toolCalls: [{ name: "spawn_subagent", args: {} }] };
    expect(groupToolRuns([...work, speaking], undefined, { streaming: 3 })).toMatchObject([{ start: 1, end: 3 }]);
    expect(groupToolRuns([asks("go"), says("Just an answer.")], undefined, { streaming: 1 })).toEqual([]);
  });
});

import { thoughtGist } from "./toolRuns";

describe("a turn that said nothing shows its thought's gist where the sentence would be", () => {
  it("lifts the first paragraph that says something, two sentences at most, dots inside names kept", () => {
    const thought = "Okay.\n\nThe README is Klide's own — it says nothing about slugify.js. Let me look for a spec under artifacts/. Maybe the fixture has one.\n\nLet me be efficient: grep and peek together.";
    expect(thoughtGist(thought)).toBe("The README is Klide's own — it says nothing about slugify.js. Let me look for a spec under artifacts/.");
  });

  it("takes markdown furniture off, caps a long paragraph at a word, and is empty for filler alone", () => {
    expect(thoughtGist("- **Read** the file first.")).toBe("Read the file first.");
    const gist = thoughtGist("word ".repeat(80).trim() + ".");
    expect(gist.length).toBeLessThanOrEqual(240);
    expect(gist.endsWith("…")).toBe(true);
    expect(thoughtGist("Hmm.\n\nWait")).toBe("");
  });

  it("skips the sentence that only restates the request, so each step's gist says what it is doing", () => {
    const thought = "The user wants me to read each file one at a time. I've already read three files. I should continue with slashCommands.ts. Let me read it.";
    expect(thoughtGist(thought)).toBe("I've already read three files. I should continue with slashCommands.ts.");
    expect(thoughtGist("The user asked for a summary.\n\nNext file: panelHost.ts.")).toBe("Next file: panelHost.ts.");
  });

  it("a stray empty fence after the thinking is not prose — the turn lends its thought instead", () => {
    const stray: Msg = { role: "assistant", content: "<think>\nNext we read attachments.ts.\n</think>\n\n```", toolCalls: [{ name: "read_file", args: {} }] };
    expect(liveWorkSteps([stray, result("read_file")], 0, 2)).toEqual([
      { kind: "thought", index: 0, text: "Next we read attachments.ts." },
      { kind: "work", names: ["read_file"], calls: 1 },
    ]);
  });

  it("a settled thinking-only turn is a thought step before its work; a thought still streaming is not read", () => {
    const quiet: Msg = { role: "assistant", content: "", thinking: "Let me read the README. Then the tests.", toolCalls: [{ name: "read_file", args: {} }] };
    expect(liveWorkSteps([quiet, result("read_file")], 0, 2)).toEqual([
      { kind: "thought", index: 0, text: "Let me read the README. Then the tests." },
      { kind: "work", names: ["read_file"], calls: 1 },
    ]);
    const streamingThought: Msg = { role: "assistant", content: "", thinking: "Still deciding" };
    expect(liveWorkSteps([call("grep"), result("grep"), streamingThought], 0, 3).map((s) => s.kind)).toEqual(["work"]);
  });
});

describe("turnsAfterQuestions", () => {
  // Question, answer, verdict read as one exchange: the reply's thought draws
  // no row between the answered card and the verdict.
  it("marks the reply to an answered question, and nothing else", () => {
    const msgs: Msg[] = [
      { role: "user", content: "/quiz" },
      { role: "assistant", content: "Q1.", toolCalls: [{ id: "q1", name: "userAnswerQuestion", args: { question: "Which?" } }] },
      { role: "tool", content: "B", toolCallId: "q1", toolName: "userAnswerQuestion" },
      { role: "assistant", content: "✅ B.", thinking: "They picked B." },
      { role: "assistant", content: "Reading.", toolCalls: [{ id: "r1", name: "read_file", args: {} }] },
      { role: "tool", content: "…", toolCallId: "r1", toolName: "read_file" },
      { role: "assistant", content: "Done.", thinking: "ok" },
    ];
    expect([...turnsAfterQuestions(msgs)]).toEqual([3]);
  });
});

describe("questionVerdicts", () => {
  // The reply's ✅ / ❌ moves onto the answered card it judges.
  it("files each graded reply's mark under the question it judged", () => {
    const ask = (id: string): Msg => ({ role: "assistant", content: "", toolCalls: [{ id, name: "userAnswerQuestion", args: { question: "?" } }] });
    const answer = (id: string): Msg => ({ role: "tool", content: "B", toolCallId: id, toolName: "userAnswerQuestion" });
    const msgs: Msg[] = [ask("q1"), answer("q1"), { role: "assistant", content: "✅ B. Right." }, ask("q2"), answer("q2"), { role: "assistant", content: "❌ Correct is B." }, ask("q3"), answer("q3"), { role: "assistant", content: "Noted." }];
    const { byQuestion, replies } = questionVerdicts(msgs);
    expect([...byQuestion]).toEqual([[0, "right"], [3, "wrong"]]);
    expect([...replies]).toEqual([2, 5]);
    expect(dropVerdictMark("❌ Correct is B.")).toBe("Correct is B.");
  });
});

describe("gradeAnswer", () => {
  it("grades by letter when both sides name one, by text otherwise", () => {
    expect(gradeAnswer("B. The Workspace refuses it.", "B")).toBe("right");
    expect(gradeAnswer("C", "B. The Workspace refuses it.")).toBe("wrong");
    expect(gradeAnswer("Recall skips drafts", "recall  skips drafts")).toBe("right");
    expect(gradeAnswer("Restart", "Recall skips drafts")).toBe("wrong");
    expect(gradeAnswer("B", undefined)).toBeUndefined();
  });

  // The key rides the call; nothing drawn while the question is open shows it.
  it("takes the answer key out of an open question's args, live or replayed", () => {
    expect(withoutAnswerKey({ question: "?", correct: "B" })).toEqual({ question: "?" });
    expect(withoutAnswerKey(JSON.stringify({ question: "?", correct: "B" }))).toEqual({ question: "?" });
    expect(withoutAnswerKey({ question: "?" })).toEqual({ question: "?" });
  });
});
