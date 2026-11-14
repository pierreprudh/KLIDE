// The one line a restricted folder shows under the title bar: what is off,
// and the click that turns it back on. Quiet type, no badge, no icon.

import { useState } from "react";
import { notify } from "../toast";
import { errMessage } from "../errors";

export function RestrictedFolderBanner({ gitPaused, onTrust }: { gitPaused: boolean; onTrust: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const trust = async () => {
    setBusy(true);
    try {
      await onTrust();
    } catch (error) {
      notify(`Couldn't trust this folder: ${errMessage(error)}`, { tone: "warn" });
      setBusy(false);
    }
  };
  return (
    <div className="klide-restricted-banner" role="status">
      <span className="klide-restricted-banner-text">
        <span className="klide-restricted-banner-title">Restricted folder</span>
        {gitPaused
          ? "Git is paused: this repository's settings can start programs."
          : "Klide runs none of this repository's Git hooks or programs."}
      </span>
      <button type="button" className="klide-restricted-banner-trust" onClick={() => void trust()} disabled={busy}>
        Trust folder
      </button>
    </div>
  );
}
