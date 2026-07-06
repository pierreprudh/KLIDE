// Lane layout for the Git Review history graph.
//
// Input: commits from `git_graph` (all refs, topo order, newest first, with
// parent hashes). Output: one GraphRow per commit describing everything the
// renderer needs to draw that row's slice of the graph — the node's column,
// straight pass-through lines, and the curves entering/leaving the node.
//
// The algorithm is the classic single-pass lane walk: `active[i]` holds the
// commit hash lane `i` is waiting to see next. When a commit appears, every
// lane waiting for it collapses into its node; its parents then claim lanes —
// the first parent inherits the node's lane (same line continues), later
// parents (merges) either join a lane that already expects them or open a
// new one.

export type GraphCommit = {
  hash: string;
  shortHash: string;
  parents: string[];
  subject: string;
  author: string;
  /** Unix seconds. */
  timestamp: number;
  /** Decorations: "HEAD -> main", "origin/main", "tag: v1". */
  refs: string[];
};

type Line = { lane: number; color: number };

export type GraphRow = {
  commit: GraphCommit;
  /** Column of this commit's node. */
  lane: number;
  /** Color index of the node's line (renderer maps it onto a palette). */
  color: number;
  /** Lanes that pass straight through this row without touching the node. */
  passThrough: Line[];
  /** Top-half curves: row top at `lane` down into the node. */
  intoNode: Line[];
  /** Bottom-half curves: node out to row bottom at `lane`. */
  outOfNode: Line[];
  /** Lanes occupied at this row — drives the graph column width. */
  width: number;
};

export function layoutGraph(commits: GraphCommit[]): GraphRow[] {
  const active: (string | null)[] = [];
  const laneColor: number[] = [];
  let nextColor = 0;

  const rows: GraphRow[] = [];
  for (const commit of commits) {
    // Every lane waiting for this commit merges into its node.
    const nodeLanes: number[] = [];
    for (let i = 0; i < active.length; i++) {
      if (active[i] === commit.hash) nodeLanes.push(i);
    }

    const intoNode: Line[] = nodeLanes.map((lane) => ({ lane, color: laneColor[lane] }));

    let lane: number;
    let color: number;
    if (nodeLanes.length === 0) {
      // A branch tip nobody was waiting for — open a lane in the first gap.
      lane = active.indexOf(null);
      if (lane < 0) lane = active.length;
      color = nextColor++;
      laneColor[lane] = color;
    } else {
      lane = Math.min(...nodeLanes);
      color = laneColor[lane];
    }

    // Lanes not involved with the node run straight through.
    const passThrough: Line[] = [];
    for (let i = 0; i < active.length; i++) {
      if (active[i] !== null && !nodeLanes.includes(i)) {
        passThrough.push({ lane: i, color: laneColor[i] });
      }
    }

    for (const l of nodeLanes) active[l] = null;

    const outOfNode: Line[] = [];
    for (let p = 0; p < commit.parents.length; p++) {
      const parent = commit.parents[p];
      const existing = active.indexOf(parent);
      if (existing >= 0) {
        // Another lane already expects this parent — our line joins it there.
        outOfNode.push({ lane: existing, color: laneColor[existing] });
        continue;
      }
      let target: number;
      if (p === 0) {
        // First parent continues the node's own line.
        target = lane;
        laneColor[target] = color;
      } else {
        target = active.indexOf(null);
        if (target < 0) target = active.length;
        laneColor[target] = nextColor++;
      }
      active[target] = parent;
      outOfNode.push({ lane: target, color: laneColor[target] });
    }

    // Trim lanes that have gone quiet so the graph column stays narrow.
    while (active.length > 0 && active[active.length - 1] === null) active.pop();

    const involved = [lane, ...passThrough.map((l) => l.lane), ...intoNode.map((l) => l.lane), ...outOfNode.map((l) => l.lane)];
    rows.push({
      commit,
      lane,
      color,
      passThrough,
      intoNode,
      outOfNode,
      width: Math.max(active.length, ...involved.map((l) => l + 1)),
    });
  }
  return rows;
}

/** Split a decoration list into renderable ref parts. "HEAD -> main" marks
 *  the current branch; "tag: v1" is a tag; names with a slash are remotes. */
export type RefPart = { name: string; kind: "head" | "local" | "remote" | "tag" };

export function splitRefs(refs: string[]): RefPart[] {
  return refs.map((ref) => {
    if (ref.startsWith("HEAD -> ")) return { name: ref.slice("HEAD -> ".length), kind: "head" as const };
    if (ref.startsWith("tag: ")) return { name: ref.slice("tag: ".length), kind: "tag" as const };
    if (ref.includes("/")) return { name: ref, kind: "remote" as const };
    return { name: ref, kind: "local" as const };
  });
}
