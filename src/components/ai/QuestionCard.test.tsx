import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../hooks/useCustomProviders", () => ({ useCustomProviders: () => [] }));

import { QuestionCard } from "./QuestionCard";

function render(props: Partial<Parameters<typeof QuestionCard>[0]> = {}) {
  return renderToStaticMarkup(
    <QuestionCard
      question="Which todo-list behaviour should I fix?"
      answer=""
      onAnswerChange={() => {}}
      onSubmit={() => {}}
      onSkip={() => {}}
      {...props}
    />
  );
}

describe("QuestionCard", () => {
  it("asks the question and offers one answer box in either placement", () => {
    for (const variant of ["inline", "island"] as const) {
      const html = render({ variant });
      expect(html).toContain("Which todo-list behaviour should I fix?");
      expect(html.split("<textarea").length - 1).toBe(1);
      expect(html).toContain("Skip");
    }
  });

  it("names itself on the canvas, where the conversation is not the label", () => {
    expect(render({ variant: "island" })).toContain(">Question<");
    expect(render({ variant: "inline" })).not.toContain(">Question<");
  });

  it("labels the full OpenCode catalog picker on a worker dispatch", () => {
    const html = render({ choices: { kind: "dispatch", options: ["opencode"], preselected: "opencode" }, onChoose: () => {} });
    expect(html).toContain("Browse all models…");
  });

  // An empty answer is not an answer: the run stays parked until there is text
  // or the user skips, so send cannot fire a blank one back to the harness.
  it("keeps send inert until the answer has text", () => {
    expect(render({ answer: "" })).toContain("disabled");
    expect(render({ answer: "   " })).toContain("disabled");
    expect(render({ answer: "the drawer timings" })).not.toContain("disabled");
  });
});
