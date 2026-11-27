import { useId, useLayoutEffect, useRef, useState } from "react";
import type { MachineStatus } from "../../ipc/machines";
import { CheckIcon, FolderIcon, MachineIcon, SuccessIcon } from "../../icons";
import { KlideMark, ProviderLogo } from "../ai/icons";
import { canVisitMachineSetupStep, type SetupStep } from "./machineSetupSteps";
import { machineSetupChecklist, type ChecklistAction } from "./machineChecklistState";

const labels: Record<SetupStep, string> = { connection: "Connect", software: "Install", signIn: "Credentials", github: "GitHub", project: "Project", ready: "Ready" };

export function MachineSetupChecklist({ status, workspace, active, action, busy, onSelect }: {
  status: MachineStatus | null; workspace: boolean; active: SetupStep; action: ChecklistAction | null; busy: boolean; onSelect: (step: SetupStep) => void;
}) {
  const id = useId();
  const nav = useRef<HTMLElement>(null);
  const [marker, setMarker] = useState({ top: 0, height: 0 });
  useLayoutEffect(() => {
    const element = nav.current!;
    const measure = () => {
      const row = element.querySelector<HTMLElement>('[aria-current="step"]');
      if (!row) return;
      const bounds = row.getBoundingClientRect();
      const top = bounds.top - element.getBoundingClientRect().top;
      setMarker((previous) => previous.top === top && previous.height === bounds.height ? previous : { top, height: bounds.height });
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(element);
    return () => resize.disconnect();
  }, [active, status, workspace]);
  return <nav ref={nav} className="klide-machine-checklist-nav" aria-label="Machine setup"><span className="klide-machine-checklist-track" aria-hidden="true" /><span className="klide-machine-step-marker" aria-hidden="true" data-step={active} style={{ height: marker.height, transform: `translateY(${marker.top}px)` }} /><ol className="klide-machine-checklist" aria-label="Setup progress">{machineSetupChecklist(status, workspace, action).map((row) => <li key={row.step} data-state={row.state} aria-current={active === row.step ? "step" : undefined}>
    <button type="button" aria-label={labels[row.step]} aria-describedby={`${id}-${row.step}`} disabled={busy || !canVisitMachineSetupStep(row.step, status, workspace)} onClick={() => onSelect(row.step)}>
      <span className="klide-machine-checklist-logo" aria-hidden="true">{row.step === "software" ? <KlideMark size={18} /> : row.step === "signIn" ? <ProviderLogo id={status?.setup.credentialMode === "openrouter" ? "openrouter" : "claude-code"} size={19} /> : row.step === "github" ? <span className="klide-machine-github-logo" /> : row.step === "project" ? <FolderIcon size={18} /> : row.step === "ready" ? <SuccessIcon size={18} /> : <MachineIcon size={18} />}</span>
      <span className="klide-machine-checklist-copy"><strong>{row.label}</strong><span id={`${id}-${row.step}`}>{row.caption}</span></span>
      <span className="klide-machine-checklist-state" aria-hidden="true">{row.state === "done" ? <CheckIcon size={12} /> : row.state === "active" ? <span className="klide-machine-spinner" /> : <span className="klide-machine-pending-dot" />}</span>
    </button>
  </li>)}</ol></nav>;
}
