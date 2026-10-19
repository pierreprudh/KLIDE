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

/// Who is asking for the operation. The sensitive-path refusal is an *agent*
/// policy: a model must never read or write credential-shaped files, but the
/// human's own editor may — refusing the user their own `.env` would break
/// legitimate editing. Every Workspace operation takes the tier explicitly so
/// the policy difference is visible at the interface, never accidental.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Access {
    User,
    Agent,
}

/// Byte caps per access tier. The agent caps exist so a model can't pull a
/// huge file into its context or spray one onto disk; the user caps only
/// bound what the webview can survive rendering.
pub const AGENT_MAX_READ_BYTES: u64 = 220_000;
pub const AGENT_MAX_WRITE_BYTES: u64 = 220_000;
pub const USER_MAX_READ_BYTES: u64 = 20_000_000;
pub const USER_MAX_WRITE_BYTES: u64 = 20_000_000;

/// Paths whose *shape* says "credentials": dotted secret dirs (`.ssh`, `.aws`…),
/// env files, key/cert extensions, well-known credential filenames. Checked
/// against the workspace-relative form so a nested `configs/.env.local` is
/// caught the same as a top-level one.
pub fn is_sensitive_path(root: &Path, path: &Path) -> bool {
    let relative = path.strip_prefix(root).unwrap_or(path);
    let components: Vec<String> = relative
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .map(|component| component.to_ascii_lowercase())
        .collect();
    if components.iter().any(|component| {
        matches!(
            component.as_str(),
            ".ssh" | ".aws" | ".gnupg" | ".azure" | ".kube"
        )
    }) {
        return true;
    }
    if components
        .windows(2)
        .any(|pair| pair[0] == ".config" && pair[1] == "gcloud")
    {
        return true;
    }
    let Some(name) = components.last() else {
        return false;
    };
    name == ".env"
        || name.starts_with(".env.")
        || matches!(
            name.as_str(),
            ".npmrc"
                | ".pypirc"
                | ".netrc"
                | ".git-credentials"
                | "credentials"
                | "credentials.json"
                | "secrets.json"
                | "secrets.yaml"
                | "secrets.yml"
        )
        || [".pem", ".key", ".p12", ".pfx", ".jks"]
            .iter()
            .any(|suffix| name.ends_with(suffix))
}

