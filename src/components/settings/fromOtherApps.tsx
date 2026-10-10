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
        description="Select text anywhere, right-click → Services → Ask Kit. It opens a new conversation with that text in the composer, not sent."
        control={
          <Toggle checked={installed === true} onChange={(v) => void toggle(v)} label="Ask Kit from any app" />
        }
      />
      <Row
        title="Continue in Klide from Claude Code"
        description="Installs a /klide skill for Claude Code. In any terminal session, “open this conversation in Klide” resumes that same session in an AI panel, in its project."
        control={<Toggle checked={skill === true} onChange={(v) => void toggleSkill(v)} label="Continue in Klide from Claude Code" />}
      />
      <Row
        title="Klide links"
        description="For Raycast quicklinks, Shortcuts or a terminal: klide://new?prompt=…, klide://open?path=/file:42, klide://project?path=/folder, klide://resume?provider=claude-code&session=<id>. A link fills the composer or resumes a session; it never sends."
        control={<CodeText>open "klide://new?prompt=hi"</CodeText>}
      />
    </Panel>
  );
}
