import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";

/** The one in-place name editor — a file in the Explorer, a conversation in
 *  the rail. It takes the row's slot, commits on Enter or blur, cancels on
 *  Escape, and reports exactly once even though Enter also fires blur. */
export function InlineNameInput({
  defaultValue,
  onCommit,
  onCancel,
  select = "basename",
  style,
  ariaLabel,
}: {
  defaultValue: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
  /** What the caret takes hold of first. A file keeps its extension out of
   *  the selection (VS Code's rename); a title is selected whole. */
  select?: "basename" | "all";
  style?: CSSProperties;
  ariaLabel?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // The input commits on both Enter and blur; Enter unmounts it, which
  // fires blur too — this flag makes sure we only commit once.
  const doneRef = useRef(false);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const dot = select === "basename" ? defaultValue.lastIndexOf(".") : -1;
    el.setSelectionRange(0, dot > 0 ? dot : defaultValue.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function commit(value: string) {
    if (doneRef.current) return;
    doneRef.current = true;
    onCommit(value);
  }

  function cancel() {
    if (doneRef.current) return;
    doneRef.current = true;
    onCancel();
  }

  return (
    <input
      ref={inputRef}
      defaultValue={defaultValue}
      spellCheck={false}
      aria-label={ariaLabel}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit(e.currentTarget.value);
        else if (e.key === "Escape") cancel();
      }}
      onBlur={(e) => commit(e.currentTarget.value)}
      style={{
        flex: 1,
        minWidth: 0,
        font: "inherit",
        fontSize: 12.5,
        color: "var(--fg-strong)",
        background: "var(--bg)",
        border: "1px solid var(--accent)",
        borderRadius: "var(--radius-xs)",
        padding: "0 4px",
        outline: "none",
        ...style,
      }}
    />
  );
}
