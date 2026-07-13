// Race dispatch — one task, N agents, N isolated worktrees.
//
// The Superset/Orca pattern with Klide's trust model: each agent gets its own
// linked git worktree (so parallel edits can't collide) and runs through the
// single Rust harness. Runs are HEADLESS — no AI panel is mounted, the run
// loop lives in Rust and Mission Control follows it via run summaries and the
// global `agent-run:{id}` broadcast. Two consequences the defaults encode:
//
// - `requireDiffReview: false` — a headless run has no panel to answer a diff
//   prompt, so edits auto-apply. Safe because every applied edit still writes
//   a rollback checkpoint and the worktree isolates the blast radius.
// - Command permissions still gate. A run that hits one pauses and surfaces
//   in Mission Control's attention queue, where resuming opens a panel.

import { invoke } from "@tauri-apps/api/core";
import { addRace, type RaceGroup, type RaceMember } from "../races";
import { worktreeName, type WorktreeInfo } from "../worktrees";
import { startAgentRun } from "./client";
import type { ProviderId } from "./types";

export type RaceAgentPick = {
  provider: ProviderId;
  model: string;
};

export async function dispatchRace(opts: {
  prompt: string;
  workspaceRoot: string;
  agents: RaceAgentPick[];
}): Promise<RaceGroup> {
  const stamp = Date.now().toString(36);
  const members: RaceMember[] = [];
  const failures: string[] = [];

  // Sequential on purpose: `git worktree add` mutates .git/worktrees and two
  // concurrent adds from the same checkout can race each other.
  for (const [i, agent] of opts.agents.entries()) {
    const branch = `klide/race-${stamp}-${i + 1}`;
    try {
      const wt = await invoke<WorktreeInfo>("git_worktree_add", {
        workspaceRoot: opts.workspaceRoot,
        branch,
        copyFiles: null,
      });
      const session = await startAgentRun(
        {
          workspaceRoot: wt.path,
          mode: "goal",
          provider: agent.provider,
          model: agent.model,
          text: opts.prompt,
          attachments: [],
          requireDiffReview: false,
        },
        // Headless: progress is read from summaries / the global broadcast,
        // not this request-scoped channel.
        () => {},
      );
      members.push({
        runId: session.runId,
        provider: agent.provider,
        model: agent.model,
        worktreePath: wt.path,
        branch: wt.branch,
        worktree: worktreeName(wt),
      });
    } catch (err) {
      failures.push(
        `${agent.provider}/${agent.model}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (members.length === 0) {
    throw new Error(`Race failed — no run started. ${failures.join(" · ")}`);
  }

  const group: RaceGroup = {
    id: `race_${stamp}`,
    prompt: opts.prompt,
    workspaceRoot: opts.workspaceRoot,
    createdMs: Date.now(),
    members,
  };
  addRace(group);

  if (failures.length > 0) {
    // Partial race: the started runs keep going; the caller reports this.
    throw new PartialRaceError(group, failures);
  }
  return group;
}

/** Some agents launched, some didn't. The group is already saved — the caller
 *  should surface the failures but treat the race as live. */
export class PartialRaceError extends Error {
  readonly group: RaceGroup;
  readonly failures: string[];

  constructor(group: RaceGroup, failures: string[]) {
    super(`Race partially failed: ${failures.join(" · ")}`);
    this.name = "PartialRaceError";
    this.group = group;
    this.failures = failures;
  }
}
