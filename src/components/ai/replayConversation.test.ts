import { describe, expect, it } from "vitest";
import {
  eventsToConversation,
  eventsToMsgs,
  hasOpenTurn,
  isSilentRunError,
  replayForAdoption,
  runMessagesToMsgs,
  shouldHealFromTranscript,
} from "./replayConversation";
import type { AgentEvent } from "../../agent/types";
import type { Msg } from "./types";

// No `as AgentEvent` anywhere below: the union is the contract, and an
// unchecked cast is how a fixture ends up describing a wire shape Rust never
// emits. `usage` and `timing` are `skip_serializing_if = "Option::is_none"` on
// the Rust side, so they are *absent* rather than null — writing `null` here
// (and casting past the error) produced a crash that looked like a bug in
// `foldAgentEvents` and was a bug in the fixture.

function runStarted(ts: number): AgentEvent {
  return {
    type: "run_started",
    runId: "r1",
    mode: "goal",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    cwd: null,
    ts,
  };
}

function userMessage(text: string, ts: number): AgentEvent {
  return { type: "user_message", runId: "r1", messageId: "u1", text, attachments: [], ts };
}

function assistantMessage(text: string, ts: number): AgentEvent {
  return {
    type: "assistant_message",
    runId: "r1",
    messageId: "a1",
    content: [{ type: "text", text }],
    ts,
  };
}

type RunErrorCode = Extract<AgentEvent, { type: "run_error" }>["error"]["code"];

function runError(code: RunErrorCode, message: string, ts: number): AgentEvent {
  return {
    type: "run_error",
    runId: "r1",
    error: { code, message, retryable: false },
    ts,
  };
}

describe("eventsToConversation", () => {
  it("prepends a system line naming the run's mode, provider and model", () => {
    const convo = eventsToConversation(
      [runStarted(1_000), userMessage("hi", 1_100), assistantMessage("hello", 1_200)],
      "r1",
      "Fix the tests"
    );
    expect(convo.msgs[0]).toEqual({
      role: "system",
      content: "Run: goal · anthropic/claude-sonnet-4-6",
    });
    expect(convo.id).toBe("r1");
    expect(convo.title).toBe("Fix the tests");
  });

  it("takes both timestamps from the transcript, never from the clock", () => {
    // A run that finished days ago must not be stamped "now" — the board sorts
    // and the panel dates conversations off these.
    const convo = eventsToConversation(
      [runStarted(1_000), userMessage("hi", 1_100), assistantMessage("done", 9_999)],
      "r1",
      "t"
    );
    expect(convo.createdAt).toBe(1_000);
    expect(convo.updatedAt).toBe(9_999);
  });

  it("explains a failed run instead of replaying as empty", () => {
    // A provider 500 leaves no assistant turn to fold, so without this line a
    // resumed panel shows the user's message and nothing else — reading as an
    // empty or hung run.
    const convo = eventsToConversation(
      [runStarted(1), userMessage("hi", 2), runError("provider_unavailable", "502 from upstream", 3)],
      "r1",
      "t"
    );
    const last = convo.msgs[convo.msgs.length - 1];
    expect(last).toEqual({
      role: "system",
      content: "Run failed: 502 from upstream",
      runError: { message: "502 from upstream" },
    });
  });

  it("stays silent about a run the user stopped", () => {
    // A Stop is not a failure; the partial output is the answer. This must match
    // the live path in AiPanel, which is why the rule is shared.
    const convo = eventsToConversation(
      [runStarted(1), userMessage("hi", 2), assistantMessage("partial", 3), runError("aborted", "Aborted", 4)],
      "r1",
      "t"
    );
    expect(convo.msgs.some((m) => m.content.startsWith("Run failed:"))).toBe(false);
    expect(isSilentRunError("aborted")).toBe(true);
    expect(isSilentRunError("provider_unavailable")).toBe(false);
  });

  it("survives a transcript with no events", () => {
    const convo = eventsToConversation([], "r1", "t");
    expect(convo.msgs).toEqual([]);
    expect(convo.createdAt).toBeUndefined();
    expect(typeof convo.updatedAt).toBe("number");
  });

  it("omits the header when the transcript does not start with run_started", () => {
    // A truncated or hand-edited transcript should replay what it has rather
    // than assert metadata it never recorded.
    const convo = eventsToConversation([userMessage("hi", 1)], "r1", "t");
    expect(convo.msgs[0].role).toBe("user");
  });
});

