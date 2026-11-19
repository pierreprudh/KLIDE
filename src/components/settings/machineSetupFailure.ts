import type { MachineSetupAction } from "../../ipc/machines";

/** Explain known SSH failures without guessing that an unreachable machine is off. */
export function machineSetupFailure(action: MachineSetupAction, output: string): string {
  if (action !== "connect" && action !== "authorize") return "Setup couldn’t finish. Try again, or open Details for the full error.";
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(output)) return "SSH could not verify this machine. Review the fingerprint warning before reconnecting.";
  if (/Permission denied|Authentication failed|Too many authentication failures/i.test(output)) return action === "authorize"
    ? "SSH sign-in was rejected. Check Remote username and the remote account password, then retry."
    : "SSH sign-in was rejected. Check Remote username, or choose Enable background access to authorize this Mac.";
  if (/Connection closed|Connection reset/i.test(output)) return "The machine closed SSH. Check the remote username and that Remote Login allows this account, then retry.";
  if (/Connection refused/i.test(output)) return "SSH is not accepting connections. On a Mac, enable Remote Login in System Settings → General → Sharing.";
  if (/timed out|No route to host|Network is unreachable|Could not resolve hostname/i.test(output)) return "Could not reach this machine. Check its address, network or VPN, and that it is awake.";
  return "SSH setup stopped. Check Remote username, then retry or open Details for the full error.";
}
