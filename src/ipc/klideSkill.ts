// The `/klide` skill for Claude Code (klide_skill.rs): whether it is installed
// in ~/.claude/skills, and installing or removing it. "Open this in Klide",
// said to Claude Code in a terminal, then opens a `klide://resume` link.

import { invoke } from "@tauri-apps/api/core";

export function klideSkillInstalled(): Promise<boolean> {
  return invoke<boolean>("klide_skill_status");
}

/** Install or remove the skill; answers whether it is installed now. */
export function setKlideSkill(enabled: boolean): Promise<boolean> {
  return invoke<boolean>("klide_skill_set", { enabled });
}
