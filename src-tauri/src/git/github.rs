// GitHub — everything Klide knows about GitHub lives here: the gh CLI seam
// (login-shell binary resolution + output capture), the PR commands, avatar
// resolution, and the pure parsers that turn gh's JSON into the structs the
// frontend renders. The parsers take &str and return structs, so they are
// fixture-tested without a gh binary, a network, or a live repo — the
// commands are thin: gh_output → parse.

use std::process::Command;

use super::{blocking, git_output, run_git};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PullRequest {
    number: u32,
    title: String,
    state: String,
    is_draft: bool,
    author: String,
    head_ref: String,
    base_ref: String,
    url: String,
    additions: i64,
    deletions: i64,
    changed_files: i32,
    /// Number of issue comments on the PR (drives the comment glyph).
    comments: i32,
    /// Distinct commenter logins, in first-seen order (drives the avatar stack).
    comment_authors: Vec<String>,
    /// ISO-8601 updated timestamp.
    updated_at_ms: i64,
    /// "open" | "merged" | "closed" | "draft" — derived for the badge.
    badge: String,
    /// True if this PR targets the current branch.
    is_current_branch: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrComment {
    author: String,
    body: String,
    created_at_ms: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrCommit {
    short_hash: String,
    headline: String,
    author: String,
    created_at_ms: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PullRequestDetails {
    number: u32,
    title: String,
    body: String,
    state: String,
    is_draft: bool,
    author: String,
    head_ref: String,
    base_ref: String,
    url: String,
    additions: i64,
    deletions: i64,
    changed_files: i32,
    /// Issue-comment count (mirrors PullRequest so the detail glyph matches).
    comments: i32,
    /// The actual comment thread, author + markdown body, oldest first.
    comment_thread: Vec<PrComment>,
    /// Commits on the PR, oldest first — interleaved with comments into a
    /// GitHub-style conversation timeline on the frontend.
    commits: Vec<PrCommit>,
    /// "open" | "merged" | "closed" | "draft" — derived for the badge.
    badge: String,
    mergeable: String,
    created_at_ms: i64,
    updated_at_ms: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitHubUser {
    login: String,
    avatar_url: String,
}

/// Resolve the `gh` binary once per session. A Finder-launched macOS `.app`
/// inherits only a minimal PATH (no `/opt/homebrew/bin`), so a bare
/// `Command::new("gh")` fails in the production bundle even when `gh` is
/// installed — which is why author avatars fell back to the initial disc and
/// the PR panel went quiet after v0.5 shipped. We resolve through the shared
/// PATH helper used by delegates and MLX; its safe login-shell fallback sees
/// Homebrew paths without interpolating the binary name. Falls back to the
/// bare name so dev still works if the lookup ever fails.
fn gh_bin() -> String {
    use std::sync::OnceLock;
    static GH: OnceLock<String> = OnceLock::new();
    GH.get_or_init(|| crate::cli::resolve_command("gh").unwrap_or_else(|_| "gh".to_string()))
        .clone()
}

fn gh_output(workspace_root: &str, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new(gh_bin());
    command.args(args);
    apply_account_env(&mut command);
    if !workspace_root.is_empty() {
        command.current_dir(workspace_root);
    }
    let output = command.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "GitHub CLI (gh) is not installed. Install it with: brew install gh".to_string()
        } else {
            format!("Failed to run gh: {e}")
        }
    })?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            Err(String::from_utf8_lossy(&output.stdout).trim().to_string())
        } else {
            Err(stderr)
        }
    }
}

fn parse_github_user(json: &str) -> Result<GitHubUser, String> {
    let raw: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("Could not parse GitHub user: {e}"))?;
    let login = raw
        .get("login")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    let avatar_url = raw
        .get("avatar_url")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    if login.is_empty() || avatar_url.is_empty() {
        return Err("GitHub account has no login or profile picture".to_string());
    }
    Ok(GitHubUser { login, avatar_url })
}

fn parse_configured_github_login(hosts: &str) -> Option<String> {
    let mut in_github = false;
    for line in hosts.lines() {
        let trimmed = line.trim();
        if line == line.trim_start() && trimmed.ends_with(':') {
            in_github = trimmed == "github.com:";
            continue;
        }
        if !in_github {
            continue;
        }
        let Some(login) = trimmed.strip_prefix("user:").map(str::trim) else {
            continue;
        };
        if !login.is_empty()
            && login
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
        {
            return Some(login.to_string());
        }
    }
    None
}

/// Every login `gh` is signed in to on github.com, read from the `users:` block
/// of hosts.yml. Order is hosts.yml's own (alphabetical, as gh writes it), and
/// entries that aren't plausible logins are dropped so a malformed file can
/// never reach a command line.
fn parse_github_logins(hosts: &str) -> Vec<String> {
    let mut logins: Vec<String> = Vec::new();
    let mut in_github = false;
    // The indentation of the `users:` key, once we're inside it. Anything more
    // deeply indented is one of its children (a login, or a login's own keys).
    let mut users_indent: Option<usize> = None;
    for line in hosts.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        if indent == 0 {
            in_github = trimmed == "github.com:";
            users_indent = None;
            continue;
        }
        if !in_github {
            continue;
        }
        match users_indent {
            Some(base) if indent > base => {
                // A login is a bare `name:` key; a login's own settings
                // (`oauth_token: …`) carry a value and are skipped.
                if let Some(login) = trimmed.strip_suffix(':') {
                    if is_plausible_login(login) {
                        logins.push(login.to_string());
                    }
                }
                continue;
            }
            // Dedented back out of `users:` — the block is over.
            Some(_) => users_indent = None,
            None => {}
        }
        if trimmed == "users:" {
            users_indent = Some(indent);
        }
    }
    logins
}

