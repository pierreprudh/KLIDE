//! The Workspace module owns the Workspace-rooted invariant: every path an
//! agent Tool or a frontend command touches must resolve inside the open
//! workspace. Construct a `Workspace` once per command/tool dispatch, then
//! resolve paths through it — there is no other sanctioned way to turn a
//! user- or model-supplied path into a real filesystem path.
//!
//! Two path dialects cross this seam:
//! - Agent Tools speak workspace-relative paths ("src/main.rs", ".") →
//!   `resolve_existing` / `resolve_new`.
//! - Frontend commands speak absolute paths (the explorer tree hands them
//!   back verbatim) → `resolve_abs_read` / `resolve_abs_entry`.
//!
//! Symlink policy: reads follow the target and the *resolved* location must
//! land inside the root. Entry operations (create/rename/delete) validate the
//! parent directory instead and never follow the entry itself, so deleting a
//! symlink removes the link, not what it points to.

use std::path::{Component, Path, PathBuf};

pub struct Workspace {
    /// Canonicalized at construction — `..` segments and symlinks in the
    /// root itself are resolved exactly once.
    root: PathBuf,
}

impl Workspace {
    pub fn new(root: &str) -> Result<Self, String> {
        if root.trim().is_empty() {
            return Err("No workspace is open".to_string());
        }
        let root = std::fs::canonicalize(root)
            .map_err(|e| format!("Invalid workspace root: {e}"))?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Resolve a workspace-relative path that must already exist (read_file,
    /// list_dir, grep…). Follows symlinks: the canonical target must stay
    /// inside the root.
    pub fn resolve_existing(&self, user_path: &str) -> Result<PathBuf, String> {
        let cleaned = clean_user_path(user_path);
        let candidate = if cleaned == "." {
            self.root.clone()
        } else {
            self.root.join(cleaned)
        };
        let real = candidate
            .canonicalize()
            .map_err(|e| format!("Unable to resolve path \"{user_path}\": {e}"))?;
        if !real.starts_with(&self.root) {
            return Err(format!("Path \"{user_path}\" is outside the workspace"));
        }
        Ok(real)
    }

    /// Resolve a workspace-relative path that may not exist yet (create_file,
    /// apply_write). canonicalize() fails on non-existent paths, so instead we
    /// reject any `..`/absolute component outright, then canonicalize the
    /// deepest existing ancestor so a symlinked directory can't smuggle the
    /// write outside the root.
    pub fn resolve_new(&self, user_path: &str) -> Result<PathBuf, String> {
        let cleaned = clean_user_path(user_path);
        let rel = Path::new(&cleaned);
        if rel
            .components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
        {
            return Err(format!("Path \"{user_path}\" is outside the workspace"));
        }
        let candidate = self.root.join(rel);
        let mut ancestor = candidate.clone();
        while !ancestor.exists() {
            match ancestor.parent() {
                Some(p) => ancestor = p.to_path_buf(),
                None => return Err(format!("Path \"{user_path}\" is outside the workspace")),
            }
        }
        let ancestor_real = ancestor
            .canonicalize()
            .map_err(|e| format!("Unable to resolve path \"{user_path}\": {e}"))?;
        if !ancestor_real.starts_with(&self.root) {
            return Err(format!("Path \"{user_path}\" is outside the workspace"));
        }
        Ok(candidate)
    }

    /// Validate an absolute path the frontend wants to read (read_text_file,
    /// list_dir). Follows symlinks: the canonical target must stay inside the
    /// root. Returns the canonical path.
    pub fn resolve_abs_read(&self, path: &str) -> Result<PathBuf, String> {
        let real =
            std::fs::canonicalize(path).map_err(|e| format!("Invalid path: {e}"))?;
        if !real.starts_with(&self.root) {
            return Err("Path is outside the open workspace".to_string());
        }
        Ok(real)
    }

    /// Validate an absolute path for an operation on the entry itself
    /// (create/rename/delete). The entry may not exist yet and may be a
    /// symlink we must not follow, so the check canonicalizes its parent
    /// directory. Returns the path verbatim.
    pub fn resolve_abs_entry(&self, path: &str) -> Result<PathBuf, String> {
        let target = PathBuf::from(path);
        let parent = target
            .parent()
            .ok_or_else(|| "Path has no parent folder".to_string())?;
        let parent = std::fs::canonicalize(parent).map_err(|e| format!("Invalid path: {e}"))?;
        if !parent.starts_with(&self.root) {
            return Err("Path is outside the open workspace".to_string());
        }
        Ok(target)
    }

    /// Render a resolved path back as workspace-relative for messages shown
    /// to the model and the user. The root itself displays as ".".
    pub fn display(&self, path: &Path) -> String {
        match path.strip_prefix(&self.root) {
            Ok(p) if !p.as_os_str().is_empty() => p.to_string_lossy().to_string(),
            _ => ".".to_string(),
        }
    }
}

/// Model-supplied paths arrive messy: surrounding whitespace, a leading "/"
/// meaning "workspace root", or empty meaning ".".
fn clean_user_path(user_path: &str) -> String {
    let trimmed = user_path.trim();
    if trimmed.is_empty() || trimmed == "/" {
        ".".to_string()
    } else {
        trimmed.trim_start_matches('/').to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_workspace(name: &str) -> (PathBuf, Workspace) {
        let dir = std::env::temp_dir().join(format!("klide-ws-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let ws = Workspace::new(dir.to_str().unwrap()).unwrap();
        (dir, ws)
    }

    #[test]
    fn new_rejects_empty_and_missing_roots() {
        assert!(Workspace::new("").is_err());
        assert!(Workspace::new("   ").is_err());
        assert!(Workspace::new("/definitely/not/a/real/dir-klide").is_err());
    }

    #[test]
    fn resolve_existing_finds_files_and_rejects_escapes() {
        let (dir, ws) = temp_workspace("existing");
        std::fs::write(dir.join("a.txt"), "hi").unwrap();
        assert!(ws.resolve_existing("a.txt").is_ok());
        assert!(ws.resolve_existing(".").is_ok());
        assert!(ws.resolve_existing("../").is_err());
        assert!(ws.resolve_existing("../../etc/passwd").is_err());
        assert!(ws.resolve_existing("missing.txt").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn resolve_existing_rejects_symlink_escape() {
        let (dir, ws) = temp_workspace("symlink");
        std::os::unix::fs::symlink("/etc", dir.join("sneaky")).unwrap();
        assert!(ws.resolve_existing("sneaky").is_err());
        assert!(ws.resolve_existing("sneaky/passwd").is_err());
    }

    #[test]
    fn resolve_new_rejects_traversal() {
        let (_dir, ws) = temp_workspace("new");
        assert!(ws.resolve_new("../escape.txt").is_err());
        assert!(ws.resolve_new("a/../../escape.txt").is_err());
        // Leading '/' is stripped → etc/passwd inside the root.
        assert!(ws.resolve_new("/etc/passwd").is_ok());
        assert!(ws.resolve_new("sub/dir/new.txt").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn resolve_new_rejects_symlinked_ancestor_escape() {
        let (dir, ws) = temp_workspace("new-symlink");
        std::os::unix::fs::symlink("/tmp", dir.join("out")).unwrap();
        let escaped = ws.resolve_new("out/smuggled.txt");
        // /tmp canonicalizes outside the workspace root.
        assert!(escaped.is_err());
    }

    #[test]
    fn resolve_abs_read_checks_containment() {
        let (dir, ws) = temp_workspace("abs-read");
        std::fs::write(dir.join("a.txt"), "hi").unwrap();
        let inside = ws.root().join("a.txt");
        assert!(ws.resolve_abs_read(inside.to_str().unwrap()).is_ok());
        // The root itself is readable (list_dir on the workspace root).
        assert!(ws.resolve_abs_read(ws.root().to_str().unwrap()).is_ok());
        assert!(ws.resolve_abs_read("/etc/hosts").is_err());
    }

    #[test]
    fn resolve_abs_entry_checks_parent_not_target() {
        let (_dir, ws) = temp_workspace("abs-entry");
        // Target doesn't exist yet — fine, its parent (the root) does.
        let new_file = ws.root().join("brand-new.txt");
        assert!(ws.resolve_abs_entry(new_file.to_str().unwrap()).is_ok());
        assert!(ws.resolve_abs_entry("/etc/passwd").is_err());
    }

    #[test]
    fn display_strips_the_root_prefix() {
        let (dir, ws) = temp_workspace("display");
        std::fs::write(dir.join("a.txt"), "hi").unwrap();
        let full = ws.resolve_existing("a.txt").unwrap();
        assert_eq!(ws.display(&full), "a.txt");
        assert_eq!(ws.display(ws.root()), ".");
    }
}
