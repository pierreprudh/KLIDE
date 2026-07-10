import { describe, expect, it } from "vitest";
import type { DiffBlock } from "./components/diffView";
import { commentFromBlocks, fileOfBlock, formatDiffComment } from "./diffComments";

const line = (
  tone: "add" | "del" | "ctx",
  oldNo: number | null,
  newNo: number | null,
  code: string
): DiffBlock => ({ kind: "line", tone, oldNo, newNo, code });

const blocks: DiffBlock[] = [
  { kind: "file", path: "src/app.ts" },
  { kind: "hunk", text: "fn main" },
  line("ctx", 10, 10, "const a = 1;"),
  line("del", 11, null, "const b = old();"),
  line("add", null, 11, "const b = fresh();"),
  line("ctx", 12, 12, "return b;"),
  { kind: "file", path: "src/other.ts" },
  line("del", 3, null, "gone();"),
  line("del", 4, null, "gone too();"),
];

describe("fileOfBlock", () => {
  it("resolves the nearest file header above", () => {
    expect(fileOfBlock(blocks, 3)).toBe("src/app.ts");
    expect(fileOfBlock(blocks, 8)).toBe("src/other.ts");
    expect(fileOfBlock([line("ctx", 1, 1, "x")], 0)).toBeNull();
  });
});

describe("commentFromBlocks", () => {
  it("anchors mixed selections to the new file with signed excerpt", () => {
    const c = commentFromBlocks(blocks, 2, 5, "  b should stay lazy  ");
    expect(c).not.toBeNull();
    expect(c!.path).toBe("src/app.ts");
    expect(c!.side).toBe("new");
    expect(c!.startLine).toBe(10);
    expect(c!.endLine).toBe(12);
    expect(c!.excerpt).toEqual([
      "  const a = 1;",
      "- const b = old();",
      "+ const b = fresh();",
      "  return b;",
    ]);
    expect(c!.text).toBe("b should stay lazy");
  });

  it("an all-deleted selection anchors to the old side", () => {
    const c = commentFromBlocks(blocks, 7, 8, "why was this removed?");
    expect(c!.side).toBe("old");
    expect(c!.startLine).toBe(3);
    expect(c!.endLine).toBe(4);
    expect(c!.path).toBe("src/other.ts");
  });

  it("handles reversed ranges and rejects line-less ranges", () => {
    const reversed = commentFromBlocks(blocks, 5, 2, "note");
    expect(reversed!.startLine).toBe(10);
    expect(commentFromBlocks(blocks, 0, 1, "no code selected")).toBeNull();
  });

  it("caps long excerpts", () => {
    const many: DiffBlock[] = [
      { kind: "file", path: "big.ts" },
      ...Array.from({ length: 30 }, (_, i) => line("add", null, i + 1, `l${i + 1}`)),
    ];
    const c = commentFromBlocks(many, 1, 30, "trim this");
    expect(c!.excerpt).toHaveLength(25);
    expect(c!.excerpt[24]).toContain("6 more selected lines");
  });
});

describe("formatDiffComment", () => {
  it("renders the contract with side-aware wording", () => {
    const text = formatDiffComment(commentFromBlocks(blocks, 3, 4, "keep old name")!);
    expect(text).toContain("Review comment on src/app.ts, line 11:");
    expect(text).toContain("> - const b = old();");
    expect(text).toContain('Comment: keep old name');

    const oldSide = formatDiffComment(commentFromBlocks(blocks, 7, 8, "restore")!);
    expect(oldSide).toContain("lines 3-4 (deleted lines — numbers refer to the previous version)");
  });
});
