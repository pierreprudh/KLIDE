//! `klide://` links — how Raycast, a Shortcut, a terminal or the Services menu
//! reach Klide.
//!
//! Four actions, all addressed by the URL's host:
//!
//! * `klide://new?prompt=…&project=/abs/dir` — start a conversation with the
//!   composer **pre-filled**. Never sent: any web page can fire a `klide://`
//!   link, so a link may put words in front of you but never runs an agent.
//! * `klide://open?path=/abs/file&line=42` — open a file in an editor tab
//!   (`path=/abs/file:42` works too).
//! * `klide://project?path=/abs/dir` — open a folder as the project.
//! * `klide://resume?provider=claude-code&session=<id>` — continue a Delegate
//!   CLI's own session in an AI panel (`claude --resume <id>`), in the project
//!   that session ran in. The project is read from the session's transcript
//!   unless `project=/abs/dir` names it. Without `session`, the newest session
//!   of that CLI in `project` is the one — for a CLI that doesn't tell its
//!   shell its own id. This is how "follow up this conversation in Klide",
//!   said to a CLI in a terminal, reaches Klide: the `/klide` skill
//!   (klide_skill.rs) opens this link.
//!
//! Rust owns the rules: the URL is parsed and every path checked here, so the
//! webview only ever receives an action that already made sense. macOS
//! delivers a link as an Apple event — to the running app, or at launch before
//! the page has loaded — so actions are queued and the frontend drains them
//! (`deep_link_take`) on mount and on each `deep-link` nudge. Nothing is lost
//! to a listener that wasn't registered yet, and nothing is handled twice.
//!
//! macOS registers the scheme from the bundle's Info.plist, which Tauri writes
//! from `plugins.deep-link` in tauri.conf.json — so links reach an installed
//! `/Applications/Klide.app`, never `tauri dev`.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// A pre-filled prompt longer than this is cut. A link is a handoff, not a
/// document upload, and a URL this long came from something other than a person.
const MAX_PROMPT_CHARS: usize = 20_000;

/// What a link asks for, already validated.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LinkAction {
    /// A new conversation with `prompt` in its composer, in `project` when
    /// given (else the project open now).
    New { prompt: String, project: Option<String> },
    /// A file in an editor tab, at `line` (1-based) when given. `project` is
    /// the repository the file lives in (its nearest `.git`), so a file of a
    /// project that isn't open brings that project along.
    Open { path: String, line: Option<u32>, project: Option<String> },
    /// A folder as the open project.
    Project { path: String },
    /// A Delegate CLI's session, continued in an AI panel: `provider` is the
    /// Delegate id (`claude-code`, `codex`, …), `session` the id that CLI
    /// resumes by, `project` the folder it ran in when known.
    Resume { provider: String, session: String, project: Option<String> },
}

/// A session id longer than this came from something other than a CLI.
const MAX_SESSION_CHARS: usize = 128;

static PENDING: Mutex<Vec<LinkAction>> = Mutex::new(Vec::new());

/// How a link's session is resolved against what is on disk. Injected so the
/// parser is testable without a CLI's home: `project_of` answers which folder
/// a session ran in, `newest_in` which session of a CLI a folder saw last.
pub struct Sessions<'a> {
    pub project_of: &'a dyn Fn(&str, &str) -> Option<String>,
    pub newest_in: &'a dyn Fn(&str, &str) -> Option<String>,
}

/// Parse and check one link. The error is said to the user as-is.
pub fn parse(raw: &str) -> Result<LinkAction, String> {
    let env = crate::delegate::home::ProcessEnv;
    parse_with(
        raw,
        Sessions {
            project_of: &|provider, session| crate::delegate::find_run(&env, provider, session).and_then(|run| run.cwd),
            newest_in: &|provider, project| crate::delegate::find_latest_run(&env, provider, project).map(|run| run.id),
        },
    )
}

