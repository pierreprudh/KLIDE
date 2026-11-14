//! `run_script` — Code Mode for the Harness, read-only slice.
//!
//! A model that needs twenty reads to answer one question used to make twenty
//! Tool calls, each a model round trip, each result carried in the provider
//! messages for the rest of the Run. `run_script` lets it write one short
//! JavaScript program instead: the program calls the read Tools, filters what
//! they return, and hands back only what the model needs to read.
//!
//! Containment is by construction, not by a wall around a full runtime. The
//! program runs in QuickJS embedded in this process (`rquickjs`) with the
//! language's own built-ins only — no filesystem, network, process, timer or
//! module loader exists in it. The one way out is the frozen `tools` object
//! below, and every entry on it is a `ReadOnly` registry Tool dispatched
//! through the same executor a direct call uses: same Workspace rooting, same
//! read snapshots `write_file` later checks. So the capability `run_script`
//! records (read workspace) is true of everything a script can do.
//!
//! Each script starts in a fresh interpreter. Nothing survives between
//! scripts: a Run's state stays in its Transcript, where replay can find it.
//!
//! Off by default. The switch lives in Settings › AI and is kept in
//! `~/.klide/code_mode.json` — read here, like the command sandbox's file, so
//! a background host and a child Run read the same answer. Even switched on,
//! a Run on a local model is not offered the Tool: small local models write
//! scripts that fail and spend the round trips the Tool was meant to save.

use super::tools::{execute_read_only_tool_with_runs_dir, NormalizedToolCall};
use super::types::ToolResult;
use crate::workspace::Workspace;
use rquickjs::{Context, Ctx, Exception, Function, Promise, Runtime, Value};
use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant};

pub const RUN_SCRIPT_TOOL: &str = "run_script";

/// The Tools a script may call. Every one is a `ReadOnly` registry entry
/// (`bindings_are_workspace_reads` pins that), so a script can do nothing a
/// direct read could not. `peek_value` is left out on purpose: it reads the
/// Run's retained values, a different capability than a workspace read.
pub const BINDINGS: &[&str] = &[
    "read_file",
    "list_dir",
    "glob",
    "grep",
    "get_git_status",
    "get_git_diff",
    "get_git_log",
    "inspect_spreadsheet",
];

/// How long one script may run, Tool calls included.
const WALL_CLOCK: Duration = Duration::from_secs(30);
/// How many Tool calls one script may make.
const MAX_CALLS: usize = 200;
/// The interpreter's heap.
const MEMORY_LIMIT: usize = 64 * 1024 * 1024;
/// The longest script accepted, in bytes.
const MAX_CODE_BYTES: usize = 32 * 1024;
/// What `console.log` may add to the result, in bytes.
const MAX_LOG_BYTES: usize = 8 * 1024;
/// The longest result returned. Above the retention threshold, so a large
/// answer becomes a retained value rather than being cut here.
const MAX_RESULT_BYTES: usize = 200 * 1024;

pub fn description() -> String {
    format!(
        "Run a short JavaScript program that calls read-only workspace tools and returns only what you need. \
Use it instead of many separate calls when a task needs many similar reads: checking every file of a kind, \
filtering a large search before reading it, or combining several reads into one answer. \
The program is the body of an async function: call `await tools.<name>({{...}})` and finish with `return <value>`. \
Available: {}. Each takes the same arguments as the tool of that name and returns its text output, \
or throws an Error with the tool's error message. `console.log` output is included in the result. \
No filesystem, network, timers or imports exist beyond these tools. Limits: {} seconds, {} tool calls. \
Each run starts fresh; nothing is kept between runs.",
        BINDINGS.iter().map(|n| format!("tools.{n}")).collect::<Vec<_>>().join(", "),
        WALL_CLOCK.as_secs(),
        MAX_CALLS,
    )
}

pub fn summary(call: &NormalizedToolCall) -> String {
    let code = call.input.get("code").and_then(|v| v.as_str()).unwrap_or("");
    let lines = code.lines().filter(|l| !l.trim().is_empty()).count();
    format!("run_script ({lines} line{})", if lines == 1 { "" } else { "s" })
}

