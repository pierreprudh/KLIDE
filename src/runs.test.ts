import { describe, expect, it } from "vitest";
import { mergeRunPages, type Run } from "./runs";

function run(input: Partial<Run> & Pick<Run, "id" | "source" | "updatedMs">): Run {
  return {
    path: "",
    kind: "run",
    title: input.id,
    status: "done",
    model: null,
    project: "KIDE",
    cwd: "/Users/pierre/Documents/Private/KIDE",
    branch: null,
    messageCount: 1,
    createdMs: input.updatedMs,
    ...input,
  };
}

describe("mergeRunPages", () => {
  it("refreshes newest rows without dropping older loaded pages", () => {
    const existing = [
      run({ id: "codex-1", source: "codex", status: "done", updatedMs: 100 }),
      run({ id: "claude-old", source: "claude-code", updatedMs: 50 }),
    ];
    const incoming = [
      run({ id: "codex-1", source: "codex", status: "running", updatedMs: 200 }),
      run({ id: "claude-new", source: "claude-code", status: "running", updatedMs: 180 }),
    ];

    const merged = mergeRunPages(existing, incoming);

    expect(merged.map((r) => `${r.source}:${r.id}`)).toEqual([
      "codex:codex-1",
      "claude-code:claude-new",
      "claude-code:claude-old",
    ]);
    expect(merged[0].status).toBe("running");
  });

  it("dedupes by source and id so different tools can share ids", () => {
    const merged = mergeRunPages(
      [run({ id: "same", source: "codex", updatedMs: 100 })],
      [
        run({ id: "same", source: "codex", updatedMs: 200 }),
        run({ id: "same", source: "claude-code", updatedMs: 150 }),
      ],
    );

    expect(merged.map((r) => `${r.source}:${r.id}`)).toEqual([
      "codex:same",
      "claude-code:same",
    ]);
  });
});
