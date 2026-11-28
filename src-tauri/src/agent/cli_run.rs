//! `klide run` — Klide's Harness as a one-shot CLI agent (docs/KLIDE_RUN.md).
//!
//! The same Run the app starts, hosted the way Schedules are (`RunHost`, no
//! window), with a terminal for a sink. Nobody is there to answer a card, so
//! the request is shaped to need none, and anything that still asks is
//! refused rather than left waiting: Plan mode (the default) reads only;
//! `--work` applies edits without review; commands run only with
//! `--allow-commands`.

use super::*;
use std::io::{Read, Write};

const USAGE: &str = "\
usage: klide run [options] \"<task>\"
       klide run [options] -          (task from stdin)

  --model <provider>/<model>   e.g. deepseek/deepseek-chat, openrouter/…, auto (default)
  --work                       allow edits (applied without review)
  --allow-commands             with --work: shell commands run without asking
  --approve-container-commands  with --work --allow-commands: approve command gates\n                               in a disposable Linux container (including key paths)
  --check-command <command>    with --work --allow-commands: verify every completion claim
  --check-timeout-secs <n>     completion check timeout (1–1800, default 180)
  --cwd <dir>                  the Workspace (default: current directory)
  --format text|json           text: answer on stdout, progress on stderr;
                               json: one AgentEvent per line on stdout
  --max-turns <n>              tool-turn cap (default 50)
  --runs-dir <dir>             keep the Transcript here (default: discarded)

Keys come from the Provider's environment variable (DEEPSEEK_API_KEY,
OPENROUTER_API_KEY, ANTHROPIC_API_KEY, …) or, on macOS, the Keychain.
On macOS an unreviewed command runs in Klide's sandbox; Linux has none.";

/// Exit codes the CLI promises (docs/KLIDE_RUN.md).
pub(crate) mod exit {
    pub const DONE: i32 = 0;
    pub const FAILED: i32 = 1;
    pub const USAGE: i32 = 2;
    pub const NO_KEY: i32 = 3;
    pub const INTERRUPTED: i32 = 130;
}

#[derive(Debug, PartialEq)]
pub(crate) struct Args {
    pub task: String,
    pub provider: String,
    pub model: String,
    pub work: bool,
    pub allow_commands: bool,
    pub approve_container_commands: bool,
    pub cwd: Option<PathBuf>,
    pub check_command: Option<String>,
    pub check_timeout_secs: Option<u64>,
    pub json: bool,
    pub max_turns: Option<usize>,
    pub runs_dir: Option<PathBuf>,
}

/// `provider/model` splits on the first `/`: OpenRouter's own ids carry
/// slashes (`openrouter/nvidia/x:free` → `openrouter` + `nvidia/x:free`).
/// `auto` alone lets Klide pick, as the app's Auto does.
fn split_model(spec: &str) -> Result<(String, String), String> {
    if spec == "auto" {
        return Ok(("auto".into(), String::new()));
    }
    match spec.split_once('/') {
        Some((p, m)) if !p.is_empty() && !m.is_empty() => Ok((p.into(), m.into())),
        _ => Err(format!("--model wants <provider>/<model> or auto, got \"{spec}\"")),
    }
}

