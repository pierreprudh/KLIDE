// The message a CI watch firing opens its read-only Run with
// (`prompt` in src-tauri/src/agent/ci_watch.rs), read back as facts so the
// conversation can draw it as a card instead of a wall of instructions + log.
// Rust owns the format; `ci_watch.rs` pins it with a test, this file parses it.

export type CiWatchPrompt = {
  number: number;
  title: string;
  url: string;
  sha: string;
  checks: { name: string; url: string }[];
  /** The failed log excerpt, or "" when Actions had none. */
  log: string;
};

const HEAD = /^CI failed on my pull request #(\d+) "(.*)" \((\S+)\), commit ([0-9a-f]+)\.\n/;
const FENCE = /<(ci-log-[0-9a-f]+)>\n([\s\S]*?)\n<\/\1>\s*$/;
const NO_LOG = "(no Actions log was available — use the check links above)";

export function parseCiWatchPrompt(text: string): CiWatchPrompt | null {
  const head = HEAD.exec(text);
  const fence = FENCE.exec(text);
  if (!head || !fence) return null;
  const block = /\nFailing checks:\n((?:- .*\n?)+)/.exec(text)?.[1] ?? "";
  const checks = block.split("\n").flatMap(line => {
    const m = /^- (.+) (https?:\/\/\S+)$/.exec(line.trim());
    return m ? [{ name: m[1], url: m[2] }] : [];
  });
  const log = fence[2].trim();
  return {
    number: Number(head[1]),
    title: head[2],
    url: head[3],
    sha: head[4],
    checks,
    log: log === NO_LOG ? "" : log,
  };
}
