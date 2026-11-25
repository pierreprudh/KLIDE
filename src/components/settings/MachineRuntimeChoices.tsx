import { useId } from "react";
import type { MachineRuntime } from "../../ipc/machines";

export function MachineExecutionChoices({ value, disabled, onChange }: {
  value: MachineRuntime; disabled: boolean; onChange: (next: MachineRuntime) => void;
}) {
  const id = useId();
  return <fieldset className="klide-machine-choices" disabled={disabled}>
    <legend>How should agents run?</legend>
    <label><input type="radio" name={`${id}-execution`} checked={value.execution === "direct"} onChange={() => onChange({ ...value, execution: "direct" })} /><span><strong>Direct</strong><small>Use the remote account’s permissions. Simplest for a dedicated VPS; agents can access that account’s files and services.</small></span></label>
    <label><input type="radio" name={`${id}-execution`} checked={value.execution === "isolated"} onChange={() => onChange({ ...value, execution: "isolated" })} /><span><strong>Isolated</strong><small>Use a Docker Sandbox with its own Linux filesystem. Host folders and personal logins are not shared. Requires Ubuntu with KVM or an Apple silicon Mac with macOS 14+.</small></span></label>
  </fieldset>;
}
export function MachineCredentialChoices({ value, disabled, onChange }: {
  value: MachineRuntime; disabled: boolean; onChange: (next: MachineRuntime) => void;
}) {
  const id = useId();
  return <fieldset className="klide-machine-choices" disabled={disabled}>
    <legend>Which credentials should Claude Code use?</legend>
    <label><input type="radio" name={`${id}-credential`} checked={value.credential === "subscription"} onChange={() => onChange({ ...value, credential: "subscription" })} /><span><strong>Sign into a subscription</strong><small>A separate Claude login for Klide on this destination. Complete sign-in in your browser; your Mac can then be switched off.</small></span></label>
    <label><input type="radio" name={`${id}-credential`} checked={value.credential === "apiKey"} onChange={() => onChange({ ...value, credential: "apiKey" })} /><span><strong>Authorize an API key</strong><small>Choose a saved Anthropic key explicitly. {value.execution === "isolated" ? "Docker’s host-side proxy stores the key outside the sandbox." : "The key is stored on the destination, readable by this account and its agents."} API usage is billed separately.</small></span></label>
    <label><input type="radio" name={`${id}-credential`} checked={value.credential === "existing"} onChange={() => onChange({ ...value, credential: "existing" })} /><span><strong>Use existing destination credentials</strong><small>Use the login or API environment already available {value.execution === "isolated" ? "inside this sandbox" : "to the remote account"}. Nothing is copied from this Mac.</small></span></label>
  </fieldset>;
}