/// The registry's read entry point.
pub fn run(ws: &Workspace, input: &serde_json::Value, run_id: &str, runs_dir: Option<&Path>) -> ToolResult {
    let Some(code) = input.get("code").and_then(|v| v.as_str()) else {
        return failure("run_script needs `code`: the body of an async JavaScript function.".into(), &[]);
    };
    if code.len() > MAX_CODE_BYTES {
        return failure(format!("The script is {} bytes; the limit is {MAX_CODE_BYTES}.", code.len()), &[]);
    }
    let root = ws.root().to_string_lossy().into_owned();
    let runs_dir = runs_dir.map(Path::to_path_buf);
    let run_id = run_id.to_string();
    execute(code, Limits::default(), move |call| match &runs_dir {
        Some(dir) => execute_read_only_tool_with_runs_dir(&root, call, &run_id, dir),
        None => super::tools::execute_read_only_tool(&root, call, &run_id),
    })
}

#[derive(Clone, Copy)]
struct Limits {
    wall_clock: Duration,
    max_calls: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { wall_clock: WALL_CLOCK, max_calls: MAX_CALLS }
    }
}

/// One inner call, as the result's metadata reports it.
#[derive(Clone, Debug, serde::Serialize)]
struct CallRecord {
    name: String,
    ok: bool,
}

#[derive(Default)]
struct State {
    calls: Vec<CallRecord>,
    log: String,
    log_truncated: bool,
}

/// Run `code` with `dispatch` answering each Tool call. Separate from [`run`]
/// so the interpreter is tested without a Workspace.
fn execute<F>(code: &str, limits: Limits, dispatch: F) -> ToolResult
where
    F: Fn(&NormalizedToolCall) -> ToolResult + 'static,
{
    let started = Instant::now();
    let deadline = started + limits.wall_clock;
    let state = Rc::new(RefCell::new(State::default()));

    let runtime = match Runtime::new() {
        Ok(rt) => rt,
        Err(e) => return failure(format!("Could not start the script engine: {e}"), &[]),
    };
    runtime.set_memory_limit(MEMORY_LIMIT);
    runtime.set_max_stack_size(1024 * 1024);
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() > deadline)));
    let context = match Context::full(&runtime) {
        Ok(ctx) => ctx,
        Err(e) => return failure(format!("Could not start the script engine: {e}"), &[]),
    };

    let dispatch = Rc::new(dispatch);
    let outcome: Result<String, String> = context.with(|ctx| {
        install(&ctx, state.clone(), dispatch.clone(), limits, deadline)
            .map_err(|e| describe_error(&ctx, e))?;
        // The model writes a function body: `await` works and `return` hands
        // the answer back.
        let wrapped = format!("(async () => {{\n{code}\n}})()");
        let promise: Promise = ctx.eval(wrapped).map_err(|e| describe_error(&ctx, e))?;
        loop {
            if let Some(result) = promise.result::<Value>() {
                let value = result.map_err(|e| describe_error(&ctx, e))?;
                return render(&ctx, value);
            }
            if Instant::now() > deadline {
                return Err(timeout_message(limits));
            }
            if !ctx.execute_pending_job() {
                // Nothing left to run and the promise never settled: the
                // script awaited something that cannot resolve.
                return Err("The script awaited something that never finished.".into());
            }
        }
    });

    let state = state.borrow();
    let elapsed_ms = started.elapsed().as_millis() as u64;
    match outcome {
        Ok(text) => {
            let mut content = text;
            if !state.log.is_empty() {
                content = format!("{content}\n\n[console]\n{}{}", state.log, if state.log_truncated { "\n…(log truncated)" } else { "" });
            }
            ToolResult { ok: true, content: cap(content), metadata: Some(metadata(&state.calls, elapsed_ms)) }
        }
        Err(message) => {
            let message = if Instant::now() > deadline && !message.contains("seconds") { timeout_message(limits) } else { message };
            let mut content = format!("Script failed: {message}");
            if !state.log.is_empty() {
                content.push_str(&format!("\n\n[console]\n{}", state.log));
            }
            ToolResult { ok: false, content: cap(content), metadata: Some(metadata(&state.calls, elapsed_ms)) }
        }
    }
}

