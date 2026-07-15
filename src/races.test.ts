import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addRace, listRaces, raceForRun, removeRace, subscribeRaces, type RaceGroup } from "./races";
import { memoryStorage } from "./testStorage";

function race(overrides: Partial<RaceGroup> = {}): RaceGroup {
  return {
    id: "race_one",
    prompt: "Fix the flaky checkout test",
    workspaceRoot: "/workspace",
    createdMs: 100,
    members: [
      {
        runId: "run_a",
        provider: "ollama",
        model: "klide-8b",
        worktreePath: "/workspace-worktrees/race-one-1",
        branch: "klide/race-one-1",
        worktree: "race-one-1",
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("race persistence", () => {
  it("scopes, finds, removes, and notifies for valid race groups", () => {
    const snapshots: string[][] = [];
    const unsubscribe = subscribeRaces((groups) => snapshots.push(groups.map((group) => group.id)));

    addRace(race());
    addRace(race({
      id: "race_other",
      workspaceRoot: "/other",
      createdMs: 200,
      members: [{ ...race().members[0], runId: "run_other" }],
    }));

    expect(listRaces("/workspace").map((group) => group.id)).toEqual(["race_one"]);
    expect(raceForRun("run_a")?.id).toBe("race_one");
    expect(snapshots).toEqual([[], ["race_one"], ["race_one", "race_other"]]);

    removeRace("race_one");
    expect(raceForRun("run_a")).toBeNull();
    unsubscribe();
  });

  it("drops malformed persisted groups and members", () => {
    localStorage.setItem(
      "klide.races",
      JSON.stringify([
        race(),
        race({ id: "bad_time", createdMs: Number.NaN }),
        { ...race({ id: "bad_member" }), members: [{ runId: "run_only" }] },
      ]),
    );

    expect(listRaces().map((group) => group.id)).toEqual(["race_one"]);
  });

  it("keeps only the newest forty groups", () => {
    for (let i = 0; i < 45; i += 1) {
      addRace(race({ id: `race_${i}`, createdMs: i }));
    }

    const groups = listRaces();
    expect(groups).toHaveLength(40);
    expect(groups[0].id).toBe("race_44");
    expect(groups[groups.length - 1]?.id).toBe("race_5");
  });
});
