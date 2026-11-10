// Settings › AI › Execution — "Sandbox unreviewed commands". The switch for
// agent/sandbox.rs: a command that ran on the full-auto rung or a wildcard
// rule, without anyone reading it, is held to the project. The choice lives in
// Rust (~/.klide/sandbox.json), so this row only reads it and asks to change it.

import { useEffect, useState } from "react";
import { commandSandboxStatus, setCommandSandbox, type CommandSandboxStatus } from "../../ipc/sandbox";
import { errMessage } from "../../errors";
import { notify } from "../../toast";
import { Row, Toggle } from "./controls";

export const COMMAND_SANDBOX_TITLE = "Sandbox unreviewed commands";
export const COMMAND_SANDBOX_NETWORK_TITLE = "Network in sandboxed commands";

export function CommandSandboxRow() {
  const [status, setStatus] = useState<CommandSandboxStatus | null>(null);

  useEffect(() => {
    commandSandboxStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  // Nothing to switch where the platform has no sandbox.
  if (!status?.supported) return null;

  async function change(next: { enabled?: boolean; network?: boolean }) {
    try {
      setStatus(await setCommandSandbox(next));
    } catch (e) {
      notify(errMessage(e), { tone: "error" });
    }
  }

  return (
    <>
      <Row
        title={COMMAND_SANDBOX_TITLE}
        description="Commands that run without your approval can write only inside the project."
        help="Applies to commands run by Full auto or a wildcard project rule. They can still write to temp folders and tool caches, but not to the rest of your disk, git hooks or git config. Commands you approve yourself are not sandboxed, and a sandboxed command can ask you to run it without the sandbox. Takes effect on the next command."
        control={<Toggle checked={status.enabled} onChange={(v) => void change({ enabled: v })} label={COMMAND_SANDBOX_TITLE} />}
      />
      {status.enabled && (
        <Row
          title={COMMAND_SANDBOX_NETWORK_TITLE}
          description="Let sandboxed commands reach the internet."
          help="Off, a sandboxed command can only reach this machine: installs, pushes and downloads fail and the agent asks you to approve them. On, they run without asking. Servers on localhost work either way."
          control={<Toggle checked={status.network} onChange={(v) => void change({ network: v })} label={COMMAND_SANDBOX_NETWORK_TITLE} />}
        />
      )}
    </>
  );
}
