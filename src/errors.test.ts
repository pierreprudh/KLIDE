// The trailing sentence on a failed turn used to be "Check <provider>
// connection and credentials." unconditionally — advice that sent a reader
// hunting through keychain entries when the real cause was a Codex CLI four
// releases behind the model it was asked to run.

import { describe, expect, it } from "vitest";

import { errMessage, providerFailureMessage, RunBusyError } from "./errors";

describe("providerFailureMessage", () => {
  it("says a busy Run is busy, without blaming the provider", () => {
    expect(providerFailureMessage(new RunBusyError(), "Anthropic")).toBe(
      "This conversation's Run is still busy — stop it or wait, then send again.",
    );
  });

  it("tells a stale CLI to update instead of blaming credentials", () => {
    const message = providerFailureMessage(
      new Error("The 'gpt-5.6-sol' model requires a newer version of Codex."),
      "Codex",
    );
    expect(message).toContain("codex update");
    expect(message).not.toContain("credentials");
  });

  it("names the provider for a CLI whose updater we haven't verified", () => {
    const message = providerFailureMessage(
      new Error("requires a newer version of Claude Code"),
      "Claude Code",
    );
    expect(message).toBe(
      "requires a newer version of Claude Code. Your Claude Code CLI is out of date — update it, then retry.",
    );
  });

  it("still points at credentials when the failure says nothing about itself", () => {
    expect(providerFailureMessage(new Error("401 Unauthorized"), "Anthropic")).toBe(
      "401 Unauthorized. Check Anthropic connection and credentials.",
    );
  });

  it("reads a bare string rejection, which the old cast rendered as undefined", () => {
    // Tauri rejects an `invoke` with a string, not an Error.
    expect(providerFailureMessage("spawn codex ENOENT", "Codex")).toBe(
      "spawn codex ENOENT. Check Codex connection and credentials.",
    );
    expect(errMessage("spawn codex ENOENT")).toBe("spawn codex ENOENT");
  });

  it("does not double the full stop the provider already wrote", () => {
    expect(providerFailureMessage(new Error("Stream closed."), "Ollama")).toBe(
      "Stream closed. Check Ollama connection and credentials.",
    );
  });
});
