import type { Msg } from "./types";

/** Conservative recognition of direct noninteractive CLI calls. Quoted prompts
 * stay single tokens, so mentioning another CLI inside a prompt is not a call.
 * This is transcript evidence, never a source of worker lifecycle or usage. */
export function shellAgentsOf(msgs: Msg[]): string[] {
  const agents = new Set<string>();
  for (const msg of msgs) {
    if (msg.role !== "assistant") continue;
    for (const call of msg.toolCalls ?? []) {
      if (call.name !== "run_command" || typeof call.args?.command !== "string") continue;
      const tokens = call.args.command.match(/"(?:\\.|[^"\\])*"|'[^']*'|&&|\|\||[;\n|]|[^\s;&|]+/g) ?? [];
      let start = true;
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (["&&", "||", ";", "\n", "|"].includes(token)) { start = true; continue; }
        if (!start) continue;
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
        start = false;
        const executable = token.replace(/^['"]|['"]$/g, "").split("/").pop();
        const remaining = tokens.slice(i + 1);
        const end = remaining.findIndex((t: string) => ["&&", "||", ";", "\n", "|"].includes(t));
        const args = end < 0 ? remaining : remaining.slice(0, end);
        if (args.some((t: string) => ["--help", "-h", "--version", "-V"].includes(t))) continue;
        if (executable === "claude" && args.some((t: string) => t === "-p" || t === "--print")) agents.add("Claude Code");
        if (executable === "codex" && args[0] === "exec") agents.add("Codex");
      }
    }
  }
  return [...agents];
}
