//! Which folders a person has trusted.
//!
//! A folder nobody has trusted opens *restricted*: Klide still reads and
//! edits it, but the repository gets no say in which programs Klide's own
//! `git` starts (see `git/cmd.rs`). Trusting a folder is one click on the
//! banner, and covers everything inside it — including a worktree whose
//! repository is trusted, wherever the worktree lives.
//!
//! The list lives in `~/.klide/trusted-folders.json`, never in the folder
//! itself, so a repository cannot vouch for itself. It only grows: there is
//! no "untrust" yet beyond editing that file.

use std::path::{Path, PathBuf};

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct Store {
    #[serde(default)]
    folders: Vec<String>,
}

fn store_path() -> Option<PathBuf> {
    crate::delegate::home_dir(&crate::delegate::ProcessEnv).map(|home| home.join(".klide/trusted-folders.json"))
}

/// The trusted folders in `path`. A missing or unreadable file trusts
/// nothing: broken storage never grants trust.
fn read_from(path: &Path) -> Vec<PathBuf> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Store>(&bytes).ok())
        .map(|store| store.folders.into_iter().map(PathBuf::from).collect())
        .unwrap_or_default()
}

fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// Whether `dir` is a trusted folder, inside one, or a worktree of a
/// repository that is.
fn is_trusted_by(folders: &[PathBuf], dir: &Path) -> bool {
    let dir = canonical(dir);
    let covered = |path: &Path| folders.iter().any(|folder| path.starts_with(folder));
    if covered(&dir) {
        return true;
    }
    // A worktree's `.git` file points into its repository's git directory;
    // that repository's checkout is the folder that was trusted.
    crate::agent::sandbox::git_dirs(&dir)
        .first()
        .and_then(|common| canonical(common).parent().map(Path::to_path_buf))
        .is_some_and(|repo| covered(&repo))
}

/// Whether `dir` is trusted, by the list on disk.
pub fn is_trusted(dir: &Path) -> bool {
    store_path().is_some_and(|path| is_trusted_by(&read_from(&path), dir))
}

/// Add `roots` to the list in `path`, each once, as the kernel names it.
fn grant_in(path: &Path, roots: &[String]) -> Result<(), String> {
    let mut folders: Vec<String> = read_from(path).into_iter().map(|p| p.to_string_lossy().into_owned()).collect();
    for root in roots {
        let root = Path::new(root);
        if !root.is_absolute() {
            return Err(format!("\"{}\" is not an absolute folder", root.display()));
        }
        let root = canonical(root).to_string_lossy().into_owned();
        if !folders.contains(&root) {
            folders.push(root);
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Unable to create {}: {e}", parent.display()))?;
    }
    let bytes = serde_json::to_vec_pretty(&Store { folders }).map_err(|e| e.to_string())?;
    crate::durable::write_atomic(path, &bytes)
}

#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrustStatus {
    pub trusted: bool,
    /// Restricted, and the repository's own Git settings name programs, so
    /// Klide runs no Git here until the folder is trusted.
    pub git_paused: bool,
}

#[tauri::command]
pub async fn workspace_trust_status(root: String) -> Result<TrustStatus, String> {
    crate::blocking::run(move || {
        let root = Path::new(&root);
        let trusted = is_trusted(root);
        Ok(TrustStatus { trusted, git_paused: !trusted && !crate::git::cmd::config_is_plain(root) })
    })
    .await
}

/// Trust each folder in `roots`. Called by the banner's one click, and once
/// on upgrade with the folders already in recents.
#[tauri::command]
pub async fn workspace_trust_grant(roots: Vec<String>) -> Result<(), String> {
    crate::blocking::run(move || {
        let path = store_path().ok_or("No home folder to keep the trusted list in")?;
        grant_in(&path, &roots)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("klide-trust-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn a_trusted_folder_covers_what_is_inside_it_and_nothing_beside_it() {
        let base = scratch("cover");
        let (project, sibling) = (base.join("project"), base.join("project-evil"));
        std::fs::create_dir_all(project.join("src")).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        let store = base.join("store.json");
        grant_in(&store, &[project.to_string_lossy().into_owned()]).unwrap();
        let folders = read_from(&store);
        assert!(is_trusted_by(&folders, &project));
        assert!(is_trusted_by(&folders, &project.join("src")));
        assert!(!is_trusted_by(&folders, &sibling), "a shared name prefix is not containment");
        assert!(!is_trusted_by(&folders, &base));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_worktree_of_a_trusted_repository_is_trusted_wherever_it_lives() {
        let base = scratch("worktree");
        let (repo, tree) = (base.join("repo"), base.join("elsewhere/feature"));
        let git_dir = repo.join(".git/worktrees/feature");
        std::fs::create_dir_all(&git_dir).unwrap();
        std::fs::create_dir_all(&tree).unwrap();
        std::fs::write(tree.join(".git"), format!("gitdir: {}\n", git_dir.display())).unwrap();
        std::fs::write(git_dir.join("commondir"), "../..\n").unwrap();
        assert!(!is_trusted_by(&[], &tree));
        assert!(is_trusted_by(std::slice::from_ref(&repo), &tree));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn broken_storage_trusts_nothing_and_a_grant_keeps_each_folder_once() {
        let base = scratch("store");
        let store = base.join("store.json");
        std::fs::write(&store, "{ not json").unwrap();
        assert!(read_from(&store).is_empty());
        let root = base.to_string_lossy().into_owned();
        grant_in(&store, &[root.clone(), root.clone()]).unwrap();
        grant_in(&store, &[root]).unwrap();
        assert_eq!(read_from(&store), vec![base.clone()]);
        assert!(grant_in(&store, &["relative/folder".into()]).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }
}
