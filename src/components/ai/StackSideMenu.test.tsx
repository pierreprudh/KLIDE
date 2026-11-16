import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { inTriangle, StackSideMenu, type Stack } from "./StackSideMenu";

const row = (id: string, extra: Partial<Stack["rows"][number]> = {}) => ({
  id,
  label: id,
  icon: null,
  onPick: () => {},
  ...extra,
});

const stacks: Stack[] = [
  { label: "Local", rows: [row("ollama")] },
  { label: "API", rows: [row("mistral", { dimmed: true, leadout: true }), row("anthropic", { active: true }), row("groq")] },
];

describe("StackSideMenu", () => {
  it("opens on the stack holding the choice, runnable rows first", () => {
    const html = renderToStaticMarkup(<StackSideMenu stacks={stacks} />);
    expect(html).toContain('aria-label="API"');
    const order = ["anthropic", "groq", "mistral"].map((id) => html.indexOf(`>${id}</span>`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).toContain('data-active="true"');
  });

  it("opens on the first stack when nothing is chosen", () => {
    const html = renderToStaticMarkup(<StackSideMenu stacks={[stacks[0], { label: "API", rows: [row("groq")] }]} />);
    expect(html).toContain('aria-label="Local"');
  });

  // Menu-aim: a step toward the card stays inside the triangle from where the
  // pointer was to the card's near edge; a step away or straight down leaves it.
  it("tells a step toward the card from one along the menu", () => {
    const from = { x: 100, y: 120 };
    const top = { x: 200, y: 60 };
    const bottom = { x: 200, y: 400 };
    expect(inTriangle({ x: 110, y: 130 }, from, top, bottom)).toBe(true);
    expect(inTriangle({ x: 102, y: 160 }, from, top, bottom)).toBe(false);
    expect(inTriangle({ x: 90, y: 125 }, from, top, bottom)).toBe(false);
  });
});