/// Klide's inbox of unreviewed Memory proposals. Pending lessons must not
/// reach a run until a person keeps them, so a run can't read the store
/// either — a read would be recall by the back door.
pub fn is_review_store(root: &Path, path: &Path) -> bool {
    let relative = path.strip_prefix(root).unwrap_or(path);
    let parts: Vec<_> = relative.components().map(|c| c.as_os_str()).collect();
    parts.windows(2).any(|pair| pair[0] == ".klide" && pair[1] == "memory-proposals")
}

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
        let root =
            std::fs::canonicalize(root).map_err(|e| format!("Invalid workspace root: {e}"))?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Normalize a model-supplied path into a workspace-relative string.
    ///
    /// Models arrive with messy paths: surrounding whitespace, a leading "/"
    /// meaning "workspace root", empty meaning ".", or — very commonly with
    /// small local models, since the system prompt shows them the root as an
    /// absolute path — the *absolute* workspace root or a child of it. Rebase
    /// any absolute path that lands inside the root to relative so it doesn't
    /// get doubled onto the root by the join in `resolve_existing`/`resolve_new`
    /// (`/ws` → join → `/ws/ws`, which fails to resolve). Paths that don't sit
    /// under the root fall through unchanged; the caller's canonicalize +
    /// containment check still rejects them.
    fn clean_user_path(&self, user_path: &str) -> String {
        let trimmed = user_path.trim();
        if trimmed.is_empty() || trimmed == "/" {
            return ".".to_string();
        }
        let candidate = Path::new(trimmed);
        if candidate.is_absolute() {
            // Try a literal strip first (root is canonical), then a
            // canonicalized strip so /var vs /private/var (macOS) still matches.
            let rebased = candidate
                .strip_prefix(&self.root)
                .map(Path::to_path_buf)
                .ok()
                .or_else(|| {
                    std::fs::canonicalize(candidate)
                        .ok()
                        .and_then(|c| c.strip_prefix(&self.root).map(Path::to_path_buf).ok())
                });
            if let Some(rel) = rebased {
                let s = rel.to_string_lossy().to_string();
                return if s.is_empty() { ".".to_string() } else { s };
            }
        }
        trimmed.trim_start_matches('/').to_string()
    }

    /// Resolve a workspace-relative path that must already exist (read_file,
    /// list_dir, grep…). Follows symlinks: the canonical target must stay
    /// inside the root.
    pub fn resolve_existing(&self, user_path: &str) -> Result<PathBuf, String> {
        let cleaned = self.clean_user_path(user_path);
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
        let cleaned = self.clean_user_path(user_path);
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
        let real = std::fs::canonicalize(path).map_err(|e| format!("Invalid path: {e}"))?;
        if !real.starts_with(&self.root) {
            return Err("Path is outside the open workspace".to_string());
        }
        Ok(real)
    }

    /// Validate an absolute path for an operation on the entry itself
    /// (create/rename/delete). The entry may not exist yet and may be a
    /// symlink we must not follow, so the check canonicalizes its parent
    /// directory. Returns the validated lexical path.
    pub fn resolve_abs_entry(&self, path: &str) -> Result<PathBuf, String> {
        let target = PathBuf::from(path);
        if !target.is_absolute()
            || target
                .components()
                .any(|component| matches!(component, Component::ParentDir))
            || !target.starts_with(&self.root)
        {
            return Err("Path is outside the open workspace".to_string());
        }
        let parent = target
            .parent()
            .ok_or_else(|| "Path has no parent folder".to_string())?;
        let parent = std::fs::canonicalize(parent).map_err(|e| format!("Invalid path: {e}"))?;
        if !parent.starts_with(&self.root) {
            return Err("Path is outside the open workspace".to_string());
        }
        Ok(target)
    }

    /// Validate an absolute path that may not exist yet. This is the frontend
    /// twin of `resolve_new`: used for writes that may create parent folders.
    pub fn resolve_abs_new(&self, path: &str) -> Result<PathBuf, String> {
        let target = PathBuf::from(path);
        if !target.is_absolute() {
            return Err("Path is outside the open workspace".to_string());
        }
        if target
            .components()
            .any(|c| matches!(c, Component::ParentDir))
        {
            return Err("Path is outside the open workspace".to_string());
        }
        if !target.starts_with(&self.root) {
            return Err("Path is outside the open workspace".to_string());
        }
        let mut ancestor = target.clone();
        while !ancestor.exists() {
            match ancestor.parent() {
                Some(p) => ancestor = p.to_path_buf(),
                None => return Err("Path is outside the open workspace".to_string()),
            }
        }
        let ancestor = ancestor
            .canonicalize()
            .map_err(|e| format!("Invalid path: {e}"))?;
        if !ancestor.starts_with(&self.root) {
            return Err("Path is outside the open workspace".to_string());
        }
        Ok(target)
    }

    /// Resolve an absolute path for a read-or-write where the caller doesn't
    /// yet know whether it exists: an existing path is validated as a read
    /// (canonicalized, symlinks followed, containment checked), a not-yet-
    /// existing one as a new write target (ancestor containment, no traversal).
    /// Collapses the `if exists() { resolve_abs_read } else { resolve_abs_new }`
    /// dance so the read-or-new decision lives behind the Workspace interface,
    /// not in each caller.
    pub fn resolve_abs_readwrite(&self, path: &str) -> Result<PathBuf, String> {
        if std::path::Path::new(path).exists() {
            self.resolve_abs_read(path)
        } else {
            self.resolve_abs_new(path)
        }
    }

    pub fn is_sensitive(&self, path: &Path) -> bool {
        is_sensitive_path(&self.root, path)
    }

    /// The one place the sensitive-path policy is enforced. Agent access to a
    /// credential-shaped path is refused with the standard guidance; User
    /// access always passes.
    pub fn guard(&self, path: &Path, access: Access) -> Result<(), String> {
        if access == Access::Agent && self.is_sensitive(path) {
            return Err(format!(
                "Access to {} is blocked because it may contain credentials or private keys. \
Open it locally yourself if needed; do not send its contents to a model.",
                self.display(path)
            ));
        }
        if access == Access::Agent && is_review_store(&self.root, path) {
            return Err(format!(
                "{} holds Memory proposals awaiting review; a run can't read them.",
                self.display(path)
            ));
        }
        Ok(())
    }

    fn max_read_bytes(access: Access) -> u64 {
        match access {
            Access::User => USER_MAX_READ_BYTES,
            Access::Agent => AGENT_MAX_READ_BYTES,
        }
    }

    fn max_write_bytes(access: Access) -> u64 {
        match access {
            Access::User => USER_MAX_WRITE_BYTES,
            Access::Agent => AGENT_MAX_WRITE_BYTES,
        }
    }

    /// Read a resolved path as text with the tier's guard and byte cap applied.
    /// Callers resolve first (`resolve_existing` / `resolve_abs_read`) — the
    /// two path dialects stay at the seam; the policy lives here.
    pub fn read_text(&self, path: &Path, access: Access) -> Result<String, String> {
        self.guard(path, access)?;
        let metadata =
            std::fs::metadata(path).map_err(|e| format!("Unable to read metadata: {e}"))?;
        if !metadata.is_file() {
            return Err(format!("{} is not a file", self.display(path)));
        }
        let max = Self::max_read_bytes(access);
        if metadata.len() > max {
            return Err(format!(
                "{} is too large to read safely ({} bytes, max {})",
                self.display(path),
                metadata.len(),
                max
            ));
        }
        std::fs::read_to_string(path)
            .map_err(|e| format!("Unable to read {} as text: {e}", self.display(path)))
    }

    /// Write text to a resolved path with the tier's guard and byte cap
    /// applied, creating parent folders as needed.
    pub fn write_text(&self, path: &Path, contents: &str, access: Access) -> Result<(), String> {
        self.guard(path, access)?;
        let max = Self::max_write_bytes(access);
        if contents.len() as u64 > max {
            return Err(format!(
                "Refusing to write {}: contents too large ({} bytes, max {})",
                self.display(path),
                contents.len(),
                max
            ));
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Unable to create folder: {e}"))?;
        }
        std::fs::write(path, contents)
            .map_err(|e| format!("Unable to write {}: {e}", self.display(path)))
    }

    /// Delete a resolved entry with the tier's guard applied. Uses
    /// symlink_metadata so deleting a symlink removes the link, never what it
    /// points to.
    pub fn remove(&self, path: &Path, access: Access) -> Result<(), String> {
        self.guard(path, access)?;
        let meta =
            std::fs::symlink_metadata(path).map_err(|e| format!("Unable to read entry: {e}"))?;
        if meta.is_dir() {
            std::fs::remove_dir_all(path).map_err(|e| format!("Unable to delete folder: {e}"))
        } else {
            std::fs::remove_file(path).map_err(|e| format!("Unable to delete file: {e}"))
        }
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

    #[test]
    fn resolve_existing_rebases_absolute_paths_inside_root() {
        let (dir, ws) = temp_workspace("abs-rebase");
        // canonicalize so the literal == the workspace root (macOS /var symlink).
        let dir = dir.canonicalize().unwrap();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/a.txt"), "hi").unwrap();
        // A model that hands the absolute workspace root must resolve to root,
        // not get doubled into <root>/<root> (the "Unable to resolve path" bug).
        let root_abs = ws.root().to_str().unwrap();
        assert_eq!(ws.resolve_existing(root_abs).unwrap(), *ws.root());
        // An absolute child path rebases to its relative form.
        let child_abs = ws.root().join("src").to_str().unwrap().to_string();
        assert_eq!(
            ws.resolve_existing(&child_abs).unwrap(),
            ws.root().join("src")
        );
        // An absolute path outside the workspace is still rejected.
        assert!(ws.resolve_existing("/etc").is_err());
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
    fn resolve_abs_readwrite_picks_read_for_existing_and_new_otherwise() {
        let (dir, ws) = temp_workspace("readwrite");
        // Canonicalize so the test's absolute paths match the workspace root
        // (macOS temp_dir is /var/... but the root canonicalizes to /private/var/...).
        let dir = dir.canonicalize().unwrap();
        std::fs::write(dir.join("here.txt"), "x").unwrap();
        // Existing in-workspace path resolves (as a read).
        assert!(ws
            .resolve_abs_readwrite(dir.join("here.txt").to_str().unwrap())
            .is_ok());
        // Not-yet-existing path under the root resolves (as a new target).
        assert!(ws
            .resolve_abs_readwrite(dir.join("sub/child.txt").to_str().unwrap())
            .is_ok());
        // An existing path outside the workspace is rejected.
        assert!(ws.resolve_abs_readwrite("/etc/hosts").is_err());
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
        assert!(ws.resolve_abs_entry("brand-new.txt").is_err());
        assert!(ws
            .resolve_abs_entry(ws.root().join("../escape.txt").to_str().unwrap())
            .is_err());
    }

    #[test]
    fn resolve_abs_new_allows_nested_missing_paths_inside_workspace() {
        let (_dir, ws) = temp_workspace("abs-new");
        let nested = ws.root().join(".klide/skills/example/SKILL.md");
        assert!(ws.resolve_abs_new(nested.to_str().unwrap()).is_ok());
        assert!(ws.resolve_abs_new("/etc/klide-nope.txt").is_err());
        assert!(ws
            .resolve_abs_new(ws.root().join("../escape.txt").to_str().unwrap())
            .is_err());
    }

    #[test]
    fn agent_read_refuses_sensitive_paths_but_user_read_allows_them() {
        let (dir, ws) = temp_workspace("sensitive-read");
        std::fs::write(dir.join(".env"), "SECRET=1").unwrap();
        let env = ws.resolve_existing(".env").unwrap();
        let refused = ws.read_text(&env, Access::Agent).unwrap_err();
        assert!(refused.contains("blocked"), "got: {refused}");
        assert_eq!(ws.read_text(&env, Access::User).unwrap(), "SECRET=1");
    }

    #[test]
    fn agent_write_refuses_sensitive_paths_but_user_write_allows_them() {
        let (dir, ws) = temp_workspace("sensitive-write");
        let env = dir.canonicalize().unwrap().join(".env");
        let refused = ws.write_text(&env, "SECRET=1", Access::Agent).unwrap_err();
        assert!(refused.contains("blocked"), "got: {refused}");
        assert!(!env.exists(), "refused write must not create the file");
        ws.write_text(&env, "SECRET=1", Access::User).unwrap();
        assert_eq!(std::fs::read_to_string(&env).unwrap(), "SECRET=1");
    }

    #[test]
    fn sensitive_shapes_are_caught_in_nested_folders() {
        let (dir, ws) = temp_workspace("sensitive-shapes");
        let root = dir.canonicalize().unwrap();
        for rel in [
            "configs/.env.local",
            ".ssh/id_rsa",
            "certs/server.pem",
            ".config/gcloud/credentials.json",
        ] {
            assert!(ws.is_sensitive(&root.join(rel)), "{rel} should be sensitive");
        }
        assert!(!ws.is_sensitive(&root.join("src/env.rs")));
        assert!(!ws.is_sensitive(&root.join("docs/environment.md")));
    }

    #[test]
    fn read_text_applies_the_agent_byte_cap() {
        let (dir, ws) = temp_workspace("read-cap");
        let big = "x".repeat(AGENT_MAX_READ_BYTES as usize + 1);
        std::fs::write(dir.join("big.txt"), &big).unwrap();
        let full = ws.resolve_existing("big.txt").unwrap();
        let refused = ws.read_text(&full, Access::Agent).unwrap_err();
        assert!(refused.contains("too large"), "got: {refused}");
        // The user tier's cap is far higher — the same file reads fine.
        assert_eq!(ws.read_text(&full, Access::User).unwrap().len(), big.len());
    }

    #[test]
    fn write_text_applies_the_agent_byte_cap() {
        let (dir, ws) = temp_workspace("write-cap");
        let target = dir.canonicalize().unwrap().join("big.txt");
        let big = "x".repeat(AGENT_MAX_WRITE_BYTES as usize + 1);
        let refused = ws.write_text(&target, &big, Access::Agent).unwrap_err();
        assert!(refused.contains("too large"), "got: {refused}");
        assert!(!target.exists());
    }

    #[test]
    fn write_text_creates_missing_parent_folders() {
        let (dir, ws) = temp_workspace("write-parents");
        let target = dir.canonicalize().unwrap().join("a/b/c.txt");
        ws.write_text(&target, "hi", Access::User).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "hi");
    }

    #[cfg(unix)]
    #[test]
    fn remove_deletes_a_symlink_not_its_target() {
        let (dir, ws) = temp_workspace("remove-symlink");
        let root = dir.canonicalize().unwrap();
        std::fs::create_dir_all(root.join("real")).unwrap();
        std::fs::write(root.join("real/keep.txt"), "keep").unwrap();
        std::os::unix::fs::symlink(root.join("real"), root.join("link")).unwrap();
        ws.remove(&root.join("link"), Access::User).unwrap();
        assert!(!root.join("link").exists());
        assert!(root.join("real/keep.txt").exists());
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
