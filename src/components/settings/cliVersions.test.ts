import { describe, expect, it } from "vitest";
import { terminalText } from "./cliVersions";

const ESC = "";

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