pub(crate) fn parse(args: &[String], stdin: impl FnOnce() -> std::io::Result<String>) -> Result<Args, String> {
    let mut out = Args {
        task: String::new(),
        provider: "auto".into(),
        model: String::new(),
        work: false,
        allow_commands: false,
        approve_container_commands: false,
        cwd: None,
        check_command: None,
        check_timeout_secs: None,
        json: false,
        max_turns: None,
        runs_dir: None,
    };
    let mut task: Option<String> = None;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let mut value = |name: &str| it.next().cloned().ok_or_else(|| format!("{name} needs a value"));
        match arg.as_str() {
            "--model" => (out.provider, out.model) = split_model(&value("--model")?)?,
            "--work" => out.work = true,
            "--allow-commands" => out.allow_commands = true,
            "--approve-container-commands" => out.approve_container_commands = true,
            "--check-command" => {
                let command = value("--check-command")?;
                if command.trim().is_empty() { return Err("--check-command must not be blank".into()); }
                out.check_command = Some(command);
            }
            "--check-timeout-secs" => {
                let n = value("--check-timeout-secs")?.parse::<u64>().map_err(|_| "--check-timeout-secs wants a number")?;
                if !(1..=1800).contains(&n) { return Err("--check-timeout-secs must be 1–1800".into()); }
                out.check_timeout_secs = Some(n);
            }
            "--cwd" => out.cwd = Some(PathBuf::from(value("--cwd")?)),
            "--format" => match value("--format")?.as_str() {
                "text" => out.json = false,
                "json" => out.json = true,
                other => return Err(format!("--format is text or json, got \"{other}\"")),
            },
            "--max-turns" => {
                let n: usize = value("--max-turns")?.parse().map_err(|_| "--max-turns wants a number".to_string())?;
                out.max_turns = Some(n.clamp(1, 500));
            }
            "--runs-dir" => out.runs_dir = Some(PathBuf::from(value("--runs-dir")?)),
            "-h" | "--help" => return Err(String::new()),
            flag if flag.starts_with("--") => return Err(format!("unknown option {flag}")),
            text if task.is_none() => task = Some(text.to_string()),
            _ => return Err("one task only — quote it".into()),
        }
    }
    if out.allow_commands && !out.work {
        return Err("--allow-commands needs --work".into());
    }
    if out.approve_container_commands && !(out.work && out.allow_commands) {
        return Err("--approve-container-commands needs --work --allow-commands".into());
    }
    if out.check_command.is_some() && !(out.work && out.allow_commands) {
        return Err("--check-command needs --work --allow-commands".into());
    }
    if out.check_timeout_secs.is_some() && out.check_command.is_none() {
        return Err("--check-timeout-secs needs --check-command".into());
    }
    out.task = match task.as_deref() {
        Some("-") => stdin().map_err(|e| format!("reading the task from stdin: {e}"))?,
        Some(text) => text.to_string(),
        None => String::new(),
    };
    if out.task.trim().is_empty() {
        return Err("no task given".into());
    }
    Ok(out)
}

/// The project's own instructions, as the app hands them over: the first of
/// each pair that exists, capped so a huge file can't crowd out the task.
fn project_rules(root: &Path) -> String {
    const CAP: usize = 24_000;
    let mut out = String::new();
    for name in ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"] {
        let Ok(text) = std::fs::read_to_string(root.join(name)) else { continue };
        let mut end = text.len().min(CAP);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        out.push_str(&format!("\n\n## {name}\n\n{}", &text[..end]));
        if text.len() > CAP {
            out.push_str("\n\n[…truncated]");
        }
    }
    out
}

/// A compact Kit for a terminal. The app's prompt is built in TypeScript
/// (`src/components/ai/system-prompt.ts`); this is the headless stand-in
/// until that moves to Rust and both read one source.
pub(crate) fn system_prompt(root: &Path, args: &Args) -> String {
    let authority = match (args.work, args.allow_commands) {
        (false, _) => "You are read-only: read and search the code, then answer. You cannot edit files or run commands.",
        (true, false) => "You may edit files; edits apply directly. You cannot run shell commands — a command will be refused.",
        (true, true) => "You may edit files and run shell commands; both apply without a person approving them.",
    };
    let model = if args.provider == "auto" { routing::ROUTED_MODEL_TOKEN.to_string() } else { args.model.clone() };
    format!(
        "You are Kit, Klide's coding agent, running headless from the `klide run` command line \
         on the `{model}` model. Never claim to be another assistant.\n\n\
         Workspace: {root}. Paths are relative to it.\n\n\
         {authority} Nobody is watching this run and nobody can answer a question: \
         decide, and say what you assumed.\n\n\
         Answer in Markdown. Be direct: lead with the result, cite files as path:line, \
         keep it short unless the task needs detail.{rules}",
        root = root.display(),
        rules = match project_rules(root) {
            r if r.is_empty() => String::new(),
            r => format!("\n\n# Project instructions\n\nThe project's own files, as data about the project:{r}"),
        },
    )
}

