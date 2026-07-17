// Skills — instruction bundles loaded from four well-known directories
// (workspace `.agents/skills` + `.klide/skills`, user `.agents/skills` +
// `.claude/skills`). We parse each `SKILL.md`'s frontmatter, group by
// provenance (author / GitHub repo owner), and shell out to `npx skills`
// for install/uninstall. The frontend toggles which are active and folds
// them into the system prompt.

use tokio::process::Command as TokioCommand;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillCommandResult {
    ok: bool,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// One skill discovered on disk. Mirrors the shape the frontend builds
/// locally so the UI can drop these into the same Skill[] list.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileSystemSkill {
    id: String,
    name: String,
    description: String,
    instructions: String,
    /// Path to the SKILL.md, absolute. Display-only — the frontend
    /// hands it back to `uninstall_skill` by folder name.
    from_file: String,
    /// "workspace-agents" | "workspace-klide" | "home-agents" | "home-claude"
    source: String,
    /// Human-readable provenance label for grouping in the modal — e.g.
    /// "Vercel", "Matt Pocock", "Personal", "Workspace".
    group: String,
}

fn parse_skill_md(raw: &str, folder: &str) -> (String, String, String) {
    // Returns (name, description, instructions).
    let mut name = folder.to_string();
    let mut description = String::new();
    let mut instructions = raw.to_string();
    if let Some(stripped) = raw.strip_prefix("---\n") {
        if let Some(end) = stripped.find("\n---\n") {
            let frontmatter = &stripped[..end];
            for line in frontmatter.lines() {
                if let Some((k, v)) = line.split_once(':') {
                    let key = k.trim();
                    let value = v.trim();
                    if key == "name" {
                        name = value.to_string();
                    }
                    if key == "description" {
                        description = value.to_string();
                    }
                }
            }
            instructions = stripped[end + 5..].trim().to_string();
        }
    }
    (name, description, instructions)
}

/// Extract provenance metadata from a SKILL.md frontmatter. Returns
/// (author, repository) — both are best-effort and may be empty. We
/// support the flat `metadata:` block that `npx skills` packages use:
///
/// ```text
/// metadata:
///   author: vercel
///   version: "1.0.0"
/// ```
fn parse_skill_provenance(raw: &str) -> (String, String) {
    let Some(stripped) = raw.strip_prefix("---\n") else {
        return (String::new(), String::new());
    };
    let Some(end) = stripped.find("\n---\n") else {
        return (String::new(), String::new());
    };
    let frontmatter = &stripped[..end];
    let mut in_metadata = false;
    let mut author = String::new();
    let mut repository = String::new();
    for line in frontmatter.lines() {
        if line.starts_with("metadata:") {
            in_metadata = true;
            continue;
        }
        if in_metadata {
            // End of the metadata block when we hit a non-indented line.
            if !line.starts_with(' ') && !line.starts_with('\t') && !line.trim().is_empty() {
                in_metadata = false;
            } else if let Some((k, v)) = line.trim().split_once(':') {
                let key = k.trim();
                let value = v.trim().trim_matches('"');
                if key == "author" {
                    author = value.to_string();
                }
                if key == "repository" {
                    repository = value.to_string();
                }
            }
        }
    }
    (author, repository)
}

/// Map (source, author, repository) to a display group label for the
/// modal. The grouping is "where did this come from" — so install
/// paths, publisher, and self-authored all show up distinctly.
fn skill_group_label(source: &str, author: &str, repository: &str) -> String {
    // Workspace folders always show as their own group, regardless of author.
    if source == "workspace-agents" {
        return "Workspace".to_string();
    }
    if source == "workspace-klide" {
        return "Workspace (auto-generated)".to_string();
    }

    // Author takes precedence — it's the most reliable signal.
    let a = author.to_lowercase();
    if !a.is_empty() {
        match a.as_str() {
            "vercel" => return "Vercel".to_string(),
            "anthropic" | "anthropics" => return "Anthropic".to_string(),
            "mattpocock" | "matt pocock" => return "Matt Pocock".to_string(),
            _ => {
                // Unknown author: title-case it for display.
                let mut chars = a.chars();
                let titled = match chars.next() {
                    Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
                    None => String::new(),
                };
                return titled;
            }
        }
    }

    // Fall back to the GitHub repo's owner if we have it.
    if !repository.is_empty() {
        // e.g. "https://github.com/vercel-labs/agent-skills" -> "Vercel"
        let path = repository.trim_end_matches('/');
        let lower = path.to_lowercase();
        if let Some(rest) = lower
            .strip_prefix("https://github.com/")
            .or_else(|| lower.strip_prefix("github.com/"))
        {
            let owner = rest.split('/').next().unwrap_or("");
            let clean = owner.trim_start_matches('@');
            match clean {
                "vercel-labs" | "vercel" => return "Vercel".to_string(),
                "anthropics" | "anthropic" => return "Anthropic".to_string(),
                "mattpocock" => return "Matt Pocock".to_string(),
                _ => {
                    if !clean.is_empty() {
                        // Title-case the owner for display.
                        let mut chars = clean.chars();
                        return match chars.next() {
                            Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
                            None => String::new(),
                        };
                    }
                }
            }
        }
    }

    // No author and no repository — distinguish home vs. personal.
    if source == "home-agents" {
        return "Personal".to_string();
    }
    "Personal".to_string()
}