/// `parse` with the on-disk session lookups injected.
pub fn parse_with(raw: &str, sessions: Sessions<'_>) -> Result<LinkAction, String> {
    let url = reqwest::Url::parse(raw.trim()).map_err(|_| format!("Not a Klide link: {raw}"))?;
    if url.scheme() != "klide" {
        return Err(format!("Not a Klide link: {raw}"));
    }
    let query = |key: &str| {
        url.query_pairs()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.into_owned())
            .filter(|v| !v.trim().is_empty())
    };
    match url.host_str().unwrap_or_default() {
        "new" => {
            let prompt = clean_prompt(&query("prompt").unwrap_or_default());
            let project = match query("project") {
                Some(p) => Some(existing(&p, Kind::Dir)?),
                None => None,
            };
            Ok(LinkAction::New { prompt, project })
        }
        "open" => {
            let raw_path = query("path").ok_or("klide://open needs a path")?;
            let (path, suffix_line) = split_line(&raw_path);
            let line = match query("line") {
                Some(l) => Some(l.trim().parse::<u32>().map_err(|_| format!("Not a line number: {l}"))?),
                None => suffix_line,
            }
            .filter(|l| *l > 0);
            let path = existing(path, Kind::File)?;
            let project = project_of(Path::new(&path));
            Ok(LinkAction::Open { path, line, project })
        }
        "project" => {
            let path = query("path").ok_or("klide://project needs a path")?;
            Ok(LinkAction::Project { path: existing(&path, Kind::Dir)? })
        }
        "resume" => {
            let provider = query("provider").ok_or("klide://resume needs a provider")?;
            if crate::delegate::lookup(&provider).is_none() {
                return Err(format!("Klide can't resume `{provider}` sessions"));
            }
            let project = match query("project") {
                Some(p) => Some(existing(&p, Kind::Dir)?),
                None => None,
            };
            let (session, project) = match query("session") {
                Some(session) => {
                    if session.len() > MAX_SESSION_CHARS
                        || !session.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
                    {
                        return Err("That isn't a session id".to_string());
                    }
                    // The transcript knows the folder; a folder that is gone
                    // since leaves the session to resume in the project open now.
                    let project = project
                        .or_else(|| (sessions.project_of)(&provider, &session).and_then(|cwd| existing(&cwd, Kind::Dir).ok()));
                    (session, project)
                }
                None => {
                    let label = crate::delegate::lookup(&provider).map(|d| d.label()).unwrap_or(provider.as_str());
                    let Some(project) = project else {
                        return Err(format!("klide://resume needs a session id, or a project to take the newest {label} session from"));
                    };
                    let session = (sessions.newest_in)(&provider, &project)
                        .ok_or_else(|| format!("No {label} session in {project} yet"))?;
                    (session, Some(project))
                }
            };
            Ok(LinkAction::Resume { provider, session, project })
        }
        other => Err(format!("Klide doesn't know the link action `{other}`")),
    }
}

enum Kind {
    File,
    Dir,
}

/// An absolute path that exists and is the right kind, with `~` expanded and
/// `..` resolved — a link names a real place or it is refused.
fn existing(raw: &str, kind: Kind) -> Result<String, String> {
    let expanded: PathBuf = match raw.strip_prefix("~/") {
        Some(rest) => crate::cli::home_dir_path().ok_or("No home directory")?.join(rest),
        None => PathBuf::from(raw),
    };
    if !expanded.is_absolute() {
        return Err(format!("A link needs an absolute path, not {raw}"));
    }
    let path = expanded.canonicalize().map_err(|_| format!("{raw} doesn't exist"))?;
    let ok = match kind {
        Kind::File => path.is_file(),
        Kind::Dir => path.is_dir(),
    };
    if !ok {
        return Err(match kind {
            Kind::File => format!("{raw} is not a file"),
            Kind::Dir => format!("{raw} is not a folder"),
        });
    }
    Ok(path.to_string_lossy().into_owned())
}

/// The nearest ancestor holding `.git` (a folder, or the file a worktree
/// writes). Found by walking up rather than asking git — this runs as the link
/// arrives, and a subprocess there would hold the main thread.
fn project_of(file: &Path) -> Option<String> {
    file.ancestors()
        .skip(1)
        .find(|dir| dir.join(".git").exists())
        .map(|dir| dir.to_string_lossy().into_owned())
}

/// `src/main.rs:42` → (`src/main.rs`, 42). A path whose tail after the last
/// `:` isn't a number is left whole.
fn split_line(raw: &str) -> (&str, Option<u32>) {
    match raw.rsplit_once(':') {
        Some((path, tail)) if !path.is_empty() => match tail.parse::<u32>() {
            Ok(line) => (path, Some(line)),
            Err(_) => (raw, None),
        },
        _ => (raw, None),
    }
}

