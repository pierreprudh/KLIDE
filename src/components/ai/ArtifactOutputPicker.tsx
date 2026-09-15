import { useRef, useState } from "react";
import "./ArtifactOutputPicker.css";
import { DocumentAppMark } from "../../documentAppLogo";
import { ARTIFACT_OUTPUTS, type ArtifactOutput } from "./artifactOutput";

export function ArtifactOutputRows({ value, onChange, disabled = false }: {
  value: ArtifactOutput | null; onChange: (value: ArtifactOutput | null) => void; disabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const firstChoice = useRef<HTMLButtonElement>(null);
  return <>
    <div className={`artifact-output-disclosure${expanded ? " is-expanded" : ""}`}>
    <button type="button" role="menuitem" aria-expanded={expanded}
      aria-label={expanded ? "Collapse document choices" : "Expand document choices"}
      className="klide-focus-add-menu-row artifact-output-trigger" inert={expanded}
      onClick={() => { setExpanded(true); requestAnimationFrame(() => firstChoice.current?.focus()); }}>
      <span style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span style={{ display: "inline-flex", alignItems: "center", paddingRight: 2 }} aria-hidden="true">
          {ARTIFACT_OUTPUTS.map((item, index) => <span key={item.id} style={{
            display: "grid", placeItems: "center", width: 28, height: 28,
            marginLeft: index === 0 ? 0 : -9, zIndex: ARTIFACT_OUTPUTS.length - index,
          }}><DocumentAppMark path={`output${item.extension}`} size={19} /></span>)}
        </span>
        Create
      </span>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"
        style={{ transform: expanded ? "rotate(90deg)" : undefined }}><path d="m9 5 7 7-7 7" /></svg>
    </button>
    <div className="artifact-output-choices" inert={!expanded}>
    {ARTIFACT_OUTPUTS.map((item, index) => {
      return <button ref={index === 0 ? firstChoice : undefined} key={item.id} type="button" role="menuitemcheckbox" aria-checked={value === item.id}
        disabled={disabled} className="klide-focus-add-menu-row"
        title={disabled ? "Choose a model with tools to create files" : `Create ${item.extension} · click again to clear`}
        onClick={() => onChange(value === item.id ? null : item.id)}>
        <span style={{ display: "flex", alignItems: "center", gap: 9 }}><DocumentAppMark path={`output${item.extension}`} size={20} />{item.label}</span>
        {value === item.id ? <span className="klide-focus-add-menu-meta">✓</span> : null}
      </button>;
    })}
    </div>
    </div>
    <div className="klide-focus-add-menu-divider" />
  </>;
}
export function ArtifactOutputSelection({ value, onClear }: { value: ArtifactOutput | null; onClear: () => void }) {
  if (!value) return null;
  const item = ARTIFACT_OUTPUTS.find((item) => item.id === value)!;
  return <button type="button" onClick={onClear} aria-label={`Clear ${item.label} output`}
    title={`Create ${item.extension} · click to clear`}
    style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "transparent", border: 0, color: "var(--accent)", font: "inherit", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" }}>
    <DocumentAppMark path={`output${item.extension}`} size={18} />{item.label}<span aria-hidden="true">×</span>
  </button>;
}
