type Props = {
  open: boolean;
  hasHistory: boolean;
  working: boolean;
  panelId: string;
  onToggle: () => void;
};

export function SideQuestionToggle({ open, hasHistory, working, panelId, onToggle }: Props) {
  const action = open ? "Close side question" : hasHistory ? "Reopen side question" : "Open side question";
  const status = working ? " · working" : !open && hasHistory ? " · saved history" : "";
  return (
    <button type="button" className={`klide-btw-toggle${open ? " is-open" : ""}`}
      aria-label={action + status} title={action + status} aria-expanded={open}
      aria-controls={panelId} onClick={onToggle}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path className="klide-btw-icon-arrow" d="m14 7-5 5 5 5" />
      </svg>
      <span aria-hidden="true">/btw</span>
      {(working || (!open && hasHistory)) && <span aria-hidden="true" className={`klide-btw-status${working ? " is-working" : ""}`} />}
    </button>
  );
}