describe("eventsToMsgs", () => {
  it("folds a transcript into the panel's messages", () => {
    const msgs = eventsToMsgs([runStarted(1), userMessage("hi", 2), assistantMessage("hello", 3)]);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1].content).toBe("hello");
  });

  it("is empty for an empty transcript", () => {
    expect(eventsToMsgs([])).toEqual([]);
  });
});

describe("replayForAdoption", () => {
  const transcript = [runStarted(1), userMessage("hi", 2), assistantMessage("hello", 3)];

  it("heals a view that stopped short of what the run wrote", () => {
    // The case this exists for: the panel took the user turn and the start of
    // the answer, then stopped following the run. The Transcript has the whole
    // exchange, so adopting it puts the answer back on screen.
    const onScreen: Msg[] = [{ role: "user", content: "hi" }];
    const healed = replayForAdoption(transcript, onScreen);
    expect(healed?.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(healed?.[1].content).toBe("hello");
  });

  it("carries queued turns across the replay", () => {
    // A turn typed ahead has not been sent, so the Transcript cannot know about
    // it. Dropping it here would silently swallow what the user just wrote.
    const queued: Msg = { role: "user", content: "and then?", queueState: "queued" };
    const healed = replayForAdoption(transcript, [{ role: "user", content: "hi" }, queued]);
    expect(healed?.[healed.length - 1]).toBe(queued);
  });

  it("refuses a replay shorter than what is already on screen", () => {
    // A half-written or truncated read must never eat live rows.
    const onScreen: Msg[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "assistant", content: "and more" },
    ];
    expect(replayForAdoption(transcript, onScreen)).toBeNull();
    expect(replayForAdoption([], onScreen)).toBeNull();
  });

  it("adopts a delegate turn whose live view holds rows the Transcript never will", () => {
    // The reload-mid-generation bug, built from the two streams Rust actually
    // produces. A delegate CLI's own tool activity is sent on the
    // request-scoped channel and never written to disk (agent/mod.rs), so the
    // live view is folded from events the Transcript does not contain — three
    // sentence fragments around four tool rows, seven rows against the two the
    // replay folds. A row count read that as a truncated read and refused it,
    // and the finished answer stayed on disk. Weighed by what was said, the
    // replay plainly carries more.
    // A call and its result, the pair the CLI reports — the row only lands
    // once the result does, which is how the live view reaches seven rows.
    const observed = (id: string, name: string, ts: number): AgentEvent[] => [
      {
        type: "observed_tool_call",
        runId: "r1",
        toolCallId: id,
        provider: "opencode",
        name,
        input: {},
        summary: name,
        ts,
      },
      { type: "observed_tool_result", runId: "r1", toolCallId: id, ok: true, content: "…", ts: ts + 1 },
    ];
    const delta = (text: string, ts: number): AgentEvent => ({
      type: "assistant_delta",
      runId: "r1",
      messageId: "a1",
      text,
      ts,
    });

    const said = [
      "I'll take that as a review of the current work — let me check what's in flight.",
      "There's a sizeable uncommitted feature in flight. Let me review the diffs.",
      "The code looks well-built; let me verify it compiles before reporting.",
    ];
    const answer = "I reviewed it. One real issue: a corrupt store reads as empty, and the next write overwrites it.";

    // What the panel had on screen when the webview reloaded: everything the
    // live channel had sent, minus the answer still being generated.
    const liveStream: AgentEvent[] = [
      runStarted(1),
      userMessage("do you find any issues in the current context", 2),
      delta(said[0], 3),
      ...observed("t1", "bash", 4),
      ...observed("t2", "read", 6),
      delta(said[1], 8),
      ...observed("t3", "read", 9),
      delta(said[2], 11),
      ...observed("t4", "bash", 12),
    ];
    const onScreen = eventsToMsgs(liveStream);

    // What the Transcript holds once the turn lands: no observed rows, and the
    // whole turn folded into one assistant message.
    const transcriptAfter: AgentEvent[] = [
      runStarted(1),
      userMessage("do you find any issues in the current context", 2),
      assistantMessage(said.join("") + answer, 10),
    ];

    // Eight rows against the two the Transcript folds — the shape the bug
    // report showed: sentence fragments around tool rows, and no answer.
    expect(onScreen).toHaveLength(8);
    expect(onScreen.filter((m) => m.role === "tool")).toHaveLength(4);
    expect(eventsToMsgs(transcriptAfter).length).toBeLessThan(onScreen.length);

    const healed = replayForAdoption(transcriptAfter, onScreen);
    expect(healed?.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(healed?.[1].content).toContain("One real issue");
  });

  it("refuses to eat a turn that is still streaming", () => {
    // The other side of the same rule: nothing is persisted until the turn
    // lands, so mid-stream the screen holds more of the answer than disk does
    // and the replay must not overwrite it with the empty turn.
    const onScreen: Msg[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "here is the first half of the answer" },
    ];
    expect(replayForAdoption([runStarted(1), userMessage("hi", 2)], onScreen)).toBeNull();
  });

  it("explains a run that died while nobody held the live channel", () => {
    // A proxy timeout folds to no row — the failure produced no work — so a
    // reattached view ended mid-tool-call and read as a crash. The user only
    // learned the run failed by finding run_error in the transcript by hand.
    const failed = [
      runStarted(1),
      userMessage("hi", 2),
      runError("provider_unavailable", "timed out waiting for the model (HTTP 524)", 3),
    ];
    const healed = replayForAdoption(failed, [{ role: "user", content: "hi" }]);
    expect(healed?.[healed.length - 1]).toEqual({
      role: "system",
      content: "Run failed: timed out waiting for the model (HTTP 524)",
      runError: { message: "timed out waiting for the model (HTTP 524)" },
    });
  });

  it("keeps queued turns after the error line, and stays silent about a Stop", () => {
    const stopped = [
      runStarted(1),
      userMessage("hi", 2),
      assistantMessage("partial", 3),
      runError("aborted", "Aborted", 4),
    ];
    const queued: Msg = { role: "user", content: "and then?", queueState: "queued" };
    const afterStop = replayForAdoption(stopped, [{ role: "user", content: "hi" }, queued]);
    expect(afterStop?.some((m) => m.content.startsWith("Run failed:"))).toBe(false);
    expect(afterStop?.[afterStop.length - 1]).toBe(queued);
  });

  it("does not pin an old error to a conversation that moved past it", () => {
    // Turn 2 failed, turn 3 was sent and answered. The error is history — a
    // trailing "Run failed" line would report a recovered thread as failed.
    const recovered = [
      runStarted(1),
      userMessage("hi", 2),
      runError("provider_unavailable", "502", 3),
      userMessage("retry", 4),
      assistantMessage("done", 5),
    ];
    const healed = replayForAdoption(recovered, []);
    expect(healed?.some((m) => m.content.startsWith("Run failed:"))).toBe(false);
  });
});

