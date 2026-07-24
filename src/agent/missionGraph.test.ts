import { describe, expect, it } from "vitest";
import { detectCycle, layoutMission, wouldCreateCycle, type GraphTask } from "./missionGraph";

const chain: GraphTask[] = [
  { id: "a", dependencies: [] },
  { id: "b", dependencies: ["a"] },
  { id: "c", dependencies: ["a"] },
  { id: "d", dependencies: ["b", "c"] },
];

describe("mission graph", () => {
  it("finds no cycle in a diamond and layers it by longest path", () => {
    expect(detectCycle(chain)).toBeNull();
    const { nodes, edges, layerCount, laneCount } = layoutMission(chain);
    const layerOf = Object.fromEntries(nodes.map((n) => [n.id, n.layer]));
    expect(layerOf).toEqual({ a: 0, b: 1, c: 1, d: 2 });
    expect(layerCount).toBe(3);
    expect(laneCount).toBe(2); // b and c share layer 1
    // Edges point prerequisite → dependent.
    expect(edges).toContainEqual({ from: "a", to: "b" });
    expect(edges).toContainEqual({ from: "c", to: "d" });
  });

  it("detects a direct and an indirect cycle", () => {
    expect(detectCycle([
      { id: "a", dependencies: ["b"] },
      { id: "b", dependencies: ["a"] },
    ])).not.toBeNull();
    const three = detectCycle([
      { id: "a", dependencies: ["b"] },
      { id: "b", dependencies: ["c"] },
      { id: "c", dependencies: ["a"] },
    ]);
    expect(three?.[0]).toBe(three?.[three.length - 1]);
  });

  it("ignores a missing dependency id (a different error)", () => {
    expect(detectCycle([{ id: "a", dependencies: ["ghost"] }])).toBeNull();
  });

  it("guards an edge that would close a loop", () => {
    // d already depends transitively on a; making a depend on d would cycle.
    expect(wouldCreateCycle(chain, "a", "d")).toBe(true);
    expect(wouldCreateCycle(chain, "a", "a")).toBe(true);
    // b→c is a fresh, acyclic edge.
    expect(wouldCreateCycle(chain, "b", "c")).toBe(false);
  });
});
