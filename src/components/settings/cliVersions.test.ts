import { describe, expect, it } from "vitest";
import { afterUpdate, terminalText } from "./cliVersions";
import type { CliVersion } from "../../ipc/cliUpdates";

const ESC = "\u001b";

describe("terminalText", () => {
  it("drops the colours an installer paints with", () => {
    expect(terminalText(`${ESC}[32mUpdated to 0.155.0${ESC}[0m`)).toBe("Updated to 0.155.0");
  });

  it("lets a redrawn progress line win, the way a terminal does", () => {
    // bun's installer rewrites one line rather than printing many.
    expect(terminalText("downloading 10%\rdownloading 60%\rdownloading 100%")).toBe(
      "downloading 100%",
    );
  });

  it("keeps separate lines separate", () => {
    expect(terminalText("checking\nalready up to date\n")).toBe("checking\nalready up to date");
  });

  it("collapses the blank runs a cleared screen leaves behind", () => {
    expect(terminalText("one\n\n\n\n\ntwo")).toBe("one\n\ntwo");
  });

  it("survives output with no escapes at all", () => {
    expect(terminalText("Current version: 2.1.274")).toBe("Current version: 2.1.274");
  });
});

describe("afterUpdate", () => {
  const row = (over: Partial<CliVersion> = {}): CliVersion => ({
    provider: "omp",
    binary: "omp",
    installed: true,
    version: "15.13.3",
    raw: "omp/15.13.3",
    commandPath: "/usr/local/bin/omp",
    updateCommand: "omp update",
    detail: null,
    latest: "18.2.4",
    updateAvailable: true,
    latestError: null,
    ...over,
  });

  it("keeps the check standing when the updater installed nothing", () => {
    // Same build, so the comparison the check made is still about this build.
    const next = afterUpdate(row(), row({ latest: null, updateAvailable: false }));
    expect(next.latest).toBe("18.2.4");
    expect(next.updateAvailable).toBe(true);
  });

  it("drops a check the update invalidated", () => {
    const next = afterUpdate(
      row(),
      row({ version: "18.2.4", raw: "omp/18.2.4", latest: null, updateAvailable: false }),
    );
    expect(next.version).toBe("18.2.4");
    expect(next.latest).toBeNull();
    // Never carries "an update is available" onto the build that took it.
    expect(next.updateAvailable).toBe(false);
  });

  it("carries a failed check forward rather than reading as up to date", () => {
    const failed = row({ latest: null, updateAvailable: false, latestError: "offline" });
    const next = afterUpdate(failed, row({ latest: null, updateAvailable: false }));
    expect(next.latestError).toBe("offline");
    expect(next.latest).toBeNull();
  });
});