describe("shouldHealFromTranscript", () => {
  const healthy = {
    behind: null,
    stillOnConversation: true,
    subagent: false,
    delegateWithoutTranscript: false,
  } as const;

  it("leaves a turn that reached the screen alone", () => {
    expect(shouldHealFromTranscript(healthy)).toBe(false);
  });

  it("heals a turn whose region was taken over mid-run", () => {
    expect(shouldHealFromTranscript({ ...healthy, behind: "region-detached" })).toBe(true);
  });

  it("heals a turn whose generation was retired under it", () => {
    // The regression this exists for. The panel used to also require the turn
    // generation to still be current — but a generation is only ever bumped, so
    // the one case this branch was written for could never satisfy it. Stop,
    // pressed mid-run, is exactly that: the generation moves on, the
    // conversation does not, and the answer already written stays on disk.
    expect(shouldHealFromTranscript({ ...healthy, behind: "generation-retired" })).toBe(true);
  });

  it("does not heal a conversation the panel has left", () => {
    // Leaving, a new chat and resuming another thread all change the
    // conversation — adopting this Run's replay would land it on someone else's
    // thread, which is a worse bug than the short view.
    expect(
      shouldHealFromTranscript({
        ...healthy,
        behind: "generation-retired",
        stillOnConversation: false,
      }),
    ).toBe(false);
  });

  it("does not heal a subagent turn or a Delegate without a transcript", () => {
    expect(
      shouldHealFromTranscript({ ...healthy, behind: "region-detached", subagent: true }),
    ).toBe(false);
    expect(
      shouldHealFromTranscript({
        ...healthy,
        behind: "region-detached",
        delegateWithoutTranscript: true,
      }),
    ).toBe(false);
  });
});

