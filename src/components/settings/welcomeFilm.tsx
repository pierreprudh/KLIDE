// Settings → Appearance → Welcome: which landscape the nature film shows.
// Cards — a fresh deal, the authored order, or one of the landscapes —
// each with a still of what it means, drawn by the same engine that draws the
// Welcome card. A still is one frame: no animation loop, no pointer listener.

import { useEffect, useRef } from "react";
import {
  PIXEL_NATURE_SCENES,
  createPixelNature,
  type PixelNatureOrder,
  type PixelNatureSceneId,
} from "../pixelNatureEngine";

/** One settled frame of a scene, at a fine cell so a thumbnail still reads. */
function SceneStill({ scene, style }: { scene: PixelNatureSceneId; style?: React.CSSProperties }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const film = createPixelNature(canvas, { order: scene, cell: 4, still: true });
    film.start();
    return () => film.destroy();
  }, [scene]);
  return <canvas ref={ref} aria-hidden style={{ display: "block", imageRendering: "pixelated", ...style }} />;
}

/** Narrow stills side by side, one per scene, in the order given. */
function Strip({ scenes }: { scenes: readonly PixelNatureSceneId[] }) {
  return (
    <span style={{ display: "grid", gridTemplateColumns: `repeat(${scenes.length}, 1fr)`, width: "100%", height: "100%" }}>
      {scenes.map((id, i) => (
        <SceneStill key={`${id}-${i}`} scene={id} style={{ width: "100%", height: "100%" }} />
      ))}
    </span>
  );
}

function dealt(): PixelNatureSceneId[] {
  const out = PIXEL_NATURE_SCENES.map((s) => s.id);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function WelcomeFilmCards({ value, onChange }: { value: PixelNatureOrder; onChange: (v: PixelNatureOrder) => void }) {
  // The shuffle card's strip is dealt once per mount, like the film itself.
  const deal = useRef<PixelNatureSceneId[] | null>(null);
  if (!deal.current) deal.current = dealt();
  const authored = PIXEL_NATURE_SCENES.map((s) => s.id);

  const cards: { value: PixelNatureOrder; label: string; preview: React.ReactNode }[] = [
    { value: "shuffle", label: "Shuffle", preview: <Strip scenes={deal.current} /> },
    { value: "fixed", label: "In order", preview: <Strip scenes={authored} /> },
    ...PIXEL_NATURE_SCENES.map((s) => ({
      value: s.id as PixelNatureOrder,
      label: s.label,
      preview: <SceneStill scene={s.id} style={{ width: "100%", height: "100%" }} />,
    })),
  ];

  return (
    <div style={{ padding: "14px 18px 16px" }}>
      <div className="klide-row-title">Nature film</div>
      <div className="klide-row-description" style={{ marginBottom: 12 }}>
        The landscape beside the recent list. Shuffle deals the scenes afresh each launch; In order plays them as
        written; pick one to keep it.
      </div>
      <div
        role="radiogroup"
        aria-label="Nature film"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(112px, 1fr))",
          gap: 10,
        }}
      >
      {cards.map((card) => {
        const active = card.value === value;
        return (
          <button
            key={card.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(card.value)}
            style={{
              padding: 0,
              border: "none",
              background: "none",
              cursor: "pointer",
              textAlign: "left",
              display: "grid",
              gap: 7,
            }}
          >
            <span
              style={{
                display: "block",
                aspectRatio: "3 / 2",
                borderRadius: "var(--radius-sm)",
                overflow: "hidden",
                border: `1px solid ${active ? "var(--accent)" : "var(--border-strong)"}`,
                boxShadow: active ? "0 0 0 1px var(--accent)" : "none",
                transition: "border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
              }}
            >
              {card.preview}
            </span>
            <span
              style={{
                fontSize: 12.5,
                lineHeight: 1.2,
                color: active ? "var(--fg-strong)" : "var(--fg-subtle)",
                fontWeight: active ? 600 : 500,
              }}
            >
              {card.label}
            </span>
          </button>
        );
      })}
      </div>
    </div>
  );
}
