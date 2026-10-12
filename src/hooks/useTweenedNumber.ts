import { useEffect, useRef, useState } from "react";

/** The one tween curve for a number that moves while you watch it — the
 *  context gauge's token counts under a streaming turn. Ease-out: fast off
 *  the old value, settling on the new one. Pure so a test can walk it. */
export function tweenAt(from: number, to: number, elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0 || elapsedMs >= durationMs) return to;
  const t = Math.max(0, elapsedMs / durationMs);
  const eased = 1 - Math.pow(1 - t, 3);
  return from + (to - from) * eased;
}

const DEFAULT_DURATION_MS = 360;

function reducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

/** A number that glides to each new `value` instead of jumping. Mounts on the
 *  value itself (a tooltip opening mid-stream shows the real count, not a
 *  climb from zero); every later change re-tweens from wherever the display
 *  currently is, so a target that keeps moving is followed, not chased. Snaps
 *  when the OS asks for reduced motion. */
export function useTweenedNumber(value: number, durationMs = DEFAULT_DURATION_MS): number {
  const [shown, setShown] = useState(value);
  const shownRef = useRef(value);
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (!Number.isFinite(value) || reducedMotion() || typeof requestAnimationFrame !== "function") {
      shownRef.current = value;
      setShown(value);
      return;
    }
    const from = shownRef.current;
    if (from === value) return;
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const next = tweenAt(from, value, now - start, durationMs);
      shownRef.current = next;
      setShown(next);
      if (next !== value) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, durationMs]);

  return shown;
}
