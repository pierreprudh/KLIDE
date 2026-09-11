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
mod chat_stream;
mod claude_code;
mod codex;
mod omp;
mod opencode;
mod runs;
pub mod status;

pub use chat::run_subscription_chat;
pub use claude_code::ClaudeCode;
pub use codex::Codex;
pub use omp::Omp;
pub use opencode::OpenCode;
pub(crate) use runs::{fill_worktree_evidence, retain_candidates_in_workspace, worktree_label};
pub use runs::{AgentRun, RunCandidate, RunMessage};

/// The frontend's "no model picked" sentinel (`DEFAULT_MODELS` in
/// src/agent/providers.ts). A delegate spawned or chatted with this model
/// gets NO model flag, so the CLI falls back to its own configured default —
/// forcing a hardcoded model here was overriding what the user set up in the
/// CLI itself (e.g. Claude Code sessions always opening on Sonnet).
pub const CLI_DEFAULT_MODEL: &str = "default";

/// What one headless turn needs beyond its working directory.
///
/// These arrived one at a time — a model, then a session to resume, then the
/// commands the project has already approved — and a fourth positional
/// argument is where an argument list stops being readable. Grouping them also
/// says the right thing: they are one turn's terms, decided by the caller, and
/// an adapter takes what its CLI can express and ignores the rest.
pub struct ChatSpec<'a> {
    /// Empty means "no model picked" — the adapter omits its model flag so the
    /// CLI uses its own default.
    pub model: &'a str,
    /// A session this conversation already opened, to continue instead of
    /// replacing. See [`Delegate::resumes_sessions`].
    pub resume: Option<&'a str>,
    /// Commands this project has already approved in Klide
    /// (`agent::command_allowlist`), exact or wildcard.
    ///
    /// A delegate runs its own permission layer, and a headless turn has no
    /// terminal to answer it in — so anything outside the CLI's own safe set is
    /// refused outright, with no prompt and no way to say yes. Handing over the
    /// approvals the user already granted is what makes the turn able to work
    /// without widening the posture to "allow everything".
    pub allowed_commands: &'a [String],
}

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

    /// The fragment selecting a reasoning effort, with a leading space, for a
    /// CLI that has such a switch. The default is `None`: most CLIs don't take
    /// one from Klide, and inventing a flag would just make the launch fail.
    /// `level` arrives trimmed, non-empty, and — because the picker is fed by
    /// `models::codex_reasoning_levels` — already one the CLI published.
    fn effort_arg(&self, _level: &str) -> Option<String> {
        None
    }

    /// Try to pull the CLI's own session id out of early PTY output, so
    /// Mission Control can link the run back to its parent. Most CLIs don't
    /// announce one — the default finds nothing.
    fn extract_session_id(&self, _output: &str) -> Option<String> {
        None
    }

    /// Build the full shell command for a PTY dispatch. Provided once for all
    /// adapters: `{prefix}{resume}{model} {task}`, every value shell-quoted.
    /// Flags are only inserted when the caller actually picked a value, so
    /// each CLI falls back to its own default otherwise. The frontend's
    /// [`CLI_DEFAULT_MODEL`] sentinel counts as "no value" — it means "let
    /// the CLI use whatever its own settings choose".
    fn spawn_command(
        &self,
        task: Option<&str>,
        model: Option<&str>,
        resume_session_id: Option<&str>,
        effort: Option<&str>,
    ) -> String {
        let task = task.map(str::trim).filter(|t| !t.is_empty());
        let model = model
            .map(str::trim)
            .filter(|m| !m.is_empty() && !m.eq_ignore_ascii_case(CLI_DEFAULT_MODEL));
        let resume = resume_session_id.map(str::trim).filter(|s| !s.is_empty());
        let effort = effort.map(str::trim).filter(|e| !e.is_empty());

        let prefix = self.spawn_prefix(task.is_some(), resume.is_some());
        let resume_arg = resume.map(|id| self.resume_arg(id)).unwrap_or_default();
        let model_arg = model.map(|m| self.model_arg(m)).unwrap_or_default();
        let effort_arg = effort
            .and_then(|level| self.effort_arg(level))
            .unwrap_or_default();
        match task {
            Some(t) => format!(
                "{prefix}{resume_arg}{model_arg}{effort_arg} {}",
                shell_quote(t)
            ),
            None => format!("{prefix}{resume_arg}{model_arg}{effort_arg}"),
        }
    }

    /// Trim + require a Mission task prompt, or a per-CLI error. Shared by the
    /// `mission_command` impls so each adapter only spells its own flags.
    fn mission_task<'a>(&self, task: Option<&'a str>) -> Result<&'a str, String> {
        task.map(str::trim)
            .filter(|task| !task.is_empty())
            .ok_or_else(|| format!("{} Mission dispatch requires a task prompt.", self.binary()))
    }

    /// The model flag fragment (leading space) for a Mission command, honoring
    /// the [`CLI_DEFAULT_MODEL`] sentinel exactly as `spawn_command` does.
    fn mission_model_arg(&self, model: Option<&str>) -> String {
        model
            .map(str::trim)
            .filter(|model| !model.is_empty() && !model.eq_ignore_ascii_case(CLI_DEFAULT_MODEL))
            .map(|model| self.model_arg(model))
            .unwrap_or_default()
    }

    /// Build a bounded one-shot command for a durable Mission Task. Unlike a
    /// normal Delegate TUI this command must exit after one turn, giving the
    /// Mission supervisor durable settlement evidence. Per-CLI flags stay
    /// behind this seam; process exit still requires explicit operator review
    /// before the Task is accepted.
    fn mission_command(&self, task: Option<&str>, model: Option<&str>) -> Result<String, String> {
        let _ = (task, model);
        Err(format!(
            "{} does not support one-shot Mission dispatch.",
            self.binary()
        ))
    }

    /// Argument vector for a one-shot headless chat invocation — prompt on
    /// stdin, plain text on stdout (the AI panel's subscription chat path).
    /// `model` may be empty — then the adapter must omit its model flag so
    /// the CLI uses its own default. Err for CLIs that only work as
    /// interactive PTY delegates.
    fn chat_args(&self, cwd: &str, model: &str) -> Result<Vec<String>, String>;

    /// Build the runnable one-shot command: resolve the binary (PATH plus
    /// known install locations), then apply `chat_args`. Resolution comes
    /// first so a missing CLI reports "not installed" rather than the
    /// PTY-only error.
    fn chat_invocation(&self, cwd: &str, model: &str) -> Result<tokio::process::Command, String> {
        let cli = crate::cli::resolve_command(self.binary())?;
        let args = self.chat_args(cwd, model)?;
        let mut command = tokio::process::Command::new(cli);
        command.current_dir(cwd).args(args);
        Ok(command)
    }

    /// Args for a headless turn that reports its own work line by line, when
    /// this CLI can (`claude --output-format stream-json`). `None` means "prose
    /// only" and the caller falls back to [`Delegate::chat_args`], so a CLI
    /// without a structured mode keeps working — it just shows no tool rows.
    ///
    /// `spec.resume` is a session id this CLI reported earlier (as
    /// [`StreamItem::Session`](chat_stream::StreamItem::Session)) for the same
    /// conversation. When it is `Some`, the adapter must continue that session
    /// rather than open a new one — that is what lets the caller send only the
    /// newest message instead of re-folding the whole transcript into every
    /// turn. An adapter that cannot resume ignores it and keeps working; the
    /// caller re-sends the full history whenever no adapter took the id.
    fn chat_stream_args(&self, _cwd: &str, _spec: &ChatSpec) -> Option<Vec<String>> {
        None
    }

    /// Whether [`Delegate::chat_stream_args`] honours a `resume` id. The runner
    /// asks *before* building the prompt, because the answer decides what the
    /// prompt is: a resuming turn sends one message, a fresh one sends the
    /// whole conversation. Answering `true` while ignoring the id would drop
    /// every earlier turn on the floor.
    fn resumes_sessions(&self) -> bool {
        false
    }

    /// Read one line of this CLI's structured stream into the shared
    /// [`StreamItem`](chat_stream::StreamItem) vocabulary.
    ///
    /// Each CLI has its own dialect — Claude Code splits a call and its result
    /// across two Anthropic-shaped lines, OpenCode packs both into one event
    /// keyed by `callID` — and that knowledge belongs to the adapter, not to a
    /// switch in the runner. The default reads nothing, which is correct for a
    /// CLI with no structured mode: it never gets called, because
    /// [`Delegate::chat_stream_args`] returned `None`.
    ///
    /// An unrecognised or malformed line must yield no items rather than an
    /// error — a new line type in a future release must not fail a turn.
    fn parse_stream_line(&self, _line: &str) -> Vec<chat_stream::StreamItem> {
        Vec::new()
    }

    /// The structured-stream twin of [`Delegate::chat_invocation`]. `None` when
    /// this CLI has no structured mode; `Some(Err)` when it has one but the
    /// binary could not be resolved.
    fn chat_stream_invocation(
        &self,
        cwd: &str,
        spec: &ChatSpec,
    ) -> Option<Result<tokio::process::Command, String>> {
        let args = self.chat_stream_args(cwd, spec)?;
        Some(crate::cli::resolve_command(self.binary()).map(|cli| {
            let mut command = tokio::process::Command::new(cli);
            command.current_dir(cwd).args(args);
            command
        }))
    }

    // ── Run listing (Mission Control) ────────────────────────────────────

    /// Every run this delegate has left on disk, as cheap (key, mtime)
    /// candidates. Discovery never parses — the board sorts and pages
    /// candidates from all delegates first, then parses only one page.
    fn discover_runs(&self, home: &str) -> Vec<RunCandidate>;

    /// The candidates that could belong to `workspace_root`, narrowed as cheaply
    /// as this CLI's storage layout allows. Discovery owns this because only the
    /// adapter knows where the answer is stored — a column, a directory name, a
    /// transcript header.
    ///
    /// The contract is one-sided: over-including is fine (the caller confirms
    /// every parsed run's real `cwd`), but dropping a candidate that does belong
    /// to the workspace makes the run vanish from the board. When in doubt, keep.
    ///
    /// The default probes each transcript's head for its `cwd`, which is where
    /// all three JSONL delegates record it.
    fn discover_runs_for_workspace(&self, home: &str, workspace_root: &str) -> Vec<RunCandidate> {
        retain_candidates_in_workspace(self.discover_runs(home), workspace_root)
    }

    /// A parser for this delegate's runs. One is created per page, not per
    /// candidate, so adapters can hold resources that are expensive to open
    /// (OpenCode's SQLite connection, Codex's title index) across the page.
    fn run_parser(&self, home: &str) -> Box<dyn RunParser>;

    /// A stamp of every input to `run_parser` *other than the transcript itself*
    /// — `0` when there is none. The run memo keys a remembered parse on the
    /// transcript's mtime and length plus this, so a sidecar that changes on its
    /// own (Codex's title index) still invalidates it.
    fn parse_inputs_stamp(&self, _home: &str) -> u64 {
        0
    }

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

    /// Install (or refresh) this CLI's Klide status hooks — env-guarded
    /// lifecycle hooks in the CLI's own config that POST normalized state to
    /// Klide's loopback hook server (see `status.rs`). Called before every
    /// PTY dispatch; must be idempotent. Returns whether anything was
    /// written. Default: the CLI has no hook mechanism — do nothing.
    fn ensure_status_hooks(&self, _home: &str) -> Result<bool, String> {
        Ok(false)
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
    list_runs_matching(home, limit, offset, None)
}

