type Props = {
  /** `data:<mime>;base64,…` URI of the image to render. */
  src: string;
  /** File path, used for the alt text. */
  name: string;
};

/**
 * Read-only image preview shown in the editor pane when an image file is opened
 * from the explorer. The picture is centred and contained on a neutral
 * backdrop; anything larger than the pane scales down to fit, and the pane
 * scrolls if it can't. Quiet by design — the tab bar already names the file.
 */
export function ImageView({ src, name }: Props) {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "grid",
        placeItems: "center",
        overflow: "auto",
        padding: 24,
        background: "var(--bg)",
      }}
    >
      <img
        src={src}
        alt={name}
        style={{
          maxWidth: "100%",
          maxHeight: "100%",
          objectFit: "contain",
          borderRadius: 6,
          border: "1px solid var(--border)",
        }}
      />
    </div>
  );
}