fn is_plausible_login(login: &str) -> bool {
    !login.is_empty()
        && login.len() <= 39
        && login
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
}

fn gh_config_root() -> Option<std::path::PathBuf> {
    std::env::var_os("GH_CONFIG_DIR")
        .map(std::path::PathBuf::from)
        .or_else(|| crate::cli::home_dir_path().map(|home| home.join(".config").join("gh")))
}

fn gh_hosts_yml() -> Option<String> {
    std::fs::read_to_string(gh_config_root()?.join("hosts.yml")).ok()
}

fn configured_github_login() -> Option<String> {
    parse_configured_github_login(&gh_hosts_yml()?)
}

/* ------------------------------------------------- the pinned account ---- */

// `gh` has one globally active account (`gh auth switch` flips it), so with a
// work and a personal login side by side, Klide's identity, avatars, and PR
// commands followed whichever account you last switched to for something else
// — the work face showing up in a personal project. A pin fixes Klide to one
// account without touching gh's global state: we read that account's own token
// and pass it per-command as GH_TOKEN, which gh (and `gh auth git-credential`,
// so pushes too) prefers over the active login. No pin = previous behaviour,
// gh's active account.

fn pinned_account_path() -> Option<std::path::PathBuf> {
    crate::cli::home_dir_path().map(|home| home.join(".klide").join("github_account.json"))
}

fn parse_pinned_account(json: &str) -> Option<String> {
    let raw: serde_json::Value = serde_json::from_str(json).ok()?;
    let login = raw.get("login")?.as_str()?.trim();
    is_plausible_login(login).then(|| login.to_string())
}

/// The pinned login, or None when Klide should follow gh's active account.
/// Read from disk on each call — it's a few bytes next to a subprocess spawn,
/// and it means a change in Settings takes effect without an app restart.
fn pinned_account() -> Option<String> {
    let json = std::fs::read_to_string(pinned_account_path()?).ok()?;
    parse_pinned_account(&json)
}

type TokenCache = std::sync::Mutex<std::collections::HashMap<String, Option<String>>>;

fn token_cache() -> &'static TokenCache {
    static CACHE: std::sync::OnceLock<TokenCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// The pinned account's own token, via `gh auth token --user`. Cached per login
/// — gh's stored tokens are long-lived, and this would otherwise double the
/// subprocesses of every gh call. Misses are cached too, so a signed-out
/// account doesn't retry forever; `github_set_account` drops the entry.
fn account_token(login: &str) -> Option<String> {
    if let Ok(cache) = token_cache().lock() {
        if let Some(hit) = cache.get(login) {
            return hit.clone();
        }
    }
    // No apply_account_env here — this is the call that resolves it.
    let token = Command::new(gh_bin())
        .args(["auth", "token", "--user", login])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|token| !token.is_empty());
    if let Ok(mut cache) = token_cache().lock() {
        cache.insert(login.to_string(), token.clone());
    }
    token
}

