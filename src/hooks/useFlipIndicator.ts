// useFlipIndicator — shared FLIP animation for a single moving
// indicator (e.g. a 2px accent bar) that follows an "active" item in
// a list. The component owns:
//   - itemRefs: a Map<id, HTMLElement> (or array of refs) for each item
//   - the active id
//   - the size of the indicator (width / height)
//   - the CSS (via .klide-flip-indicator + .klide-flip-track)
//
// On the first render and on every active-id change, the hook:
//   1. measures the active item's position relative to the track,
//   2. renders the indicator at the new position with an inverse
//      transform that visually pins it to the previous position,
//   3. drops the inverse on the next animation frame, so the CSS
//      transition carries the indicator to its new resting place.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type FlipIndicatorState = {
  /** Inline style for the indicator. */
  style: { transform: string; opacity: number };
  /** Whether the indicator is ready to animate. Spread as
   *  `data-flip={flip}` on the track so CSS can gate the transition
   *  off for the first frame. */
  flip: boolean;
  /** Ref callback to spread on the track element. */
  trackRef: (el: HTMLElement | null) => void;
  /** Ref callback to spread on each item element. */
  setItemRef: (id: string) => (el: HTMLElement | null) => void;
};

export type FlipOptions = {
  /** The indicator's rendered size on its primary axis. The hook
   *  positions the indicator at the active item's edge; the size is
   *  just a constant for the consumer to use in CSS. */
  size: number;
  /** Whether the indicator is visible (skip when nothing's active). */
  active: boolean;
  /** Whether the indicator moves on the X axis (e.g. a tab bar) or
   *  the Y axis (e.g. a vertical nav rail). Default "y". */
  axis?: "x" | "y";
};

export function useFlipIndicator(
  activeId: string | null,
  options: FlipOptions,
): FlipIndicatorState {
  const itemRefs = useRef<Map<string, HTMLElement | null>>(new Map());
  const trackRef = useRef<HTMLElement | null>(null);
  const previousPos = useRef<number | null>(null);
  // Live position of the indicator (where it should rest, ignoring transform).
  const [restPos, setRestPos] = useState<number | null>(null);
  // Visual offset. 0 = at restPos. Non-zero = inverse transform to play.
  const [barOffset, setBarOffset] = useState(0);
  // First-measurement gate. False until one frame after `restPos` first
  // settles, so the initial transform change doesn't animate.
  const [flip, setFlip] = useState(false);
  const axis = options.axis ?? "y";

  useLayoutEffect(() => {
    if (!options.active || !activeId) return;
    const track = trackRef.current;
    const active = itemRefs.current.get(activeId);
    if (!track || !active) return;
    const trackRect = track.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    const pos = axis === "y"
      ? activeRect.top - trackRect.top
      : activeRect.left - trackRect.left;
    setRestPos(pos);
  }, [activeId, options.active, options.size, axis]);

  useLayoutEffect(() => {
    if (restPos === null) return;
    const from = previousPos.current;
    previousPos.current = restPos;
    if (from === null) return; // first measurement, no animation
    if (from === restPos) {
      setBarOffset(0);
      return;
    }
    setBarOffset(from - restPos);
    const raf = requestAnimationFrame(() => setBarOffset(0));
    return () => cancelAnimationFrame(raf);
  }, [restPos]);

  // Enable the CSS transition one frame after the first measurement.
  useEffect(() => {
    if (restPos === null || flip) return;
    const raf = requestAnimationFrame(() => setFlip(true));
    return () => cancelAnimationFrame(raf);
  }, [restPos, flip]);

  const translateFn = axis === "y" ? "translateY" : "translateX";
  return {
    style: {
      transform: restPos !== null
        ? `${translateFn}(${restPos + barOffset}px)`
        : `${translateFn}(0)`,
      opacity: restPos !== null ? 1 : 0,
    },
    flip,
    trackRef: (el) => { trackRef.current = el; },
    setItemRef: (id) => (el) => { itemRefs.current.set(id, el); },
  };
}