/// One page of recent runs constrained to a workspace. Unlike frontend
/// filtering after `list_runs`, this pages AFTER matching, so a busy different
/// project cannot push older current-workspace runs out of the first page.
pub fn list_runs_for_workspace(
    home: &str,
    limit: usize,
    offset: usize,
    workspace_root: &str,
) -> Vec<AgentRun> {
    list_runs_matching(home, limit, offset, Some(workspace_root))
}

pub(crate) fn normalize_path(path: &str) -> String {
    path.trim().trim_end_matches('/').to_string()
}

/// How many candidates a single page may parse and then discard as
/// not-this-workspace before the scan gives up.
///
/// `discover_runs_for_workspace` should have narrowed the set already, so misses
/// here are the cost of an adapter that couldn't answer cheaply. This bound is
/// what keeps that fallback from degenerating into "parse every log on disk":
/// a project with fewer runs than a page holds never satisfies the `limit`
/// break, so without a ceiling the loop walks the entire history — the exact
/// shape that froze the board on a newly-opened project.
const MAX_WORKSPACE_MISSES: usize = 128;

fn run_matches_workspace(run: &AgentRun, workspace_root: &str) -> bool {
    run.cwd
        .as_deref()
        .map(normalize_path)
        .is_some_and(|cwd| cwd == normalize_path(workspace_root))
}

