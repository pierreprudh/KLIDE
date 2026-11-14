//! User-local storage for project-scoped capability approvals.
//!
//! A repository must never be able to ship its own permission decisions. The
//! files produced here live under Klide's app-data directory (next to `runs/`),
//! are mode 0600, and are scoped to a fingerprint of the repository's current
//! HEAD plus its tracked and untracked changes. Switching commits or changing a
//! command-defining file invalidates prior approvals and forces a fresh prompt.

use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};

const MAX_GIT_BYTES: usize = 32 * 1024 * 1024;
const MAX_UNTRACKED_LIST_BYTES: usize = 1024 * 1024;

/// Ignored local configuration can change command semantics too, so the
/// fingerprint covers these even though Git deliberately omits them.
const IGNORED_LOCAL_CONFIG: [&str; 7] = [
    ".env",
    ".env.local",
    ".env.development",
    ".env.development.local",
    ".npmrc",
    ".agents/tools.json",
    ".klide/worktree.json",
];

/// The remembered fingerprint of one repository, and the tree stamp it was
/// computed under. See [`trust_fingerprint`].
struct FingerprintMemo {
    stamp: String,
    fingerprint: String,
    /// How many times the full fingerprint has been computed for this root —
    /// the tests' way of seeing a memo hit.
    #[cfg(test)]
    generation: usize,
}

fn memo() -> &'static Mutex<HashMap<PathBuf, FingerprintMemo>> {
    static MEMO: OnceLock<Mutex<HashMap<PathBuf, FingerprintMemo>>> = OnceLock::new();
    MEMO.get_or_init(|| Mutex::new(HashMap::new()))
}

