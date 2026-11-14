// Settings › AI › Execution — "Code Mode". The switch for agent/script.rs:
// a Run may be offered `run_script`, which reads many files in one step and
// sends back only the answer. The choice lives in Rust
// (~/.klide/code_mode.json), so this row only reads it and asks to change it.

import { useEffect, useState } from "react";
import { codeModeStatus, setCodeMode, type CodeModeStatus } from "../../ipc/codeMode";
import { errMessage } from "../../errors";
import { notify } from "../../toast";
import { Row, Toggle } from "./controls";

export const CODE_MODE_TITLE = "Code Mode";

export function CodeModeRow() {
  const [status, setStatus] = useState<CodeModeStatus | null>(null);

  useEffect(() => {
    codeModeStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  if (!status) return null;

  async function change(enabled: boolean) {
    try {
      setStatus(await setCodeMode(enabled));
    } catch (e) {
      notify(errMessage(e), { tone: "error" });
    }
  }

  return (
    <Row
      title={CODE_MODE_TITLE}
      description="Let the agent read many files in one step and send back only what it needs."
      help="Experimental. The agent writes a short script that can only read: files, searches and git history inside the project. No edits, commands or network. Not offered to local models. Takes effect on the next message."
      control={<Toggle checked={status.enabled} onChange={(v) => void change(v)} label={CODE_MODE_TITLE} />}
    />
  );
}
