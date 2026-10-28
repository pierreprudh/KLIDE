// The app's interface sounds grow from Kobra's "tap" (kobra.systems/components/sound),
// synthesized with Web Audio rather than shipped as a file: a 1300 Hz sine,
// frequency-modulated at half its pitch, gone in ~20 ms. Settings → General
// has separate interaction and agent notification switches.
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

export type SoundCue = "tap" | "send" | "complete" | "attention" | "failure";

// All cues use the original tap's sine/FM voice, with lower pitches and
// slightly longer envelopes for agent events. No audio assets or extra engine.
const CUES: Record<SoundCue, readonly { pitch: number; duration: number; gain: number; offset: number; rise?: number }[]> = {
  tap: [{ pitch: TAP.frequency, duration: TAP.decay + TAP.release, gain: 1, offset: 0 }],
  send: [{ pitch: 780, rise: 920, duration: 0.045, gain: 0.65, offset: 0 }],
  complete: [
    { pitch: 780, duration: 0.07, gain: 0.75, offset: 0 },
    { pitch: 650, duration: 0.09, gain: 0.65, offset: 0.09 },
  ],
  attention: [{ pitch: 520, duration: 0.1, gain: 0.9, offset: 0 }],
  failure: [{ pitch: 195, duration: 0.085, gain: 0.85, offset: 0 }],
};

let lastNotification = -Infinity;

/** Preview bypasses category switches, but always respects the volume. */
export function playSound(cue: SoundCue, preview = false, velocity = 1): void {
  const notification = cue !== "tap" && cue !== "send";
  if (!preview && !getSetting(notification ? SETTINGS.agentSounds : SETTINGS.uiSounds)) return;
  const volume = getSetting(SETTINGS.soundVolume) / 100;
  if (volume <= 0) return;
  // Several workers settling together should sound like one event.
  const now = performance.now();
  if (notification && !preview && now - lastNotification < 400) return;
  const ac = audio();
  if (!ac) return;
  try {
    if (ac.state === "suspended") {
      void ac.resume().catch(() => {});
      // Don't queue a background cue to surprise the user on the next gesture.
      if (notification && !preview) return;
    }
    if (notification && !preview) lastNotification = now;
    const detune = (Math.random() * 2 - 1) * TAP.jitterCents;
    for (const note of CUES[cue]) {
      const t = ac.currentTime + note.offset;
      const carrier = ac.createOscillator();
      carrier.type = "sine";
      carrier.frequency.setValueAtTime(note.pitch, t);
      if (note.rise) carrier.frequency.exponentialRampToValueAtTime(note.rise, t + note.duration);
      carrier.detune.value = detune;
      const modulator = ac.createOscillator();
      modulator.type = "sine";
      modulator.frequency.value = note.pitch * TAP.fm.ratio;
      modulator.detune.value = detune;
      const depth = ac.createGain();
      depth.gain.value = TAP.fm.depth * (note.pitch / TAP.frequency);
      modulator.connect(depth).connect(carrier.frequency);
      const amp = ac.createGain();
      const peak = TAP.gain * note.gain * volume * Math.max(0, Math.min(1, velocity)) * (0.9 + Math.random() * 0.1);
      amp.gain.setValueAtTime(peak, t);
      amp.gain.exponentialRampToValueAtTime(0.0001, t + note.duration);
      carrier.connect(amp).connect(ac.destination);
      const end = t + note.duration + 0.01;
      carrier.onended = () => {
        carrier.disconnect(); modulator.disconnect(); depth.disconnect(); amp.disconnect();
      };
      carrier.start(t); modulator.start(t);
      carrier.stop(end); modulator.stop(end);
    }
  } catch {
    // Sound must never interrupt sending, navigation, or run handling.
  }
}

export function playTap(velocity = 1): void {
  playSound("tap", false, velocity);
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
  // Unlock audio on a gesture even when interaction sounds are muted.
  const unlock = () => {
    if (!getSetting(SETTINGS.uiSounds) && !getSetting(SETTINGS.agentSounds)) return;
    const ac = audio();
    if (ac?.state === "suspended") void ac.resume().catch(() => {});
  };
  document.addEventListener("pointerdown", unlock, { capture: true });
  document.addEventListener("keydown", unlock, { capture: true });
}