pub struct ApprovalLocation {
    pub path: PathBuf,
    pub fingerprint: String,
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    let digest = Sha256::digest(bytes.as_ref());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn git_bytes_limited(root: &Path, args: &[&str], limit: usize) -> Result<Vec<u8>, String> {
    let mut child = crate::git::cmd::git()
        .arg("-C")
        .arg(root)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Unable to inspect repository trust state: {e}"))?;
    let mut bytes = Vec::new();
    child
        .stdout
        .take()
        .ok_or_else(|| "Unable to inspect repository trust state".to_string())?
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Unable to inspect repository trust state: {e}"))?;
    if bytes.len() > limit {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Repository changes are too large for a persistent approval".to_string());
    }
    let status = child
        .wait()
        .map_err(|e| format!("Unable to inspect repository trust state: {e}"))?;
    if !status.success() {
        return Err("Persistent approvals require a Git repository with an initial commit".into());
    }
    Ok(bytes)
}

fn hash_file(hasher: &mut Sha256, path: &Path, remaining: &mut usize) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|e| format!("Unable to fingerprint {}: {e}", path.display()))?;
    hasher.update(path.to_string_lossy().as_bytes());
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Persistent approvals are disabled while {} is a symlink",
            path.display()
        ));
    }
    if !metadata.is_file() {
        return Ok(());
    }
    let size = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
    if size > *remaining {
        return Err("Repository changes are too large for a persistent approval".to_string());
    }
    *remaining -= size;
    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("Unable to fingerprint {}: {e}", path.display()))?;
    let mut buf = [0_u8; 16 * 1024];
    loop {
        let read = file
            .read(&mut buf)
            .map_err(|e| format!("Unable to fingerprint {}: {e}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(())
}

/// Is a path Git handed us safe to join onto the repository root?
///
/// `git ls-files --others` should only ever emit repo-relative paths, but this
/// value is about to be joined onto the toplevel and read, so a `..` or a root
/// component would reach outside the repository and fold a file we were never
/// asked about into the trust fingerprint. Pulled out of the loop so the refusal
/// is a rule that can be tested rather than a branch nobody can reach.
fn is_safe_repo_relative(rel: &Path) -> bool {
    rel.components()
        .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
}

/// Does the workspace actually live inside the repository Git named?
///
/// If it does not, the HEAD and diff we are about to fingerprint describe a
/// different tree than the one the approval will be used in.
fn workspace_is_inside_repo(canonical_root: &Path, canonical_toplevel: &Path) -> bool {
    canonical_root.starts_with(canonical_toplevel)
}

/// Fold one path's `symlink_metadata` into a stamp: the mtime in nanoseconds,
/// the size, and whether it is a file, a directory, a symlink, or missing. A
/// symlink is stamped as itself, never followed — the full fingerprint refuses
/// symlinked untracked files, and the stamp must not paper over that.
fn stat_into(hasher: &mut Sha256, path: &Path) {
    hasher.update(path.to_string_lossy().as_bytes());
    match std::fs::symlink_metadata(path) {
        Ok(meta) => {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let kind: u8 = if meta.file_type().is_symlink() {
                b'l'
            } else if meta.is_dir() {
                b'd'
            } else {
                b'f'
            };
            hasher.update([0, kind]);
            hasher.update(mtime.to_le_bytes());
            hasher.update(meta.len().to_le_bytes());
        }
        Err(_) => hasher.update(b"\0missing"),
    }
    hasher.update(b"\0");
}

/// The paths a `git status --porcelain=v1 -z` listing names: `XY path`, with a
/// rename or copy followed by one extra NUL-separated original path.
fn status_paths(status: &[u8]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut tokens = status.split(|b| *b == 0).filter(|t| !t.is_empty());
    while let Some(entry) = tokens.next() {
        if entry.len() < 4 {
            continue;
        }
        let (code, rest) = entry.split_at(3);
        out.push(PathBuf::from(String::from_utf8_lossy(rest).as_ref()));
        if matches!(code[0], b'R' | b'C') || matches!(code[1], b'R' | b'C') {
            // The original path of a rename: gone from the tree, nothing to stat.
            tokens.next();
        }
    }
    out
}

/// A cheap stamp of everything the full fingerprint depends on: HEAD, the
/// `git status` listing (which paths are changed or untracked, and how), the
/// mtime + size of each of those paths, and of the ignored config files the
/// fingerprint also covers. Two short git processes and a stat per dirty path
/// — no diff, no hashing of file contents.
///
/// The trust argument is the one Git's own index makes: a byte can only change
/// behind an unchanged (path, mtime_ns, size) triple by an edit landing in the
/// same nanosecond as the last one. Anything coarser — a new untracked file,
/// a staged hunk, a revert, a checkout — moves the status listing itself.
fn tree_stamp(canonical_root: &Path) -> Result<String, String> {
    let ids = git_bytes_limited(
        canonical_root,
        &["rev-parse", "--show-toplevel", "HEAD"],
        16 * 1024,
    )?;
    let ids = String::from_utf8_lossy(&ids);
    let mut lines = ids.lines();
    let toplevel = PathBuf::from(lines.next().unwrap_or("").trim());
    let head = lines.next().unwrap_or("").trim().to_string();
    // Porcelain paths are repository-relative whatever `-C` says, and without a
    // pathspec the listing covers the whole working tree — the same scope the
    // full fingerprint diffs.
    let status = git_bytes_limited(
        canonical_root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        MAX_UNTRACKED_LIST_BYTES,
    )?;

    let mut hasher = Sha256::new();
    hasher.update(b"klide-tree-stamp-v1\0");
    hasher.update(canonical_root.to_string_lossy().as_bytes());
    hasher.update(b"\0head\0");
    hasher.update(head.as_bytes());
    hasher.update(b"\0status\0");
    hasher.update(&status);
    hasher.update(b"\0stats\0");
    for rel in status_paths(&status) {
        stat_into(&mut hasher, &toplevel.join(rel));
    }
    for name in IGNORED_LOCAL_CONFIG {
        stat_into(&mut hasher, &canonical_root.join(name));
    }
    Ok(hex_digest(hasher.finalize()))
}

/// The repository's trust fingerprint, remembered per root.
///
/// The full computation (`compute_trust_fingerprint`) diffs the whole tree
/// against HEAD and hashes every untracked byte — hundreds of milliseconds on
/// a busy checkout, and it is read at every Run start and, for subscription
/// Providers, before every turn. So it runs only when the [`tree_stamp`] has
/// moved since the last answer for this root. A stamp that cannot be taken
/// (not a repository, unborn HEAD) falls through to the full path so the
/// caller sees the same refusal it always did.
fn trust_fingerprint(root: &Path) -> Result<String, String> {
    let canonical_root = std::fs::canonicalize(root)
        .map_err(|e| format!("Unable to resolve workspace for approval: {e}"))?;
    let Ok(stamp) = tree_stamp(&canonical_root) else {
        return compute_trust_fingerprint(&canonical_root);
    };
    if let Some(hit) = memo().lock().unwrap().get(&canonical_root) {
        if hit.stamp == stamp {
            return Ok(hit.fingerprint.clone());
        }
    }
    let fingerprint = compute_trust_fingerprint(&canonical_root)?;
    let mut memo = memo().lock().unwrap();
    #[cfg(test)]
    let generation = memo.get(&canonical_root).map(|m| m.generation).unwrap_or(0) + 1;
    memo.insert(
        canonical_root,
        FingerprintMemo {
            stamp,
            fingerprint: fingerprint.clone(),
            #[cfg(test)]
            generation,
        },
    );
    Ok(fingerprint)
}

/// How many times the full fingerprint has been computed for `root`.
#[cfg(test)]
fn fingerprint_generation(root: &Path) -> usize {
    let canonical_root = std::fs::canonicalize(root).unwrap();
    memo()
        .lock()
        .unwrap()
        .get(&canonical_root)
        .map(|m| m.generation)
        .unwrap_or(0)
}

/// The full fingerprint: HEAD, the complete diff against it, every untracked
/// file's bytes, and the ignored local config. `root` is already canonical.
fn compute_trust_fingerprint(canonical_root: &Path) -> Result<String, String> {
    let canonical_root = canonical_root.to_path_buf();
    let toplevel = git_bytes_limited(
        &canonical_root,
        &["rev-parse", "--show-toplevel"],
        16 * 1024,
    )?;
    let toplevel = PathBuf::from(String::from_utf8_lossy(&toplevel).trim());
    let canonical_toplevel = std::fs::canonicalize(&toplevel)
        .map_err(|e| format!("Unable to resolve repository for approval: {e}"))?;
    if !workspace_is_inside_repo(&canonical_root, &canonical_toplevel) {
        return Err("Workspace does not belong to its reported Git repository".into());
    }

    let head = git_bytes_limited(&canonical_toplevel, &["rev-parse", "HEAD"], 1024)?;
    let diff = git_bytes_limited(
        &canonical_toplevel,
        &["diff", "--binary", "--no-ext-diff", "HEAD", "--", "."],
        MAX_GIT_BYTES,
    )?;
    let untracked = git_bytes_limited(
        &canonical_toplevel,
        &[
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            ".",
        ],
        MAX_UNTRACKED_LIST_BYTES,
    )?;

    let mut hasher = Sha256::new();
    hasher.update(b"klide-project-approval-v1\0");
    hasher.update(canonical_root.to_string_lossy().as_bytes());
    hasher.update(b"\0head\0");
    hasher.update(&head);
    hasher.update(b"\0diff\0");
    hasher.update(&diff);

    let mut remaining = MAX_GIT_BYTES;
    for raw in untracked.split(|b| *b == 0).filter(|s| !s.is_empty()) {
        let rel = PathBuf::from(String::from_utf8_lossy(raw).as_ref());
        if !is_safe_repo_relative(&rel) {
            return Err("Git returned an unsafe untracked path".into());
        }
        let path = canonical_toplevel.join(rel);
        if path.exists() {
            hash_file(&mut hasher, &path, &mut remaining)?;
        }
    }

    // Ignored local configuration can change command semantics too. Include
    // the common top-level files even though Git deliberately omitted them.
    for name in IGNORED_LOCAL_CONFIG {
        let path = canonical_root.join(name);
        if path.exists() {
            hash_file(&mut hasher, &path, &mut remaining)?;
        }
    }

    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// Resolve a private app-data file for one capability and current repository
/// state. `Ok(None)` means project persistence is unavailable (not a Git repo,
/// unborn HEAD, or too much uncommitted data); callers safely fall back to
/// prompting and run-scoped memory.
pub fn location(
    runs_dir: &Path,
    workspace_root: &str,
    capability: &str,
) -> Result<Option<ApprovalLocation>, String> {
    let canonical_root = std::fs::canonicalize(workspace_root)
        .map_err(|e| format!("Unable to resolve workspace for approval: {e}"))?;
    let fingerprint = match trust_fingerprint(&canonical_root) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let project_id = hex_digest(canonical_root.to_string_lossy().as_bytes());
    let app_data = runs_dir.parent().unwrap_or(runs_dir);
    Ok(Some(ApprovalLocation {
        path: app_data
            .join("approvals")
            .join(project_id)
            .join(format!("{capability}.json")),
        fingerprint,
    }))
}

/// Read a fingerprint-scoped allowlist document at `location`. A missing file
/// and a stale fingerprint both read as "no approvals" via `fresh` — a
/// checkout change silently re-prompts instead of honoring old trust. This is
/// the one copy of the read → parse → fingerprint-check flow every allowlist
/// used to hand-roll.
pub fn read_scoped<T: serde::de::DeserializeOwned>(
    location: &ApprovalLocation,
    what: &str,
    fingerprint_of: impl Fn(&T) -> &str,
    fresh: impl Fn(String) -> T,
) -> Result<T, String> {
    if !location.path.exists() {
        return Ok(fresh(location.fingerprint.clone()));
    }
    let text = std::fs::read_to_string(&location.path)
        .map_err(|e| format!("Unable to read {what} allowlist: {e}"))?;
    let parsed: T = serde_json::from_str(&text)
        .map_err(|e| format!("Invalid {what} allowlist JSON: {e}"))?;
    if fingerprint_of(&parsed) == location.fingerprint {
        Ok(parsed)
    } else {
        Ok(fresh(location.fingerprint.clone()))
    }
}

/// Serialize + write a fingerprint-scoped allowlist document privately. The
/// twin of `read_scoped`.
pub fn write_scoped<T: serde::Serialize>(
    path: &Path,
    value: &T,
    what: &str,
) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value)
        .map_err(|e| format!("Unable to serialize {what} allowlist: {e}"))?;
    write_private(path, format!("{text}\n").as_bytes())
}

pub fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Approval store has no parent directory".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| format!("Unable to create approval store: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("Unable to secure approval store: {e}"))?;
    }
    crate::durable::write_atomic_private(path, bytes)
        .map_err(|e| format!("Unable to write approval store: {e}"))
}