/// Put `tools` and `console` on the global object. The bindings are frozen so
/// a script cannot swap one for something else mid-run.
fn install<'js, F>(
    ctx: &Ctx<'js>,
    state: Rc<RefCell<State>>,
    dispatch: Rc<F>,
    limits: Limits,
    deadline: Instant,
) -> rquickjs::Result<()>
where
    F: Fn(&NormalizedToolCall) -> ToolResult + 'static,
{
    let globals = ctx.globals();
    let call_state = state.clone();
    let call = Function::new(ctx.clone(), move |ctx: Ctx<'js>, name: String, args: String| -> rquickjs::Result<String> {
        if !BINDINGS.contains(&name.as_str()) {
            return Err(Exception::throw_message(&ctx, &format!("No tool named {name} is available to scripts.")));
        }
        if Instant::now() > deadline {
            return Err(Exception::throw_message(&ctx, &timeout_message(limits)));
        }
        let count = call_state.borrow().calls.len();
        if count >= limits.max_calls {
            return Err(Exception::throw_message(&ctx, &format!("The script reached its limit of {} tool calls.", limits.max_calls)));
        }
        let input: serde_json::Value = serde_json::from_str(&args).unwrap_or(serde_json::Value::Null);
        let input = if input.is_object() { input } else { serde_json::json!({}) };
        let normalized = NormalizedToolCall { id: format!("script-{count}"), name: name.clone(), input };
        let result = (*dispatch)(&normalized);
        call_state.borrow_mut().calls.push(CallRecord { name: name.clone(), ok: result.ok });
        if result.ok {
            Ok(result.content)
        } else {
            Err(Exception::throw_message(&ctx, &format!("{name}: {}", result.content)))
        }
    })?;
    globals.set("__klide_call", call)?;

    let log_state = state;
    let log = Function::new(ctx.clone(), move |line: String| {
        let mut state = log_state.borrow_mut();
        if state.log.len() + line.len() + 1 > MAX_LOG_BYTES {
            state.log_truncated = true;
            return;
        }
        state.log.push_str(&line);
        state.log.push('\n');
    })?;
    globals.set("__klide_log", log)?;

    let names = serde_json::to_string(BINDINGS).unwrap_or_else(|_| "[]".into());
    ctx.eval::<(), _>(format!(
        r#"(() => {{
  const call = __klide_call, log = __klide_log;
  const show = (v) => typeof v === "string" ? v : (() => {{ try {{ return JSON.stringify(v); }} catch {{ return String(v); }} }})();
  globalThis.tools = Object.freeze(Object.fromEntries({names}.map((n) => [n, async (args) => call(n, JSON.stringify(args ?? {{}}))])));
  globalThis.console = Object.freeze({{ log: (...a) => log(a.map(show).join(" ")), error: (...a) => log(a.map(show).join(" ")), warn: (...a) => log(a.map(show).join(" ")) }});
  delete globalThis.__klide_call;
  delete globalThis.__klide_log;
}})();"#
    ))?;
    Ok(())
}

/// The script's return value as the text the model reads: a string as is,
/// anything else as JSON.
fn render<'js>(ctx: &Ctx<'js>, value: Value<'js>) -> Result<String, String> {
    if value.is_undefined() {
        return Ok("(the script returned nothing — end it with `return <value>`)".into());
    }
    if let Some(s) = value.as_string() {
        return s.to_string().map_err(|e| e.to_string());
    }
    match ctx.json_stringify(value) {
        Ok(Some(s)) => s.to_string().map_err(|e| e.to_string()),
        Ok(None) => Ok("(the script returned a value that has no JSON form)".into()),
        Err(e) => Err(describe_error(ctx, e)),
    }
}

