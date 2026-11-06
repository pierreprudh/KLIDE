import { useState } from "react";
import type { GitImageDiff, GitImageSide } from "../ipc/git";

function ImageSide({ side, label, path }: { side: GitImageSide; label: string; path: string }) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [size, setSize] = useState<{ source: string; text: string } | null>(null);
  const dimensions = size?.source === side.dataUri ? size.text : "";
  const failed = side.dataUri !== null && failedSource === side.dataUri;
  return (
    <figure style={{ margin: 0, minWidth: 0, flex: "1 1 220px" }}>
      <figcaption style={{ display: "flex", gap: 8, justifyContent: "space-between", padding: "0 0 8px", color: "var(--fg-subtle)", fontSize: 12 }}>
        <span>{label}</span><span>{dimensions}</span>
      </figcaption>
      <div style={{ display: "grid", placeItems: "center", minHeight: 120, padding: 16, borderRadius: "var(--radius-md)", backgroundColor: "var(--bg)", backgroundImage: "repeating-conic-gradient(var(--bg-hover) 0% 25%, transparent 0% 50%)", backgroundSize: "16px 16px" }}>
        {side.error || failed || !side.dataUri ? (
          <span role="status" style={{ color: "var(--fg-subtle)", fontSize: 12 }}>{side.error ?? "Unable to display this image."}</span>
        ) : (
          <img src={side.dataUri} alt={`${label}: ${path}`} loading="lazy"
            onLoad={e => setSize({ source: side.dataUri!, text: `${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}` })}
            onError={() => setFailedSource(side.dataUri)}
            style={{ display: "block", maxWidth: "100%", maxHeight: 420, objectFit: "contain" }} />
        )}
      </div>
    </figure>
  );
}

/** Images stay in their regular diff card, including collapse and open-in-editor. */
export function ImageDiffView({ image, path }: { image: GitImageDiff; path: string }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 16, padding: 16, fontFamily: "var(--font-ui)" }}>
      {image.before && <ImageSide side={image.before} label={image.after ? "Before" : "Deleted"} path={path} />}
      {image.after && <ImageSide side={image.after} label={image.before ? "After" : "Added"} path={path} />}
      {!image.before && !image.after && <span style={{ color: "var(--fg-subtle)", fontSize: 12 }}>No image changes available.</span>}
    </div>
  );
}
