import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../hooks/useCustomProviders", () => ({ useCustomProviders: () => [] }));

import { choiceIndexForKey, liftLetteredChoices, QuestionCard, splitQuestion } from "./QuestionCard";

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
  it("asks the question and offers one answer box", () => {
    const html = render();
    expect(html).toContain("Which todo-list behaviour should I fix?");
    expect(html.split("<textarea").length - 1).toBe(1);
    expect(html).toContain("Skip");
  });

  // A list of answers is prose, not code: each answer is a row in the UI face
  // that wraps, and a better answer than the listed ones can still be typed.
  it("draws plain answers as wrapping rows and still takes a typed one", () => {
    const options = ["A pending draft in .klide/memory/proposals/, excluded from recall until a person accepts it", "A reviewed entry"];
    const html = render({ choices: { options }, onChoose: () => {} });
    expect(html).toContain(`<span style="min-width:0;overflow-wrap:anywhere;padding-top:1.5px">${options[0]}</span>`);
    expect(html).not.toContain("white-space:nowrap");
    expect(html).toContain("Something else…");
  });

  it("keeps model lists mono and takes no typed answer on a dispatch", () => {
    const html = render({ choices: { kind: "dispatch", options: ["codex"], preselected: "codex", preselectedModel: "gpt-5" }, onChoose: () => {} });
    expect(html).toMatch(/white-space:nowrap;font-family:var\(--font-mono\)[^>]*>gpt-5</);
    expect(html).not.toContain("Something else…");
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

  // A model that writes the answers into the question and offers only their
  // letters gets them moved onto the rows, and the pick carries the line.
  it("lifts lettered answers out of the question onto the rows", () => {
    const question = "Q4 · What happens?\n\nA. It reads fine.\nB. The Workspace refuses it.\nC) Redacted.\nD. Refused everywhere.";
    expect(liftLetteredChoices(question, ["A", "B", "C", "D"])).toEqual({
      question: "Q4 · What happens?",
      options: ["A. It reads fine.", "B. The Workspace refuses it.", "C. Redacted.", "D. Refused everywhere."],
      labels: ["It reads fine.", "The Workspace refuses it.", "Redacted.", "Refused everywhere."],
    });
    const html = render({ question, choices: { options: ["A", "B", "C", "D"] }, onChoose: () => {} });
    expect(html).toContain(">The Workspace refuses it.</span>");
    expect(html).not.toContain("B. The Workspace");
  });

  it("leaves real answers and unmatched letters alone", () => {
    expect(liftLetteredChoices("Which?", ["Yes", "No"])).toBeNull();
    expect(liftLetteredChoices("Which?\nA. one", ["A", "B"])).toBeNull();
  });

  // Each answer wears its letter as a keycap, and the typed answer is the
  // next letter down — the row after the last answer, not a box in the foot.
  it("letters the answers and the something-else row after them", () => {
    const html = render({ choices: { options: ["Postgres", "Redis"] }, onChoose: () => {} });
    expect(html).toMatch(/klide-choice-key">A<[\s\S]*klide-choice-key">B<[\s\S]*klide-choice-key">C<[\s\S]*Something else…/);
  });

  it("picks by letter whatever the layout, and by digit by key code", () => {
    expect(choiceIndexForKey({ key: "a", code: "KeyQ" })).toBe(0);
    expect(choiceIndexForKey({ key: "C", code: "KeyC" })).toBe(2);
    expect(choiceIndexForKey({ key: "&", code: "Digit1" })).toBe(0);
    expect(choiceIndexForKey({ key: "a", code: "KeyA", metaKey: true })).toBe(-1);
    expect(choiceIndexForKey({ key: "Enter", code: "Enter" })).toBe(-1);
  });

  it("titles the question with its first line and keeps the rest as its reason", () => {
    expect(splitQuestion("Which store?\nEvery request reads it.")).toEqual({ title: "Which store?", detail: "Every request reads it." });
    expect(splitQuestion("  Which store?  ")).toEqual({ title: "Which store?", detail: "" });
  });
});
