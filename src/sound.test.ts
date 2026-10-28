import { afterEach, beforeEach, expect, it, vi } from "vitest";

const prefs = vi.hoisted(() => ({ ui: true, agent: true, volume: 100 }));
vi.mock("./settingsStore", () => ({
  SETTINGS: { uiSounds: "ui", agentSounds: "agent", soundVolume: "volume" },
  getSetting: (key: keyof typeof prefs) => prefs[key],
}));

let state: string;
let oscillators: Array<{ frequency: { value: number; setValueAtTime: ReturnType<typeof vi.fn>; exponentialRampToValueAtTime: ReturnType<typeof vi.fn> } }>;
const param = () => ({ value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
const node = () => ({ connect: vi.fn(function (this: unknown, target: unknown) { return target; }), disconnect: vi.fn() });

beforeEach(() => {
  vi.resetModules();
  Object.assign(prefs, { ui: true, agent: true, volume: 100 });
  state = "running";
  oscillators = [];
  vi.stubGlobal("AudioContext", class {
    currentTime = 0;
    destination = {};
    get state() { return state; }
    resume = vi.fn(async () => {});
    createOscillator() {
      const osc = { ...node(), frequency: param(), detune: param(), start: vi.fn(), stop: vi.fn() };
      oscillators.push(osc);
      return osc;
    }
    createGain() { return { ...node(), gain: param() }; }
  });
});
afterEach(() => vi.unstubAllGlobals());

it("preserves the existing tap pitch and FM ratio", async () => {
  const { playTap } = await import("./sound");
  playTap();
  expect(oscillators).toHaveLength(2);
  expect(oscillators[0].frequency.setValueAtTime).toHaveBeenCalledWith(1300, 0);
  expect(oscillators[1].frequency.value).toBe(650);
});

it("separates interaction and agent switches, with previews respecting zero volume", async () => {
  const { playSound } = await import("./sound");
  prefs.ui = false;
  playSound("tap"); playSound("send");
  expect(oscillators).toHaveLength(0);
  playSound("attention");
  expect(oscillators).toHaveLength(2);
  prefs.agent = false;
  playSound("failure");
  expect(oscillators).toHaveLength(2);
  playSound("complete", true);
  expect(oscillators).toHaveLength(6);
  prefs.volume = 0;
  playSound("tap", true);
  expect(oscillators).toHaveLength(6);
});

it("coalesces a burst of workers without suppressing previews", async () => {
  const { playSound } = await import("./sound");
  playSound("attention"); playSound("complete"); playSound("failure");
  expect(oscillators).toHaveLength(2);
  playSound("failure", true);
  expect(oscillators).toHaveLength(4);
});

it("does not queue background sounds on a suspended context", async () => {
  state = "suspended";
  const { playSound } = await import("./sound");
  playSound("complete");
  expect(oscillators).toHaveLength(0);
  state = "running";
  playSound("complete");
  expect(oscillators).toHaveLength(4);
});

it("keeps app actions working when audio is unavailable", async () => {
  vi.stubGlobal("AudioContext", class { constructor() { throw new Error("unavailable"); } });
  const { playSound } = await import("./sound");
  expect(() => playSound("send")).not.toThrow();
});
