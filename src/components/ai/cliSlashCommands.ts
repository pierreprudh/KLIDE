// A delegate CLI's own `/` commands in Klide's menu.
//
// Each delegate that can say what it runs itself (Claude Code on every
// headless turn, omp over its RPC mode) is asked by Rust, which keeps the
// list per workspace (`delegate/cli_commands.rs`); a CLI that cannot say is
// never started to find out. Here the list becomes menu entries. Accepting
// one leaves `/name ` in the composer and the message goes out as typed — the
// CLI, not the model, reads it.

import { useEffect, useRef, useState } from "react";
import { delegateSlashCommands, type CliCommands } from "../../ipc/delegateCommands";
import { isDelegateProvider } from "../../agent/providers";
import type { ProviderId } from "../../agent/types";
import type { SlashCommand } from "./slashCommands";

/** One of the CLI's commands as the menu shows it. */
export type CliSlashCommand = { name: string; desc?: string };

/** Klide built-ins a CLI's own version replaces while that CLI is the
 *  provider: it owns its context (`/compact`) and its CLAUDE.md (`/init`).
 *  `/clear`, `/handoff` and the modes stay Klide's — they act on the Klide
 *  conversation, which the CLI cannot see. */
export const CLI_OWNED = new Set(["compact", "init"]);

/** The CLI's commands, asked again each time the menu opens so a turn that
 *  refreshed the list shows up without a remount. An error or a CLI that
 *  reports nothing is an empty list: the menu stays Klide's. */
export function useCliSlashCommands(provider: ProviderId, workspaceRoot: string | null, open: boolean): CliSlashCommand[] {
  const [names, setNames] = useState<CliSlashCommand[]>([]);
  const askedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!isDelegateProvider(provider) || !workspaceRoot) { askedFor.current = null; setNames([]); return; }
    // Mount (or a new provider / folder) primes the list; after that only an
    // opening menu asks again.
    const key = `${provider}:${workspaceRoot}`;
    if (!open && askedFor.current === key) return;
    if (askedFor.current !== key) setNames([]);
    askedFor.current = key;
    let alive = true;
    void delegateSlashCommands(provider, workspaceRoot)
      .then((found) => { if (alive) setNames(runnableCommands(found)); })
      .catch(() => { if (alive) setNames([]); });
    return () => { alive = false; };
  }, [provider, workspaceRoot, open]);
  return names;
}

/** What a composer can send: not TUI-only, not internal (`__…`). */
export function runnableCommands(found: CliCommands): CliSlashCommand[] {
  const terminal = new Set(found.terminal);
  return found.commands
    .filter((name) => !terminal.has(name) && !name.startsWith("_"))
    .map((name) => ({ name, desc: found.descriptions?.[name] }));
}

/** Klide's menu with the CLI's commands merged in. The CLI wins the names in
 *  `CLI_OWNED`; every other name Klide already offers (its built-ins, and the
 *  skills both read from the same folders) keeps Klide's entry. */
export function withCliCommands(
  klide: SlashCommand[],
  cliCommands: readonly CliSlashCommand[],
  cliLabel: string,
  insert: (prefix: string) => void,
): SlashCommand[] {
  if (!cliCommands.length) return klide;
  const cli = new Set(cliCommands.map((c) => c.name));
  const kept = klide.filter((c) => !(CLI_OWNED.has(c.name) && cli.has(c.name)));
  const taken = new Set(kept.map((c) => c.name));
  const added = cliCommands
    .filter((c) => !taken.has(c.name))
    .map(({ name, desc }) => ({ name, desc: desc || `${cliLabel} command`, run: () => insert(`/${name} `) }));
  return [...kept, ...added];
}
