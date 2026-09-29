/** Bare icon with an accessible hit target and native keyboard focus outline. */
export function AccountSwapButton({ label, busy, onClick }: {
  label: string;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} disabled={busy} aria-label={label} aria-busy={busy} title={busy ? "Switching account…" : label}
      style={{ appearance: "none", border: 0, background: "transparent", boxShadow: "none", borderRadius: 0, color: "var(--fg-subtle)", width: 32, height: 32, padding: 0, display: "grid", placeItems: "center", flexShrink: 0, cursor: busy ? "wait" : "pointer", opacity: busy ? 0.5 : 1 }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4" />
      </svg>
    </button>
  );
}