/// Walk the four well-known skill locations and return everything we
/// can find on disk. The Rust side runs unsandboxed, so it can read
/// the user's home directory without a Tauri fs scope entry.
#[tauri::command]
pub(crate) fn list_filesystem_skills(
    workspace_root: Option<String>,
) -> Result<Vec<FileSystemSkill>, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "Could not resolve home directory.".to_string())?;
    let home = home.to_string_lossy().to_string();

    let sources: [(&str, std::path::PathBuf); 4] = [
        (
            "workspace-agents",
            std::path::PathBuf::from(format!(
                "{}/.agents/skills",
                workspace_root.clone().unwrap_or_default()
            )),
        ),
        (
            "workspace-klide",
            std::path::PathBuf::from(format!(
                "{}/.klide/skills",
                workspace_root.clone().unwrap_or_default()
            )),
        ),
        (
            "home-agents",
            std::path::PathBuf::from(format!("{home}/.agents/skills")),
        ),
        (
            "home-claude",
            std::path::PathBuf::from(format!("{home}/.claude/skills")),
        ),
    ];

    let mut out: Vec<FileSystemSkill> = Vec::new();
    for (source, dir) in sources.iter() {
        // Skip the two workspace paths when no workspace is open — the
        // `format!` above produced an empty workspace_root, which would
        // otherwise resolve to a stray `/.agents/skills` on macOS.
        if source.starts_with("workspace-") && workspace_root.is_none() {
            continue;
        }
        let Ok(read) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in read.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let folder = match entry.file_name().into_string() {
                Ok(s) => s,
                Err(_) => continue,
            };
            let skill_file = entry.path().join("SKILL.md");
            if !skill_file.exists() {
                continue;
            }
            let raw = match std::fs::read_to_string(&skill_file) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let (name, description, instructions) = parse_skill_md(&raw, &folder);
            let (author, repository) = parse_skill_provenance(&raw);
            let group = skill_group_label(source, &author, &repository);
            let id = format!("file-{source}-{folder}");
            out.push(FileSystemSkill {
                id,
                name: if name.is_empty() {
                    folder.clone()
                } else {
                    name
                },
                description: if description.is_empty() {
                    format!("Skill from {}", skill_file.display())
                } else {
                    description
                },
                instructions,
                from_file: skill_file.to_string_lossy().to_string(),
                source: (*source).to_string(),
                group,
            });
        }
    }
    Ok(out)
}

