// Pure graph derivation over a Mission's task dependencies.
//
// There is no stored graph model (v0.6 slice 2: "no second graph state model").
// Nodes, layers, and edges are all computed from the same `dependencies` arrays
// the durable Markdown already owns — the graph view is a projection, exactly
// like the tier board. Rust is the durable authority for the acyclic invariant
// (`first_dependency_cycle` in missions.rs); `detectCycle`/`wouldCreateCycle`
// mirror it here so the console can refuse an edge before it round-trips to
// disk. A task depending on B means "B must be accepted before this task runs",
// so an edge points prerequisite → dependent and the layout reads left→right.

export type GraphTask = { id: string; dependencies: string[] };

export type GraphNode = { id: string; layer: number; order: number };
/** `from` is the prerequisite (upstream), `to` is the dependent (downstream). */
export type GraphEdge = { from: string; to: string };
export type MissionLayout = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Number of dependency layers (columns), at least 1. */
  layerCount: number;
  /** Widest layer's node count (rows), at least 1. */
  laneCount: number;
};

/** The first dependency cycle as ids in traversal order with the closing id
 *  repeated, or `null` when acyclic. Missing dependency ids are skipped — they
 *  are a different error the caller reports separately. Mirrors the Rust check. */
export function detectCycle(tasks: GraphTask[]): string[] | null {
  const depsById = new Map(tasks.map((task) => [task.id, task.dependencies]));
  const mark = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  function walk(node: string): string[] | null {
    mark.set(node, "visiting");
    stack.push(node);
    for (const dep of depsById.get(node) ?? []) {
      if (!depsById.has(dep)) continue; // missing dependency — not a cycle
      const state = mark.get(dep);
      if (state === "done") continue;
      if (state === "visiting") {
        return [...stack.slice(stack.indexOf(dep)), dep];
      }
      const found = walk(dep);
      if (found) return found;
    }
    stack.pop();
    mark.set(node, "done");
    return null;
  }

  for (const task of tasks) {
    if (!mark.has(task.id)) {
      const found = walk(task.id);
      if (found) return found;
    }
  }
  return null;
}

/** Would adding "`dependentId` depends on `dependencyId`" close a loop? Used to
 *  gate an edge before it is written, so the durable store never has to reject
 *  it. Depending on itself always would. */
export function wouldCreateCycle(
  tasks: GraphTask[],
  dependentId: string,
  dependencyId: string
): boolean {
  if (dependentId === dependencyId) return true;
  const next = tasks.map((task) =>
    task.id === dependentId && !task.dependencies.includes(dependencyId)
      ? { ...task, dependencies: [...task.dependencies, dependencyId] }
      : task
  );
  return detectCycle(next) !== null;
}

/** Assign every task a layer (longest path from a root) and an order within
 *  that layer, then derive the edge list. Assumes the graph is acyclic — which
 *  Rust guarantees on disk — but a defensive in-progress guard keeps a stray
 *  cycle from recursing forever. */
export function layoutMission(tasks: GraphTask[]): MissionLayout {
  const ids = new Set(tasks.map((task) => task.id));
  const depsById = new Map(
    tasks.map((task) => [task.id, task.dependencies.filter((dep) => ids.has(dep))])
  );
  const layerOf = new Map<string, number>();
  const inProgress = new Set<string>();

  function layer(id: string): number {
    const cached = layerOf.get(id);
    if (cached !== undefined) return cached;
    if (inProgress.has(id)) return 0; // cycle guard — Rust prevents this on disk
    inProgress.add(id);
    const deps = depsById.get(id) ?? [];
    const value = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(layer));
    inProgress.delete(id);
    layerOf.set(id, value);
    return value;
  }

  for (const task of tasks) layer(task.id);

  const orderInLayer = new Map<number, number>();
  const nodes: GraphNode[] = tasks.map((task) => {
    const l = layerOf.get(task.id) ?? 0;
    const order = orderInLayer.get(l) ?? 0;
    orderInLayer.set(l, order + 1);
    return { id: task.id, layer: l, order };
  });

  const edges: GraphEdge[] = tasks.flatMap((task) =>
    (depsById.get(task.id) ?? []).map((dep) => ({ from: dep, to: task.id }))
  );

  const layerCount = Math.max(1, ...nodes.map((node) => node.layer + 1));
  const laneCount = Math.max(1, ...Array.from(orderInLayer.values()));
  return { nodes, edges, layerCount, laneCount };
}
