// The Delegate module — owns everything that makes a delegate CLI a Delegate.
//
// A Delegate (CONTEXT.md) is an external CLI agent (Claude Code, Codex,
// OpenCode) dispatched into the workspace through a PTY session. Klide
// observes its output; it does not drive its loop. Each CLI differs in spawn
// syntax, resume flags, and how its sessions are recorded on disk — and ALL
// of that per-CLI knowledge belongs here, behind one interface, one adapter
// per CLI. The PTY plumbing (openpty, reader thread, throttled emit) stays in
// pty.rs; it asks an adapter for the command string and knows nothing else.
//
// The shape mirrors `StreamingProvider` in lib.rs: adapters supply the small
// pieces that differ (flags, prefixes, session-id sniffing); the trait's
// provided method does the assembly once.

mod chat;
mod claude_code;
mod codex;
mod omp;
mod opencode;
mod runs;

pub use chat::run_subscription_chat;
pub use claude_code::ClaudeCode;
pub use codex::Codex;
pub use omp::Omp;
pub use opencode::OpenCode;
pub(crate) use runs::worktree_label;
pub use runs::{AgentRun, RunCandidate, RunMessage};

pub trait Delegate: Sync {
    /// Klide's provider id for this delegate, e.g. "claude-code". This is the
    /// `source` field on every Run the adapter parses.
    fn id(&self) -> &'static str;

    /// The CLI binary name, resolved through the user's login shell PATH.
    fn binary(&self) -> &'static str;

    /// Command prefix for a dispatch. Default: the bare binary (its TUI).
    /// Adapters override when the CLI needs a subcommand to accept a prompt.
    fn spawn_prefix(&self, _has_task: bool, _resuming: bool) -> String {
        self.binary().to_string()
    }

    /// The flag fragment selecting a model, with a leading space — each CLI
    /// spells it differently (`--model` vs `-m`). `model` arrives trimmed
    /// and non-empty.
    fn model_arg(&self, model: &str) -> String;

    /// The fragment continuing a past session, with a leading space.
    /// `session_id` arrives trimmed and non-empty.
    fn resume_arg(&self, session_id: &str) -> String;

    /// Try to pull the CLI's own session id out of early PTY output, so
    /// Mission Control can link the run back to its parent. Most CLIs don't
    /// announce one — the default finds nothing.
    fn extract_session_id(&self, _output: &str) -> Option<String> {
        None
    }

    /// Build the full shell command for a PTY dispatch. Provided once for all
    /// adapters: `{prefix}{resume}{model} {task}`, every value shell-quoted.
    /// Flags are only inserted when the caller actually picked a value, so
    /// each CLI falls back to its own default otherwise.
    fn spawn_command(
        &self,
        task: Option<&str>,
        model: Option<&str>,
        resume_session_id: Option<&str>,
    ) -> String {
        let task = task.map(str::trim).filter(|t| !t.is_empty());
        let model = model.map(str::trim).filter(|m| !m.is_empty());
        let resume = resume_session_id.map(str::trim).filter(|s| !s.is_empty());

        let prefix = self.spawn_prefix(task.is_some(), resume.is_some());
        let resume_arg = resume.map(|id| self.resume_arg(id)).unwrap_or_default();
        let model_arg = model.map(|m| self.model_arg(m)).unwrap_or_default();
        match task {
            Some(t) => format!("{prefix}{resume_arg}{model_arg} {}", shell_quote(t)),
            None => format!("{prefix}{resume_arg}{model_arg}"),
        }
    }

    /// Argument vector for a one-shot headless chat invocation — prompt on
    /// stdin, plain text on stdout (the AI panel's subscription chat path).
    /// Err for CLIs that only work as interactive PTY delegates.
    fn chat_args(&self, cwd: &str, model: &str) -> Result<Vec<String>, String>;

