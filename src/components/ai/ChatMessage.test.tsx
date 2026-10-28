import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Msg } from "./types";
import { delegationThinking, extractThinking, normalizeThinking, renderMessageBody, type AttachedResult } from "./ChatMessage";
import { responseCosts } from "./responseCost";
import { foldAgentEvents, foldedToMsgs } from "../../agent/foldEvents";

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("response cost footer", () => {
  it.each([true, false])("shows a compaction's own price after replay (manual=%s)", (manual) => {
    const msgs = foldedToMsgs(foldAgentEvents([
      { type: "context_compacted", runId: "r", summary: "Earlier findings", kept: 0, costUsd: 0.313914, manual, ts: 0 },
    ]));
    const restored: Msg = JSON.parse(JSON.stringify(msgs[0]));
    const html = renderToStaticMarkup(renderMessageBody(restored));
    expect(html).toContain("Compacted 0 earlier turns · $0.31");
  });

  it("does not invent a price for old compaction markers without recorded usage", () => {
    const msgs = foldedToMsgs(foldAgentEvents([
      { type: "context_compacted", runId: "r", summary: "Earlier findings", ts: 0 },
    ]));
    expect(renderToStaticMarkup(renderMessageBody(msgs[0]))).not.toContain("$");
  });

  it("renders the cost of all calls through the same wrapper the panel uses", () => {
    const msgs: Msg[] = [
      { role: "user", content: "Inspect the project" },
      { role: "assistant", content: "Reading", toolCalls: [{ name: "read_file", args: {} }], meta: { costUsd: 0.854 } },
      { role: "tool", content: "code", toolName: "read_file" },
      { role: "assistant", content: "Here is the explanation", meta: { costUsd: 0.142, tokens: 5990 } },
      { role: "system", content: "Compacted", compaction: { count: 4, summary: "notes", source: "manual" } },
      { role: "user", content: "Continue" },
      { role: "assistant", content: "Recap", meta: { costUsd: 0.586 } },
    ];
    const costs = responseCosts(msgs);
    const html = renderToStaticMarkup(renderMessageBody(msgs[3], false, { responseCost: costs.get(3) }));
    expect(html).toContain("$1.00 response total (2 priced calls)");
    expect(html).not.toContain("$0.14 this call");
    const followup = renderToStaticMarkup(renderMessageBody(msgs[6], false, { responseCost: costs.get(6) }));
    expect(followup).toContain("$0.59 response total (1 priced call)");
  });
});

describe("tool-run thinking", () => {
  it.each([
    {
      name: "structured thinking",
      message: { role: "assistant", content: "", thinking: "Inspect the workspace." } satisfies Msg,
      expected: "Inspect the workspace.",
    },
    {
      name: "inline think block",
      message: { role: "assistant", content: "<think>Find the relevant symbol.</think>" } satisfies Msg,
      expected: "Find the relevant symbol.",
    },
    {
      name: "plan JSON",
      message: {
        role: "assistant",
        content: JSON.stringify({ analysis: "Verify the change.", plan: "Run the tests.", commands: [] }),
      } satisfies Msg,
      expected: "Verify the change.\n\nRun the tests.",
    },
  ])("extracts $name", ({ message, expected }) => {
    expect(extractThinking(message)).toBe(expected);
  });

  it("keeps its thinking in place inside a fold, so opening one restores the order", () => {
    const message: Msg = {
      role: "assistant",
      content: "",
      thinking: "Inspect the workspace.",
      thinkingMs: 700,
      toolCalls: [{ name: "read_file", args: { path: "src/App.tsx" } }],
    };

    const html = renderToStaticMarkup(renderMessageBody(message, false));

    expect(occurrences(html, "Thought for 0.7s")).toBe(1);
    expect(occurrences(html, "Inspect the workspace.")).toBe(1);
    expect(html.indexOf("Inspect the workspace.")).toBeLessThan(html.indexOf("read_file"));
  });

  it("keeps the original thinking block when the message is not folded", () => {
    const message: Msg = {
      role: "assistant",
      content: "Answer after checking.",
      thinking: "Inspect the workspace.",
    };

    const html = renderToStaticMarkup(renderMessageBody(message));

    expect(occurrences(html, "Thought process")).toBe(1);
    expect(occurrences(html, "Inspect the workspace.")).toBe(1);
    expect(html).toContain("Answer after checking.");
  });
});