/// A thrown value or engine error as one line the model can act on.
fn describe_error(ctx: &Ctx<'_>, error: rquickjs::Error) -> String {
    if !matches!(error, rquickjs::Error::Exception) {
        return error.to_string();
    }
    let thrown = ctx.catch();
    if let Some(exception) = thrown.as_exception() {
        let message = exception.message().unwrap_or_default();
        return if message.is_empty() { "an error with no message was thrown".into() } else { message };
    }
    if thrown.is_null() || thrown.is_undefined() {
        // An uncatchable interrupt (the wall clock) leaves no value behind.
        return "the script was stopped".into();
    }
    match ctx.json_stringify(thrown) {
        Ok(Some(s)) => s.to_string().unwrap_or_default(),
        _ => "an unprintable value was thrown".into(),
    }
}

fn timeout_message(limits: Limits) -> String {
    format!("the script ran past its {} seconds.", limits.wall_clock.as_secs())
}

fn metadata(calls: &[CallRecord], elapsed_ms: u64) -> serde_json::Value {
    serde_json::json!({ "scriptCalls": calls, "elapsedMs": elapsed_ms })
}

fn failure(content: String, calls: &[CallRecord]) -> ToolResult {
    ToolResult { ok: false, content, metadata: Some(metadata(calls, 0)) }
}

fn cap(mut text: String) -> String {
    if text.len() > MAX_RESULT_BYTES {
        let mut end = MAX_RESULT_BYTES;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push_str("\n…(result cut at 200 KB — return less)");
    }
    text
}

// ── The switch ──────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct Stored {
    #[serde(default)]
    enabled: bool,
}

fn settings_path() -> Option<PathBuf> {
    crate::cli::home_dir_path().map(|home| home.join(".klide/code_mode.json"))
}

/// No file, or one that cannot be read, means off.
fn stored_at(path: &Path) -> Stored {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Stored>(&bytes).ok())
        .unwrap_or_default()
}

fn store_at(path: &Path, stored: Stored) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Create the Klide settings folder: {e}"))?;
    }
    let bytes = serde_json::to_vec_pretty(&stored).map_err(|e| e.to_string())?;
    crate::durable::write_atomic(path, &bytes)
}

/// Whether the person turned Code Mode on. Tests never read the developer's
/// setting.
pub fn enabled() -> bool {
    !cfg!(test) && settings_path().map(|p| stored_at(&p).enabled).unwrap_or(false)
}

/// What Settings shows.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
}

pub fn status() -> Status {
    Status { enabled: settings_path().map(|p| stored_at(&p).enabled).unwrap_or(false) }
}

pub fn set(enabled: bool) -> Result<Status, String> {
    let path = settings_path().ok_or("Cannot locate the Klide settings directory.")?;
    store_at(&path, Stored { enabled })?;
    Ok(status())
}