    /// Build the runnable one-shot command: resolve the binary (PATH plus
    /// known install locations), then apply `chat_args`. Resolution comes
    /// first so a missing CLI reports "not installed" rather than the
    /// PTY-only error.
    fn chat_invocation(&self, cwd: &str, model: &str) -> Result<tokio::process::Command, String> {
        let cli = crate::resolve_command(self.binary())?;
        let args = self.chat_args(cwd, model)?;
        let mut command = tokio::process::Command::new(cli);
        command.current_dir(cwd).args(args);
        Ok(command)
    }

    // ── Run listing (Mission Control) ────────────────────────────────────

    /// Every run this delegate has left on disk, as cheap (key, mtime)
    /// candidates. Discovery never parses — the board sorts and pages
    /// candidates from all delegates first, then parses only one page.
    fn discover_runs(&self, home: &str) -> Vec<RunCandidate>;

    /// A parser for this delegate's runs. One is created per page, not per
    /// candidate, so adapters can hold resources that are expensive to open
    /// (OpenCode's SQLite connection, Codex's title index) across the page.
    fn run_parser(&self, home: &str) -> Box<dyn RunParser>;

    /// The run's conversation for the Mission Control detail pane. `key` is
    /// the same value `discover_runs` produced — a transcript path or a
    /// session id, depending on the CLI.
    fn read_run(&self, home: &str, key: &str) -> Result<Vec<RunMessage>, String>;

    // ── Authentication & install (subscription status) ───────────────────
    //
    // How a CLI logs in, how to ask whether it's logged in, and where its
    // binary hides when it isn't on PATH — all per-CLI knowledge, so it lives
    // behind the seam with everything else. `ai_subscription_status` and
    // `resolve_command` in lib.rs ask the adapter; they hold no CLI strings.

    /// Shell commands the user can run to authenticate this CLI, shown when it
    /// is installed but not logged in. Default: none — the CLI needs no login.
    fn login_commands(&self) -> Vec<String> {
        Vec::new()
    }

    /// Whether the CLI is currently authenticated, plus a human detail line.
    /// `command_path` is the resolved binary to invoke. Default: a CLI with no
    /// login is usable as soon as it is installed (OpenCode's posture).
    fn check_auth(&self, _command_path: &str) -> Result<(bool, String), String> {
        Ok((true, format!("{} CLI is installed.", self.binary())))
    }

    /// Absolute paths to probe when the binary isn't found on PATH. `home` is
    /// the user's home dir. Default: none — PATH is expected to be enough.
    fn install_paths(&self, _home: &str) -> Vec<String> {
        Vec::new()
    }
}

/// Parses one delegate's run candidates into board rows. Holding this as a
/// value (rather than a method on the stateless adapter) is what lets each
/// CLI keep per-page state.
pub trait RunParser {
    fn parse(&self, key: &str) -> Option<AgentRun>;
}

/// The registry — one adapter per delegate CLI Klide can dispatch.
pub const ALL: [&dyn Delegate; 4] = [&ClaudeCode, &Codex, &OpenCode, &Omp];

pub fn lookup(provider: &str) -> Option<&'static dyn Delegate> {
    ALL.into_iter().find(|d| d.id() == provider)
}

/// One page of recent runs across every delegate, newest first. Stat-and-sort
/// is cheap; only the requested page (offset..offset+limit) is parsed, so big
/// histories stay fast and the UI can lazily page in older runs.
pub fn list_runs(home: &str, limit: usize, offset: usize) -> Vec<AgentRun> {
    let mut candidates: Vec<(usize, RunCandidate)> = Vec::new();
    for (i, delegate) in ALL.iter().enumerate() {
        for c in delegate.discover_runs(home) {
            candidates.push((i, c));
        }
    }
    candidates.sort_by_key(|(_, c)| std::cmp::Reverse(c.mtime_ms));

    let mut parsers: Vec<Option<Box<dyn RunParser>>> = ALL.iter().map(|_| None).collect();
    let mut runs: Vec<AgentRun> = candidates
        .into_iter()
        .skip(offset)
        .take(limit)
        .filter_map(|(i, c)| {
            parsers[i]
                .get_or_insert_with(|| ALL[i].run_parser(home))
                .parse(&c.key)
        })
        .collect();
    runs.sort_by_key(|r| std::cmp::Reverse(r.updated_ms));
    runs
}

