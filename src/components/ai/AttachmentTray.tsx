// The staged-attachment tray — one row of what's riding along on the next
// turn, shared by the AI panel's composer and Focus's start stage so a photo
// looks the same wherever you dropped it.
//
// One card for every kind: a square tile, then the name over its size. The
// tile is what tells kinds apart — a photo (or a staged SVG) is its own
// thumbnail, a document wears its app's mark or its file-type icon. Removal
// is a hover reveal — the tray is a quiet strip until you reach for it.
import { useState } from "react";
import type { AgentAttachment as Attachment } from "../../agent/types";
import { FileTypeIcon } from "../fileMarks";
import { conversationMark } from "../../modelIdentity";
import type { ProviderId } from "../../agent/types";
import { attachmentSize, isPhotoAttachment, markupPreviewUri } from "./attachments";
import { DocumentAppMark, documentApp } from "../../documentAppLogo";
import { eyesName, type Eyes } from "./sight";

const CARD = 56;
const TILE = 40;
// Tints of the text colour over the composer's surface: darker on the light
// themes, lighter on the dark ones, without a token per theme.
const CARD_FILL = "color-mix(in srgb, var(--fg-strong) 4%, var(--bg-elevated))";
const TILE_FILL = "color-mix(in srgb, var(--fg-strong) 7%, var(--bg-elevated))";

export function AttachmentTray({
  attachments,
  onRemove,
  onOpenPhoto,
  padding = "10px 12px 2px",
  eyes = null,
}: {
  attachments: readonly Attachment[];
  onRemove: (index: number) => void;
  /** Click-through on a photo — the composer's lightbox, where there is one. */
  onOpenPhoto?: (dataUri: string) => void;
  padding?: string;
  /** The model that will read the staged photos because the chosen one
   *  cannot (see ./sight.ts): named beside the tiles, behind its maker's
   *  mark, so the person knows who looks before they send. Null when the
   *  chosen model sees for itself. */
  eyes?: Eyes | null;
}) {
  if (attachments.length === 0) return null;
  const hasPhoto = attachments.some(isPhotoAttachment);
  const note = eyes ? `Described by ${eyesName(eyes)}` : null;
  const mark = eyes ? conversationMark(eyes.model, eyes.provider as ProviderId, 14)?.node : null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding, alignItems: "center" }}>
      {attachments.map((a, i) => (
        <AttachmentTile
          key={`${a.path}-${i}`}
          attachment={a}
          onRemove={() => onRemove(i)}
          onOpenPhoto={onOpenPhoto}
          title={isPhotoAttachment(a) && note ? note : undefined}
        />
      ))}
      {hasPhoto && note && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--fg-dim)", letterSpacing: "0.01em", userSelect: "none", textAlign: "left" }}>
          {mark && <span aria-hidden style={{ display: "grid", placeItems: "center", flexShrink: 0 }}>{mark}</span>}
          {note}
        </span>
      )}
    </div>
  );
}

function AttachmentTile({
  attachment,
  onRemove,
  onOpenPhoto,
  title,
}: {
  attachment: Attachment;
  onRemove: () => void;
  onOpenPhoto?: (uri: string) => void;
  /** Overrides the tile's tooltip — the tray's note on a photo. */
  title?: string;
}) {
  const [hover, setHover] = useState(false);
  const isPhoto = isPhotoAttachment(attachment);
  // An SVG is sent as text but staged as the drawing it is.
  const preview = isPhoto ? (attachment.dataUri as string) : markupPreviewUri(attachment);
  const onOpen = preview && onOpenPhoto ? () => onOpenPhoto(preview) : undefined;
  const name = attachment.path.split("/").pop() || attachment.path;
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      title={title ? `${name} — ${title}` : isPhoto ? name : `${name} — sent as text`}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 11,
        height: CARD,
        minWidth: 176,
        maxWidth: 240,
        padding: `0 32px 0 ${(CARD - TILE) / 2}px`,
        boxSizing: "border-box",
        borderRadius: 16,
        border: "1px solid var(--border)",
        // A step off the composer it sits in (which is --bg-elevated), so
        // the card reads as a thing laid on the box, not printed into it.
        background: CARD_FILL,
        flexShrink: 0,
      }}
    >
      <div
        onClick={onOpen}
        style={{
          width: TILE,
          height: TILE,
          flexShrink: 0,
          display: "grid",
          placeItems: "center",
          borderRadius: 10,
          overflow: "hidden",
          background: TILE_FILL,
          cursor: onOpen ? "zoom-in" : "default",
        }}
      >
        {preview ? (
          <img
            src={preview}
            alt={name}
            style={{
              width: "100%",
              height: "100%",
              // A drawing is shown whole; a photo fills its tile.
              objectFit: isPhoto ? "cover" : "contain",
              padding: isPhoto ? 0 : 5,
              boxSizing: "border-box",
              display: "block",
            }}
          />
        ) : documentApp(name) ? (
          <span style={{ color: "var(--fg-muted)", display: "grid" }}><DocumentAppMark path={name} size={20} /></span>
        ) : (
          <FileTypeIcon name={name} size={20} />
        )}
      </div>
      <div style={{ minWidth: 0, display: "grid", gap: 2 }}>
        <span
          style={{
            fontSize: 13.5,
            lineHeight: 1.25,
            color: "var(--fg-strong)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {name}
        </span>
        <span style={{ fontSize: 12, lineHeight: 1.25, color: "var(--fg-subtle)" }}>{attachmentSize(attachment)}</span>
      </div>
      <button
        type="button"
        aria-label={`Remove ${name}`}
        title="Remove"
        onClick={onRemove}
        style={{
          position: "absolute",
          top: 6,
          right: 6,
          width: 22,
          height: 22,
          display: "grid",
          placeItems: "center",
          padding: 0,
          border: "none",
          borderRadius: "50%",
          background: "var(--bg-elevated)",
          // A soft lift and a whisper of a ring — it floats over the card
          // rather than being drawn onto it.
          boxShadow: "var(--shadow-raised), 0 0 0 1px color-mix(in srgb, var(--fg) 10%, transparent)",
          color: "var(--fg-strong)",
          cursor: "pointer",
          lineHeight: 1,
          opacity: hover ? 1 : 0,
          transform: hover ? "scale(1)" : "scale(0.9)",
          pointerEvents: hover ? "auto" : "none",
          willChange: "opacity, transform",
          // Arrives unhurried and settles; leaves a touch quicker than it came.
          transition: hover
            ? "opacity var(--motion-slow) var(--ease-soft), transform var(--motion-slower) var(--ease-soft)"
            : "opacity var(--motion-med) var(--ease-soft), transform var(--motion-med) var(--ease-soft)",
        }}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}