#[cfg(test)]
mod tests {
    //! This module decides whether a repository is allowed to carry its own
    //! persisted permission decisions, and it had no tests at all.
    //!
    //! Its three refusals — a symlink, a path Git should never have emitted, and
    //! a workspace outside its own repository — each carry a written rationale
    //! and none of them was checked. Nor was the fingerprint itself: the
    //! `permission.rs` tests that exercise `persist_project` assert an approval
    //! *round-trips*, which it would do just as happily if `trust_fingerprint`
    //! returned a constant. That is the point of the first test below.

    use super::*;
    use std::process::Command;

    fn git(root: &Path, args: &[&str]) -> bool {
        Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// A repo with one commit, or `None` when git is unavailable.
    fn repo(tag: &str) -> Option<PathBuf> {
        let base = std::env::temp_dir().join(format!(
            "klide-approval-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).ok()?;
        if !git(&base, &["init", "-b", "main"]) {
            return None;
        }
        git(&base, &["config", "user.email", "test@klide.local"]);
        git(&base, &["config", "user.name", "Klide Test"]);
        std::fs::write(base.join("a.txt"), "hi").ok()?;
        git(&base, &["add", "."]);
        git(&base, &["commit", "-m", "init"]);
        Some(base)
    }

    #[test]
    fn the_fingerprint_moves_with_every_input_it_claims_to_cover() {
        let Some(root) = repo("inputs") else { return };
        let base = trust_fingerprint(&root).expect("fingerprint");

        // Stable for an unchanged tree, or every prompt would be re-asked.
        assert_eq!(trust_fingerprint(&root).unwrap(), base, "must be stable");

        // A tracked edit — the diff arm.
        std::fs::write(root.join("a.txt"), "changed").unwrap();
        let after_edit = trust_fingerprint(&root).unwrap();
        assert_ne!(after_edit, base, "an uncommitted edit must invalidate");

        // Committing it — the HEAD arm. Note this also empties the diff, so a
        // fingerprint that ignored HEAD would spring back to `base` here.
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "second"]);
        let after_commit = trust_fingerprint(&root).unwrap();
        assert_ne!(after_commit, base, "a new commit must invalidate");
        assert_ne!(after_commit, after_edit);

        // An untracked file — the ls-files arm.
        std::fs::write(root.join("new.txt"), "fresh").unwrap();
        let after_untracked = trust_fingerprint(&root).unwrap();
        assert_ne!(after_untracked, after_commit, "an untracked file counts");

        // Its *contents*, not just its name: an untracked script is exactly the
        // kind of file that changes what an approved command does.
        std::fs::write(root.join("new.txt"), "different").unwrap();
        assert_ne!(
            trust_fingerprint(&root).unwrap(),
            after_untracked,
            "untracked contents are hashed, not just paths"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ignored_local_config_still_invalidates_an_approval() {
        // Git deliberately omits these, but they change what a command does —
        // `.agents/tools.json` literally defines the command tools, and `.env`
        // supplies what they run with.
        let Some(root) = repo("ignored-config") else { return };
        std::fs::write(root.join(".gitignore"), ".env\n.agents/\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "ignore"]);
        let base = trust_fingerprint(&root).unwrap();

        std::fs::write(root.join(".env"), "TOKEN=one").unwrap();
        let with_env = trust_fingerprint(&root).unwrap();
        assert_ne!(with_env, base, ".env must count");

        std::fs::write(root.join(".env"), "TOKEN=two").unwrap();
        assert_ne!(trust_fingerprint(&root).unwrap(), with_env, ".env contents count");

        std::fs::create_dir_all(root.join(".agents")).unwrap();
        std::fs::write(root.join(".agents/tools.json"), "{\"tools\":[]}").unwrap();
        let with_tools = trust_fingerprint(&root).unwrap();
        assert_ne!(with_tools, with_env, ".agents/tools.json must count");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_untracked_file_disables_persistent_approvals() {
        // Following it would fingerprint a file outside the repository — or a
        // file whose target can be swapped after approval.
        let Some(root) = repo("symlink") else { return };
        let outside = root.parent().unwrap().join("klide-approval-outside.txt");
        std::fs::write(&outside, "secret").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link.txt")).unwrap();

        let err = trust_fingerprint(&root).expect_err("a symlink must refuse");
        assert!(err.contains("symlink"), "got: {err}");

        // And the refusal must surface as "no project persistence" rather than
        // an error the caller has to handle: prompting is the safe fallback.
        let runs = root.join("app").join("runs");
        std::fs::create_dir_all(&runs).unwrap();
        let resolved = location(&runs, root.to_str().unwrap(), "commands").unwrap();
        assert!(resolved.is_none(), "callers fall back to prompting");

        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_path_git_should_never_emit_is_refused() {
        // `git ls-files --others` emits repo-relative paths, but the value is
        // joined onto the toplevel and read, so a `..` would fold a file from
        // outside the repository into the trust fingerprint.
        assert!(is_safe_repo_relative(Path::new("src/main.rs")));
        assert!(is_safe_repo_relative(Path::new("./a.txt")));
        assert!(is_safe_repo_relative(Path::new("a b/c.txt")));

        assert!(!is_safe_repo_relative(Path::new("../outside.txt")));
        assert!(!is_safe_repo_relative(Path::new("a/../../outside.txt")));
        assert!(!is_safe_repo_relative(Path::new("/etc/passwd")));
    }

    #[test]
    fn a_workspace_outside_its_reported_repository_is_refused() {
        // If this were false, the HEAD and diff being fingerprinted would
        // describe a different tree than the one the approval is used in.
        assert!(workspace_is_inside_repo(
            Path::new("/repo/packages/app"),
            Path::new("/repo")
        ));
        assert!(workspace_is_inside_repo(Path::new("/repo"), Path::new("/repo")));
        assert!(!workspace_is_inside_repo(Path::new("/elsewhere"), Path::new("/repo")));
        // A shared prefix is not containment.
        assert!(!workspace_is_inside_repo(
            Path::new("/repo-other/app"),
            Path::new("/repo")
        ));
    }

    #[test]
    fn a_directory_without_git_has_no_project_persistence() {
        let base = std::env::temp_dir().join(format!("klide-approval-nogit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("runs")).unwrap();

        // Not a repository at all → `Ok(None)`, never an error: the caller
        // prompts and remembers for the run instead.
        let resolved = location(&base.join("runs"), base.to_str().unwrap(), "commands").unwrap();
        assert!(resolved.is_none());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn two_capabilities_in_one_project_get_separate_files_and_one_fingerprint() {
        let Some(root) = repo("layout") else { return };
        let runs = root.join("app").join("runs");
        std::fs::create_dir_all(&runs).unwrap();

        let commands = location(&runs, root.to_str().unwrap(), "commands")
            .unwrap()
            .expect("a git repo has project persistence");
        let network = location(&runs, root.to_str().unwrap(), "network")
            .unwrap()
            .expect("same repo");

        assert_ne!(commands.path, network.path, "one file per capability");
        assert_eq!(commands.fingerprint, network.fingerprint, "one tree state");
        assert_eq!(commands.path.parent(), network.path.parent(), "one project dir");
        // Under the app-data dir, a sibling of `runs/` — never inside the
        // repository, which must not be able to ship its own approvals.
        assert!(commands.path.starts_with(root.join("app").join("approvals")));
        assert!(commands.path.ends_with("commands.json"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn write_private_creates_a_locked_down_store() {
        let base = std::env::temp_dir().join(format!("klide-approval-write-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let path = base.join("approvals").join("proj").join("commands.json");

        write_private(&path, b"{\"rules\":[]}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"rules\":[]}");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let file = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(file, 0o600, "the approval file is private: {file:o}");
            let dir = std::fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(dir, 0o700, "so is its directory: {dir:o}");
        }

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn an_unchanged_tree_answers_from_the_memo() {
        let Some(root) = repo("memo") else { return };
        let first = trust_fingerprint(&root).unwrap();
        let generation = fingerprint_generation(&root);
        assert_eq!(generation, 1, "the first read computes");
        assert_eq!(trust_fingerprint(&root).unwrap(), first);
        assert_eq!(trust_fingerprint(&root).unwrap(), first);
        assert_eq!(
            fingerprint_generation(&root),
            generation,
            "an unchanged tree must not recompute the full fingerprint"
        );
    }

    #[test]
    fn a_same_size_edit_to_an_untracked_file_moves_the_memo() {
        // The stamp does not hash untracked contents; it trusts mtime + size.
        // Same size, later mtime: still a different fingerprint.
        let Some(root) = repo("memo-untracked") else { return };
        std::fs::write(root.join("notes.txt"), "aaa").unwrap();
        let before = trust_fingerprint(&root).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(root.join("notes.txt"), "bbb").unwrap();
        let after = trust_fingerprint(&root).unwrap();
        assert_ne!(after, before, "an untracked edit must invalidate through the memo");
        assert_eq!(fingerprint_generation(&root), 2);
    }

    #[test]
    fn a_tracked_edit_and_its_revert_both_move_the_memo() {
        let Some(root) = repo("memo-tracked") else { return };
        let base = trust_fingerprint(&root).unwrap();
        std::fs::write(root.join("a.txt"), "changed").unwrap();
        let edited = trust_fingerprint(&root).unwrap();
        assert_ne!(edited, base);
        // Back to HEAD's bytes: git status goes clean, the stamp moves again,
        // and the fingerprint is the clean tree's once more.
        std::fs::write(root.join("a.txt"), "hi").unwrap();
        assert_eq!(trust_fingerprint(&root).unwrap(), base);
        assert_eq!(fingerprint_generation(&root), 3);
    }

    #[test]
    fn status_paths_reads_renames_and_spaces() {
        let listing = b"R  new name.txt\0old name.txt\0?? notes.txt\0 M src/a.rs\0";
        let paths = status_paths(listing);
        assert_eq!(
            paths,
            vec![
                PathBuf::from("new name.txt"),
                PathBuf::from("notes.txt"),
                PathBuf::from("src/a.rs"),
            ]
        );
    }
}