pub(crate) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // The resume-flag matrix is the easiest thing in the app to break by
    // accident — three CLIs, three spellings. These tests pin the exact
    // command strings the PTY runs.

    #[test]
    fn claude_dispatch_with_task_and_model() {
        let cmd = ClaudeCode.spawn_command(Some("fix the bug"), Some("claude-sonnet-4-6"), None);
        assert_eq!(cmd, "claude --model 'claude-sonnet-4-6' 'fix the bug'");
    }

    #[test]
    fn claude_resume() {
        let cmd = ClaudeCode.spawn_command(None, None, Some("abc-123"));
        assert_eq!(cmd, "claude --resume 'abc-123'");
    }

    #[test]
    fn codex_dispatch_with_model() {
        let cmd = Codex.spawn_command(Some("write tests"), Some("gpt-5.4"), None);
        assert_eq!(cmd, "codex -m 'gpt-5.4' 'write tests'");
    }

    #[test]
    fn codex_resume_is_a_subcommand() {
        let cmd = Codex.spawn_command(None, None, Some("sess-9"));
        assert_eq!(cmd, "codex resume 'sess-9'");
    }

    #[test]
    fn opencode_task_gets_run_subcommand() {
        // Bare `opencode '<task>'` treats the arg as a project path and dies;
        // only `run` accepts a message.
        let cmd = OpenCode.spawn_command(Some("add a feature"), Some("minimax-m3"), None);
        assert_eq!(cmd, "opencode run -m 'minimax-m3' 'add a feature'");
    }

    #[test]
    fn opencode_resume_skips_run_even_with_task() {
        // In resume mode the TUI must come up interactive — `run` would make
        // it one-shot. The task still lands as the first prompt.
        let cmd = OpenCode.spawn_command(Some("continue"), None, Some("oss-42"));
        assert_eq!(cmd, "opencode -s 'oss-42' 'continue'");
    }

    #[test]
    fn opencode_without_task_stays_bare_tui() {
        // `opencode run` with no message errors out — no task means no `run`.
        let cmd = OpenCode.spawn_command(None, None, None);
        assert_eq!(cmd, "opencode");
    }

    #[test]
    fn blank_values_are_treated_as_absent() {
        let cmd = ClaudeCode.spawn_command(Some("  "), Some(""), Some(" \t"));
        assert_eq!(cmd, "claude");
    }

    #[test]
    fn task_with_single_quote_is_escaped() {
        let cmd = Codex.spawn_command(Some("don't break"), None, None);
        assert_eq!(cmd, "codex 'don'\\''t break'");
    }

    #[test]
    fn unknown_provider_has_no_adapter() {
        assert!(lookup("gemini-cli").is_none());
    }

    #[test]
    fn login_commands_per_cli() {
        // Same spirit as the resume matrix: these strings are surfaced to the
        // user verbatim and used to drive auth, so pin them.
        assert_eq!(
            ClaudeCode.login_commands(),
            vec![
                "claude auth login --claudeai",
                "claude auth login --console",
                "claude auth login --sso",
                "claude setup-token",
            ]
        );
        assert_eq!(
            Codex.login_commands(),
            vec![
                "codex login",
                "codex login --device-auth",
                "codex login --with-api-key",
                "codex login --with-access-token",
            ]
        );
        assert_eq!(OpenCode.login_commands(), vec!["opencode"]);
        // Omp is not a subscription CLI — the default (no login) applies.
        assert!(Omp.login_commands().is_empty());
    }

    #[test]
    fn install_paths_cover_delegate_binaries() {
        let home = "/home/u";
        assert_eq!(
            ClaudeCode.install_paths(home),
            vec!["/home/u/.local/bin/claude"]
        );
        assert_eq!(
            OpenCode.install_paths(home),
            vec!["/home/u/.opencode/bin/opencode", "/home/u/.local/bin/opencode"]
        );
        assert!(Codex
            .install_paths(home)
            .contains(&"/Applications/Codex.app/Contents/Resources/codex".to_string()));
    }

    #[test]
    fn frontend_delegate_ids_match_all() {
        // The frontend keeps its own copy of the delegate id set in
        // src/delegates.ts (a TypeScript union type can't be produced from a
        // runtime call into Rust). This test is the seam that makes the two
        // lists fail the build if they ever drift apart.
        let ts = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/delegates.ts"),
        )
        .expect("read src/delegates.ts");
        let start = ts.find("DELEGATE_IDS").expect("DELEGATE_IDS in delegates.ts");
        let open = ts[start..].find('[').expect("opening [") + start;
        let close = ts[open..].find(']').expect("closing ]") + open;
        // Split the array literal on quotes; the quoted contents land on the
        // odd indices ("", "claude-code", ", ", "codex", …).
        let mut frontend: Vec<&str> = ts[open + 1..close]
            .split('"')
            .skip(1)
            .step_by(2)
            .collect();
        frontend.sort_unstable();
        let mut backend: Vec<&str> = ALL.iter().map(|d| d.id()).collect();
        backend.sort_unstable();
        assert_eq!(
            backend, frontend,
            "delegate::ALL and src/delegates.ts disagree — update both"
        );
    }

    #[test]
    fn list_runs_merges_sources_and_pages() {
        // One Claude session (file mtime ≈ now) and two OpenCode sessions
        // with ancient explicit timestamps — the board sorts them together,
        // newest first, and parses only the requested page.
        let home = std::env::temp_dir().join("klide-delegate-test-list-runs");
        let _ = std::fs::remove_dir_all(&home);
        let proj = home.join(".claude/projects/-tmp-proj");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::write(
            proj.join("c1.jsonl"),
            r#"{"type":"user","ts":1,"message":{"content":"claude run"}}"#,
        )
        .unwrap();
        let oc = home.join(".local/share/opencode");
        std::fs::create_dir_all(&oc).unwrap();
        let conn = rusqlite::Connection::open(oc.join("opencode.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE session (id TEXT, title TEXT, directory TEXT, model TEXT, \
                 time_updated INTEGER, time_created INTEGER, parent_id TEXT);
             CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
             CREATE TABLE part (id TEXT, session_id TEXT, message_id TEXT, data TEXT, time_created INTEGER);
             INSERT INTO session VALUES ('oss-new', 'newer', '/tmp', NULL, 2000, 2000, NULL);
             INSERT INTO session VALUES ('oss-old', 'older', '/tmp', NULL, 1000, 1000, NULL);",
        )
        .unwrap();

        let home_str = home.to_str().unwrap();
        let page = list_runs(home_str, 2, 0);
        assert_eq!(page.len(), 2);
        assert_eq!(page[0].source, "claude-code");
        assert_eq!(page[1].id, "oss-new");
        let rest = list_runs(home_str, 10, 2);
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].id, "oss-old");
    }

    #[test]
    fn opencode_session_id_from_startup_output() {
        let out = "booting...\nUsing session: oss-abc-123\n";
        assert_eq!(
            OpenCode.extract_session_id(out).as_deref(),
            Some("oss-abc-123")
        );
    }

    #[test]
    fn other_delegates_announce_no_session_id() {
        let out = "Using session: oss-abc-123\n";
        assert_eq!(ClaudeCode.extract_session_id(out), None);
        assert_eq!(Codex.extract_session_id(out), None);
    }
}
