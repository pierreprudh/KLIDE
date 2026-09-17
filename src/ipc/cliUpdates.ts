// Typed frontend adapter for the `cli_version*` / `cli_update` family — which
// version of each delegate CLI this machine has, and running the CLI's own
// updater.
//
// Klide never updates a CLI on its own: an update mid-fleet changes what every
// live delegate session is running. Everything here is something the user
// asked for.

import { Channel, invoke } from "@tauri-apps/api/core";

/** What one delegate's CLI reports about itself (mirrors `cli_update::CliVersion`). */
export type CliVersion = {
  /** Klide's provider id — `claude-code`, `codex`, `opencode`, `omp`. */
  provider: string;
  binary: string;
  installed: boolean;
  /** The number alone, when the CLI's line yielded one. */
  version: string | null;
  /** The CLI's own line, verbatim. */
  raw: string | null;
  commandPath: string | null;
  /** The updater Klide would run, spelled as you'd type it. `null` hides the action. */
  updateCommand: string | null;
  /** Why there is no version, when there is none. */
  detail: string | null;
};

type CliUpdateEvent = { kind: "output"; chunk: string };

export function cliVersions(): Promise<CliVersion[]> {
  return invoke<CliVersion[]>("cli_versions");
}

export function cliVersion(provider: string): Promise<CliVersion> {
  return invoke<CliVersion>("cli_version", { provider });
}

/**
 * Run one CLI's own updater, streaming its terminal output as it arrives.
 * Resolves with the version left behind — an updater that installed something
 * and one that said "already up to date" both land here, and the caller
 * compares for itself.
 */
export function runCliUpdate(
  provider: string,
  onOutput: (chunk: string) => void,
): Promise<CliVersion> {
  const channel = new Channel<CliUpdateEvent>();
  channel.onmessage = (event) => {
    if (event.kind === "output") onOutput(event.chunk);
  };
  return invoke<CliVersion>("cli_update", { provider, onEvent: channel });
}