/// May a Run on this pair be offered `run_script`? Only when the switch is on
/// and the model is not a local one.
pub fn offered_for(switch_on: bool, provider: &str, model: &str) -> bool {
    switch_on && !matches!(crate::model_capabilities::price_class(provider, model), crate::model_capabilities::PriceClass::Local)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_dispatch(call: &NormalizedToolCall) -> ToolResult {
        match call.name.as_str() {
            "glob" => ToolResult { ok: true, content: "a.md\nb.md\nc.txt".into(), metadata: None },
            "read_file" => {
                let path = call.input["path"].as_str().unwrap_or("");
                match path {
                    "a.md" => ToolResult { ok: true, content: "see [b](b.md) and [gone](missing.md)".into(), metadata: None },
                    "b.md" => ToolResult { ok: true, content: "no links".into(), metadata: None },
                    _ => ToolResult { ok: false, content: format!("File not found: {path}"), metadata: None },
                }
            }
            other => ToolResult { ok: true, content: format!("{other} ok"), metadata: None },
        }
    }

    fn run_code(code: &str) -> ToolResult {
        execute(code, Limits::default(), fake_dispatch)
    }

    fn calls(result: &ToolResult) -> Vec<String> {
        result.metadata.as_ref().unwrap()["scriptCalls"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["name"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn a_script_reads_filters_and_returns_only_the_answer() {
        let result = run_code(
            r#"
            const files = (await tools.glob({ pattern: "*.md" })).split("\n").filter(f => f.endsWith(".md"));
            const broken = [];
            for (const f of files) {
              const text = await tools.read_file({ path: f });
              for (const [, target] of text.matchAll(/\]\(([^)]+)\)/g)) {
                try { await tools.read_file({ path: target }); } catch { broken.push({ file: f, target }); }
              }
            }
            return broken;
            "#,
        );
        assert!(result.ok, "{}", result.content);
        assert_eq!(result.content, r#"[{"file":"a.md","target":"missing.md"}]"#);
        assert_eq!(calls(&result), ["glob", "read_file", "read_file", "read_file", "read_file"]);
    }

    #[test]
    fn a_string_comes_back_as_is_and_console_is_appended() {
        let result = run_code(r#"console.log("checked", 2, { n: 1 }); return "done";"#);
        assert!(result.ok);
        assert_eq!(result.content, "done\n\n[console]\nchecked 2 {\"n\":1}\n");
    }

    #[test]
    fn a_tool_error_throws_and_an_uncaught_one_fails_the_script() {
        let result = run_code(r#"return await tools.read_file({ path: "nope" });"#);
        assert!(!result.ok);
        assert!(result.content.contains("read_file: File not found: nope"), "{}", result.content);
    }

    #[test]
    fn a_syntax_error_is_reported_not_panicked() {
        let result = run_code("return (;");
        assert!(!result.ok);
        assert!(result.content.starts_with("Script failed:"), "{}", result.content);
    }

    #[test]
    fn nothing_beyond_the_bindings_exists() {
        let result = run_code(
            r#"return [typeof require, typeof process, typeof fetch, typeof setTimeout, typeof std, typeof os,
                       typeof __klide_call, Object.keys(tools).sort().join(",")];"#,
        );
        assert!(result.ok, "{}", result.content);
        let mut names: Vec<&str> = BINDINGS.to_vec();
        names.sort();
        let expected = format!(
            r#"["undefined","undefined","undefined","undefined","undefined","undefined","undefined","{}"]"#,
            names.join(",")
        );
        assert_eq!(result.content, expected);
    }

    #[test]
    fn the_bindings_cannot_be_swapped_or_extended() {
        let result = run_code(r#""use strict"; tools.read_file = () => "x"; return 1;"#);
        assert!(!result.ok, "a frozen binding refuses assignment in strict code");
        let result = run_code(r#"try { return await tools.run_command({ command: "rm -rf /" }); } catch (e) { return String(e); }"#);
        assert!(result.ok);
        assert!(result.content.contains("not a function"), "{}", result.content);
    }

    #[test]
    fn an_endless_loop_is_stopped_by_the_clock() {
        let limits = Limits { wall_clock: Duration::from_millis(200), max_calls: MAX_CALLS };
        let started = Instant::now();
        let result = execute("while (true) {}", limits, fake_dispatch);
        assert!(!result.ok);
        assert!(result.content.contains("ran past"), "{}", result.content);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn the_call_budget_is_enforced() {
        let limits = Limits { wall_clock: WALL_CLOCK, max_calls: 3 };
        let result = execute("for (let i = 0; i < 10; i++) await tools.get_git_status({}); return 1;", limits, fake_dispatch);
        assert!(!result.ok);
        assert!(result.content.contains("limit of 3 tool calls"), "{}", result.content);
        assert_eq!(calls(&result).len(), 3);
    }

    #[test]
    fn a_missing_return_says_so() {
        let result = run_code("await tools.get_git_status({});");
        assert!(result.ok);
        assert!(result.content.contains("returned nothing"));
    }

    #[test]
    fn a_huge_result_is_cut() {
        let result = run_code(r#"return "x".repeat(300000);"#);
        assert!(result.ok);
        assert!(result.content.len() < MAX_RESULT_BYTES + 100);
        assert!(result.content.ends_with("return less)"));
    }

    #[test]
    fn bindings_are_workspace_reads() {
        for name in BINDINGS {
            assert_eq!(
                super::super::tools::find_tool_kind_for_workspace(name, None),
                Some(super::super::tools::ToolKind::ReadOnly),
                "{name} must stay a ReadOnly registry Tool to be callable from a script"
            );
        }
        assert_eq!(
            super::super::tools::find_tool_kind_for_workspace(RUN_SCRIPT_TOOL, None),
            Some(super::super::tools::ToolKind::ReadOnly)
        );
    }

    #[test]
    fn a_script_reads_a_real_workspace_through_the_registry() {
        let dir = std::env::temp_dir().join(format!("klide-script-ws-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("docs")).unwrap();
        std::fs::write(dir.join("docs/a.md"), "[ok](b.md) [gone](nowhere.md)").unwrap();
        std::fs::write(dir.join("docs/b.md"), "fine").unwrap();
        let root = dir.to_string_lossy().into_owned();
        let call = NormalizedToolCall {
            id: "c1".into(),
            name: RUN_SCRIPT_TOOL.into(),
            input: serde_json::json!({ "code": r#"
                const text = await tools.read_file({ path: "docs/a.md" });
                const missing = [];
                for (const [, t] of text.matchAll(/\]\(([^)]+)\)/g)) {
                  try { await tools.read_file({ path: "docs/" + t }); } catch { missing.push(t); }
                }
                try { await tools.read_file({ path: "../../etc/passwd" }); missing.push("ESCAPED"); } catch {}
                return missing;
            "# }),
        };
        let result = super::super::tools::execute_read_only_tool(&root, &call, "run-script-test");
        assert!(result.ok, "{}", result.content);
        assert_eq!(result.content, r#"["nowhere.md"]"#, "the Workspace guard still refuses a path outside it");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_run_is_not_offered_the_tool_unless_switched_on_and_nothing_it_wraps_is_off() {
        use super::super::permission::GateSubject;
        let mut request = super::super::test_support::test_request("/workspace", &[]);
        request.mode = super::super::types::AgentMode::Goal;
        request.provider = "anthropic".into();
        request.model = "claude-sonnet-5-5".into();
        // Tests never read the developer's switch, so it reads as off.
        let subject = GateSubject::from_request(&request);
        assert!(subject.permits(RUN_SCRIPT_TOOL, Some(super::super::tools::ToolKind::ReadOnly)).is_err());
    }

    #[test]
    fn an_offered_run_lists_the_tool_in_plan_and_work_but_never_chat() {
        use super::super::permission::GateSubject;
        use super::super::tools::{schemas_for_mode, tools_include};
        use super::super::types::AgentMode;
        for (mode, expected) in [(AgentMode::Plan, true), (AgentMode::Goal, true), (AgentMode::Chat, false)] {
            let mut subject = GateSubject::for_mode(mode.clone());
            assert!(!tools_include(&schemas_for_mode(&subject, None), RUN_SCRIPT_TOOL), "{mode:?}: not offered by default");
            subject.script_offered = true;
            assert_eq!(tools_include(&schemas_for_mode(&subject, None), RUN_SCRIPT_TOOL), expected, "{mode:?}");
        }
    }

    #[test]
    fn the_switch_defaults_off_and_round_trips() {
        let dir = std::env::temp_dir().join(format!("klide-code-mode-{}", std::process::id()));
        let path = dir.join("nested/code_mode.json");
        assert!(!stored_at(&path).enabled, "no file is off");
        store_at(&path, Stored { enabled: true }).unwrap();
        assert!(stored_at(&path).enabled);
        std::fs::write(&path, b"{not json").unwrap();
        assert!(!stored_at(&path).enabled, "a damaged file is off");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn local_models_are_never_offered_the_tool() {
        assert!(!offered_for(false, "anthropic", "claude-sonnet-5-5"), "switch off");
        assert!(offered_for(true, "anthropic", "claude-sonnet-5-5"));
        assert!(!offered_for(true, "ollama", "llama3.1:8b"));
        assert!(!offered_for(true, "mlx", "mlx-community/Qwen3-8B-4bit"));
    }
}
