// Settings › General › From other apps — the ways into Klide from outside it:
// the "Ask Kit" Services item, and the `klide://` links Raycast, Shortcuts or
// a terminal can open (deep_link.rs). Both only ever pre-fill: a link can put
// words in the composer, never send them.

import { useEffect, useState } from "react";
import { askKitServiceInstalled, setAskKitService } from "../../ipc/servicesMenu";
import { errMessage } from "../../errors";
import { notify } from "../../toast";
import { CodeText, Panel, Row, Toggle } from "./controls";

export function FromOtherApps() {
  const [installed, setInstalled] = useState<boolean | null>(null);

  useEffect(() => {
    askKitServiceInstalled().then(setInstalled).catch(() => setInstalled(false));
  }, []);

  async function toggle(enabled: boolean) {
    try {
      setInstalled(await setAskKitService(enabled));
      if (enabled) notify("Ask Kit added to the Services menu", { tone: "success" });
    } catch (e) {
      notify(errMessage(e), { tone: "error" });
    }
  }

  return (
    <Panel>
      <Row
        title="Ask Kit from any app"
        description="Select text anywhere, right-click → Services → Ask Kit. It opens a new conversation with that text in the composer, not sent."
        control={
          <Toggle checked={installed === true} onChange={(v) => void toggle(v)} label="Ask Kit from any app" />
        }
      />
      <Row
        title="Klide links"
        description="For Raycast quicklinks, Shortcuts or a terminal: klide://new?prompt=…, klide://open?path=/file:42, klide://project?path=/folder. A link fills the composer; it never sends."
        control={<CodeText>open "klide://new?prompt=hi"</CodeText>}
      />
    </Panel>
  );
}
