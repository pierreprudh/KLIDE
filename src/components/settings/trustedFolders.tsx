// Settings › AI › Execution — "Trusted folders". The list Rust keeps in
// ~/.klide/trusted-folders.json (workspace_trust.rs): a folder on it, and
// everything inside it, runs its repository's own Git hooks and programs.
// Trust is granted from the notification on a restricted folder; this row is
// where it is taken back.

import { useEffect, useState } from "react";
import { trustedFolders, untrustWorkspace } from "../../ipc/workspaceTrust";
import { trustListChanged } from "../../workspaceTrust";
import { errMessage } from "../../errors";
import { notify } from "../../toast";
import { GhostButton, Row } from "./controls";

export const TRUSTED_FOLDERS_TITLE = "Trusted folders";

function folderName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

export function TrustedFoldersRow() {
  const [folders, setFolders] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    trustedFolders().then(setFolders).catch(() => setFolders([]));
  }, []);

  async function remove(folder: string) {
    setBusy(folder);
    try {
      await untrustWorkspace(folder);
      setFolders(await trustedFolders());
      trustListChanged();
    } catch (e) {
      notify(`Couldn't remove this folder: ${errMessage(e)}`, { tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  const count = folders?.length ?? 0;
  return (
    <Row
      title={TRUSTED_FOLDERS_TITLE}
      description={
        folders === null ? "Loading…" : count === 0 ? "No folder is trusted yet." : count === 1 ? "1 folder runs its own Git hooks and programs." : `${count} folders run their own Git hooks and programs.`
      }
      help="A folder you have not trusted opens restricted: Klide reads and edits it, but runs none of its repository's own Git hooks or programs. Trusting a folder covers everything inside it, and worktrees of its repository wherever they live. Remove a folder here to restrict it again; the notification offers to trust it the next time you open it."
      control={null}
      footer={
        count > 0 ? (
          <ul className="klide-trusted-list">
            {folders!.map((folder) => (
              <li key={folder} className="klide-trusted-row">
                <div style={{ minWidth: 0 }}>
                  <div className="klide-trusted-name">{folderName(folder)}</div>
                  <div className="klide-trusted-path" title={folder}>{folder}</div>
                </div>
                <GhostButton onClick={() => void remove(folder)} disabled={busy !== null}>
                  {busy === folder ? "Removing…" : "Remove"}
                </GhostButton>
              </li>
            ))}
          </ul>
        ) : undefined
      }
    />
  );
}