describe("agent coordination tool rows", () => {
  it("renders a durable question as a human agent-to-agent action", () => {
    const message: Msg = {
      role: "assistant",
      content: "",
      toolCalls: [{
        name: "agent_send",
        args: {
          toRunId: "run_reviewer",
          kind: "question",
          body: "Can you verify the replay invariant?",
          waitForReply: true,
        },
      }],
    };

    const html = renderToStaticMarkup(renderMessageBody(message));

    expect(html).toContain("Asked");
    expect(html).toContain("@run_reviewer");
    expect(html).toContain("Can you verify the replay invariant?");
    expect(html).not.toContain("agent_send");
    expect(html).not.toContain("toRunId");
  });

  it("renders a delivered agent message in the sender's line, from the other side", () => {
    const message: Msg = {
      role: "system",
      content: "",
      steering: { reason: "Agent message delivered: question from @run_reviewer (env_42)" },
    };

    const html = renderToStaticMarkup(renderMessageBody(message, false, { workspaceRoot: "/tmp/ws" }));

    expect(html).toContain("Asked by");
    expect(html).toContain("@run_reviewer");
    expect(html).not.toContain("Steered");
    expect(html).not.toContain("Received");
    expect(html).not.toContain("env_42");
  });

  it("keeps ordinary steering lines as steering", () => {
    const message: Msg = {
      role: "system",
      content: "",
      steering: { reason: "Loop detected — `read_file` called 3×" },
    };

    const html = renderToStaticMarkup(renderMessageBody(message));

    expect(html).toContain("Steered");
    expect(html).not.toContain("Received");
  });

  it("draws an attached result under its own call, without repeating the tool name", () => {
    const message: Msg = {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "a", name: "read_file", args: { path: "src/a.ts" } },
        { id: "b", name: "peek_value", args: { ref: "call_1" } },
      ],
    };
    const results = new Map([
      ["a", { msg: { role: "tool" as const, content: "Contents of src/a.ts (220 lines)", toolName: "read_file", toolCallId: "a" }, active: false }],
    ]);

    const html = renderToStaticMarkup(renderMessageBody(message, false, { results }));

    // The result sits between its call and the next call.
    const call = html.indexOf("read_file");
    const result = html.indexOf("Contents of src/a.ts");
    const next = html.indexOf("peek_value");
    expect(call).toBeGreaterThan(-1);
    expect(result).toBeGreaterThan(call);
    expect(next).toBeGreaterThan(result);
    // The call row already names the tool; the result line does not say it again.
    expect(html.match(/read_file/g)).toHaveLength(1);
  });

  it("labels coordination results without exposing raw machinery", () => {
    const message: Msg = {
      role: "tool",
      content: "Message env_123 queued for @run_reviewer.",
      toolName: "agent_send",
      toolCallId: "call_1",
    };

    const html = renderToStaticMarkup(renderMessageBody(message));

    expect(html).toContain("coordination update");
    expect(html).toContain("Message env_123 queued");
  });
});

describe("a speaking turn with a wall of calls", () => {
  const speaking = (n: number, results?: Map<string, AttachedResult>): string =>
    renderToStaticMarkup(
      renderMessageBody(
        {
          role: "assistant",
          content: "I'll set up a todo list and read the code.",
          toolCalls: Array.from({ length: n }, (_, i) => ({ id: `c${i}`, name: i === n - 1 ? "glob" : "update_todo_list", args: { text: `step ${i}` } })),
        },
        false,
        { results },
      ),
    );

  it("keeps the sentence and folds the rows behind the tool-run summary", () => {
    const html = speaking(7);
    expect(html).toContain("I&#x27;ll set up a todo list and read the code.");
    expect(html).toContain("7 tool calls");
    expect(html).toContain('data-open="false"');
    // the rows are still there, mounted under the fold
    expect(occurrences(html, "update_todo_list")).toBeGreaterThanOrEqual(6);
  });

  it("leaves two rows alone — two rows are not a wall", () => {
    const html = speaking(2);
    expect(html).not.toContain("tool calls");
    expect(html).not.toContain("klide-tool-run-body");
  });

  it("stays open while one of its results is still running", () => {
    const results = new Map<string, AttachedResult>([["c0", { msg: { role: "tool", content: "Running update_todo_list", toolName: "update_todo_list" }, active: true }]]);
    expect(speaking(4, results)).toContain('data-open="true"');
  });
});

