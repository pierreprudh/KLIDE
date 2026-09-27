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

/** `autoCompact` → `Auto compact`, `defaultToAgentsView` → `Default to agents view`. */
export function configLabel(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(" ");
  return words
    .map((w, i) => (w.length <= 3 && w === w.toUpperCase() ? w : i === 0 ? w[0].toUpperCase() + w.slice(1) : w.toLowerCase()))
    .join(" ");
}

/** What Claude Code's files say a setting is now, as the CLI spells values. */
export function currentConfigValue(settings: Record<string, unknown>, key: string): string | null {
  const v = settings[key];
  return typeof v === "boolean" || typeof v === "number" || typeof v === "string" ? String(v) : null;
}

/** The message that applies the staged changes, or `null` when there are
 *  none a headless turn could send. */
export function configCommand(changes: Record<string, string>): string | null {
  const pairs = Object.entries(changes)
    .map(([k, v]) => [k, v.trim()] as const)
    .filter(([, v]) => v !== "" && !/\s/.test(v));
  return pairs.length ? `/config ${pairs.map(([k, v]) => `${k}=${v}`).join(" ")}` : null;
}
