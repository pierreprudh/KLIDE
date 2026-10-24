import "./runTimeline.css";

const TABS = [
  { id: "conversation", label: "Conversation" },
  { id: "timeline", label: "Timeline" },
  { id: "context", label: "Context" },
  { id: "usage", label: "Tokens & cost" },
] as const;
export type RunActivityView = typeof TABS[number]["id"];

export function RunActivityTabs({ idPrefix, value, onChange }: { idPrefix: string; value: RunActivityView; onChange: (view: RunActivityView) => void }) {
  return <div className="run-detail-tabs" role="tablist" aria-label="Run activity">
    {TABS.map(({ id, label }) => <button key={id} id={`${idPrefix}-${id}-tab`} role="tab"
      aria-selected={value === id} aria-controls={`${idPrefix}-activity`} tabIndex={value === id ? 0 : -1}
      onClick={() => onChange(id)} onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const index = TABS.findIndex(tab => tab.id === value);
        const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length;
        const next = TABS[nextIndex].id;
        onChange(next);
        document.getElementById(`${idPrefix}-${next}-tab`)?.focus();
      }}>{label}</button>)}
  </div>;
}
