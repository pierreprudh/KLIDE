import { describe, expect, it } from "vitest";
import {
  buildChildIndex,
  buildRaceRowIndex,
  buildRunLedger,
  clusterRaceRows,
  filterLedgerEntries,
  groupLedgerBySection,
  isClaudeInternalSubagent,
  presentProjects,
  projectMatchesFilter,
  runLedgerKey,
  type RunLedgerMetadataStore,
} from "./runLedger";
import type { Run } from "./runs";
import type { KlideConvo } from "./klideConvos";
import type { TaskSession } from "./tasks";

const ROOT = "/Users/pierre/Documents/Private/KIDE";
const ROOT_NAME = "KIDE";

function diskRun(over: Partial<Run> = {}): Run {
  return {
    id: "r1",
    path: `/runs/r1.jsonl`,
    source: "klide",
    kind: "run",
    title: "On-disk run",
    status: "done",
    model: "qwen2.5:7b",
    project: "KIDE",
    cwd: ROOT,
    branch: null,
    messageCount: 6,
    updatedMs: 2_000,
    createdMs: 1_000,
    ...over,
  };
}

function convo(over: Partial<KlideConvo> = {}): KlideConvo {
  return {
    id: "c1",
    title: "Live convo",
    status: "running",
    model: "qwen2.5:7b",
    cwd: ROOT,
    branch: null,
    messages: [],
    updatedMs: 3_000,
    ...over,
  };
}

function task(over: Partial<TaskSession> = {}): TaskSession {
  return {
    id: "t1",
    title: "Delegated todo",
    source: null,
    model: null,
    status: "queued",
    workspaceRoot: ROOT,
    cwd: ROOT,
    branch: null,
    worktree: null,
    startedMs: 500,
    ...over,
  };
}

function build(over: Partial<Parameters<typeof buildRunLedger>[0]> = {}) {
  return buildRunLedger({ tasks: [], convos: [], runs: [], workspaceRoot: ROOT, ...over });
}

