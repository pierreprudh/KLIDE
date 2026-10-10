//! The `/klide` skill for Claude Code — "open this conversation in Klide",
//! said in a terminal, becomes `open "klide://resume?…&session=$CLAUDE_CODE_SESSION_ID"`
//! (deep_link.rs). It is one `SKILL.md` in Claude Code's user skills folder,
//! written only when asked (Settings › From other apps) and removed only when
//! it is still the file Klide wrote. Same shape as the Ask Kit Quick Action
//! (services_menu.rs): a tiny file that opens a link; Klide owns the rules.
//!
//! Why a skill and not an MCP server: a server would be a child of the CLI
//! and would not know the parent's session id either — the id reaches a
//! shell as `CLAUDE_CODE_SESSION_ID`, so a skill that runs `open` is the whole
//! bridge. Claude Code only, for now: no other Delegate exports its id.

use std::path::PathBuf;

/// Claude Code's copy: exact, because its shell knows `$CLAUDE_CODE_SESSION_ID`.
const SKILL_CLAUDE: &str = include_str!("../resources/klide-skill/SKILL.md");
/// The copy every other CLI reads from `~/.agents/skills` (Codex documents the
/// folder; OpenCode and omp read it too): the newest session in the folder,
/// since those CLIs don't tell their shell their own id.
const SKILL_AGENTS: &str = include_str!("../resources/klide-skill/SKILL.agents.md");
/// The line that makes a file ours to remove.
const MARKER: &str = "Installed by Klide";

/// Both files the toggle owns: `<Claude Code skills dir>/klide/SKILL.md` (the
/// adapter owns where that is, `CLAUDE_CONFIG_DIR` honoured) and
/// `~/.agents/skills/klide/SKILL.md`, the cross-agent folder the Skills
/// loader already lists.
fn skill_files() -> Result<[(PathBuf, &'static str); 2], String> {
    let claude = crate::delegate::ClaudeCode
        .skills_dir(&crate::delegate::ProcessEnv)
        .ok_or("No home directory")?;
    let home = crate::cli::home_dir_path().ok_or("No home directory")?;
    Ok([
        (claude.join("klide").join("SKILL.md"), SKILL_CLAUDE),
        (home.join(".agents").join("skills").join("klide").join("SKILL.md"), SKILL_AGENTS),
    ])
}

fn ours(file: &std::path::Path) -> bool {
    std::fs::read_to_string(file).is_ok_and(|s| s.contains(MARKER))
}

/// Installed means both copies are in place and still ours.
pub fn installed() -> bool {
    skill_files().is_ok_and(|files| files.iter().all(|(f, _)| ours(f)))
}

pub fn install() -> Result<(), String> {
    for (file, body) in skill_files()? {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
        }
        std::fs::write(&file, body).map_err(|e| format!("Could not write {}: {e}", file.display()))?;
    }
    Ok(())
}

/// Remove the skill — only the files Klide wrote, so a user who replaced one
/// with their own `klide` skill keeps theirs.
pub fn uninstall() -> Result<(), String> {
    for (file, _) in skill_files()? {
        if !ours(&file) {
            continue;
        }
        std::fs::remove_file(&file).map_err(|e| format!("Could not remove {}: {e}", file.display()))?;
        if let Some(dir) = file.parent() {
            let _ = std::fs::remove_dir(dir); // only when empty
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn klide_skill_status() -> Result<bool, String> {
    crate::blocking::run(|| Ok(installed())).await
}

#[tauri::command]
pub(crate) async fn klide_skill_set(enabled: bool) -> Result<bool, String> {
    crate::blocking::run(move || {
        if enabled { install()? } else { uninstall()? }
        Ok(installed())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_skills_open_a_resume_link_each_cli_can_fill() {
        for skill in [SKILL_CLAUDE, SKILL_AGENTS] {
            assert!(skill.starts_with("---\nname: klide\n"));
            assert!(skill.contains(MARKER), "the uninstall marker must be in the file");
            assert!(skill.contains("klide://resume?provider="));
        }
        // Claude Code's copy is exact: its shell knows the session id.
        assert!(SKILL_CLAUDE.contains(r#"open "klide://resume?provider=claude-code&session=$CLAUDE_CODE_SESSION_ID""#));
        // The others name every Delegate id and lean on the folder.
        for d in crate::delegate::catalog() {
            assert!(SKILL_AGENTS.contains(&format!("`{}`", d.id)), "{} missing from the cross-agent skill", d.id);
        }
        assert!(SKILL_AGENTS.contains("&project=$("));
    }
}
