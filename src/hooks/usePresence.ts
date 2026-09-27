import { useEffect, useState } from "react";

/** Keeps something mounted for `exitMs` after `open` turns false, so it can
 *  play a leave animation instead of vanishing. `leaving` is true during that
 *  window — put it on the element as the cue for its exit styles. */
export function usePresence(open: boolean, exitMs: number) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const t = window.setTimeout(() => setMounted(false), exitMs);
    return () => window.clearTimeout(t);
  }, [open, exitMs]);
  return { mounted: open || mounted, leaving: !open && mounted };
}
