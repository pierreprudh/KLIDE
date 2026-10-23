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

const CARD = 52;
const TILE = 38;

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
        gap: 10,
        height: CARD,
        minWidth: 168,
        maxWidth: 232,
        padding: `0 30px 0 ${(CARD - TILE) / 2 - 1}px`,
        boxSizing: "border-box",
        borderRadius: 12,
        border: "1px solid var(--border)",
        background: "var(--bg-elevated)",
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
          borderRadius: 8,
          overflow: "hidden",
          background: "var(--bg-hover)",
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
            fontSize: 13,
            color: "var(--fg-strong)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {name}
        </span>
        <span style={{ fontSize: 11.5, color: "var(--fg-subtle)" }}>{attachmentSize(attachment)}</span>
      </div>
      <button
        type="button"
        aria-label={`Remove ${name}`}
        title="Remove"
        onClick={onRemove}
        style={{
          position: "absolute",
          top: 5,
          right: 5,
          width: 22,
          height: 22,
          display: "grid",
          placeItems: "center",
          padding: 0,
          border: "1px solid var(--border-strong)",
          borderRadius: "50%",
          background: "var(--bg-elevated)",
          color: "var(--fg)",
          cursor: "pointer",
          lineHeight: 1,
          opacity: hover ? 1 : 0,
          transition: "opacity var(--motion-fast) var(--ease-out)",
        }}
      >
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}
