import type { ReactNode } from "react";
import type { GridLayout, PanelKind } from "../gridLayouts";

type Props = {
  layout: GridLayout;
  renderPanel: (kind: PanelKind, key: string) => ReactNode;
};

// Renders a saved grid layout live: each area becomes a CSS-grid cell holding
// the real panel for its assigned kind. Cells with no panel show a placeholder.
export function GridWorkbench({ layout, renderPanel }: Props) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "grid",
        gridTemplateColumns: `repeat(${layout.cols}, 1fr)`,
        gridTemplateRows: `repeat(${layout.rows}, 1fr)`,
        gap: 6,
        padding: 6,
      }}
    >
      {layout.areas.map((area) => (
        <div
          key={area.id}
          style={{
            gridColumn: `${area.x + 1} / span ${area.w}`,
            gridRow: `${area.y + 1} / span ${area.h}`,
            minWidth: 0,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            // Don't clip — panels carry their own rounded frame + drop shadow.
            overflow: "visible",
          }}
        >
          {area.panel ? (
            renderPanel(area.panel, area.id)
          ) : (
            <div
              style={{
                flex: 1,
                display: "grid",
                placeItems: "center",
                borderRadius: "var(--radius-md)",
                border: "1px dashed var(--border-strong)",
                color: "var(--fg-subtle)",
                fontSize: 12,
              }}
            >
              Empty
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
