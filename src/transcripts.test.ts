import { describe, expect, it } from "vitest";
import {
  compactConversationMessages,
  isProcessNote,
  runMessagesToMarkdown,
} from "./transcripts";
import type { RunMessage } from "./runs";

describe("isProcessNote", () => {
  it("flags running commentary", () => {
    expect(isProcessNote("I found the bug in the parser.")).toBe(true);
    expect(isProcessNote("Build is green.")).toBe(true);
  });

  it("treats substantive replies as real messages", () => {
    expect(isProcessNote("Here is the summary you asked for: the cache evicts on write.")).toBe(false);
    expect(isProcessNote("")).toBe(false);
  });

  it("does not collapse very long turns even if they start like a note", () => {
    expect(isProcessNote(`I found ${"x".repeat(1000)}`)).toBe(false);
  });
});

describe("compactConversationMessages", () => {
  it("keeps real messages and collapses process notes into a stack", () => {
    const msgs: RunMessage[] = [
      { role: "user", text: "Fix the test." },
      { role: "assistant", text: "I found the failing assertion." },
      { role: "assistant", text: "Here is the fix, applied and verified." },
    ];
    const items = compactConversationMessages(msgs);
    expect(items.map((i) => i.type)).toEqual(["message", "process", "message"]);
    const stack = items[1];
    expect(stack.type === "process" && stack.notes).toEqual(["I found the failing assertion."]);
  });

  it("hoists a tool-only assistant turn onto the previous assistant message", () => {
    const msgs: RunMessage[] = [
      { role: "assistant", text: "Applying the patch now." },
      { role: "assistant", text: "", tools: [{ name: "write_file", status: "finished" }] },
    ];
    const items = compactConversationMessages(msgs);
    expect(items).toHaveLength(1);
    expect(items[0].type === "message" && items[0].tools.map((t) => t.name)).toEqual(["write_file"]);
  });
});

describe("runMessagesToMarkdown", () => {
  it("renders a header, turns, and tool blocks using the passed label", () => {
    const md = runMessagesToMarkdown(
      { title: "Fix parser", id: "run-1", model: "opus", cwd: null, branch: null, worktree: null },
      [
        { role: "user", text: "Go." },
        {
          role: "assistant",
          text: "Done.",
          tools: [{ name: "write_file", input: { path: "a.ts" }, result: "ok" }],
        },
      ],
      "Klide",
    );
    expect(md).toContain("# Fix parser");
    expect(md).toContain("- Source: Klide");
    expect(md).toContain("- Run: `run-1`");
    expect(md).toContain("## User\n\nGo.");
    expect(md).toContain("## Klide\n\nDone.");
    expect(md).toContain("Tool: `write_file`");
    expect(md).toContain('"path": "a.ts"');
  });
});