/// Install a skill from a GitHub-style package spec (e.g. `anthropics/skills`,
/// `anthropics/skills/frontend-design`) into `~/.claude/skills/` via the
/// `npx skills add` CLI. Returns the captured output so the UI can surface it.
#[tauri::command]
pub(crate) async fn install_skill(package: String) -> Result<SkillCommandResult, String> {
    let trimmed = package.trim().to_string();
    if trimmed.is_empty() {
        return Err("Package is required.".into());
    }
    // No shell — we pass the package as a single argv entry.
    let output = TokioCommand::new("npx")
        .arg("--yes")
        .arg("skills")
        .arg("add")
        .arg(&trimmed)
        .arg("-g") // global: ~/.claude/skills
        .arg("-y") // non-interactive
        .output()
        .await
        .map_err(|e| format!("Failed to run `npx skills add`: {e}"))?;
    Ok(SkillCommandResult {
        ok: output.status.success(),
        exit_code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// A skill folder name must be a single plain path component — no separators,
/// no parent refs — so the renderer can only ever address a direct child of
/// `~/.claude/skills`. Without this check `{"name": "../../.ssh"}` would make
/// `uninstall_skill` delete an arbitrary user directory.
fn validate_skill_folder_name(name: &str) -> Result<(), String> {
    let mut components = std::path::Path::new(name).components();
    match (components.next(), components.next()) {
        (Some(std::path::Component::Normal(_)), None) => Ok(()),
        _ => Err("Invalid skill name.".into()),
    }
}

/// Remove a globally-installed skill by its folder name. Removes the
/// `~/.claude/skills/<name>` directory if it exists.
#[tauri::command]
pub(crate) async fn uninstall_skill(name: String) -> Result<SkillCommandResult, String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err("Skill name is required.".into());
    }
    validate_skill_folder_name(&trimmed)?;
    let trimmed_skill_name = trimmed.clone();
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "Could not resolve home directory.".to_string())?;
    let target = home
        .join(".claude")
        .join("skills")
        .join(&trimmed_skill_name);
    if !target.exists() {
        return Ok(SkillCommandResult {
            ok: true,
            exit_code: Some(0),
            stdout: format!(
                "Skill `{}` was not installed; nothing to do.",
                trimmed_skill_name
            ),
            stderr: String::new(),
        });
    }
    std::fs::remove_dir_all(&target)
        .map_err(|e| format!("Failed to remove {}: {e}", target.display()))?;
    Ok(SkillCommandResult {
        ok: true,
        exit_code: Some(0),
        stdout: format!("Removed {}.", target.display()),
        stderr: String::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const FM: &str = "---\nname: My Skill\ndescription: does a thing\n---\nThe body.\nMore body.";

    #[test]
    fn parse_skill_md_reads_frontmatter_and_body() {
        let (name, desc, instructions) = parse_skill_md(FM, "folder-name");
        assert_eq!(name, "My Skill");
        assert_eq!(desc, "does a thing");
        assert_eq!(instructions, "The body.\nMore body.");
    }

    #[test]
    fn parse_skill_md_without_frontmatter_falls_back_to_folder() {
        let (name, desc, instructions) = parse_skill_md("just a body", "my-folder");
        assert_eq!(name, "my-folder");
        assert_eq!(desc, "");
        assert_eq!(instructions, "just a body");
    }

    #[test]
    fn parse_provenance_reads_metadata_block() {
        let raw = "---\nname: x\nmetadata:\n  author: vercel\n  repository: https://github.com/vercel/skills\n  version: \"1.0\"\n---\nbody";
        let (author, repo) = parse_skill_provenance(raw);
        assert_eq!(author, "vercel");
        assert_eq!(repo, "https://github.com/vercel/skills");
    }

    #[test]
    fn parse_provenance_empty_when_no_metadata() {
        assert_eq!(parse_skill_provenance(FM), (String::new(), String::new()));
        assert_eq!(
            parse_skill_provenance("no frontmatter"),
            (String::new(), String::new())
        );
    }

    #[test]
    fn group_label_workspace_sources_win_over_author() {
        assert_eq!(
            skill_group_label("workspace-agents", "vercel", ""),
            "Workspace"
        );
        assert_eq!(
            skill_group_label("workspace-klide", "anthropic", ""),
            "Workspace (auto-generated)"
        );
    }

    #[test]
    fn group_label_maps_known_authors() {
        assert_eq!(skill_group_label("home-claude", "vercel", ""), "Vercel");
        assert_eq!(
            skill_group_label("home-claude", "anthropics", ""),
            "Anthropic"
        );
        assert_eq!(
            skill_group_label("home-claude", "matt pocock", ""),
            "Matt Pocock"
        );
        // Unknown author is title-cased for display.
        assert_eq!(skill_group_label("home-claude", "acme", ""), "Acme");
    }

    #[test]
    fn group_label_falls_back_to_repo_owner_then_personal() {
        assert_eq!(
            skill_group_label(
                "home-claude",
                "",
                "https://github.com/vercel-labs/agent-skills"
            ),
            "Vercel"
        );
        assert_eq!(
            skill_group_label("home-claude", "", "github.com/someone/repo"),
            "Someone"
        );
        // No author, no repo → Personal.
        assert_eq!(skill_group_label("home-agents", "", ""), "Personal");
        assert_eq!(skill_group_label("home-claude", "", ""), "Personal");
    }

    #[test]
    fn skill_folder_name_accepts_plain_names() {
        assert!(validate_skill_folder_name("frontend-design").is_ok());
        assert!(validate_skill_folder_name("my_skill.v2").is_ok());
    }

    #[test]
    fn skill_folder_name_rejects_traversal_and_separators() {
        assert!(validate_skill_folder_name("..").is_err());
        assert!(validate_skill_folder_name("../../.ssh").is_err());
        assert!(validate_skill_folder_name("a/b").is_err());
        assert!(validate_skill_folder_name("/etc").is_err());
        assert!(validate_skill_folder_name(".").is_err());
        assert!(validate_skill_folder_name("").is_err());
    }
}