/// Point a `gh` (or `git`) command at the pinned account, if there is one.
/// Shared so PR creation and pushes act as the same account the avatar shows.
pub(crate) fn apply_account_env(command: &mut Command) {
    let Some(login) = pinned_account() else { return };
    let Some(token) = account_token(&login) else { return };
    command.env("GH_TOKEN", token);
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitHubAccounts {
    /// Every login gh is signed in to, for the Settings picker.
    logins: Vec<String>,
    /// gh's globally active account — what Klide uses when nothing is pinned.
    active: Option<String>,
    /// Klide's pin, when set.
    pinned: Option<String>,
}

/// The accounts Klide can act as, plus which one it's currently using.
#[tauri::command]
pub(crate) async fn github_accounts() -> Result<GitHubAccounts, String> {
    blocking(move || {
        let hosts = gh_hosts_yml().unwrap_or_default();
        let active = parse_configured_github_login(&hosts);
        let mut logins = parse_github_logins(&hosts);
        // An active account gh recorded without a `users:` entry (older config)
        // still belongs in the list.
        if let Some(active) = &active {
            if !logins.iter().any(|login| login == active) {
                logins.push(active.clone());
            }
        }
        Ok(GitHubAccounts {
            logins,
            active,
            pinned: pinned_account(),
        })
    })
    .await
}

/// Pin Klide to one GitHub account, or clear the pin with `None`. Returns the
/// identity now in force so the caller can repaint the avatar immediately.
#[tauri::command]
pub(crate) async fn github_set_account(login: Option<String>) -> Result<GitHubUser, String> {
    blocking(move || {
        let path = pinned_account_path().ok_or("No home directory to store the account in")?;
        let parent = path
            .parent()
            .ok_or("Could not resolve the Klide config directory")?;
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not create {parent:?}: {e}"))?;

        match login.as_deref().map(str::trim).filter(|l| !l.is_empty()) {
            Some(login) => {
                if !is_plausible_login(login) {
                    return Err(format!("'{login}' is not a valid GitHub login"));
                }
                let hosts = gh_hosts_yml().unwrap_or_default();
                if !parse_github_logins(&hosts).iter().any(|l| l == login) {
                    return Err(format!(
                        "gh is not signed in as '{login}' — run `gh auth login` for that account first"
                    ));
                }
                // Drop any cached miss first: the account may have been signed
                // in since we last looked.
                if let Ok(mut cache) = token_cache().lock() {
                    cache.remove(login);
                }
                if account_token(login).is_none() {
                    return Err(format!("Could not read gh's token for '{login}'"));
                }
                let body = serde_json::json!({ "login": login }).to_string();
                std::fs::write(&path, body)
                    .map_err(|e| format!("Could not save the account: {e}"))?;
            }
            None => {
                if path.exists() {
                    std::fs::remove_file(&path)
                        .map_err(|e| format!("Could not clear the account: {e}"))?;
                }
            }
        }
        resolve_current_user()
    })
    .await
}

/// The identity Klide acts as: the pin, else gh's active account, else — for a
/// config we couldn't read — whatever `gh api user` reports.
///
/// The pin only counts when its token still resolves. A pinned account you've
/// since signed out of would otherwise show its face here while every gh call
/// quietly fell back to the active login — the exact mismatch the pin exists to
/// prevent. Better to admit which account is really in force.
fn resolve_current_user() -> Result<GitHubUser, String> {
    let pinned = pinned_account().filter(|login| account_token(login).is_some());
    if let Some(login) = pinned.or_else(configured_github_login) {
        return Ok(GitHubUser {
            avatar_url: format!("https://github.com/{login}.png?size=96"),
            login,
        });
    }
    parse_github_user(&gh_output("", &["api", "user"])?)
}

/// ISO-8601 value → unix millis, 0 when absent/unparsable.
fn ms_from_rfc3339(v: Option<&serde_json::Value>) -> i64 {
    v.and_then(|x| x.as_str())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis())
        .unwrap_or(0)
}

fn str_field(obj: &serde_json::Map<String, serde_json::Value>, key: &str, default: &str) -> String {
    obj.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or(default)
        .to_string()
}

fn badge_for(state: &str, is_draft: bool) -> String {
    if is_draft {
        "draft".to_string()
    } else {
        state.to_lowercase()
    }
}

/// Parse `gh pr list --json …` output. Pure — fixture-tested below.
fn parse_pr_list(json: &str, current_branch: &str) -> Result<Vec<PullRequest>, String> {
    let raw: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| format!("Could not parse `gh pr list` output: {e}"))?;
    let arr = raw.as_array().cloned().unwrap_or_default();
    let mut prs: Vec<PullRequest> = Vec::with_capacity(arr.len());
    for v in arr {
        let obj = match v.as_object() {
            Some(o) => o,
            None => continue,
        };
        let state = str_field(obj, "state", "OPEN");
        let is_draft = obj
            .get("isDraft")
            .and_then(|x| x.as_bool())
            .unwrap_or(false);
        let head_ref = str_field(obj, "headRefName", "");
        let comment_arr = obj.get("comments").and_then(|x| x.as_array());
        let comments = comment_arr.map(|a| a.len()).unwrap_or(0) as i32;
        // Distinct commenter logins in first-seen order — feeds the avatar stack.
        let mut comment_authors: Vec<String> = Vec::new();
        if let Some(arr) = comment_arr {
            for c in arr {
                if let Some(login) = c
                    .get("author")
                    .and_then(|a| a.get("login"))
                    .and_then(|a| a.as_str())
                {
                    let login = login.to_string();
                    if !login.is_empty() && !comment_authors.contains(&login) {
                        comment_authors.push(login);
                    }
                }
            }
        }
        prs.push(PullRequest {
            number: obj.get("number").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
            title: str_field(obj, "title", ""),
            badge: badge_for(&state, is_draft),
            state,
            is_draft,
            author: obj
                .get("author")
                .and_then(|x| x.get("login"))
                .and_then(|x| x.as_str())
                .unwrap_or("unknown")
                .to_string(),
            is_current_branch: !current_branch.is_empty() && head_ref == current_branch,
            head_ref,
            base_ref: str_field(obj, "baseRefName", ""),
            url: str_field(obj, "url", ""),
            additions: obj.get("additions").and_then(|x| x.as_i64()).unwrap_or(0),
            deletions: obj.get("deletions").and_then(|x| x.as_i64()).unwrap_or(0),
            changed_files: obj
                .get("changedFiles")
                .and_then(|x| x.as_i64())
                .unwrap_or(0) as i32,
            comments,
            comment_authors,
            updated_at_ms: ms_from_rfc3339(obj.get("updatedAt")),
        });
    }
    // Mixed states come back grouped by state; sort newest-first so the panel
    // reads chronologically regardless of the open/merged/closed mix.
    prs.sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms));
    Ok(prs)
}

