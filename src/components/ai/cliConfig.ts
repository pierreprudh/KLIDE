// Claude Code's `/config`, read as a form.
//
// Headless, `/config` with no argument prints its own usage — one
// `key=a|b|c` line per setting — and `/config key=value …` sets them. The
// menu Claude Code draws in its terminal app is not available to a headless
// turn, so the composer turns that usage text back into something to pick
// from. The CLI stays the source of truth for what exists and what is
// accepted; nothing here lists a setting of its own.

export type ConfigOption = {
  key: string;
  /** The accepted values, in the CLI's order; `null` means free text. */
  choices: string[] | null;
  /** A value with a space in it cannot be sent (the CLI splits on spaces and
   *  rejects quotes), so such a setting is shown but not offered. */
  settable: boolean;
};

const USAGE = /^\s*Usage:\s*\/config key=value/;

/** The settings in a `/config` usage answer, or `null` for any other text. */
export function parseConfigUsage(text: string): ConfigOption[] | null {
  if (!USAGE.test(text)) return null;
  const options: ConfigOption[] = [];
  for (const line of text.split("\n").slice(1)) {
    const m = line.match(/^\s*([A-Za-z][\w.]*)=(.+?)\s*$/);
    if (!m) continue;
    const [, key, spec] = m;
    const choices = /^<[^>]+>$/.test(spec) ? null : spec.split("|").map((c) => c.trim()).filter(Boolean);
    options.push({ key, choices, settable: !choices || choices.every((c) => !/\s/.test(c)) });
  }
  return options.length ? options : null;
}

/** What Claude Code's files say a setting is now, as the CLI spells values.
 *  Claude Code stores some settings under a longer name than `/config` takes
 *  (`autoCompact` → `autoCompactEnabled`, `editor` → `editorMode`, checked
 *  against what `/config` wrote), so those suffixes are read too. */
export function currentConfigValue(settings: Record<string, unknown>, key: string): string | null {
  for (const name of [key, `${key}Enabled`, `${key}Mode`]) {
    const v = settings[name];
    if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") return String(v);
  }
  return null;
}

/** The message that applies the staged changes, or `null` when there are
 *  none a headless turn could send. */
export function configCommand(changes: Record<string, string>): string | null {
  const pairs = Object.entries(changes)
    .map(([k, v]) => [k, v.trim()] as const)
    .filter(([, v]) => v !== "" && !/\s/.test(v));
  return pairs.length ? `/config ${pairs.map(([k, v]) => `${k}=${v}`).join(" ")}` : null;
}

/** After an Apply, what the files say about the edits it sent.
 *
 *  A sent edit the files read back equal is confirmed, and one they read back
 *  different stays pending (the CLI refused it). One the files hold under a
 *  name Klide cannot read is taken as applied — the CLI answered in the
 *  conversation — and returned as `assumed`, so the row shows it rather than
 *  staying lit forever. Edits that were not sent are left as they are. */
export function settleAppliedConfig(
  staged: Record<string, string>,
  sent: Record<string, string>,
  settings: Record<string, unknown>,
): { staged: Record<string, string>; assumed: Record<string, string> } {
  const next = { ...staged };
  const assumed: Record<string, string> = {};
  for (const [key, value] of Object.entries(sent)) {
    if (next[key] !== value) continue;
    const onDisk = currentConfigValue(settings, key);
    if (onDisk === null) assumed[key] = value.trim();
    if (onDisk === null || onDisk === value.trim()) delete next[key];
  }
  return { staged: next, assumed };
}

/** The staged edits `configCommand` actually puts in its message. */
export function sendableConfigChanges(changes: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(changes).filter(([, v]) => v.trim() !== "" && !/\s/.test(v.trim())));
}