/// Parsed runs remembered per transcript file (file_memo.rs). Mission Control
/// re-lists every 7.5 s and a page re-parses from candidate zero to honour
/// `offset`; with the memo both are a stat per candidate, and only a transcript
/// that moved since the last tick is read again. OpenCode keys are session ids,
/// not paths — the memo computes those uncached, exactly as before.
static PARSED_RUNS: crate::file_memo::FileMemo<Option<AgentRun>> = crate::file_memo::FileMemo::new();

fn list_runs_matching(
    home: &str,
    limit: usize,
    offset: usize,
    workspace_root: Option<&str>,
) -> Vec<AgentRun> {
    let stamps: Vec<u64> = ALL.iter().map(|d| d.parse_inputs_stamp(home)).collect();
    let mut candidates: Vec<(usize, RunCandidate)> = Vec::new();
    for (i, delegate) in ALL.iter().enumerate() {
        let found = match workspace_root {
            Some(root) => delegate.discover_runs_for_workspace(home, root),
            None => delegate.discover_runs(home),
        };
        for c in found {
            candidates.push((i, c));
        }
    }
    candidates.sort_by_key(|(_, c)| std::cmp::Reverse(c.mtime_ms));

    let mut parsers: Vec<Option<Box<dyn RunParser>>> = ALL.iter().map(|_| None).collect();
    let mut runs: Vec<AgentRun> = Vec::new();
    let mut matched = 0usize;
    let mut misses = 0usize;
    for (i, c) in candidates {
        let Some(run) = PARSED_RUNS.get_or_compute(std::path::Path::new(&c.key), stamps[i], |_| {
            parsers[i]
                .get_or_insert_with(|| ALL[i].run_parser(home))
                .parse(&c.key)
        }) else {
            continue;
        };
        if let Some(root) = workspace_root {
            if !run_matches_workspace(&run, root) {
                misses += 1;
                if misses >= MAX_WORKSPACE_MISSES {
                    break;
                }
                continue;
            }
        }
        if matched < offset {
            matched += 1;
            continue;
        }
        runs.push(run);
        matched += 1;
        if runs.len() >= limit {
            break;
        }
    }
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
        let cmd = ClaudeCode.spawn_command(Some("fix the bug"), Some("claude-sonnet-4-6"), None, None);
        assert_eq!(cmd, "claude --model 'claude-sonnet-4-6' 'fix the bug'");
    }

    #[test]
    fn claude_resume() {
        let cmd = ClaudeCode.spawn_command(None, None, Some("abc-123"), None);
        assert_eq!(cmd, "claude --resume 'abc-123'");
    }

    #[test]
    fn codex_dispatch_with_model() {
        let cmd = Codex.spawn_command(Some("write tests"), Some("gpt-5.4"), None, None);
        assert_eq!(cmd, "codex -m 'gpt-5.4' 'write tests'");
    }

    #[test]
    fn only_codex_takes_a_reasoning_effort() {
        // Codex has no effort flag: `-c key=value` overrides one config key
        // for this launch, which is how the picker's choice reaches the CLI
        // without rewriting the user's ~/.codex/config.toml.
        let cmd = Codex.spawn_command(Some("write tests"), Some("gpt-6-astra"), None, Some("high"));
        assert_eq!(
            cmd,
            "codex -m 'gpt-6-astra' -c model_reasoning_effort='high' 'write tests'"
        );
        // Every other CLI takes no such switch, so a level that reaches them
        // (a stale per-model setting, say) must not invent a flag.
        for cmd in [
            ClaudeCode.spawn_command(Some("t"), None, None, Some("high")),
            OpenCode.spawn_command(Some("t"), None, None, Some("high")),
            Omp.spawn_command(Some("t"), None, None, Some("high")),
        ] {
            assert!(!cmd.contains("high"), "{cmd}");
        }
    }

    #[test]
    fn codex_resume_is_a_subcommand() {
        let cmd = Codex.spawn_command(None, None, Some("sess-9"), None);
        assert_eq!(cmd, "codex resume 'sess-9'");
    }

    #[test]
    fn opencode_task_gets_run_subcommand() {
        // Bare `opencode '<task>'` treats the arg as a project path and dies;
        // only `run` accepts a message.
        let cmd = OpenCode.spawn_command(Some("add a feature"), Some("minimax-m3"), None, None);
        assert_eq!(cmd, "opencode run -m 'minimax-m3' 'add a feature'");
    }

    #[test]
    fn opencode_resume_skips_run_even_with_task() {
        // In resume mode the TUI must come up interactive — `run` would make
        // it one-shot. The task still lands as the first prompt.
        let cmd = OpenCode.spawn_command(Some("continue"), None, Some("oss-42"), None);
        assert_eq!(cmd, "opencode -s 'oss-42' 'continue'");
    }

    #[test]
    fn opencode_without_task_stays_bare_tui() {
        // `opencode run` with no message errors out — no task means no `run`.
        let cmd = OpenCode.spawn_command(None, None, None, None);
        assert_eq!(cmd, "opencode");
    }

    #[test]
    fn blank_values_are_treated_as_absent() {
        let cmd = ClaudeCode.spawn_command(Some("  "), Some(""), Some(" \t"), None);
        assert_eq!(cmd, "claude");
    }

    #[test]
    fn mission_commands_are_one_shot_and_keep_cli_flags_behind_adapters() {
        assert_eq!(
            ClaudeCode
                .mission_command(Some("fix the bug"), Some("claude-sonnet-4-6"))
                .unwrap(),
            "claude -p --model 'claude-sonnet-4-6' --permission-mode acceptEdits --output-format text 'fix the bug'"
        );
        assert_eq!(
            Codex
                .mission_command(Some("fix the bug"), Some("gpt-5.4"))
                .unwrap(),
            "codex exec -m 'gpt-5.4' -s workspace-write --skip-git-repo-check --color never 'fix the bug'"
        );
        assert_eq!(
            OpenCode
                .mission_command(Some("fix the bug"), Some("opencode/minimax-m3"))
                .unwrap(),
            "opencode run -m 'opencode/minimax-m3' 'fix the bug'"
        );
        assert_eq!(
            Omp.mission_command(Some("fix the bug"), Some("default"))
                .unwrap(),
            "omp -p --auto-approve --mode text 'fix the bug'"
        );
    }

    #[test]
    fn default_model_sentinel_omits_the_model_flag() {
        // "default" means "the CLI's own configured default" — forcing a
        // --model here would override what the user set up in the CLI.
        let cmd = ClaudeCode.spawn_command(Some("fix the bug"), Some("default"), None, None);
        assert_eq!(cmd, "claude 'fix the bug'");
        let cmd = Codex.spawn_command(None, Some("Default"), None, None);
        assert_eq!(cmd, "codex");
    }

    #[test]
    fn task_with_single_quote_is_escaped() {
        let cmd = Codex.spawn_command(Some("don't break"), None, None, None);
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
        // omp has no login command — keys ride the shell environment; the
        // "login option" is launching the TUI itself (OpenCode's posture).
        assert_eq!(Omp.login_commands(), vec!["omp"]);
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
            vec![
                "/home/u/.opencode/bin/opencode",
                "/home/u/.local/bin/opencode"
            ]
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
        let start = ts
            .find("DELEGATE_IDS")
            .expect("DELEGATE_IDS in delegates.ts");
        let open = ts[start..].find('[').expect("opening [") + start;
        let close = ts[open..].find(']').expect("closing ]") + open;
        // Split the array literal on quotes; the quoted contents land on the
        // odd indices ("", "claude-code", ", ", "codex", …).
        let mut frontend: Vec<&str> = ts[open + 1..close].split('"').skip(1).step_by(2).collect();
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
    fn a_repeated_listing_parses_each_transcript_once() {
        let home = std::env::temp_dir().join("klide-delegate-test-run-memo");
        let _ = std::fs::remove_dir_all(&home);
        let proj = home.join(".claude/projects/-tmp-proj");
        std::fs::create_dir_all(&proj).unwrap();
        let log = proj.join("c1.jsonl");
        std::fs::write(
            &log,
            r#"{"type":"user","ts":1,"message":{"content":"claude run"}}"#,
        )
        .unwrap();
        let home_str = home.to_str().unwrap();

        let first = list_runs(home_str, 10, 0);
        assert_eq!(first.len(), 1);
        let again = list_runs(home_str, 10, 0);
        assert_eq!(again.len(), 1);
        assert_eq!(
            PARSED_RUNS.computes_for(&log),
            1,
            "an unchanged transcript is parsed once across listings"
        );

        // The session continues: the file grows, and the next listing sees it.
        std::thread::sleep(std::time::Duration::from_millis(20));
        let mut text = std::fs::read_to_string(&log).unwrap();
        text.push_str("\n{\"type\":\"assistant\",\"ts\":2,\"message\":{\"content\":\"done\"}}");
        std::fs::write(&log, text).unwrap();
        let grown = list_runs(home_str, 10, 0);
        assert_eq!(PARSED_RUNS.computes_for(&log), 2, "a changed transcript is parsed again");
        assert!(grown[0].message_count > first[0].message_count);
    }

    #[test]
    fn list_runs_for_workspace_pages_after_filtering() {
        let home = std::env::temp_dir().join("klide-delegate-test-scoped-runs");
        let workspace = std::env::temp_dir().join("klide-delegate-test-scoped-workspace");
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&workspace);
        std::fs::create_dir_all(&workspace).unwrap();

        let proj = home.join(".claude/projects/-tmp-klide-delegate-test-scoped-workspace");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::write(
            proj.join("c-scoped.jsonl"),
            format!(
                r#"{{"type":"user","ts":1,"cwd":"{}","message":{{"content":"scoped claude run"}}}}"#,
                workspace.to_string_lossy()
            ),
        )
        .unwrap();

        let oc = home.join(".local/share/opencode");
        std::fs::create_dir_all(&oc).unwrap();
        let conn = rusqlite::Connection::open(oc.join("opencode.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE session (id TEXT, title TEXT, directory TEXT, model TEXT, \
                 time_updated INTEGER, time_created INTEGER, parent_id TEXT);
             CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
             CREATE TABLE part (id TEXT, session_id TEXT, message_id TEXT, data TEXT, time_created INTEGER);",
        )
        .unwrap();
        for i in 0..25 {
            conn.execute(
                "INSERT INTO session VALUES (?1, ?2, '/tmp/not-kide', NULL, ?3, ?3, NULL)",
                (
                    format!("oss-{i}"),
                    format!("other {i}"),
                    2_000_000_000_000i64 - i,
                ),
            )
            .unwrap();
        }

        let home_str = home.to_str().unwrap();
        let global_first_page = list_runs(home_str, 20, 0);
        assert!(
            global_first_page.iter().all(|r| r.source != "claude-code"),
            "the old global-first page would miss the KIDE Claude run"
        );

        let scoped = list_runs_for_workspace(home_str, 20, 0, workspace.to_str().unwrap());
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].id, "c-scoped");
        assert_eq!(scoped[0].source, "claude-code");
        assert_eq!(scoped[0].cwd.as_deref(), workspace.to_str());

        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&workspace);
    }

    /// The bug this pins: matching a workspace used to require a *full parse* of
    /// every candidate, because `cwd` only appears after parsing. A project with
    /// fewer runs than a page holds never satisfies the `limit` break, so opening
    /// the board on a fresh project walked the entire on-disk history — hundreds
    /// of megabytes — to find nothing. Narrowing at discovery is what fixes it.
    #[test]
    fn workspace_discovery_narrows_before_parsing() {
        let home = std::env::temp_dir().join("klide-delegate-test-narrowing");
        let workspace = std::env::temp_dir().join("klide-delegate-test-narrow-ws");
        let _ = std::fs::remove_dir_all(&home);
        let proj = home.join(".claude/projects/-tmp-narrow");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::write(
            proj.join("mine.jsonl"),
            format!(
                r#"{{"type":"user","ts":1,"cwd":"{}","message":{{"content":"mine"}}}}"#,
                workspace.to_string_lossy()
            ),
        )
        .unwrap();
        for i in 0..50 {
            std::fs::write(
                proj.join(format!("other-{i}.jsonl")),
                r#"{"type":"user","ts":1,"cwd":"/tmp/some-other-project","message":{"content":"x"}}"#,
            )
            .unwrap();
        }

        let home_str = home.to_str().unwrap();
        assert_eq!(ClaudeCode.discover_runs(home_str).len(), 51);
        let narrowed =
            ClaudeCode.discover_runs_for_workspace(home_str, workspace.to_str().unwrap());
        assert_eq!(
            narrowed.len(),
            1,
            "the 50 other-project transcripts must be dropped before anyone parses them"
        );
        assert!(narrowed[0].key.ends_with("mine.jsonl"));

        let _ = std::fs::remove_dir_all(&home);
    }

    /// The narrowing contract is one-sided on purpose: a candidate whose cwd
    /// isn't cheaply readable must survive, or a run silently vanishes from the
    /// board. Over-including only costs one parse.
    #[test]
    fn narrowing_keeps_candidates_whose_cwd_is_not_cheaply_readable() {
        let home = std::env::temp_dir().join("klide-delegate-test-narrow-unknown");
        let _ = std::fs::remove_dir_all(&home);
        let proj = home.join(".claude/projects/-tmp-unknown");
        std::fs::create_dir_all(&proj).unwrap();
        // No cwd anywhere in the head — the pre-filter can't judge this one.
        std::fs::write(
            proj.join("headless.jsonl"),
            "{\"type\":\"summary\"}\n{\"type\":\"user\",\"message\":{\"content\":\"hi\"}}\n",
        )
        .unwrap();
        // cwd present but JSON-escaped — we refuse to decode escapes by hand.
        std::fs::write(
            proj.join("escaped.jsonl"),
            r#"{"type":"user","cwd":"/tmp/od\\d","message":{"content":"hi"}}"#,
        )
        .unwrap();

        let kept = ClaudeCode.discover_runs_for_workspace(home.to_str().unwrap(), "/tmp/anything");
        assert_eq!(kept.len(), 2, "unknown cwd must not exclude a candidate");

        let _ = std::fs::remove_dir_all(&home);
    }

    /// OpenCode stores the workspace as a column, so it narrows in SQL — and the
    /// same keep-when-unknown rule applies to a NULL directory.
    #[test]
    fn opencode_narrows_in_sql_and_keeps_unknown_directories() {
        let home = std::env::temp_dir().join("klide-delegate-test-oc-narrow");
        let _ = std::fs::remove_dir_all(&home);
        let oc = home.join(".local/share/opencode");
        std::fs::create_dir_all(&oc).unwrap();
        let conn = rusqlite::Connection::open(oc.join("opencode.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE session (id TEXT, title TEXT, directory TEXT, model TEXT, \
                 time_updated INTEGER, time_created INTEGER, parent_id TEXT);
             INSERT INTO session VALUES ('oss-mine', 'mine', '/tmp/ws', NULL, 3000, 3000, NULL);
             INSERT INTO session VALUES ('oss-slash', 'mine', '/tmp/ws/', NULL, 2500, 2500, NULL);
             INSERT INTO session VALUES ('oss-other', 'other', '/tmp/elsewhere', NULL, 2000, 2000, NULL);
             INSERT INTO session VALUES ('oss-null', 'unknown', NULL, NULL, 1000, 1000, NULL);",
        )
        .unwrap();

        let mut ids: Vec<String> = OpenCode
            .discover_runs_for_workspace(home.to_str().unwrap(), "/tmp/ws")
            .into_iter()
            .map(|c| c.key)
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["oss-mine", "oss-null", "oss-slash"]);

        let _ = std::fs::remove_dir_all(&home);
    }

    /// The backstop, stated as behaviour: once a page has parsed and discarded
    /// `MAX_WORKSPACE_MISSES` candidates it stops rather than walking the rest of
    /// the history. This *can* truncate a page — that is the accepted trade for
    /// never freezing the board when an adapter can't narrow cheaply.
    #[test]
    fn workspace_scan_stops_after_too_many_misses() {
        let home = std::env::temp_dir().join("klide-delegate-test-miss-ceiling");
        let _ = std::fs::remove_dir_all(&home);
        let proj = home.join(".claude/projects/-tmp-misses");
        std::fs::create_dir_all(&proj).unwrap();
        // Each decoy hides its cwd from the pre-filter, so it survives narrowing
        // and is only rejected after a full parse — a miss.
        let decoys = MAX_WORKSPACE_MISSES + 20;
        for i in 0..decoys {
            std::fs::write(
                proj.join(format!("decoy-{i:04}.jsonl")),
                "{\"type\":\"user\",\"message\":{\"content\":\"no cwd here\"}}\n",
            )
            .unwrap();
        }

        let scoped = list_runs_for_workspace(home.to_str().unwrap(), 20, 0, "/tmp/never-matches");
        assert!(scoped.is_empty());

        let _ = std::fs::remove_dir_all(&home);
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
