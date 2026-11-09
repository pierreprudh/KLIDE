import { describe, expect, it } from "vitest";
import { designDockWidth, designTask, isInterfaceConversation, sortTokens, type ReviewItem } from "./designReview";

const base = { epoch: 1, elementId: 3, component: "AiPanel › InlineCommandReview", where: "span “Run the checks.”" };
const items: ReviewItem[] = [
  { ...base, kind: "edit", id: 1, prop: "color", label: "Text colour", from: "var(--fg-subtle)", to: "var(--fg)" },
  { ...base, kind: "comment", id: 2, n: 1, text: "Quieter than the answer", resolved: false },
  { ...base, kind: "comment", id: 3, n: 2, text: "Already fine", resolved: true },
];

describe("designTask", () => {
  it("lists exact edits and open comments under their component, never resolved ones", () => {
    const task = designTask(items, "  keep it calm ", "localhost:5173");
    expect(task).toContain("Design review of localhost:5173.");
    expect(task).toContain("AiPanel › InlineCommandReview\n- span “Run the checks.”: text colour var(--fg-subtle) → var(--fg)\n- span “Run the checks.”: Quieter than the answer");
    expect(task).not.toContain("Already fine");
    expect(task.endsWith("Also: keep it calm")).toBe(true);
  });
  it("groups elements no component claims under Page", () => {
    expect(designTask([{ ...items[0], component: "" }], "", null)).toContain("Page\n- span");
  });
});

describe("sortTokens", () => {
  const rgb = (v: string) => `rgb(${v})`;
  it("sorts a page's own custom properties into colour, size and radius rows", () => {
    const sorted = sortTokens({
      "--fg": "#1c1b18", "--fg-muted": "#6b6a66", "--accent": "#2596be", "--bg": "#fffefc", "--bg-panel": "#f7f6f2",
      "--diff-add-bg": "#e6f4ea", "--fs-md": "14px", "--fs-xs": "12px", "--radius-lg": "8px", "--radius-sm": "4px", "--ease-out": "cubic-bezier(0,0,1,1)",
    }, rgb);
    expect(sorted.text.map(t => t.name)).toEqual(["--fg", "--fg-muted", "--accent"]);
    expect(sorted.surface.map(t => t.name)).toEqual(["--bg", "--bg-panel"]);
    expect(sorted.sizes.map(t => t.short)).toEqual(["xs", "md"]);
    expect(sorted.radii.map(t => t.short)).toEqual(["sm", "lg"]);
    expect(sorted.text[0].rgb).toBe("rgb(#1c1b18)");
  });
  it("offers nothing for a page without tokens", () => {
    expect(sortTokens({}, rgb)).toEqual({ text: [], surface: [], sizes: [], radii: [] });
  });
});

describe("isInterfaceConversation", () => {
  it("is about the interface when you talk about it or the work touches rendered files", () => {
    expect(isInterfaceConversation([{ role: "user", content: "The button spacing feels off" }])).toBe(true);
    expect(isInterfaceConversation([{ role: "user", content: "fix it" }, { role: "assistant", content: "", toolCalls: [{ args: { path: "src/App.tsx" } }] }])).toBe(true);
    expect(isInterfaceConversation([{ role: "assistant", content: "I changed styles/site.css." }])).toBe(true);
  });
  it("is not for backend or prose work", () => {
    expect(isInterfaceConversation([{ role: "user", content: "Why does the Rust test hang?" }, { role: "assistant", content: "", toolCalls: [{ args: { path: "src-tauri/src/lib.rs" } }] }])).toBe(false);
    expect(isInterfaceConversation([])).toBe(false);
    // The assistant's own wording does not make a conversation about UI.
    expect(isInterfaceConversation([{ role: "user", content: "summarise the logs" }, { role: "assistant", content: "Here is the layout of the logs" }])).toBe(false);
  });
});

describe("designDockWidth", () => {
  it("leaves the conversation at least 360px and never goes below a usable canvas", () => {
    expect(designDockWidth(1440)).toBe(835);
    expect(designDockWidth(2560)).toBe(1100);
    expect(designDockWidth(1000)).toBe(580);
    expect(designDockWidth(800)).toBe(440); // a small window: the conversation keeps its 360px
  });
});
