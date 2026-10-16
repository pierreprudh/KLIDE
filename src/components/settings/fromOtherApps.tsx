// Settings › General › From other apps — the ways into Klide from outside it:
// the "Ask Kit" Services item, and the `klide://` links Raycast, Shortcuts or
// a terminal can open (deep_link.rs). Both only ever pre-fill: a link can put
// words in the composer, never send them.

import { useEffect, useState } from "react";
import { askKitServiceInstalled, setAskKitService } from "../../ipc/servicesMenu";
import { klideSkillInstalled, setKlideSkill } from "../../ipc/klideSkill";
import { errMessage } from "../../errors";
import { notify } from "../../toast";
import { CodeText, Panel, Row, Toggle } from "./controls";

export function FromOtherApps() {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [skill, setSkill] = useState<boolean | null>(null);

  useEffect(() => {
    askKitServiceInstalled().then(setInstalled).catch(() => setInstalled(false));
    klideSkillInstalled().then(setSkill).catch(() => setSkill(false));
  }, []);

  async function toggleSkill(enabled: boolean) {
    try {
      setSkill(await setKlideSkill(enabled));
      if (enabled) notify("The /klide skill is in ~/.claude/skills — say “open this in Klide” to Claude Code", { tone: "success" });
    } catch (e) {
      notify(errMessage(e), { tone: "error" });
    }
  }

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
        description="Send selected text to a new Klide conversation without submitting it."
        help="Select text in another app, then right-click → Services → Ask Kit. Review the text in the composer before sending."
        control={
          <Toggle checked={installed === true} onChange={(v) => void toggle(v)} label="Ask Kit from any app" />
        }
      />
      <Row
        title="Continue in Klide from Claude Code"
        description="Resume a Claude Code terminal conversation in Klide."
        help="Installs the /klide skill for Claude Code. Ask “open this conversation in Klide” to resume the same session in its project."
        control={<Toggle checked={skill === true} onChange={(v) => void toggleSkill(v)} label="Continue in Klide from Claude Code" />}
      />
      <Row
        title="Klide links"
        description="Open files, projects, or conversations from Raycast, Shortcuts, or a terminal."
        help="Use klide://new?prompt=…, klide://open?path=/file:42, klide://project?path=/folder, or klide://resume?provider=claude-code&session=<id>. Links fill the composer or resume a session; they never send a message."
        control={<CodeText>open "klide://new?prompt=hi"</CodeText>}
      />
    </Panel>
  );
}