describe("buildRunLedger", () => {
  it("drops a live convo once its on-disk twin exists", () => {
    // A Klide convo id IS its transcript id, so a settled run appears twice —
    // once from the in-memory convo store, once from disk. The on-disk copy
    // wins because it carries the enriched summary (tokens, validation).
    const entries = build({
      convos: [convo({ id: "shared", title: "from convo" })],
      runs: [diskRun({ id: "shared", title: "from disk" })],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe("from disk");
    expect(entries[0].origin).toBe("transcript");
  });

  it("keeps a live convo that has no twin yet", () => {
    const entries = build({ convos: [convo({ id: "fresh" })] });
    expect(entries.map((e) => e.origin)).toEqual(["klide-convo"]);
  });

  it("hides convos belonging to another workspace but keeps cwd-less ones", () => {
    const entries = build({
      convos: [
        convo({ id: "here", cwd: ROOT }),
        convo({ id: "elsewhere", cwd: "/Users/pierre/Documents/Other" }),
        convo({ id: "no-cwd", cwd: null }),
      ],
    });
    expect(entries.map((e) => e.id).sort()).toEqual(["here", "no-cwd"]);
  });

  it("orders tasks, then live convos, then disk runs", () => {
    const entries = build({
      tasks: [task({ id: "t" })],
      convos: [convo({ id: "c" })],
      runs: [diskRun({ id: "r" })],
    });
    expect(entries.map((e) => e.id)).toEqual(["t", "c", "r"]);
  });

  it("applies a renamed title without losing the original", () => {
    const run = diskRun();
    const metadata: RunLedgerMetadataStore = {
      [runLedgerKey(run)]: { title: "  My name for it  " },
    };
    const [entry] = build({ runs: [run], metadata });
    expect(entry.title).toBe("My name for it");
    expect(entry.originalTitle).toBe("On-disk run");

    // A rename cleared to whitespace falls back to the parsed title rather
    // than leaving a blank row.
    const blank: RunLedgerMetadataStore = { [runLedgerKey(run)]: { title: "   " } };
    expect(build({ runs: [run], metadata: blank })[0].title).toBe("On-disk run");
  });

  it("hides archived entries unless asked for them", () => {
    const run = diskRun();
    const metadata: RunLedgerMetadataStore = { [runLedgerKey(run)]: { archived: true } };
    expect(build({ runs: [run], metadata })).toHaveLength(0);
    const [entry] = build({ runs: [run], metadata, showArchived: true });
    expect(entry.archived).toBe(true);
  });

  it("dismisses board runs but never a task", () => {
    // Tasks are explicit assignments the user created; dismissing is for
    // finished agent runs cluttering the board, so it must not swallow a todo.
    const entries = build({
      tasks: [task({ id: "t1" })],
      runs: [diskRun({ id: "r1" })],
      dismissedBoardRuns: new Set(["klide:t1", "klide:r1"]),
      dismissKey: runLedgerKey,
    });
    expect(entries.map((e) => e.id)).toEqual(["t1"]);
  });

  it("gives every delegate the same resume and terminal capabilities", () => {
    // The board used to hardcode claude-code || codex || opencode in three
    // places, so omp runs silently lost their resume affordance. Capabilities
    // come off `isDelegateId` instead, which covers all four.
    for (const source of ["claude-code", "codex", "opencode", "omp"] as const) {
      const [entry] = build({ runs: [diskRun({ source })] });
      expect(entry.capabilities.canResume, source).toBe(true);
      expect(entry.capabilities.canOpenTerminal, source).toBe(true);
      // Evidence packets render from Klide's own AgentEvent transcript only.
      expect(entry.capabilities.canExportEvidence, source).toBe(false);
    }

    const [klide] = build({ runs: [diskRun({ source: "klide" })] });
    expect(klide.capabilities.canResume).toBe(true);
    expect(klide.capabilities.canExportEvidence).toBe(true);
  });

  it("withholds rename and archive while a run is still active", () => {
    const [running] = build({ runs: [diskRun({ status: "running" })] });
    expect(running.capabilities.canRename).toBe(false);
    expect(running.capabilities.canArchive).toBe(false);

    const [done] = build({ runs: [diskRun({ status: "done" })] });
    expect(done.capabilities.canRename).toBe(true);
    expect(done.capabilities.canArchive).toBe(true);
  });

  it("marks a finished task as needing review, not done", () => {
    const [entry] = build({ tasks: [task({ status: "done" })] });
    expect(entry.lifecycle).toBe("needs_review");
  });
});

describe("projectMatchesFilter", () => {
  it("matches the current workspace by cwd even when the parsed project is missing", () => {
    const run = {
      project: null,
      cwd: "/Users/pierre/Documents/Private/KIDE",
    };

    expect(projectMatchesFilter(run, "KIDE", "/Users/pierre/Documents/Private/KIDE")).toBe(true);
  });

  it("matches by cwd basename as a fallback for stale project strings", () => {
    const run = {
      project: "Private",
      cwd: "/Users/pierre/Documents/Private/KIDE",
    };

    expect(projectMatchesFilter(run, "KIDE", "/Users/pierre/Documents/Private/KIDE")).toBe(true);
  });

  it("matches runs executing in a linked worktree of the filtered project", () => {
    // Races and worktree forks run in `<repo>-worktrees/<name>` — they must
    // stay visible under the default current-project filter.
    const run = {
      project: null,
      cwd: "/Users/pierre/Documents/Private/KIDE-worktrees/race-m3abc-1",
    };

    expect(projectMatchesFilter(run, "KIDE", "/Users/pierre/Documents/Private/KIDE")).toBe(true);
  });

  it("does not leak another project's worktree runs into the filter", () => {
    const run = {
      project: null,
      cwd: "/Users/pierre/Documents/Other-worktrees/race-m3abc-1",
    };

    expect(projectMatchesFilter(run, "KIDE", "/Users/pierre/Documents/Private/KIDE")).toBe(false);
  });
});

describe("presentProjects", () => {
  it("includes projects recoverable from cwd", () => {
    expect(presentProjects([{ project: null, cwd: "/Users/pierre/Documents/Private/KIDE" }])).toEqual(["KIDE"]);
  });
});

describe("board model", () => {
  const raceGroups = [
    { id: "race-1", prompt: "Add a README section", members: [{ runId: "a" }, { runId: "b" }] },
  ];

  it("indexes race members with stable letters", () => {
    const index = buildRaceRowIndex(raceGroups);
    expect(index.get("a")).toMatchObject({ groupId: "race-1", memberIndex: 0, label: "A", size: 2 });
    expect(index.get("b")?.label).toBe("B");
    expect(index.get("c")).toBeUndefined();
  });

  it("pulls race siblings adjacent without disturbing everyone else", () => {
    // A race must read as one comparison block. Recency alone scatters the two
    // members around whatever else finished between them.
    const rows = [
      diskRun({ id: "a", updatedMs: 500 }),
      diskRun({ id: "unrelated", updatedMs: 400 }),
      diskRun({ id: "b", updatedMs: 300 }),
    ].map((r) => build({ runs: [r] })[0]);

    const clustered = clusterRaceRows(rows, buildRaceRowIndex(raceGroups));
    expect(clustered.map((r) => r.id)).toEqual(["a", "b", "unrelated"]);
    // Each row appears exactly once — the sibling pull must not duplicate.
    expect(new Set(clustered.map((r) => r.id)).size).toBe(3);
  });

  it("leaves rows untouched when nothing is racing", () => {
    const rows = build({ runs: [diskRun({ id: "x" }), diskRun({ id: "y" })] });
    expect(clusterRaceRows(rows, new Map()).map((r) => r.id)).toEqual(["x", "y"]);
  });

  it("composes every filter, including the live-strip exclusion", () => {
    const entries = build({
      runs: [
        diskRun({ id: "live", source: "klide" }),
        diskRun({ id: "codex-run", source: "codex", title: "parser work" }),
        diskRun({ id: "elsewhere", cwd: "/Users/pierre/Documents/Other", project: "Other" }),
      ],
    });

    const filter = {
      liveConvoIds: new Set(["live"]),
      source: "all" as const,
      project: ROOT_NAME,
      workspaceRoot: ROOT,
    };
    // "live" is rendered in the Live now strip; listing it again would double it.
    expect(filterLedgerEntries(entries, filter).map((e) => e.id)).toEqual(["codex-run"]);

    // Each predicate composes with the others.
    expect(
      filterLedgerEntries(entries, { ...filter, source: "codex" }).map((e) => e.id)
    ).toEqual(["codex-run"]);
    expect(
      filterLedgerEntries(entries, { ...filter, query: "parser" }).map((e) => e.id)
    ).toEqual(["codex-run"]);
    expect(filterLedgerEntries(entries, { ...filter, query: "nothing-matches" })).toEqual([]);
  });

  it("sorts sections newest-first with a stable id tiebreak", () => {
    // The tiebreak is why rows already on screen don't reshuffle when older
    // runs page in: without it the order followed [tasks, convos, runs].
    const entries = build({
      runs: [
        diskRun({ id: "b", updatedMs: 100 }),
        diskRun({ id: "a", updatedMs: 100 }),
        diskRun({ id: "newer", updatedMs: 900 }),
      ],
    });
    const sections = groupLedgerBySection(entries);
    expect(sections.done.map((e) => e.id)).toEqual(["newer", "b", "a"]);

    // Re-grouping a shuffled input gives byte-identical order.
    const shuffled = groupLedgerBySection([entries[1], entries[2], entries[0]]);
    expect(shuffled.done.map((e) => e.id)).toEqual(["newer", "b", "a"]);
  });

  it("routes runs to the section their lifecycle implies", () => {
    const sections = groupLedgerBySection(
      build({
        tasks: [task({ id: "todo", status: "queued" })],
        runs: [
          diskRun({ id: "failed", status: "error" }),
          diskRun({ id: "finished", status: "done" }),
        ],
      })
    );
    expect(sections.blocked.map((e) => e.id)).toEqual(["failed"]);
    expect(sections.done.map((e) => e.id)).toEqual(["finished"]);
    expect(sections.running.map((e) => e.id)).toEqual(["todo"]);
  });
});

describe("buildChildIndex", () => {
  it("keeps a finished Guardian review under its running Codex parent across board sections", () => {
    const all = build({
      runs: [
        diskRun({ id: "codex-parent", source: "codex", status: "running", updatedMs: Date.now() }),
        diskRun({
          id: "guardian-review",
          source: "codex",
          title: "Guardian review",
          parentId: "codex-parent",
          status: "done",
        }),
      ],
    });
    const sections = groupLedgerBySection(all);
    const index = buildChildIndex(all, all);

    expect(index.topLevel(sections.running).map((e) => e.id)).toEqual(["codex-parent"]);
    expect(index.topLevel(sections.blocked)).toEqual([]);
    expect(index.topLevel(sections.ready_for_review)).toEqual([]);
    expect(index.topLevel(sections.done)).toEqual([]);
    expect(index.childrenOf("codex-parent").map((e) => e.title)).toEqual(["Guardian review"]);
  });

  it("nests children under a visible parent", () => {
    const all = build({
      runs: [diskRun({ id: "parent" }), diskRun({ id: "kid", parentId: "parent" })],
    });
    const index = buildChildIndex(all, all);

    expect(index.hasChildren("parent")).toBe(true);
    expect(index.childrenOf("parent").map((e) => e.id)).toEqual(["kid"]);
    // The child renders nested, so it must not also appear at the top level.
    expect(index.topLevel(all).map((e) => e.id)).toEqual(["parent"]);
  });

  it("keeps a child flat when the filter hid its parent", () => {
    // Subagent-only view: the parent is filtered out, so its children have no
    // row to nest under. Dropping them would make the view empty.
    const all = build({
      runs: [diskRun({ id: "parent" }), diskRun({ id: "kid", parentId: "parent" })],
    });
    const visible = all.filter((e) => e.id === "kid");
    const index = buildChildIndex(all, visible);

    // The parent link is still known even though the parent isn't shown.
    expect(index.hasChildren("parent")).toBe(true);
    expect(index.topLevel(visible).map((e) => e.id)).toEqual(["kid"]);
  });

  it("orders children oldest-first, as steps the parent took", () => {
    const all = build({
      runs: [
        diskRun({ id: "parent" }),
        diskRun({ id: "second", parentId: "parent", createdMs: 200 }),
        diskRun({ id: "first", parentId: "parent", createdMs: 100 }),
      ],
    });
    const index = buildChildIndex(all, all);
    expect(index.childrenOf("parent").map((e) => e.id)).toEqual(["first", "second"]);
  });

  it("reports no children for a childless run", () => {
    const all = build({ runs: [diskRun({ id: "lonely" })] });
    const index = buildChildIndex(all, all);
    expect(index.hasChildren("lonely")).toBe(false);
    expect(index.childrenOf("lonely")).toEqual([]);
  });
});

describe("canResume", () => {
  it("is one rule the board and the detail pane both read", () => {
    // Four spellings before this: two on the board, two in the detail pane.
    const resumable = (over: Parameters<typeof diskRun>[0]) =>
      build({ runs: [diskRun(over)] })[0].capabilities.canResume;

    expect(resumable({ source: "klide", status: "done" })).toBe(true);
    expect(resumable({ source: "codex", status: "done" })).toBe(true);
    // A run still going has nothing to resume — reattach, don't restart.
    expect(resumable({ source: "codex", status: "running" })).toBe(false);
    // But one blocked on input is exactly what you want to resume.
    expect(resumable({ source: "codex", status: "waiting" })).toBe(true);
  });

  it("refuses Claude's internal subagent transcripts", () => {
    // `<parent>/subagents/<agent>.jsonl` holds turns inside the parent session,
    // not a session of its own, so there is no id to --resume.
    const internal = build({
      runs: [
        diskRun({
          id: "sub",
          source: "claude-code",
          path: "/Users/p/.claude/projects/proj/parent-1/subagents/explore.jsonl",
          status: "done",
        }),
      ],
    })[0];
    expect(isClaudeInternalSubagent(internal)).toBe(true);
    expect(internal.capabilities.canResume).toBe(false);

    // A top-level Claude session is resumable.
    const top = build({
      runs: [
        diskRun({
          id: "top",
          source: "claude-code",
          path: "/Users/p/.claude/projects/proj/parent-1.jsonl",
          status: "done",
        }),
      ],
    })[0];
    expect(isClaudeInternalSubagent(top)).toBe(false);
    expect(top.capabilities.canResume).toBe(true);
  });

  it("has nothing to resume for a convo with no transcript on disk", () => {
    // A convo-origin entry is one the ledger found no disk twin for, so the
    // harness has no transcript to continue from.
    const [entry] = build({ convos: [convo({ id: "fresh", status: "error" })] });
    expect(entry.origin).toBe("klide-convo");
    expect(entry.capabilities.canResume).toBe(false);
  });
});
