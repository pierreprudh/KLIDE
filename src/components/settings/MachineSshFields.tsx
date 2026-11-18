import type { Ref } from "react";
import { joinSshAddress, needsSshUsername, splitSshAddress } from "./machineSshAddress";

/** Keep the saved SSH destination intact while making its account explicit. */
export function MachineSshFields({ value, onChange, disabled, inputRef }: {
  value: string; onChange: (value: string) => void; disabled: boolean; inputRef?: Ref<HTMLInputElement>;
}) {
  const { address, username } = splitSshAddress(value);
  return <div className="klide-machine-ssh-fields">
    <label>SSH host<input ref={inputRef} className="klide-field" value={address} onChange={(event) => {
      const next = event.target.value;
      onChange(next.includes("@") ? next : joinSshAddress(next, username));
    }} required disabled={disabled} placeholder="IP, hostname or SSH alias" autoCapitalize="none" spellCheck={false} /></label>
    <label>Remote username<input className="klide-field" value={username} onChange={(event) => onChange(joinSshAddress(address, event.target.value.trim()))} required={needsSshUsername(value)} disabled={disabled} placeholder="Account on that machine" autoCapitalize="none" spellCheck={false} autoComplete="off" /></label>
  </div>;
}
