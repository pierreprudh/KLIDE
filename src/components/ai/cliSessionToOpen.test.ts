import { describe, expect, it } from "vitest";
import { cliSessionToOpen } from "./runController";

describe("cliSessionToOpen", () => {
  it("reads the openSession marker a successful open_cli_session result carries", () => {
    const open = cliSessionToOpen({
      ok: true,
      metadata: { openSession: { provider: "claude-code", session: "abc-123", project: "/Users/x/proj", title: "fix login" } },
    });
    expect(open).toEqual({ provider: "claude-code", session: "abc-123", project: "/Users/x/proj", title: "fix login" });
  });

  it("is null for any other result — failed, unmarked, or naming a provider that is not a Delegate", () => {
    expect(cliSessionToOpen({ ok: false, metadata: { openSession: { provider: "claude-code", session: "s" } } })).toBeNull();
    expect(cliSessionToOpen({ ok: true, content: "read" } as never)).toBeNull();
    expect(cliSessionToOpen({ ok: true, metadata: { openSession: { provider: "ollama", session: "s" } } })).toBeNull();
    expect(cliSessionToOpen({ ok: true, metadata: { openSession: { provider: "codex", session: "" } } })).toBeNull();
  });

  it("keeps project null when the transcript did not name one", () => {
    expect(cliSessionToOpen({ ok: true, metadata: { openSession: { provider: "omp", session: "s1", project: null } } })?.project).toBeNull();
  });
});