/// Parse `gh pr view --json …` output. Pure — fixture-tested below.
fn parse_pr_view(json: &str, number: u32) -> Result<PullRequestDetails, String> {
    let obj: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| format!("Could not parse `gh pr view` output: {e}"))?;
    let obj = match obj.as_object() {
        Some(o) => o,
        None => return Err(format!("PR #{number} not found")),
    };
    let commits: Vec<PrCommit> = obj
        .get("commits")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .map(|c| {
                    let oid = c.get("oid").and_then(|o| o.as_str()).unwrap_or("");
                    PrCommit {
                        short_hash: oid.chars().take(7).collect(),
                        headline: c
                            .get("messageHeadline")
                            .and_then(|m| m.as_str())
                            .unwrap_or("")
                            .to_string(),
                        // `authors` is the co-author list; take the first login.
                        author: c
                            .get("authors")
                            .and_then(|a| a.as_array())
                            .and_then(|a| a.first())
                            .and_then(|a| a.get("login"))
                            .and_then(|a| a.as_str())
                            .unwrap_or("")
                            .to_string(),
                        created_at_ms: ms_from_rfc3339(c.get("committedDate")),
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    let comment_thread: Vec<PrComment> = obj
        .get("comments")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .map(|c| PrComment {
                    author: c
                        .get("author")
                        .and_then(|a| a.get("login"))
                        .and_then(|a| a.as_str())
                        .unwrap_or("unknown")
                        .to_string(),
                    body: c
                        .get("body")
                        .and_then(|b| b.as_str())
                        .unwrap_or("")
                        .to_string(),
                    created_at_ms: ms_from_rfc3339(c.get("createdAt")),
                })
                .collect()
        })
        .unwrap_or_default();
    let state = str_field(obj, "state", "OPEN");
    let is_draft = obj
        .get("isDraft")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    Ok(PullRequestDetails {
        number: obj.get("number").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
        title: str_field(obj, "title", ""),
        body: str_field(obj, "body", ""),
        badge: badge_for(&state, is_draft),
        state,
        is_draft,
        author: obj
            .get("author")
            .and_then(|x| x.get("login"))
            .and_then(|x| x.as_str())
            .unwrap_or("unknown")
            .to_string(),
        head_ref: str_field(obj, "headRefName", ""),
        base_ref: str_field(obj, "baseRefName", ""),
        url: str_field(obj, "url", ""),
        additions: obj.get("additions").and_then(|x| x.as_i64()).unwrap_or(0),
        deletions: obj.get("deletions").and_then(|x| x.as_i64()).unwrap_or(0),
        changed_files: obj
            .get("changedFiles")
            .and_then(|x| x.as_i64())
            .unwrap_or(0) as i32,
        comments: comment_thread.len() as i32,
        comment_thread,
        commits,
        mergeable: str_field(obj, "mergeable", "UNKNOWN"),
        created_at_ms: ms_from_rfc3339(obj.get("createdAt")),
        updated_at_ms: ms_from_rfc3339(obj.get("updatedAt")),
    })
}

#[tauri::command]
pub(crate) async fn create_pr(
    workspace_root: String,
    title: String,
    body: Option<String>,
) -> Result<String, String> {
    blocking(move || {
        // Create a branch from the current changes. Cap the name at 50 chars —
        // truncate() takes a BYTE index and panics mid-char on non-ASCII titles
        // (is_alphanumeric keeps accented/Unicode letters), so count chars instead.
        let branch: String = format!(
            "klide/{}",
            title
                .to_lowercase()
                .replace(|c: char| !c.is_alphanumeric() && c != '-', "-")
                .trim_matches('-')
        )
        .chars()
        .take(50)
        .collect();

        // Check if gh CLI is available
        let gh_check = Command::new(gh_bin()).arg("--version").output();
        if gh_check.is_err() || !gh_check.unwrap().status.success() {
            return Err(
                "GitHub CLI (gh) is not installed. Install it with: brew install gh".to_string(),
            );
        }

        // Commit exactly what the user staged in the Git Review UI — do NOT
        // `git add -A`. A blanket add sweeps every untracked/unstaged file in the
        // tree (scratch files, copied worktree config) into the PR commit, which is
        // the worktree-bootstrap pollution bug. The commit/PR flow is staging-driven
        // everywhere else; keep it that way here.
        let status = Command::new("git")
            .args(["-C", &workspace_root, "diff", "--cached", "--quiet"])
            .status()
            .map_err(|e| format!("Failed to check git status: {e}"))?;
        if status.success() {
            return Err("No staged changes — stage files before opening a PR.".to_string());
        }

        // Create and switch to new branch
        run_git(&workspace_root, &["checkout", "-b", &branch])?;

        // Commit the staged changes before pushing; otherwise the PR branch has no
        // new commits for GitHub to compare against the base branch.
        run_git(&workspace_root, &["commit", "-m", title.trim()])?;

        // The pinned account signs the push too (gh's credential helper prefers
        // GH_TOKEN), so the branch lands under the same identity that opens the
        // PR — otherwise a personal repo gets a 403 from the work login.
        let mut push_cmd = Command::new("git");
        push_cmd.args([
            "-C",
            &workspace_root,
            "push",
            "-u",
            "origin",
            branch.as_str(),
        ]);
        apply_account_env(&mut push_cmd);
        let push = push_cmd
            .output()
            .map_err(|e| format!("Failed to push: {e}"))?;
        if !push.status.success() {
            let err = String::from_utf8_lossy(&push.stderr);
            let _ = Command::new("git")
                .args(["-C", &workspace_root, "checkout", "-"])
                .status();
            let _ = Command::new("git")
                .args(["-C", &workspace_root, "branch", "-D", branch.as_str()])
                .status();
            return Err(format!("Push failed: {}", err.trim()));
        }

        let mut gh_args = vec!["pr", "create", "--title", &title, "--head", branch.as_str()];
        let body_str;
        if let Some(b) = &body {
            body_str = b.clone();
            gh_args.push("--body");
            gh_args.push(&body_str);
        }

        let mut pr_cmd = Command::new(gh_bin());
        pr_cmd.args(gh_args).current_dir(&workspace_root);
        apply_account_env(&mut pr_cmd);
        let pr = pr_cmd
            .output()
            .map_err(|e| format!("Failed to create PR: {e}"))?;

        if pr.status.success() {
            let url = String::from_utf8_lossy(&pr.stdout).trim().to_string();
            Ok(if url.is_empty() {
                format!("PR created on branch '{branch}'")
            } else {
                url
            })
        } else {
            let err = String::from_utf8_lossy(&pr.stderr);
            Err(format!("PR creation failed: {}", err.trim()))
        }
    })
    .await
}

