import "./machineSetupDialog.css";

export function MachineSetupWaiting({ children }: { children: React.ReactNode }) {
  return <div className="klide-machine-waiting" role="status"><span className="klide-machine-spinner" aria-hidden="true" /><span>{children}</span></div>;
}
