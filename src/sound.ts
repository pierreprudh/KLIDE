// The app's one interface sound — Kobra's "tap" (kobra.systems/components/sound),
// synthesized with Web Audio rather than shipped as a file: a 1300 Hz sine,
// frequency-modulated at half its pitch, gone in ~20 ms. Settings → General
// turns it off.
//
// Apple's rule for interface sound: reinforce a change the eye already sees,
// and stay rare enough never to grate. So the tap marks moving somewhere —
// a rail destination, a Settings page, a tab, a view or option switch — and
// not every button. A control opts in with `data-sound="tap"` (tabs are in by
// role); pressing the one already selected changes nothing and stays silent.

import { getSetting, SETTINGS } from "./settingsStore";

const TAP = {
  frequency: 1300,
  fm: { ratio: 0.5, depth: 100 },
  decay: 0.015,
  release: 0.005,
  gain: 0.2,
  /** Each play is detuned up to ± this many cents, so repeats don't drone. */
  jitterCents: 26,
};

const NAVIGATES = '[data-sound="tap"], [role="tab"]';

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (ctx) return ctx;
  try {
    ctx = new AudioContext();
  } catch {
    return null;
  }
  return ctx;
}

export function playTap(velocity = 1): void {
  const ac = audio();
  if (!ac) return;
  if (ac.state === "suspended") void ac.resume();

  const t = ac.currentTime;
  const detune = (Math.random() * 2 - 1) * TAP.jitterCents;
  const peak = TAP.gain * velocity * (0.9 + Math.random() * 0.1);

  const carrier = ac.createOscillator();
  carrier.type = "sine";
  carrier.frequency.value = TAP.frequency;
  carrier.detune.value = detune;

  // FM: a second sine wobbles the carrier's frequency by ± depth Hz.
  const modulator = ac.createOscillator();
  modulator.type = "sine";
  modulator.frequency.value = TAP.frequency * TAP.fm.ratio;
  modulator.detune.value = detune;
  const depth = ac.createGain();
  depth.gain.value = TAP.fm.depth;
  modulator.connect(depth).connect(carrier.frequency);

  // Zero attack, decay to silence, then a short release tail.
  const amp = ac.createGain();
  amp.gain.setValueAtTime(peak, t);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + TAP.decay + TAP.release);
  carrier.connect(amp).connect(ac.destination);

  const end = t + TAP.decay + TAP.release + 0.01;
  carrier.start(t);
  modulator.start(t);
  carrier.stop(end);
  modulator.stop(end);
}

function onClick(event: MouseEvent): void {
  if (!getSetting(SETTINGS.uiSounds)) return;
  const target = event.target instanceof Element ? event.target.closest(NAVIGATES) : null;
  if (!target) return;
  if (target.matches(":disabled") || target.getAttribute("aria-disabled") === "true") return;
  if (
    target.getAttribute("aria-current") === "page" ||
    target.getAttribute("aria-selected") === "true" ||
    (target.getAttribute("role") === "radio" && target.getAttribute("aria-checked") === "true")
  ) {
    return;
  }
  playTap();
}

/** Install the app-wide tap. Called once at boot. */
export function installTapSound(): void {
  document.addEventListener("click", onClick, { capture: true });
}