/// The GitHub account authenticated in `gh`, used by the shared profile row.
/// This is global identity, so unlike repository commands it needs no cwd.
#[tauri::command]
pub(crate) async fn github_current_user() -> Result<GitHubUser, String> {
    blocking(resolve_current_user).await
}

/// One (commit, author-email) pair the frontend wants an avatar for.
#[derive(serde::Deserialize)]
pub(crate) struct AvatarQuery {
    hash: String,
    email: String,
}

/// Resolve commit authors to their REAL GitHub account pictures. GitHub is
/// the only party that can map a commit to an account (it works even when
/// the author's email is private), via the commit endpoint's `author` field.
/// Results — including misses — are cached per email for the app's lifetime,
/// so each unique author costs one `gh api` call ever.
#[tauri::command]
pub(crate) async fn github_commit_avatars(
    workspace_root: String,
    queries: Vec<AvatarQuery>,
) -> Result<std::collections::HashMap<String, String>, String> {
    blocking(move || {
        use std::collections::HashMap;
        use std::sync::{Mutex, OnceLock};
        static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
        let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));

        let mut out = HashMap::new();
        let mut misses: Vec<(String, String)> = Vec::new();
        {
            let cache = cache.lock().map_err(|_| "avatar cache poisoned")?;
            let mut seen = std::collections::HashSet::new();
            for q in &queries {
                let email = q.email.trim().to_lowercase();
                if email.is_empty() || !seen.insert(email.clone()) {
                    continue;
                }
                match cache.get(&email) {
                    Some(Some(url)) => {
                        out.insert(email, url.clone());
                    }
                    Some(None) => {}
                    None => misses.push((email, q.hash.clone())),
                }
            }
        }

        // Each lookup is a network round-trip (~0.5s); cap the batch so one
        // giant repo can't stall this blocking task for a minute. Uncached
        // stragglers resolve on a later call.
        for (email, hash) in misses.into_iter().take(12) {
            let url = gh_output(
                &workspace_root,
                &[
                    "api",
                    &format!("repos/{{owner}}/{{repo}}/commits/{hash}"),
                    "--jq",
                    ".author.avatar_url",
                ],
            )
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && s != "null");
            if let Some(url) = &url {
                out.insert(email.clone(), url.clone());
            }
            if let Ok(mut cache) = cache.lock() {
                cache.insert(email, url);
            }
        }
        Ok(out)
    })
    .await
}

#[tauri::command]
pub(crate) async fn git_pr_list(workspace_root: String) -> Result<Vec<PullRequest>, String> {
    blocking(move || {
        let json = gh_output(
            &workspace_root,
            &[
                "pr",
                "list",
                // Without `--state` gh only returns OPEN PRs, so merged/closed ones
                // never reached the "Merged"/"All" tabs. Pull every state; cap the
                // batch so a busy repo can't stall this off-thread call.
                "--state",
                "all",
                "--limit",
                "50",
                "--json",
                "number,title,state,isDraft,author,headRefName,baseRefName,url,additions,deletions,changedFiles,comments,updatedAt",
            ],
        )?;
        let current_branch = git_output(&workspace_root, &["branch", "--show-current"])
            .unwrap_or_default()
            .trim()
            .to_string();
        parse_pr_list(&json, &current_branch)
    })
    .await
}

#[tauri::command]
pub(crate) async fn git_pr_view(
    workspace_root: String,
    number: u32,
) -> Result<PullRequestDetails, String> {
    blocking(move || {
        let json = gh_output(
            &workspace_root,
            &[
                "pr",
                "view",
                &number.to_string(),
                "--json",
                "number,title,body,state,isDraft,author,headRefName,baseRefName,url,additions,deletions,changedFiles,comments,commits,mergeable,createdAt,updatedAt",
            ],
        )?;
        parse_pr_view(&json, number)
    })
    .await
}

