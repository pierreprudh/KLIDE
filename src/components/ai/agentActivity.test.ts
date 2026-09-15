import { describe, expect, it } from "vitest";
import { shellAgentsOf } from "./shellAgentEvidence";
import type { Msg } from "./types";
const calls = (...commands: string[]): Msg[] => [{ role: "assistant", content: "", toolCalls: commands.map((command) => ({ name: "run_command", args: { command } })) }];
describe("shell agent evidence", () => {
  it("retains both CLI participants across handoffs, deduplicating invocations", () => {
    expect(shellAgentsOf(calls('cd /workspace && claude -p "Implement"', 'codex exec -s workspace-write "Test"', 'claude --print "Review"'))).toEqual(["Claude Code", "Codex"]);
  });
  it("ignores installation probes and commands quoted inside prompts", () => {
    expect(shellAgentsOf(calls('claude --version; codex exec --help', 'echo "claude -p test"', 'claude -p "then run codex exec; codex exec test"'))).toEqual(["Claude Code"]);
  });
  it("handles absolute executables and environment assignments", () => {
    expect(shellAgentsOf(calls('CI=1 /usr/local/bin/codex exec "test"'))).toEqual(["Codex"]);
  });
  it("does not invent agents from narrative text or unrelated tools", () => {
    expect(shellAgentsOf([{ role: "assistant", content: "Claude finished", toolCalls: [{ name: "read_file", args: { command: 'codex exec test' } }] }])).toEqual([]);
  });
});
