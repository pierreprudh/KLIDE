// Mission Control's two views — the runs that have started and the ones that
// are scheduled to — as round tabs beside its title. Both views draw this same
// strip in their headers, so switching never moves it.

export type MissionView = "runs" | "scheduled";

const VIEWS: { id: MissionView; label: string }[] = [
  { id: "runs", label: "Runs" },
  { id: "scheduled", label: "Scheduled" },
];

export function MissionViewTabs({ value, onChange, scheduledNote }: {
  value: MissionView;
  onChange: (view: MissionView) => void;
  /** Something wrong with a schedule, in words ("1 failed"). */
  scheduledNote?: string;
}) {
  return (
    <div className="mission-view-tabs" role="tablist" aria-label="Mission Control views">
      {VIEWS.map(({ id, label }, index) => (
        <button
          key={id}
          id={`mission-view-${id}`}
          type="button"
          role="tab"
          aria-selected={value === id}
          tabIndex={value === id ? 0 : -1}
          onClick={() => { if (value !== id) onChange(id); }}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? 0
              : event.key === "End" ? VIEWS.length - 1
              : (index + (event.key === "ArrowRight" ? 1 : -1) + VIEWS.length) % VIEWS.length;
            onChange(VIEWS[next].id);
          }}
        >
          {label}
          {id === "scheduled" && scheduledNote ? <span className="mission-view-note">{scheduledNote}</span> : null}
        </button>
      ))}
    </div>
  );
}