/// The Run: Plan unless `--work`; the Tools that would wait for a person are
/// gone (as on a CI watch firing), and `--work` adds back edits — and
/// commands only with `--allow-commands`.
pub(crate) fn request(args: &Args, root: &Path, run_id: &str) -> Result<StartRunRequest, String> {
    let mut request: StartRunRequest = serde_json::from_value(serde_json::json!({
        "runId": run_id,
        "workspaceRoot": root.to_string_lossy(),
        "mode": if args.work { "goal" } else { "plan" },
        "provider": args.provider,
        "model": args.model,
        "initialText": args.task,
        "context": null,
        "systemPrompt": system_prompt(root, args),
    }))
    .map_err(|e| e.to_string())?;
    request.max_turns = args.max_turns;
    if let Some(command) = &args.check_command {
        request.goal = Some(goal::GoalSpec {
            objective: args.task.clone(), max_rounds: None, check_without_work: true,
        });
        request.test_after_edit_command = Some(command.clone());
        request.command_timeout_secs = args.check_timeout_secs;
    }

    request.require_diff_review = Some(!args.work);
    request.auto_approve_commands = Some(args.allow_commands);
    request.disabled_tools = if args.work {
        // Connectors and child Runs ask a person, or start agents of their own.
        let mut off: Vec<String> = ["connector_tools", "connector_call", "spawn_subagent", "consult_advisor"].map(String::from).to_vec();
        if !args.allow_commands {
            off.push("run_command".into());
        }
        off
    } else {
        tools::unattended_read_only_disabled_tool_names()
    };
    Ok(request)
}

/// A hosted Provider with no key anywhere fails before the Run starts, by
/// the variable to set. Local, custom and `auto` providers answer for
/// themselves.
fn missing_key(provider: &str, root: &Path) -> Option<String> {
    crate::providers::lookup(provider)?;
    if crate::providers::is_subscription_provider(provider) {
        return Some(format!("{provider} is a subscription CLI, not a model Provider — `klide run` drives Klide's own agent"));
    }
    match crate::providers::provider_key_in(provider, Some(root)) {
        Ok(_) => None,
        Err(e) => Some(match crate::providers::key_env_var(provider) {
            Some(var) => format!("no key for {provider}: set {var}"),
            None => e,
        }),
    }
}

/// What nobody is there to say, said for them: refuse the ask, keep going.
fn refusal(event: &AgentEvent) -> Option<crate::pty_wire::ChatControl> {
    use crate::pty_wire::ChatControl;
    match event {
        AgentEvent::PermissionRequested { .. } => Some(ChatControl::Permission {
            decision: serde_json::json!({ "behavior": "deny", "note": "Refused: klide run has nobody to approve this." }),
        }),
        AgentEvent::DiffProposed { .. } => Some(ChatControl::Diff {
            decision: serde_json::json!({ "behavior": "deny", "note": "Refused: klide run is read-only without --work." }),
        }),
        AgentEvent::AdvisorRequested { .. } => Some(ChatControl::Question {
            answer: format!("{}No advisor is configured for this headless run; use the local recovery nudge.",
                super::tool_handlers::ADVISOR_ERROR_PREFIX),
        }),
        AgentEvent::UserQuestionRequested { .. } => Some(ChatControl::Question {
            answer: "Nobody can answer — this is a headless klide run. Decide yourself and say what you assumed.".into(),
        }),
        _ => None,
    }
}