describe("runMessagesToMsgs", () => {
  const session = [
    { role: "user" as const, text: "check the tree" },
    {
      role: "assistant" as const,
      text: "Looking.",
      tools: [
        {
          id: "t1",
          name: "Bash",
          input: { command: "git status" },
          result: "On branch main",
          ok: true,
        },
      ],
    },
  ];

  it("carries a call's arguments, so the row can say more than its tool's name", () => {
    const [, assistant] = runMessagesToMsgs(session);

    expect(assistant.role).toBe("assistant");
    expect(assistant.role === "assistant" && assistant.toolCalls).toEqual([
      { id: "t1", name: "Bash", args: { command: "git status" } },
    ]);
  });

  it("puts what a call returned in its own row under it", () => {
    const result = runMessagesToMsgs(session)[2];

    expect(result).toEqual({
      role: "tool",
      content: "On branch main",
      toolName: "Bash",
      toolCallId: "t1",
    });
  });

  it("says which delegate ran a tool, because Klide gated none of it", () => {
    const result = runMessagesToMsgs(session, "claude-code")[2];

    expect(result.role === "tool" && result.observedBy).toBe("claude-code");
  });

  it("marks a failed result as an error and omits a call that never answered", () => {
    const msgs = runMessagesToMsgs([
      {
        role: "assistant",
        text: "",
        tools: [
          { id: "a", name: "Bash", input: { command: "false" }, result: "exit 1", ok: false },
          { id: "b", name: "Read", input: { file_path: "/gone.rs" } },
        ],
      },
    ]);

    // Two calls on the assistant row, one result row — an unanswered call has
    // nothing to show, and an empty row would read as a tool that returned
    // nothing rather than one still unaccounted for.
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toMatchObject({ role: "tool", content: "Error: exit 1" });
  });
});

describe("hasOpenTurn", () => {
  const user = (text: string, ts: number): AgentEvent => ({
    type: "user_message",
    runId: "r1",
    messageId: `u${ts}`,
    text,
    attachments: [],
    ts,
  });
  const assistant = (text: string, ts: number): AgentEvent => ({
    type: "assistant_message",
    runId: "r1",
    messageId: `a${ts}`,
    content: [{ type: "text", text }],
    ts,
  });

  it("is true for a transcript that ends on an unanswered user message", () => {
    expect(hasOpenTurn([runStarted(1), user("hello", 2)])).toBe(true);
    expect(hasOpenTurn([user("one", 1), assistant("first", 2), user("two", 3)])).toBe(true);
  });

  it("is false once the turn was answered or settled", () => {
    expect(hasOpenTurn([user("one", 1), assistant("first", 2)])).toBe(false);
    expect(hasOpenTurn([user("one", 1), { type: "run_result", runId: "r1", result: { status: "done" }, ts: 2 }])).toBe(false);
    expect(hasOpenTurn([user("one", 1), { type: "run_error", runId: "r1", error: { code: "provider_unavailable", message: "500", retryable: false }, ts: 2 }])).toBe(false);
  });

  it("is false for a transcript with no turn at all", () => {
    expect(hasOpenTurn([])).toBe(false);
    expect(hasOpenTurn([runStarted(1)])).toBe(false);
  });
});
