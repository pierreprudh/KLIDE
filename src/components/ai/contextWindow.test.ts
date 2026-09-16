import { describe, expect, it } from "vitest";
import {
  contextCapOptions,
  contextCeiling,
  contextControlLabel,
  contextSizeLabel,
  expectedWorkingWindow,
  providerHasContextWindowSetting,
  resolveGaugeWindow,
  WORKING_WINDOW_DEFAULT,
} from "./contextWindow";

describe("providerHasContextWindowSetting", () => {
  it("is only Ollama — nothing else takes a window on the request", () => {
    expect(providerHasContextWindowSetting("ollama")).toBe(true);
    for (const p of ["anthropic", "openai", "openrouter", "mlx", "codex", "claude-code", "custom:x", "auto"]) {
      expect(providerHasContextWindowSetting(p)).toBe(false);
    }
  });
});

describe("expectedWorkingWindow (mirrors adapters::working_num_ctx)", () => {
  it("is the flat default for a small conversation", () => {
    expect(expectedWorkingWindow(200, 131_072)).toBe(WORKING_WINDOW_DEFAULT);
    expect(expectedWorkingWindow(20_000, 131_072)).toBe(WORKING_WINDOW_DEFAULT);
  });
  it("grows past the default for a large one, with headroom", () => {
    expect(expectedWorkingWindow(40_000, 131_072)).toBe(44_096);
  });
  it("never exceeds the ceiling", () => {
    expect(expectedWorkingWindow(200_000, 131_072)).toBe(131_072);
    expect(expectedWorkingWindow(100, 8_192)).toBe(8_192);
  });
});

describe("resolveGaugeWindow", () => {
  const base = { provider: "ollama", detected: 131_072, reported: null, estimatedPromptTokens: 1_000 };

  it("hosted providers measure against the detected window, whatever else is set", () => {
    expect(resolveGaugeWindow({ ...base, provider: "anthropic", detected: 200_000, override: 32_768, reported: 8_192 })).toBe(200_000);
  });
  it("Ollama before any turn: the expected working window, not the trained max", () => {
    expect(resolveGaugeWindow(base)).toBe(32_768);
  });
  it("Ollama after a turn: what the turn reported it ran in", () => {
    expect(resolveGaugeWindow({ ...base, reported: 65_536 })).toBe(65_536);
  });
  it("an override is a ceiling on the working window", () => {
    expect(resolveGaugeWindow({ ...base, override: 8_192 })).toBe(8_192);
    expect(resolveGaugeWindow({ ...base, override: 65_536 })).toBe(32_768);
    expect(resolveGaugeWindow({ ...base, override: 65_536, estimatedPromptTokens: 100_000 })).toBe(65_536);
  });
  it("contextCeiling is the override when set, else detected", () => {
    expect(contextCeiling(131_072)).toBe(131_072);
    expect(contextCeiling(131_072, 8_192)).toBe(8_192);
    expect(contextCeiling(131_072, 0)).toBe(131_072);
  });
});

describe("contextCapOptions", () => {
  it("offers Auto plus every standard cap strictly below the trained window", () => {
    const labels = contextCapOptions(131_072).map((o) => o.label);
    expect(labels).toEqual(["Auto", "8K", "16K", "32K", "64K"]);
  });
  it("an 8k model gets no cap smaller than itself", () => {
    expect(contextCapOptions(8_192).map((o) => o.label)).toEqual(["Auto"]);
  });
  it("a 256k model reaches 128K", () => {
    expect(contextCapOptions(262_144).map((o) => o.label)).toContain("128K");
  });
  it("Auto says what it will do", () => {
    expect(contextCapOptions(131_072)[0].caption).toBe("32K working window, grows to 128K");
    expect(contextCapOptions(8_192)[0].caption).toBe("8K working window, grows to 8K");
  });
});

describe("labels", () => {
  it("power-of-two windows divide by 1024, decimal ones stay decimal", () => {
    expect(contextSizeLabel(131_072)).toBe("128K");
    expect(contextSizeLabel(1_048_576)).toBe("1M");
    expect(contextSizeLabel(200_000)).toBe("200K");
    expect(contextSizeLabel(1_000_000)).toBe("1M");
    expect(contextSizeLabel(272_000)).toBe("272K");
  });
  it("the composer label shows the cap, else the detected size", () => {
    expect(contextControlLabel(32_768, 131_072)).toBe("32K ctx");
    expect(contextControlLabel(undefined, 200_000)).toBe("200K ctx");
    expect(contextControlLabel(undefined, 0)).toBe("auto ctx");
  });
});