/// Keep newlines and tabs; drop every other control character (a terminal
/// escape pasted into a composer is noise at best), and cap the length.
fn clean_prompt(raw: &str) -> String {
    raw.chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .take(MAX_PROMPT_CHARS)
        .collect::<String>()
        .trim()
        .to_string()
}

/// Handle links macOS handed us: queue what parses, say what doesn't, bring
/// the window forward, and nudge the page to drain the queue.
pub fn receive(app: &tauri::AppHandle, urls: impl IntoIterator<Item = String>) {
    let mut queued = false;
    for raw in urls {
        match parse(&raw) {
            Ok(action) => {
                // A launch link can arrive twice — as the launch URL and as an
                // open event — and must still act once.
                let mut pending = PENDING.lock().unwrap_or_else(|p| p.into_inner());
                if !pending.contains(&action) {
                    pending.push(action);
                }
                queued = true;
            }
            Err(message) => {
                let _ = app.emit("deep-link:error", message);
            }
        }
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    if queued {
        let _ = app.emit("deep-link", ());
    }
}

/// Every queued action, oldest first, and an empty queue after.
#[tauri::command]
pub(crate) async fn deep_link_take() -> Vec<LinkAction> {
    std::mem::take(&mut *PENDING.lock().unwrap_or_else(|p| p.into_inner()))
}

/// Tests only ever build paths under the temp dir.
#[cfg(test)]
fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("klide-links-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.canonicalize().unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enc(s: &str) -> String {
        url_encode(s)
    }

    fn url_encode(s: &str) -> String {
        s.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => (b as char).to_string(),
                _ => format!("%{b:02X}"),
            })
            .collect()
    }

    #[test]
    fn new_prefills_and_keeps_newlines_but_not_escapes() {
        let link = format!("klide://new?prompt={}", enc("Fix the build\n\u{1b}[31mnow"));
        assert_eq!(
            parse(&link).unwrap(),
            LinkAction::New { prompt: "Fix the build\n[31mnow".to_string(), project: None }
        );
        // An empty prompt is still a valid "new conversation" link.
        assert_eq!(parse("klide://new").unwrap(), LinkAction::New { prompt: String::new(), project: None });
    }

    #[test]
    fn new_with_a_project_must_name_a_real_folder() {
        let dir = temp("project");
        let ok = parse(&format!("klide://new?prompt=hi&project={}", enc(dir.to_str().unwrap()))).unwrap();
        assert_eq!(ok, LinkAction::New { prompt: "hi".into(), project: Some(dir.to_string_lossy().into()) });
        assert!(parse("klide://new?project=/klide/no/such/dir").unwrap_err().contains("doesn't exist"));
    }

    #[test]
    fn open_takes_a_line_either_way_and_refuses_folders() {
        let dir = temp("open");
        let file = dir.join("main.rs");
        std::fs::write(&file, "fn main() {}\n").unwrap();
        let f = file.to_string_lossy().to_string();
        let want = LinkAction::Open { path: f.clone(), line: Some(42), project: None };
        assert_eq!(parse(&format!("klide://open?path={}&line=42", enc(&f))).unwrap(), want);
        assert_eq!(parse(&format!("klide://open?path={}", enc(&format!("{f}:42")))).unwrap(), want);
        assert_eq!(
            parse(&format!("klide://open?path={}", enc(&f))).unwrap(),
            LinkAction::Open { path: f, line: None, project: None }
        );
        assert!(parse(&format!("klide://open?path={}", enc(dir.to_str().unwrap()))).unwrap_err().contains("not a file"));
    }

    #[test]
    fn an_opened_file_brings_its_repository() {
        let repo = temp("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(repo.join("src")).unwrap();
        let file = repo.join("src/lib.rs");
        std::fs::write(&file, "").unwrap();
        match parse(&format!("klide://open?path={}", enc(file.to_str().unwrap()))).unwrap() {
            LinkAction::Open { project, .. } => assert_eq!(project, Some(repo.to_string_lossy().into())),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_path_is_absolute_and_resolved() {
        let dir = temp("resolve");
        std::fs::create_dir_all(dir.join("a")).unwrap();
        let dotted = format!("{}/a/..", dir.display());
        assert_eq!(
            parse(&format!("klide://project?path={}", enc(&dotted))).unwrap(),
            LinkAction::Project { path: dir.to_string_lossy().into() }
        );
        assert!(parse("klide://project?path=relative/dir").unwrap_err().contains("absolute"));
    }

    #[test]
    fn unknown_actions_and_other_schemes_are_refused() {
        assert!(parse("klide://run?command=rm").unwrap_err().contains("run"));
        assert!(parse("https://example.com").is_err());
        assert!(parse("klide://open").unwrap_err().contains("needs a path"));
    }

    #[test]
    fn a_huge_prompt_is_capped() {
        let link = format!("klide://new?prompt={}", "a".repeat(MAX_PROMPT_CHARS + 500));
        match parse(&link).unwrap() {
            LinkAction::New { prompt, .. } => assert_eq!(prompt.len(), MAX_PROMPT_CHARS),
            other => panic!("{other:?}"),
        }
    }

    fn sessions<'a>(
        project_of: &'a dyn Fn(&str, &str) -> Option<String>,
        newest_in: &'a dyn Fn(&str, &str) -> Option<String>,
    ) -> Sessions<'a> {
        Sessions { project_of, newest_in }
    }
    fn never(_: &str, _: &str) -> Option<String> {
        panic!("not asked")
    }
    fn none(_: &str, _: &str) -> Option<String> {
        None
    }

    #[test]
    fn resume_names_a_delegate_and_a_session_and_finds_the_project() {
        let dir = temp("resume");
        let found = |provider: &str, session: &str| {
            assert_eq!((provider, session), ("claude-code", "abc-123"));
            Some(dir.to_string_lossy().into_owned())
        };
        assert_eq!(
            parse_with("klide://resume?provider=claude-code&session=abc-123", sessions(&found, &never)).unwrap(),
            LinkAction::Resume {
                provider: "claude-code".into(),
                session: "abc-123".into(),
                project: Some(dir.to_string_lossy().into()),
            }
        );
        // An explicit project wins and is checked like any other folder.
        let explicit = format!("klide://resume?provider=codex&session=s1&project={}", enc(dir.to_str().unwrap()));
        match parse_with(&explicit, sessions(&never, &never)).unwrap() {
            LinkAction::Resume { project, .. } => assert_eq!(project, Some(dir.to_string_lossy().into())),
            other => panic!("{other:?}"),
        }
        // A session whose folder is gone still resumes, in the open project.
        let gone = |_: &str, _: &str| Some("/klide/no/such/dir".to_string());
        match parse_with("klide://resume?provider=opencode&session=ses_1", sessions(&gone, &never)).unwrap() {
            LinkAction::Resume { project, .. } => assert_eq!(project, None),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn resume_without_a_session_takes_the_newest_one_in_the_project() {
        let dir = temp("resume-newest");
        let newest = |provider: &str, project: &str| {
            assert_eq!(provider, "codex");
            assert_eq!(project, dir.to_string_lossy());
            Some("thread-7".to_string())
        };
        let link = format!("klide://resume?provider=codex&project={}", enc(dir.to_str().unwrap()));
        assert_eq!(
            parse_with(&link, sessions(&never, &newest)).unwrap(),
            LinkAction::Resume { provider: "codex".into(), session: "thread-7".into(), project: Some(dir.to_string_lossy().into()) }
        );
        assert!(parse_with(&link, sessions(&never, &none)).unwrap_err().contains("No Codex session"));
        assert!(parse_with("klide://resume?provider=codex", sessions(&never, &never)).unwrap_err().contains("project"));
    }

    #[test]
    fn resume_refuses_what_is_not_a_delegate_session() {
        assert!(parse_with("klide://resume?provider=ollama&session=x", sessions(&none, &none)).unwrap_err().contains("ollama"));
        assert!(parse_with("klide://resume?session=x", sessions(&none, &none)).unwrap_err().contains("provider"));
        let shell = format!("klide://resume?provider=claude-code&session={}", enc("x; rm -rf /"));
        assert!(parse_with(&shell, sessions(&none, &none)).unwrap_err().contains("session id"));
        let long = format!("klide://resume?provider=claude-code&session={}", "a".repeat(MAX_SESSION_CHARS + 1));
        assert!(parse_with(&long, sessions(&none, &none)).is_err());
    }

    #[test]
    fn a_path_without_a_numeric_tail_keeps_its_colon() {
        assert_eq!(split_line("/a/b.rs:12"), ("/a/b.rs", Some(12)));
        assert_eq!(split_line("/a/b:c.rs"), ("/a/b:c.rs", None));
    }
}