describe("a delegation row while the child works", () => {
  const delegation = (result?: AttachedResult): string =>
    renderToStaticMarkup(
      renderMessageBody(
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c0", name: "spawn_subagent", args: { subagent: "explorer", task: "Map the fold." }, childRunId: "sub_run_c0" }],
        },
        false,
        { results: result ? new Map([["c0", result]]) : undefined },
      ),
    );

  it("does not treat the pending 'Running' placeholder as the child's report", () => {
    const pending: AttachedResult = { msg: { role: "tool", content: "Running spawn_subagent...", toolName: "spawn_subagent" }, active: true };
    expect(delegation(pending)).not.toContain("subagent report");
    const html = delegation(pending);
    expect(html).toContain("Starting…");
    expect(html).toContain("border-left:1px solid var(--border)");
    expect(html).not.toContain("border:1px solid var(--border)");
    expect(html).toContain("View activity: Starting…");
  });

  it("draws one loader while the child has no Run id yet: Starting…, not a second 'subagent working…'", () => {
    const html = renderToStaticMarkup(
      renderMessageBody(
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c0", name: "spawn_subagent", args: { subagent: "implementer", worker: "claude-code", task: "Create hello.sh." } }],
        },
        false,
        { results: new Map([["c0", { msg: { role: "tool", content: "Running spawn_subagent...", toolName: "spawn_subagent" }, active: true }]]) },
      ),
    );
    expect(html).toContain("Starting…");
    expect(html).not.toContain("subagent working…");
  });

  it("says the setup stage while the worker's worktree is being prepared, and that it failed", () => {
    const row = (stage: string, result: AttachedResult) => renderToStaticMarkup(
      renderMessageBody(
        { role: "assistant", content: "", toolCalls: [{ id: "c0", name: "spawn_subagent", args: { subagent: "implementer", worker: "codex", task: "Do it.", stage } }] },
        false,
        { results: new Map([["c0", result]]) },
      ),
    );
    const running = row("Running setup…", { msg: { role: "tool", content: "Running spawn_subagent...", toolName: "spawn_subagent" }, active: true });
    expect(running).toContain("Running setup…");
    expect(running).not.toContain("Starting…");
    const failed = row("Running setup…", { msg: { role: "tool", content: "The worktree setup failed, so Codex was not started and no model tokens were spent.\n\nnpm ERR! missing script", toolName: "spawn_subagent" }, active: false });
    expect(failed).toContain("Setup failed");
    expect(failed).toContain("npm ERR! missing script");
    expect(failed).not.toContain("Completed");
    // The failure belongs to the delegation: its output sits on the row's
    // spine, not in a separate report row with its own box.
    expect(failed).not.toContain("subagent report");
    expect(failed).not.toContain("no model tokens were spent");
  });

  it.each(["The worktree setup was cancelled", "The worker dispatch was cancelled"])("renders %s on the delegation", (prefix) => {
    const message: Msg = { role: "assistant", content: "", toolCalls: [{ id: "c0", name: "spawn_subagent", childRunId: "sub_run_c0", args: {
      subagent: "implementer", worker: "codex", task: "Do it.", stage: "Running setup…", background: true,
    } }] };
    const live = renderToStaticMarkup(renderMessageBody(message, false));
    expect(live).toContain("Running setup…");
    expect(live).toContain('aria-label="Cancel worker"');
    const result: AttachedResult = { msg: { role: "tool", toolName: "spawn_subagent", content: `${prefix}, so Codex was not started and no model tokens were spent. The worktree is kept at /tmp/worker for a look.\n\nSetup cancelled.` }, active: false };
    const settled = renderToStaticMarkup(renderMessageBody(message, false, { results: new Map([["c0", result]]), workspaceRoot: "/tmp/project" }));
    expect(settled).toContain("Cancelled");
    expect(settled).toContain("Setup cancelled.");
    expect(settled).not.toContain("subagent report");
    expect(settled).not.toContain("Completed");
    expect(settled).not.toContain('aria-label="Cancel worker"');
  });

  it("keeps a background dispatch receipt behind the activity disclosure", () => {
    const receipt: AttachedResult = { msg: { role: "tool", content: "Dispatched Claude Code as implementer in the background as Run `sub_run_c0`", toolName: "spawn_subagent" }, active: false };
    const html = delegation(receipt);
    expect(html).toContain("Map the fold.");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Completed");
    expect(html).toContain("klide-orbit-loader");
    expect(html).not.toContain("Dispatched Claude Code");
    expect(html).not.toContain("subagent report");
  });

  it("says it is sending a worker from the first frame, and not when declined", () => {
    const row = (args: Record<string, unknown>, content: string, childRunId?: string) => renderToStaticMarkup(
      renderMessageBody(
        { role: "assistant", content: "", toolCalls: [{ id: "c0", name: "spawn_subagent", args: { subagent: "implementer", worker: "claude-code", task: "Add a test.", ...args }, childRunId }] },
        false,
        { results: new Map([["c0", { msg: { role: "tool", content, toolName: "spawn_subagent" }, active: false }]]) },
      ),
    );
    expect(row({ background: true }, "Dispatched Claude Code as implementer in the background as Run `sub_run_c0`", "sub_run_c0"))
      .toContain("I&#x27;m sending a worker: Claude Code will work on it in the background, and I&#x27;ll tell you when it reports.");
    expect(row({}, "Done.", "sub_run_c0")).toContain("I&#x27;m sending a worker: Claude Code will work on it.");
    expect(row({}, "Running spawn_subagent...")).toContain("I&#x27;m sending a worker");
    expect(row({ background: true }, "The user declined to dispatch Claude Code.")).not.toContain("sending a worker");
  });

  it("says a worker over capacity is queued until its Run starts", () => {
    const html = renderToStaticMarkup(
      renderMessageBody(
        { role: "assistant", content: "", toolCalls: [{ id: "c0", name: "spawn_subagent", args: { subagent: "implementer", worker: "anthropic", task: "Add a test.", background: true, stage: "Queued behind 4 running API workers" }, childRunId: "sub_run_c0" }] },
        false,
        { results: new Map([["c0", { msg: { role: "tool", content: "Dispatched Anthropic as implementer in the background as Run `sub_run_c0`", toolName: "spawn_subagent" }, active: false }]]) },
      ),
    );
    expect(html).toContain("Queued behind 4 running API workers");
    expect(html).not.toContain("Starting…");
  });

  it("draws a dispatch cancelled at its card as cancelled, not as a child still starting", () => {
    // Rust answers a rejected dispatch gate with this sentence and emits no
    // `subagent_requested`, so the call has no child Run id — and the model's
    // own `background: true` must not keep the row live for a child that
    // never existed (it did: "Starting…" with a clock, for good).
    const html = renderToStaticMarkup(
      renderMessageBody(
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c0", name: "spawn_subagent", args: { subagent: "implementer", worker: "opencode", task: "Add slugify.js.", background: true } }],
        },
        false,
        { results: new Map([["c0", { msg: { role: "tool", content: "The user declined to dispatch OpenCode. Do the task another way, or ask them how they would like it done.", toolName: "spawn_subagent" }, active: false }]]) },
      ),
    );
    expect(html).toContain("Cancelled");
    expect(html).not.toContain("Starting…");
    expect(html).not.toContain("Completed");
    expect(html).not.toContain("klide-orbit-loader");
    expect(html).not.toContain("aria-expanded");
  });

  it("offers the child's activity once the report has landed", () => {
    const report: AttachedResult = { msg: { role: "tool", content: "The fold has three stages.", toolName: "spawn_subagent" }, active: false };
    expect(delegation(report)).toContain("View activity");
  });
});

