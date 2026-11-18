import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

type Props = {
  onConfirm: () => void;
  /** Label shown while armed, after the first click. */
  confirmLabel: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  title?: string;
  /** How long the button stays armed, in ms (default 3000). */
  armMs?: number;
};

/** Two-step inline confirm for destructive actions: the first click arms the
 *  button (its label swaps to `confirmLabel`), the second click within `armMs`
 *  fires `onConfirm`. Blur or timeout disarms. Replaces blocking
 *  window.confirm dialogs for in-place destructive actions. */
export function ConfirmButton({ onConfirm, confirmLabel, children, className, style, disabled, title, armMs = 3000 }: Props) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  function disarm() {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setArmed(false);
  }
  return (
    <button
      type="button"
      className={className}
      style={armed ? { ...style, color: "var(--danger)" } : style}
      disabled={disabled}
      title={title}
      aria-label={armed ? confirmLabel : undefined}
      onClick={() => {
        if (disabled) return;
        if (!armed) {
          setArmed(true);
          timer.current = window.setTimeout(disarm, armMs);
          return;
        }
        disarm();
        onConfirm();
      }}
      onBlur={disarm}
    >
      {armed ? confirmLabel : children}
    </button>
  );
}
