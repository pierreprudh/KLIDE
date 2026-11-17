import { useEffect, useRef, useState } from "react";
import { machineDiscover, type MachineCandidate, type MachineConnectionMethod, type MachineDiscovery } from "../../ipc/machines";
import { MachineIcon, NewTaskIcon, TailscaleIcon } from "../../icons";
import { errMessage } from "../../errors";
import { MachineSetupWaiting } from "./MachineSetupWaiting";
import { GhostButton } from "./controls";

const methods = [
  { id: "tailscale", label: "Tailscale", description: "Choose a device on your private Tailscale network." },
  { id: "vpn", label: "Other VPN", description: "Use a VPN that’s already connected on this Mac." },
  { id: "ssh", label: "Direct SSH", description: "A server address or a host from your SSH configuration." },
] as const;

export function MachineConnectionPicker({ method, onMethod, onSelect, onManual, onClose }: {
  method: MachineConnectionMethod | null; onMethod: (method: MachineConnectionMethod | null) => void;
  onSelect: (candidate: MachineCandidate) => void; onManual: () => void; onClose: () => void;
}) {
  const [result, setResult] = useState<MachineDiscovery | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!method) first.current?.focus(); }, [method]);
  useEffect(() => {
    if (!method) return;
    let live = true;
    setLoading(true); setResult(null); setError("");
    machineDiscover(method).then((value) => { if (live) setResult(value); })
      .catch((reason) => { if (live) setError(errMessage(reason)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [method, revision]);
  if (!method) return <div className="klide-machine-connections">
    <p>How would you like to connect?</p>
    <div className="klide-machine-methods">{methods.map((option, index) => <button ref={index === 0 ? first : undefined} key={option.id} type="button" onClick={() => onMethod(option.id)}>
      {option.id === "tailscale" ? <TailscaleIcon size={24} /> : <MachineIcon size={24} />}
      <span><strong>{option.label}</strong><span>{option.description}</span>{option.id === "vpn" && <span className="klide-vpn-brands">
        <img src="/vpn/wireguard.svg" alt="WireGuard" title="WireGuard" width="24" height="24" />
        <img src="/vpn/zerotier.svg" alt="ZeroTier" title="ZeroTier" width="24" height="24" />
        <img src="/vpn/openvpn.svg" alt="OpenVPN" title="OpenVPN" width="24" height="24" />
      </span>}</span>
    </button>)}</div>
    <div className="klide-machine-dialog-footer"><GhostButton onClick={onClose}>Cancel</GhostButton></div>
  </div>;
  return <div className="klide-machine-connections">
    <div className="klide-machine-discovery-heading"><h3>{method === "tailscale" ? "Machines on Tailscale" : method === "vpn" ? "Available machines" : "Available SSH machines"}</h3><GhostButton disabled={loading} onClick={() => setRevision((value) => value + 1)}>Refresh</GhostButton></div>
    {loading && <MachineSetupWaiting>{method === "tailscale" ? "Looking for Tailscale devices" : "Reading saved SSH machines"}</MachineSetupWaiting>}
    {error && <p role="alert" className="klide-add-machine-error">{error}</p>}
    {result && <><p>{result.message}</p><div className="klide-machine-candidates">{result.machines.map((candidate) => <button type="button" key={candidate.sshHost} disabled={!candidate.supported} onClick={() => onSelect(candidate)}>
      <MachineIcon size={20} /><span><strong>{candidate.label}</strong><code>{candidate.sshHost}</code><span>{candidate.detail}</span></span>
      {candidate.online !== null && <span className="klide-machine-availability">{candidate.online ? "Online" : "Offline"}</span>}
    </button>)}</div>{!result.machines.length && <p>No machines found yet. You can add one by address.</p>}</>}
    <div className="klide-machine-dialog-footer"><GhostButton onClick={() => onMethod(null)}>Back</GhostButton><button type="button" className="klide-button klide-button-secondary klide-machine-manual-add" onClick={onManual}><NewTaskIcon size={15} />Add a machine</button></div>
  </div>;
}