#[tauri::command]
pub(crate) async fn git_pr_checkout(workspace_root: String, number: u32) -> Result<String, String> {
    blocking(move || {
        let out = gh_output(&workspace_root, &["pr", "checkout", &number.to_string()])?;
        Ok(out.trim().to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn git_pr_merge(
    workspace_root: String,
    number: u32,
    method: Option<String>,
) -> Result<String, String> {
    blocking(move || {
        let method = method.unwrap_or_else(|| "merge".to_string());
        let flag = match method.as_str() {
            "merge" => "--merge",
            "squash" => "--squash",
            "rebase" => "--rebase",
            other => return Err(format!("Unknown merge method: {other}")),
        };
        let out = gh_output(
            &workspace_root,
            &["pr", "merge", &number.to_string(), flag, "--delete-branch"],
        )?;
        // The merge happened on GitHub; the local repo has not heard. Fetch so
        // the merge commit exists here (the history graph reads every ref, so
        // it draws in on origin/<base> at once), and if the base branch is the
        // one checked out, fast-forward it — that is what `gh` itself does when
        // run from the PR branch. Both are best-effort: the merge is done, a
        // flaky remote or a dirty tree must not turn it into an error.
        let _ = run_git(&workspace_root, &["fetch", "--all", "--prune"]);
        let base = gh_output(
            &workspace_root,
            &["pr", "view", &number.to_string(), "--json", "baseRefName", "-q", ".baseRefName"],
        )
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
        let current = git_output(&workspace_root, &["rev-parse", "--abbrev-ref", "HEAD"])
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        if !base.is_empty() && base == current {
            let _ = run_git(&workspace_root, &["merge", "--ff-only", "@{u}"]);
        }
        Ok(out.trim().to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn git_pr_open(workspace_root: String, number: u32) -> Result<String, String> {
    blocking(move || {
        // `gh pr view --web` opens the PR in the default browser; we return the
        // resolved URL so the UI can show a toast.
        let url = gh_output(
            &workspace_root,
            &[
                "pr",
                "view",
                &number.to_string(),
                "--json",
                "url",
                "-q",
                ".url",
            ],
        )?;
        let url = url.trim().to_string();
        if url.is_empty() {
            return Err(format!("PR #{number} has no URL"));
        }
        Command::new("open")
            .arg(&url)
            .output()
            .or_else(|_| Command::new("xdg-open").arg(&url).output())
            .map_err(|e| format!("Failed to open browser: {e}"))?;
        Ok(url)
    })
    .await
}

#[tauri::command]
pub(crate) async fn git_pr_merged(workspace_root: String, number: u32) -> Result<bool, String> {
    blocking(move || {
        // `gh pr view <n> --json merged -q .merged` is the cheapest signal.
        let raw = gh_output(
            &workspace_root,
            &[
                "pr",
                "view",
                &number.to_string(),
                "--json",
                "merged",
                "-q",
                ".merged",
            ],
        )?;
        Ok(raw.trim().eq_ignore_ascii_case("true"))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_user_parses_login_and_profile_picture() {
        let user = parse_github_user(
            r#"{"login":"pierreprudh","avatar_url":"https://avatars.githubusercontent.com/u/42?v=4"}"#,
        )
        .expect("parses");
        assert_eq!(user.login, "pierreprudh");
        assert_eq!(
            user.avatar_url,
            "https://avatars.githubusercontent.com/u/42?v=4"
        );
    }

    #[test]
    fn github_user_requires_a_real_identity() {
        assert!(parse_github_user(r#"{"login":"","avatar_url":""}"#).is_err());
    }

    #[test]
    fn github_user_reads_the_active_login_without_network() {
        let hosts = r#"github.com:
    git_protocol: https
    users:
        another-user:
        pierreprudh:
    user: pierreprudh
git.example.com:
    user: someone-else
"#;
        assert_eq!(
            parse_configured_github_login(hosts).as_deref(),
            Some("pierreprudh")
        );
    }

    #[test]
    fn github_accounts_list_every_signed_in_login() {
        let hosts = r#"github.com:
    git_protocol: https
    users:
        Pierre-OTK:
            oauth_token: gho_secret
        pierreprudh:
    user: Pierre-OTK
git.example.com:
    users:
        someone-else:
    user: someone-else
"#;
        assert_eq!(
            parse_github_logins(hosts),
            vec!["Pierre-OTK".to_string(), "pierreprudh".to_string()]
        );
    }

    #[test]
    fn github_accounts_ignore_keys_outside_the_users_block() {
        let hosts = r#"github.com:
    users:
        pierreprudh:
    user: pierreprudh
    git_protocol: https
"#;
        // `user:` and `git_protocol:` sit at the users-block's own indent, so
        // the block has ended — neither is a login.
        assert_eq!(parse_github_logins(hosts), vec!["pierreprudh".to_string()]);
    }

    #[test]
    fn pinned_account_reads_a_valid_login_only() {
        assert_eq!(
            parse_pinned_account(r#"{"login":"pierreprudh"}"#).as_deref(),
            Some("pierreprudh")
        );
        assert_eq!(parse_pinned_account(r#"{"login":""}"#), None);
        assert_eq!(parse_pinned_account(r#"{"login":"bad login;rm"}"#), None);
        assert_eq!(parse_pinned_account("not json"), None);
    }

    const PR_LIST_JSON: &str = r#"[
      {
        "number": 7,
        "title": "Older draft",
        "state": "OPEN",
        "isDraft": true,
        "author": { "login": "pierre" },
        "headRefName": "feat/older",
        "baseRefName": "main",
        "url": "https://github.com/o/r/pull/7",
        "additions": 10,
        "deletions": 2,
        "changedFiles": 3,
        "comments": [
          { "author": { "login": "alice" }, "body": "first" },
          { "author": { "login": "bob" }, "body": "second" },
          { "author": { "login": "alice" }, "body": "third" }
        ],
        "updatedAt": "2026-07-01T10:00:00Z"
      },
      {
        "number": 9,
        "title": "Newer merged",
        "state": "MERGED",
        "isDraft": false,
        "author": { "login": "carol" },
        "headRefName": "feat/newer",
        "baseRefName": "main",
        "url": "https://github.com/o/r/pull/9",
        "additions": 1,
        "deletions": 1,
        "changedFiles": 1,
        "comments": [],
        "updatedAt": "2026-07-05T10:00:00Z"
      }
    ]"#;

    #[test]
    fn pr_list_parses_sorts_and_derives_badges() {
        let prs = parse_pr_list(PR_LIST_JSON, "feat/older").expect("parses");
        assert_eq!(prs.len(), 2);
        // Newest-first regardless of gh's state grouping.
        assert_eq!(prs[0].number, 9);
        assert_eq!(prs[0].badge, "merged");
        assert!(!prs[0].is_current_branch);
        // Draft badge wins over open state; current branch matched by head ref.
        assert_eq!(prs[1].badge, "draft");
        assert!(prs[1].is_current_branch);
        // Distinct commenters in first-seen order.
        assert_eq!(prs[1].comments, 3);
        assert_eq!(prs[1].comment_authors, vec!["alice", "bob"]);
        assert!(prs[0].updated_at_ms > prs[1].updated_at_ms);
    }

    #[test]
    fn pr_list_tolerates_missing_fields_and_junk_entries() {
        let prs = parse_pr_list(r#"[{"number": 3}, 42]"#, "").expect("parses");
        assert_eq!(prs.len(), 1);
        assert_eq!(prs[0].number, 3);
        assert_eq!(prs[0].author, "unknown");
        assert_eq!(prs[0].badge, "open");
        assert_eq!(prs[0].updated_at_ms, 0);
        assert!(!prs[0].is_current_branch);
    }

    const PR_VIEW_JSON: &str = r#"{
      "number": 12,
      "title": "Premium PR panel",
      "body": "Timeline + hero.",
      "state": "OPEN",
      "isDraft": false,
      "author": { "login": "pierre" },
      "headRefName": "feat/pr-panel",
      "baseRefName": "main",
      "url": "https://github.com/o/r/pull/12",
      "additions": 120,
      "deletions": 30,
      "changedFiles": 4,
      "comments": [
        { "author": { "login": "alice" }, "body": "Nice.", "createdAt": "2026-07-02T09:00:00Z" }
      ],
      "commits": [
        {
          "oid": "0123456789abcdef",
          "messageHeadline": "feat(git): timeline",
          "authors": [ { "login": "pierre" } ],
          "committedDate": "2026-07-01T08:00:00Z"
        }
      ],
      "mergeable": "MERGEABLE",
      "createdAt": "2026-06-30T12:00:00Z",
      "updatedAt": "2026-07-02T09:00:00Z"
    }"#;

    #[test]
    fn pr_view_parses_timeline_pieces() {
        let d = parse_pr_view(PR_VIEW_JSON, 12).expect("parses");
        assert_eq!(d.number, 12);
        assert_eq!(d.badge, "open");
        assert_eq!(d.mergeable, "MERGEABLE");
        // comments mirrors the actual thread length.
        assert_eq!(d.comments, 1);
        assert_eq!(d.comment_thread[0].author, "alice");
        assert_eq!(d.commits.len(), 1);
        assert_eq!(d.commits[0].short_hash, "0123456");
        assert_eq!(d.commits[0].author, "pierre");
        assert!(d.commits[0].created_at_ms > 0);
        assert!(d.created_at_ms < d.updated_at_ms);
    }

    #[test]
    fn pr_view_rejects_non_object_payload() {
        let err = match parse_pr_view("null", 5) {
            Ok(_) => panic!("expected an error for a null payload"),
            Err(e) => e,
        };
        assert!(err.contains("PR #5 not found"), "{err}");
    }
}

/// Recognize only a plain, pinned gh watch. Shell wrappers remain generic
/// observers: never guess a repository or execute observer text while polling.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CiWatchTarget { pub run_id: u64, pub repo: Option<String> }

pub fn ci_watch_target(command: &str) -> Option<CiWatchTarget> {
    let args = shell_words::split(command).ok()?;
    if args.first()?.rsplit('/').next()? != "gh" || args.get(1)? != "run" || args.get(2)? != "watch" { return None; }
    let mut run_id = None;
    let mut repo = None;
    let mut i = 3;
    while i < args.len() {
        match args[i].as_str() {
            "--exit-status" | "--compact" => {},
            "-R" | "--repo" => {
                i += 1;
                let value = args.get(i)?;
                let parts: Vec<_> = value.split('/').collect();
                if parts.len() != 2 || parts.iter().any(|p| (p.is_empty() || *p == "." || *p == "..") || !p.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))) { return None; }
                repo = Some(value.clone());
            },
            value if run_id.is_none() && value.chars().all(|c| c.is_ascii_digit()) => run_id = Some(value.parse().ok()?),
            _ => return None,
        }
        i += 1;
    }
    Some(CiWatchTarget { run_id: run_id?, repo })
}

pub fn ci_watch_status(cwd: &str, target: CiWatchTarget) -> Result<serde_json::Value, String> {
    let local_repo = gh_output(cwd, &["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).ok().map(|s| s.trim().to_string());
    let repo = target.repo.or_else(|| local_repo.clone()).ok_or("Could not resolve the observer repository")?;
    let endpoint = format!("repos/{repo}/actions/runs/{}", target.run_id);
    let run: serde_json::Value = serde_json::from_str(&gh_output(cwd, &["api", &endpoint])?).map_err(|e| e.to_string())?;
    let attempt = run["run_attempt"].as_u64().ok_or("Missing run attempt")?;
    let jobs_endpoint = format!("{endpoint}/attempts/{attempt}/jobs?per_page=100");
    let pages: Vec<serde_json::Value> = serde_json::from_str(&gh_output(cwd, &["api", &jobs_endpoint, "--paginate", "--slurp"])?) .map_err(|e| e.to_string())?;
    let jobs: Vec<_> = pages.iter().flat_map(|page| page["jobs"].as_array().into_iter().flatten()).map(|j| serde_json::json!({"name":j["name"],"status":j["status"],"conclusion":j["conclusion"]})).collect();
    let mut pr_number = run["pull_requests"].as_array().and_then(|prs| prs.first()).and_then(|p| p["number"].as_u64());
    // GitHub sometimes omits pull_requests (including after merge). Ask for
    // PRs associated with the exact SHA and require a unique branch/repo match.
    if pr_number.is_none() {
        if let Some(sha) = run["head_sha"].as_str() {
            if let Ok(json) = gh_output(cwd, &["api", &format!("repos/{repo}/commits/{sha}/pulls")]) {
                if let Ok(prs) = serde_json::from_str::<Vec<serde_json::Value>>(&json) {
                    pr_number = associated_watch_pr(&run, &prs, &repo);
                }
            }
        }
    }
    let pr = pr_number.and_then(|n| gh_output(cwd, &["api", &format!("repos/{repo}/pulls/{n}")]).ok()).and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok());
    Ok(serde_json::json!({
        "runId": target.run_id, "attempt": attempt, "url": run["html_url"],
        "status": run["status"], "conclusion": run["conclusion"], "headSha": run["head_sha"],
        "jobs": jobs, "prNumber": pr_number,
        "prUrl": pr.as_ref().map(|p| &p["html_url"]),
        "prHeadSha": pr.as_ref().map(|p| &p["head"]["sha"]),
        "prState": pr.as_ref().map(|p| if p["merged"].as_bool() == Some(true) { "merged" } else { p["state"].as_str().unwrap_or("unknown") }),
        "repo": repo, "cwd": cwd, "localRepo": local_repo
    }))
}

fn associated_watch_pr(run: &serde_json::Value, prs: &[serde_json::Value], repo: &str) -> Option<u64> {
    let candidates: Vec<_> = prs.iter().filter(|p| p["head"]["ref"] == run["head_branch"] && p["head"]["repo"]["full_name"].as_str() == Some(repo)).filter_map(|p| p["number"].as_u64()).collect();
    if candidates.len() == 1 { Some(candidates[0]) } else { None }
}

#[cfg(test)]
mod ci_watch_tests {
    use super::*;
    #[test]
    fn commit_association_must_be_unambiguous_and_in_the_same_repo() {
        let run = serde_json::json!({"head_branch":"feature"});
        let pr = serde_json::json!({"number":120,"head":{"ref":"feature","repo":{"full_name":"owner/repo"}}});
        assert_eq!(associated_watch_pr(&run, &[pr.clone()], "owner/repo"), Some(120));
        assert_eq!(associated_watch_pr(&run, &[pr.clone()], "other/repo"), None);
        assert_eq!(associated_watch_pr(&run, &[pr.clone(), pr], "owner/repo"), None);
    }
    #[test]
    fn only_pinned_plain_watches_are_recognized() {
        let target = ci_watch_target("gh run watch 123 --exit-status -R owner/repo").unwrap();
        assert_eq!(target.run_id, 123);
        assert_eq!(target.repo.as_deref(), Some("owner/repo"));
        for command in ["gh run watch", "gh run watch 1; echo done", "gh run watch 1 && echo done", "echo gh run watch 1", "gh run watch 1 -R ../repo", "gh run watch 1 --unknown"] { assert!(ci_watch_target(command).is_none(), "{command}"); }
    }
}
