import { Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Msg } from "./types";
import { extractThinking, renderMessageBody, ThinkingBlock, type AttachedResult } from "./ChatMessage";

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

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

  it("renders one hoisted copy when the folded message body remains mounted", () => {
    const message: Msg = {
      role: "assistant",
      content: "",
      thinking: "Inspect the workspace.",
      toolCalls: [{ name: "read_file", args: { path: "src/App.tsx" } }],
    };
    const thinking = extractThinking(message);

    const html = renderToStaticMarkup(
      <Fragment>
        <ThinkingBlock text={thinking} streaming={false} />
        {renderMessageBody(message, false, { hideThinking: true })}
      </Fragment>,
    );

    expect(occurrences(html, "Thought process")).toBe(1);
    expect(occurrences(html, "Inspect the workspace.")).toBe(1);
    expect(html).toContain("read_file");
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
    expect(html).toContain("update_todo_list, glob");
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
    expect(delegation(pending)).not.toContain("View activity");
  });

  it("offers the child's activity once the report has landed", () => {
    const report: AttachedResult = { msg: { role: "tool", content: "The fold has three stages.", toolName: "spawn_subagent" }, active: false };
    expect(delegation(report)).toContain("View activity");
  });
});