describe("a question the run asked, once answered", () => {
  const exchange = (answer: string): string =>
    renderToStaticMarkup(
      renderMessageBody(
        { role: "assistant", content: "", toolCalls: [{ id: "q0", name: "userAnswerQuestion", args: { question: "Which slug style — kebab or snake?" } }] },
        false,
        { results: new Map([["q0", { msg: { role: "tool", content: answer, toolName: "userAnswerQuestion" }, active: false }]]) },
      ),
    );

  it("stays in the conversation as the exchange, not as a mono tool row", () => {
    const html = exchange("Kebab, like the rest of the repo.");
    expect(html).toContain("Which slug style — kebab or snake?");
    expect(html).toContain("Kebab, like the rest of the repo.");
    expect(html).toContain("ask-card-answered");
    expect(html).not.toContain("userAnswerQuestion");
  });

  it("reads a bare letter answer as the line it picked", () => {
    const html = renderToStaticMarkup(
      renderMessageBody(
        { role: "assistant", content: "", toolCalls: [{ id: "q0", name: "userAnswerQuestion", args: { question: "Q2 · Why?\nA. Restart.\nB. Recall skips drafts.", choices: ["A", "B"] } }] },
        false,
        { results: new Map([["q0", { msg: { role: "tool", content: "B", toolName: "userAnswerQuestion" }, active: false }]]) },
      ),
    );
    expect(html).toContain(">Q2 · Why?</span>");
    expect(html).toContain(">B. Recall skips drafts.</span>");
  });

  it("marks the pick against the answer key at once, before any reply", () => {
    const answered = (answer: string) => renderToStaticMarkup(
      renderMessageBody(
        { role: "assistant", content: "", toolCalls: [{ id: "q0", name: "userAnswerQuestion", args: { question: "Why?", choices: ["Restart", "Recall skips drafts"], correct: "Recall skips drafts" } }] },
        false,
        { results: new Map([["q0", { msg: { role: "tool", content: answer, toolName: "userAnswerQuestion" }, active: false }]]) },
      ),
    );
    expect(answered("Restart")).toContain("ask-card-wrong");
    expect(answered("Recall skips drafts")).toContain("ask-card-answered");
  });

  it("never shows the answer key while the question is open", () => {
    const html = renderToStaticMarkup(
      renderMessageBody(
        { role: "assistant", content: "", toolCalls: [{ id: "q0", name: "userAnswerQuestion", args: { correct: "SECRET-KEY", question: "Why?" } }] },
        true,
        { results: new Map([["q0", { msg: { role: "tool", content: "", toolName: "userAnswerQuestion" }, active: true }]]) },
      ),
    );
    expect(html).not.toContain("SECRET-KEY");
  });

  it("says a skipped question was skipped rather than quoting the harness", () => {
    const html = exchange("[user skipped this question]");
    expect(html).toContain("Skipped");
    expect(html).toContain("ask-card-skipped");
    expect(html).not.toContain("[user skipped this question]");
  });

  it("keeps the plain row while the run is still waiting on the answer", () => {
    const html = renderToStaticMarkup(
      renderMessageBody(
        { role: "assistant", content: "", toolCalls: [{ id: "q0", name: "userAnswerQuestion", args: { question: "Kebab or snake?" } }] },
        false,
        { results: new Map([["q0", { msg: { role: "tool", content: "Running userAnswerQuestion...", toolName: "userAnswerQuestion" }, active: true }]]) },
      ),
    );
    expect(html).toContain("userAnswerQuestion");
    expect(html).not.toContain("Question answered");
  });
});

