import { describe, expect, it } from "vitest";
import { runnableNames, withCliCommands } from "./cliSlashCommands";

const klide = ["clear", "compact", "init", "handoff", "tdd"].map((name) => ({ name, desc: `klide ${name}`, run: () => {} }));

describe("withCliCommands", () => {
  it("lets the CLI own /compact and /init and keeps every other Klide name", () => {
    const inserted: string[] = [];
    const merged = withCliCommands(klide, ["compact", "init", "clear", "tdd", "context"], "Claude Code", (p) => inserted.push(p));
    expect(merged.map((c) => [c.name, c.desc])).toEqual([
      ["clear", "klide clear"],
      ["handoff", "klide handoff"],
      ["tdd", "klide tdd"],
      ["compact", "Claude Code command"],
      ["init", "Claude Code command"],
      ["context", "Claude Code command"],
    ]);
    merged.find((c) => c.name === "context")!.run();
    expect(inserted).toEqual(["/context "]);
  });

  it("leaves Klide's menu alone when the CLI listed nothing", () => {
    expect(withCliCommands(klide, [], "Claude Code", () => {})).toBe(klide);
  });
});

describe("runnableNames", () => {
  it("drops TUI-only and internal commands", () => {
    expect(runnableNames({ commands: ["compact", "config", "__remote-workflow"], terminal: ["config"] })).toEqual(["compact"]);
  });
});
