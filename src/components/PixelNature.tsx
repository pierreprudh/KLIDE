import { useEffect, useRef } from "react";
import { createPixelNature, type PixelNatureOptions } from "./pixelNatureEngine";

type Props = PixelNatureOptions & { className?: string };

/** The Welcome card's big-pixel nature film. Decorative: hidden from AT. */
export function PixelNature({ className, cell, sceneSeconds, transitionSeconds, speed }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const film = createPixelNature(canvas, { cell, sceneSeconds, transitionSeconds, speed, still: mq.matches });
    film.start();
    const sync = () => film.setStill(mq.matches);
    mq.addEventListener("change", sync);
    // Don't burn frames while the window is hidden behind the workspace.
    const vis = () => (document.hidden ? film.stop() : film.start());
    document.addEventListener("visibilitychange", vis);
    return () => {
      mq.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", vis);
      film.destroy();
    };
  }, [cell, sceneSeconds, transitionSeconds, speed]);

  return <canvas ref={canvasRef} className={className} aria-hidden />;
}