describe("normalizeThinking", () => {
  it("keeps a fence the model mentions as prose, not a code block", () => {
    expect(normalizeThinking("the wrapper is ```html visualizer. I'll use ```svg fence. Hmm")).toBe(
      "the wrapper is `html` visualizer. I'll use `svg` fence. Hmm",
    );
  });

  it("drops a bare fence and folds the lines around it", () => {
    expect(normalizeThinking("so:\n```\nconst a = 1\n```\ndone")).toBe("so: const a = 1 done");
  });
});


describe("delegation reasoning", () => {
  it("combines reasoning above the worker and keeps a later report separate", () => {
    const msgs: Msg[] = [
      { role: "assistant", content: "", thinking: "Choose the worker.", toolCalls: [{ name: "spawn_subagent", args: {} }] },
      { role: "tool", content: "Dispatched worker", toolName: "spawn_subagent" },
      { role: "assistant", content: "Meanwhile…", thinking: "Continue the conversation." },
      { role: "system", content: "Report arrived" },
      { role: "assistant", content: "Done", thinking: "Check the result." },
    ];
    const thoughts = delegationThinking(msgs);
    expect(thoughts.get(0)).toBe("Choose the worker.\n\nContinue the conversation.");
    expect(thoughts.get(2)).toBe("");
    expect(thoughts.has(4)).toBe(false);
  });
});
