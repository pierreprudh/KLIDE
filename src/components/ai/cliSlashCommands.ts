// A delegate CLI's own `/` commands in Klide's menu.
//
// Claude Code names what it answers itself on every headless turn; Rust keeps
// that list per workspace (`delegate/cli_commands.rs`) and primes it with one
// probe before the first turn. Here the list becomes menu entries. Accepting
// one leaves `/name ` in the composer and the message goes out as typed — the
// CLI, not the model, reads it.

import { useEffect, useRef, useState } from "react";
import { delegateSlashCommands, type CliCommands } from "../../ipc/delegateCommands";
import type { SlashCommand } from "./slashCommands";

/** Klide built-ins a CLI's own version replaces while that CLI is the
 *  provider: it owns its context (`/compact`) and its CLAUDE.md (`/init`).
 *  `/clear`, `/handoff` and the modes stay Klide's — they act on the Klide
 *  conversation, which the CLI cannot see. */
export const CLI_OWNED = new Set(["compact", "init"]);

/** The CLI's commands, asked again each time the menu opens so a turn that
 *  refreshed the list shows up without a remount. An error or a CLI that
 *  reports nothing is an empty list: the menu stays Klide's. */
export function useCliSlashCommands(provider: string, workspaceRoot: string | null, open: boolean): string[] {
  const [names, setNames] = useState<string[]>([]);
  const askedFor = useRef<string | null>(null);
  useEffect(() => {
    if (provider !== "claude-code" || !workspaceRoot) { askedFor.current = null; setNames([]); return; }
    // Mount (or a new provider / folder) primes the list; after that only an
    // opening menu asks again.
    const key = `${provider}:${workspaceRoot}`;
    if (!open && askedFor.current === key) return;
    if (askedFor.current !== key) setNames([]);
    askedFor.current = key;
    let alive = true;
    void delegateSlashCommands(provider, workspaceRoot)
      .then((found) => { if (alive) setNames(runnableNames(found)); })
      .catch(() => { if (alive) setNames([]); });
    return () => { alive = false; };
  }, [provider, workspaceRoot, open]);
  return names;
}

/** What a composer can send: not TUI-only, not internal (`__…`). */
export function runnableNames(found: CliCommands): string[] {
  const terminal = new Set(found.terminal);
  return found.commands.filter((name) => !terminal.has(name) && !name.startsWith("_"));
}

/** Klide's menu with the CLI's commands merged in. The CLI wins the names in
 *  `CLI_OWNED`; every other name Klide already offers (its built-ins, and the
 *  skills both read from the same folders) keeps Klide's entry. */
export function withCliCommands(
  klide: SlashCommand[],
  cliNames: readonly string[],
  cliLabel: string,
  insert: (prefix: string) => void,
): SlashCommand[] {
  if (!cliNames.length) return klide;
  const cli = new Set(cliNames);
  const kept = klide.filter((c) => !(CLI_OWNED.has(c.name) && cli.has(c.name)));
  const taken = new Set(kept.map((c) => c.name));
  const added = cliNames
    .filter((name) => !taken.has(name))
    .map((name) => ({ name, desc: `${cliLabel} command`, run: () => insert(`/${name} `) }));
  return [...kept, ...added];
}
