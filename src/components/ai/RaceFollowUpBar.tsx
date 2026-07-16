// The free-mode "ask both" bar — a slim composer floating at the bottom of
// the workbench while a race is being watched. One Enter fans the text out to
// every racer's panel (App.sendRaceFollowUp), where it continues each racer's
// conversation as a normal turn. Dismissing hides the bar only: the panels —
// and the runs behind them — are untouched.
import { useState } from "react";
import { Z } from "../../zLayers";

export function RaceFollowUpBar({
  count,
  onSend,
  onDismiss,
}: {
  /** How many racers are still being watched (drives the placeholder). */
  count: number;
  onSend: (text: string) => void;
  onDismiss: () => void;
}) {
  const [text, setText] = useState("");

  function submit() {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText("");
  }

  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        transform: "translateX(-50%)",
        bottom: 14,
        width: "min(520px, 70%)",
        zIndex: Z.raceBar,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 9px",
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-strong)",
        borderRadius: "var(--radius-md)",
      }}
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={count > 1 ? "Ask both racers…" : "Ask the racer…"}
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 12.5,
          fontFamily: "inherit",
          color: "var(--fg-strong)",
          background: "transparent",
          border: "none",
          outline: "none",
        }}
      />
      <button
        type="button"
        onClick={submit}
        disabled={!text.trim()}
        style={{
          border: "none",
          background: "transparent",
          font: "inherit",
          fontSize: 11.5,
          color: text.trim() ? "var(--fg-strong)" : "var(--fg-dim)",
          cursor: text.trim() ? "pointer" : "default",
          padding: 0,
          transition: "color var(--motion-fast) var(--ease-out)",
        }}
      >
        Send to {count > 1 ? "both" : "one"}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        title="Hide this bar — the panels and their runs are untouched"
        aria-label="Dismiss"
        style={{
          border: "none",
          background: "transparent",
          font: "inherit",
          fontSize: 12,
          lineHeight: 1,
          color: "var(--fg-dim)",
          cursor: "pointer",
          padding: "0 0 0 2px",
          transition: "color var(--motion-fast) var(--ease-out)",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--fg-strong)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-dim)"; }}
      >
        ✕
      </button>
    </div>
  );
}