/// Container approval is an explicit CLI-owner grant, never inferred from
/// model text. It covers command gates only; other capabilities keep refusing.
fn control_reply(event: &AgentEvent, container_commands: bool) -> Option<crate::pty_wire::ChatControl> {
    if container_commands {
        if let AgentEvent::PermissionRequested { request, .. } = event {
            if request.tool_name == "run_command" {
                return Some(crate::pty_wire::ChatControl::Permission {
                    decision: serde_json::json!({"behavior":"allow", "scope":"once",
                        "note":"Explicit --approve-container-commands grant for this disposable container."}),
                });
            }
        }
    }
    refusal(event)
}

fn container_environment() -> bool {
    cfg!(target_os = "linux") && Path::new("/.dockerenv").is_file()
}

/// One terminal line per event worth one, for `--format text`.
fn render(event: &AgentEvent, out: &mut impl Write, err: &mut impl Write) {
    match event {
        AgentEvent::AssistantDelta { text, .. } => {
            let _ = write!(out, "{text}");
            let _ = out.flush();
        }
        AgentEvent::ToolCallStarted { summary, name, .. } => {
            let _ = writeln!(err, "\x1b[2m· {}\x1b[0m", if summary.is_empty() { name } else { summary });
        }
        AgentEvent::RouteResolved { .. } | AgentEvent::RouteLocked { .. } => {
            if let Ok(v) = serde_json::to_value(event) {
                if let (Some(p), Some(m)) = (v["provider"].as_str(), v["model"].as_str()) {
                    let _ = writeln!(err, "\x1b[2m· auto → {p}/{m}\x1b[0m");
                }
            }
        }
        AgentEvent::RunError { error, .. } => {
            let _ = writeln!(err, "\nklide run: {}", error.message);
        }
        _ => {}
    }
}

pub fn main() -> ! {
    let argv: Vec<String> = std::env::args().skip(2).collect();
    let args = match parse(&argv, || {
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s).map(|_| s)
    }) {
        Ok(a) => a,
        Err(e) if e.is_empty() => {
            println!("{USAGE}");
            std::process::exit(exit::DONE)
        }
        Err(e) => {
            eprintln!("klide run: {e}\n\n{USAGE}");
            std::process::exit(exit::USAGE)
        }
    };
    let code = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt.block_on(run(args)),
        Err(e) => {
            eprintln!("klide run: {e}");
            exit::FAILED
        }
    };
    std::process::exit(code)
}

