import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SETTINGS,
  decodeSetting,
  encodeSetting,
  getSetting,
  resetSettingsCacheForTests,
  setSetting,
  subscribeSetting,
  type SettingDef,
} from "./settingsStore";

beforeEach(() => resetSettingsCacheForTests());

describe("decodeSetting", () => {
  it("keeps historical formats readable", () => {
    // Booleans were written as String(bool); both default-true and
    // default-false semantics must survive.
    expect(decodeSetting("true", false)).toBe(true);
    expect(decodeSetting("false", true)).toBe(false);
    expect(decodeSetting("junk", true)).toBe(true);
    // Raw strings (autosave modes, theme ids, model ids) stay raw.
    expect(decodeSetting("delay", "off")).toBe("delay");
    expect(decodeSetting("llama3.1:8b", "x")).toBe("llama3.1:8b");
    // Numbers reject garbage.
    expect(decodeSetting("14", 13)).toBe(14);
    expect(decodeSetting("wide", 13)).toBe(13);
    // Objects JSON-parse with the fallback as safety net.
    expect(decodeSetting('{"maxTurns":32}', {})).toEqual({ maxTurns: 32 });
    expect(decodeSetting("{broken", { a: 1 })).toEqual({ a: 1 });
    // Absent key → fallback.
    expect(decodeSetting(null, "off")).toBe("off");
  });
});

describe("encodeSetting", () => {
  it("mirrors the historical write formats", () => {
    expect(encodeSetting("delay")).toBe("delay");
    expect(encodeSetting(true)).toBe("true");
    expect(encodeSetting(14)).toBe("14");
    expect(encodeSetting({ maxTurns: 32 })).toBe('{"maxTurns":32}');
  });
});

describe("get/set/subscribe", () => {
  const def: SettingDef<number> = {
    key: "test-size",
    fallback: () => 13,
    normalize: (n) => Math.min(20, Math.max(11, n)),
  };

  it("reads the fallback, persists writes, and round-trips", () => {
    expect(getSetting(def)).toBe(13);
    setSetting(def, 15);
    expect(getSetting(def)).toBe(15);
    resetSettingsCacheForTests();
    // Note: after a cache reset the memory store is dropped too, so this
    // re-reads the fallback — persistence within a session is what we pin.
    expect(getSetting(def)).toBe(13);
  });

  it("normalizes on read and on write", () => {
    setSetting(def, 999);
    expect(getSetting(def)).toBe(20);
  });

  it("notifies subscribers on the same key only", () => {
    const hit = vi.fn();
    const other = vi.fn();
    const off = subscribeSetting(def.key, hit);
    subscribeSetting("unrelated", other);
    setSetting(def, 12);
    expect(hit).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    off();
    setSetting(def, 14);
    expect(hit).toHaveBeenCalledTimes(1);
  });
});

describe("SETTINGS catalog", () => {
  it("validates the fiddly settings", () => {
    expect(getSetting(SETTINGS.autoSaveMode)).toBe("off");
    setSetting(SETTINGS.autoSaveMode, "delay");
    expect(getSetting(SETTINGS.autoSaveMode)).toBe("delay");
    expect(getSetting(SETTINGS.editorFontSize)).toBe(13);
    expect(getSetting(SETTINGS.autoTheme)).toBe(true);
    expect(getSetting(SETTINGS.harnessSettings)).toEqual({});
  });
});
