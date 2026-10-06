// The staged-attachment tray — one row of what's riding along on the next
// turn, shared by the AI panel's composer and Focus's start stage so a photo
// looks the same wherever you dropped it.
//
// Two shapes, because the two kinds carry different information: a photo IS
// its thumbnail, so it shows one; a document is its name, so the name is the
// tile and the file-type icon only labels it. Removal is a hover reveal — the
// tray is a quiet strip until you reach for it.
import { useState } from "react";
import type { AgentAttachment as Attachment } from "../../agent/types";
import { FileTypeIcon } from "../fileMarks";
import { isPhotoAttachment } from "./attachments";

const TILE = 52;

export function AttachmentTray({
  attachments,
  onRemove,
  onOpenPhoto,
  padding = "10px 12px 2px",
  photoNote = null,
}: {
  attachments: readonly Attachment[];
  onRemove: (index: number) => void;
  /** Click-through on a photo — the composer's lightbox, where there is one. */
  onOpenPhoto?: (dataUri: string) => void;
  padding?: string;
  /** What will happen to the staged photos that the person should know —
   *  "Described by gemma3" when the model cannot see and other eyes will
   *  read the picture for it (see ./sight.ts). Null when the model sees. */
  photoNote?: string | null;
}) {
  if (attachments.length === 0) return null;
  const hasPhoto = attachments.some(isPhotoAttachment);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding, alignItems: "flex-end" }}>
      {attachments.map((a, i) => (
        <AttachmentTile
          key={`${a.path}-${i}`}
          attachment={a}
          onRemove={() => onRemove(i)}
          onOpen={a.dataUri && onOpenPhoto ? () => onOpenPhoto(a.dataUri as string) : undefined}
          title={isPhotoAttachment(a) && photoNote ? photoNote : undefined}
        />
      ))}
      {hasPhoto && photoNote && (
        <span style={{ fontSize: 11, color: "var(--fg-dim)", letterSpacing: "0.01em", userSelect: "none", paddingBottom: 2 }}>
          {photoNote}
        </span>
      )}
    </div>
  );
}

function AttachmentTile({
  attachment,
  onRemove,
  onOpen,
  title,
}: {
  attachment: Attachment;
  onRemove: () => void;
  onOpen?: () => void;
  /** Overrides the tile's tooltip — the tray's note on a photo. */
  title?: string;
}) {
  const [hover, setHover] = useState(false);
  const photo = isPhotoAttachment(attachment);
  const name = attachment.path.split("/").pop() || attachment.path;
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={title ? `${name} — ${title}` : photo ? name : `${name} — sent as text`}
      style={{
        position: "relative",
        height: TILE,
        width: photo ? TILE : undefined,
        maxWidth: 148,
        borderRadius: 8,
        overflow: "hidden",
        border: "1px solid var(--border)",
        background: "var(--bg-elevated)",
        flexShrink: 0,
      }}
    >
      {photo ? (
        <img
          src={attachment.dataUri}
          alt={name}
          onClick={onOpen}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: "block",
            cursor: onOpen ? "zoom-in" : "default",
          }}
        />
      ) : (
        <div
          style={{
            height: "100%",
            display: "flex",
            alignItems: "center",
            gap: 7,
            padding: "0 10px 0 9px",
          }}
        >
          <FileTypeIcon name={name} size={16} />
          <div style={{ minWidth: 0, display: "grid", gap: 1 }}>
            <span
              style={{
                fontSize: 11.5,
                color: "var(--fg-strong)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {name}
            </span>
            <span style={{ fontSize: 10, color: "var(--fg-subtle)", letterSpacing: "0.02em" }}>
              {documentMeasure(attachment.content)}
            </span>
          </div>
        </div>
      )}
      <button
        type="button"
        aria-label={`Remove ${name}`}
        title="Remove"
        onClick={onRemove}
        style={{
          position: "absolute",
          top: 2,
          right: 2,
          width: 16,
          height: 16,
          display: "grid",
          placeItems: "center",
          padding: 0,
          border: "none",
          borderRadius: "50%",
          background: "color-mix(in srgb, var(--bg) 70%, transparent)",
          color: "var(--fg-strong)",
          cursor: "pointer",
          lineHeight: 1,
          opacity: hover ? 1 : 0,
          transition: "opacity var(--motion-fast) var(--ease-out)",
        }}
      >
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}

/** A document's weight in the words the model will actually read. */
function documentMeasure(content: string): string {
  const lines = content ? content.split("\n").length : 0;
  if (lines === 0) return "empty";
  return `${lines.toLocaleString()} line${lines === 1 ? "" : "s"}`;
}