async fn run(args: Args) -> i32 {
    if args.approve_container_commands && !container_environment() {
        eprintln!("klide run: --approve-container-commands requires a disposable Linux Docker container; do not mount host credentials or host control sockets.");
        return exit::USAGE;
    }
    let cwd = args.cwd.clone().map(Ok).unwrap_or_else(std::env::current_dir);
    let root = match cwd.and_then(|p| p.canonicalize()) {
        Ok(r) if r.is_dir() => r,
        _ => {
            eprintln!("klide run: the Workspace folder doesn't exist");
            return exit::USAGE;
        }
    };
    if let Some(why) = missing_key(&args.provider, &root) {
        eprintln!("klide run: {why}");
        return exit::NO_KEY;
    }
    // Own scratch space: no app conversation, journal or Schedule is touched.
    let scratch = std::env::temp_dir().join(format!("klide-run-{}", transcripts::run_id()));
    let data = std::env::var_os("KLIDE_DATA_DIR").map(PathBuf::from).unwrap_or_else(|| scratch.join("data"));
    let runs = args.runs_dir.clone().unwrap_or_else(|| scratch.join("runs"));
    let run_id = transcripts::run_id();
    let request = match request(&args, &root, &run_id) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("klide run: {e}");
            return exit::FAILED;
        }
    };
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let host = daemon::RunHost::new(data, Arc::new(move |_, _, e| {
        let _ = tx.send(e.clone());
    }));
    if let Err(e) = host.start_cli(request, runs).await {
        eprintln!("klide run: {e}");
        let _ = std::fs::remove_dir_all(&scratch);
        return exit::FAILED;
    }
    let (mut out, mut err) = (std::io::stdout(), std::io::stderr());
    let mut code = exit::FAILED;
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                let _ = host.control(&run_id, crate::pty_wire::ChatControl::Stop);
                code = exit::INTERRUPTED;
                break;
            }
            event = rx.recv() => {
                let Some(event) = event else { break };
                if args.json {
                    if let Ok(line) = serde_json::to_string(&event) {
                        let _ = writeln!(out, "{line}");
                    }
                } else {
                    render(&event, &mut out, &mut err);
                }
                // The pending slot is filled as the card is raised; give it a
                // moment rather than race it.
                for _ in 0..40 {
                    let Some(control) = control_reply(&event, args.approve_container_commands) else { break };
                    if host.control(&run_id, control).is_ok() { break; }
                    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                }
                match &event {
                    AgentEvent::RunResult { result, .. } => {
                        code = match result["status"].as_str() {
                            Some("done") => exit::DONE,
                            Some("cancelled") => exit::INTERRUPTED,
                            _ => exit::FAILED,
                        };
                        break;
                    }
                    AgentEvent::RunError { .. } => { code = exit::FAILED; break; }
                    _ => {}
                }
            }
        }
    }
    if !args.json {
        let _ = writeln!(out);
    }
    // The Transcript writer settles after its last event; don't cut it off.
    let end = tokio::time::Instant::now() + std::time::Duration::from_secs(8);
    while host.status(&run_id).0.is_some() && tokio::time::Instant::now() < end {
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    // A goal failure emits its result before its diagnostic. Drain the tail
    // after settlement so JSON consumers and terminal users receive both.
    while let Ok(event) = rx.try_recv() {
        if args.json {
            if let Ok(line) = serde_json::to_string(&event) { let _ = writeln!(out, "{line}"); }
        } else { render(&event, &mut out, &mut err); }
    }
    let _ = std::fs::remove_dir_all(&scratch);
    code
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Result<Args, String> {
        parse(&list.iter().map(|s| s.to_string()).collect::<Vec<_>>(), || Ok("from stdin".into()))
    }

    #[test]
    fn the_command_line_reads_as_the_doc_says() {
        let a = args(&["--model", "openrouter/nvidia/x:free", "--work", "fix it"]).unwrap();
        assert_eq!((a.provider.as_str(), a.model.as_str(), a.work, a.task.as_str()), ("openrouter", "nvidia/x:free", true, "fix it"));
        assert_eq!(args(&["-"]).unwrap().task, "from stdin");
        assert_eq!(args(&["why?"]).unwrap().provider, "auto");
        assert_eq!(args(&["--help"]), Err(String::new()));
        assert!(args(&["--allow-commands", "x"]).unwrap_err().contains("--work"));
        assert!(args(&["--model", "deepseek", "x"]).unwrap_err().contains("<provider>/<model>"));
        assert!(args(&[]).unwrap_err().contains("no task"));
        assert!(args(&["a", "b"]).unwrap_err().contains("one task"));
    }

    #[test]
    fn read_only_by_default_and_commands_only_when_asked() {
        let root = std::env::temp_dir();
        let plan = request(&args(&["why?"]).unwrap(), &root, "r1").unwrap();
        assert_eq!(plan.mode, AgentMode::Plan);
        assert_eq!(plan.require_diff_review, Some(true));
        assert_eq!(plan.auto_approve_commands, Some(false));
        for tool in ["run_command", "write_file", "spawn_subagent", "connector_call"] {
            assert!(plan.disabled_tools.iter().any(|t| t == tool), "{tool} must be off in a read-only run");
        }
        let work = request(&args(&["--work", "fix"]).unwrap(), &root, "r2").unwrap();
        assert_eq!(work.mode, AgentMode::Goal);
        assert_eq!(work.require_diff_review, Some(false));
        assert!(work.disabled_tools.iter().any(|t| t == "run_command"));
        assert!(!work.disabled_tools.iter().any(|t| t == "write_file"));
        let full = request(&args(&["--work", "--allow-commands", "fix"]).unwrap(), &root, "r3").unwrap();
        assert_eq!(full.auto_approve_commands, Some(true));
        assert!(!full.disabled_tools.iter().any(|t| t == "run_command"));
    }

    #[test]
    fn every_card_is_answered_with_a_refusal() {
        let raised: AgentEvent = serde_json::from_value(serde_json::json!({
            "type": "user_question_requested", "runId": "r", "requestId": "q", "question": "?", "ts": 0
        })).unwrap();
        assert!(matches!(refusal(&raised), Some(crate::pty_wire::ChatControl::Question { .. })));
    }

    #[test]
    fn completion_checks_require_command_authority_and_a_bounded_timeout() {
        for flags in [vec!["--check-command", "true", "x"],
            vec!["--work", "--check-command", "true", "x"],
            vec!["--check-timeout-secs", "1", "x"],
            vec!["--work", "--allow-commands", "--check-command", "", "x"],
            vec!["--work", "--allow-commands", "--check-command", "true", "--check-timeout-secs", "0", "x"]] {
            assert!(args(&flags).is_err(), "{flags:?}");
        }
        let a = args(&["--work", "--allow-commands", "--check-command", "true", "x"]).unwrap();
        let request = request(&a, Path::new("."), "check").unwrap();
        assert!(request.goal.unwrap().check_without_work);
        assert_eq!(request.test_after_edit_command.as_deref(), Some("true"));
    }

    #[test]
    fn unavailable_advisor_resolves_to_the_native_fallback() {
        let event: AgentEvent = serde_json::from_value(serde_json::json!({
            "type":"advisor_requested", "runId":"r", "requestId":"a", "question":"help", "ts":0
        })).unwrap();
        match refusal(&event) {
            Some(crate::pty_wire::ChatControl::Question { answer }) =>
                assert!(answer.starts_with(super::super::tool_handlers::ADVISOR_ERROR_PREFIX)),
            _ => panic!("a headless advisor request must resolve immediately"),
        }
    }

    #[test]
    fn container_approval_is_explicit_and_only_for_command_gates() {
        assert!(args(&["--approve-container-commands", "x"]).is_err());
        assert!(args(&["--work", "--approve-container-commands", "x"]).is_err());
        assert!(args(&["--work", "--allow-commands", "--approve-container-commands", "x"]).unwrap().approve_container_commands);
        let event = |tool: &str| serde_json::from_value::<AgentEvent>(serde_json::json!({
            "type":"permission_requested", "runId":"r", "ts":0, "request":{
                "id":"p", "runId":"r", "toolCallId":"c", "toolName":tool,
                "input":{"command":"openssl req -keyout /etc/nginx/ssl/server.key"},
                "summary":"command", "reason":"credential path", "options":[]
            }
        })).unwrap();
        let decision = |e, enabled| match control_reply(&e, enabled).unwrap() {
            crate::pty_wire::ChatControl::Permission { decision } => decision["behavior"].as_str().unwrap().to_owned(),
            _ => panic!("expected permission reply"),
        };
        assert_eq!(decision(event("run_command"), false), "deny");
        assert_eq!(decision(event("run_command"), true), "allow");
        assert_eq!(decision(event("connector_call"), true), "deny");
    }

    #[test]
    fn the_prompt_carries_the_projects_own_instructions() {
        let dir = std::env::temp_dir().join(format!("klide-run-prompt-{}", transcripts::run_id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("AGENTS.md"), "Use tabs.").unwrap();
        let prompt = system_prompt(&dir, &args(&["--model", "deepseek/deepseek-chat", "x"]).unwrap());
        assert!(prompt.contains("Use tabs.") && prompt.contains("deepseek-chat") && prompt.contains("read-only"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
