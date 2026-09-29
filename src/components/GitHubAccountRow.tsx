import { AccountSwapButton } from "./AccountSwapButton";
import { useRef, useState } from "react";
import { Row } from "./settings/controls";
import { githubAccounts, githubSetAccount } from "../ipc/git";
import { setGitHubUserInfo, useUserInfo } from "../hooks/useUserInfo";
import { notify } from "../toast";

/** One-click cycling through the accounts already signed in to GitHub CLI. */
export function GitHubAccountRow({ compact = false }: { compact?: boolean }) {
  const { githubLogin } = useUserInfo();
  const [busy, setBusy] = useState(false);
  const switching = useRef(false);

  async function swap() {
    if (switching.current) return;
    switching.current = true;
    setBusy(true);
    try {
      // Read on every click so accounts added outside Klide are available immediately.
      const view = await githubAccounts();
      const current = view.pinned ?? view.active;
      const index = view.logins.indexOf(current ?? "");
      const next = view.logins[(index + 1) % view.logins.length];
      if (!next || next === current) {
        notify("Add another GitHub account with: gh auth login --hostname github.com", { tone: "info" });
        return;
      }
      const user = await githubSetAccount(next);
      setGitHubUserInfo(user);
      notify(`Switched to ${user.login}.`, { tone: "success" });
    } catch (error) {
      notify(String(error), { tone: "error" });
    } finally {
      switching.current = false;
      setBusy(false);
    }
  }

  const control = (
    <AccountSwapButton label="Switch GitHub account" busy={busy} onClick={() => void swap()} />
  );

  if (compact) return (
    <section aria-label="GitHub account" className="profile-account-menu-row">
      <img src="./github-invertocat.svg" alt="" width={18} height={18} />
      <span style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {githubLogin || "GitHub"}
      </span>
      {control}
    </section>
  );

  return (
    <Row
      title="GitHub"
      description={githubLogin || "Not signed in"}
      control={control}
      leading={<img src="./github-invertocat.svg" alt="" width={18} height={18} />}
    />
  );
}
