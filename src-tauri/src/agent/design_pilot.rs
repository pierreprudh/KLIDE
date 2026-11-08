//! Development-only thin host adapter. Provider execution remains in run_host.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{future::Future, sync::OnceLock, time::Duration};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    request: StartRunRequest,
    #[serde(default)]
    allowed_write_paths: Vec<String>,
    max_attempts: usize,
    timeout_secs: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Budget {
    limit: usize,
    model: String,
    attempts: Vec<Value>,
    output: PathBuf,
    allowed_writes: Vec<PathBuf>,
}
type Shared = Arc<Mutex<Budget>>;
static RUNS: OnceLock<Mutex<HashMap<String, Shared>>> = OnceLock::new();
tokio::task_local! { static ACTIVE: Shared; }
pub(super) fn active() -> bool {
    ACTIVE.try_with(|_| ()).is_ok()
}
pub(super) async fn scope<T>(id: &str, work: impl Future<Output = T>) -> T {
    let budget = RUNS.get().and_then(|m| m.lock().ok()?.get(id).cloned());
    match budget {
        Some(b) => ACTIVE.scope(b, work).await,
        None => work.await,
    }
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn image_hashes(v: &Value, images: &mut Vec<String>, key: &str) {
    match v {
        Value::String(s) if s.starts_with("data:image/") => {
            if let Some((_, b)) = s.split_once(',') {
                if let Ok(bytes) = STANDARD.decode(b) {
                    images.push(digest(&bytes));
                }
            }
        }
        Value::String(s) if key == "images" => {
            if let Ok(bytes) = STANDARD.decode(s) {
                images.push(digest(&bytes));
            }
        }
        Value::Array(a) => {
            for v in a {
                image_hashes(v, images, key)
            }
        }
        Value::Object(m) => {
            for (k, v) in m {
                image_hashes(v, images, k)
            }
        }
        _ => (),
    }
}
/// Called before every streaming HTTP dispatch, including adapter retries.
pub(crate) async fn before_send(
    builder: &reqwest::RequestBuilder,
    provider: &str,
) -> Result<(), String> {
    let Ok(budget) = ACTIVE.try_with(Clone::clone) else {
        return Ok(());
    };
    let request = builder
        .try_clone()
        .ok_or("Pilot request cannot be inspected")?
        .build()
        .map_err(|e| e.to_string())?;
    let bytes = request
        .body()
        .and_then(|b| b.as_bytes())
        .ok_or("Pilot requires a JSON request body")?;
    let body: Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let mut images = Vec::new();
    image_hashes(&body, &mut images, "");
    let record = json!({"provider":provider,"model":body["model"],"bodySha256":digest(bytes),"imageSha256":images,"at":now_ms()});
    let model = body["model"].as_str().unwrap_or("").to_string();
    crate::blocking::run(move || {
        let mut b = budget.lock().map_err(|_| "Pilot budget poisoned")?;
        if model != b.model {
            return Err("Pilot model substitution refused".into());
        }
        if b.attempts.len() >= b.limit {
            return Err("Design pilot provider-attempt budget exhausted".into());
        }
        b.attempts.push(record);
        // Reserve durably BEFORE dispatch. A crash consumes the reservation.
        crate::durable::write_atomic(
            &b.output.join("attempts.json"),
            &serde_json::to_vec_pretty(&*b).map_err(|e| e.to_string())?,
        )
    })
    .await
}

pub(super) fn check_write(id: &str, root: &str, path: &str) -> Result<(), String> {
    let Some(budget) = RUNS.get().and_then(|m| m.lock().ok()?.get(id).cloned()) else {
        return Ok(());
    };
    let ws = crate::workspace::Workspace::new(root)?;
    let resolved = ws.resolve_new(path)?;
    let b = budget.lock().map_err(|_| "Pilot budget poisoned")?;
    if !b.allowed_writes.contains(&resolved) {
        return Err("Write is outside the pilot's exact file scope".into());
    }
    Ok(())
}

pub(crate) fn cli_main() {
    let args: Vec<String> = std::env::args().skip(2).collect();
    let result = (|| -> Result<(), String> {
        if args.len() != 2 {
            return Err("Usage: klide design-pilot-run INPUT_JSON NEW_OUTPUT_DIR".into());
        }
        let input: Input =
            serde_json::from_slice(&std::fs::read(&args[0]).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        let output = PathBuf::from(&args[1]);
        std::fs::create_dir(&output).map_err(|e| format!("Output must be new: {e}"))?;
        let runtime = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
        runtime.block_on(run(input, output))
    })();
    if let Err(error) = result {
        eprintln!("Design pilot incomplete: {error}");
        std::process::exit(1);
    }
}
async fn run(mut input: Input, output: PathBuf) -> Result<(), String> {
    if !(1..=24).contains(&input.max_attempts) || !(1..=2700).contains(&input.timeout_secs) {
        return Err("Pilot limits out of bounds".into());
    }
    let r = &mut input.request;
    if r.provider != "ollama" {
        return Err("Initial live pilot supports explicit local Ollama only".into());
    }
    if r.naming.is_some()
        || r.goal.is_some()
        || r.parent_id.is_some()
        || r.mission_id.is_some()
        || r.eyes.is_some()
    {
        return Err("Pilot must be standalone; side calls are disabled".into());
    }
    let root = r
        .workspace_root
        .clone()
        .ok_or("Pilot requires disposable workspace")?;
    let ws = crate::workspace::Workspace::new(&root)?;
    if !ws.root().join(".klide-design-disposable").is_file() {
        return Err("Workspace must carry .klide-design-disposable marker".into());
    }
    let mut allowed_writes = Vec::new();
    for name in &input.allowed_write_paths {
        if std::path::Path::new(name)
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err("Write scope requires relative files without traversal".into());
        }
        let p = ws.resolve_new(name)?;
        ws.guard(&p, crate::workspace::Access::Agent)?;
        if !name.starts_with("src/") && !name.starts_with("preview/") {
            return Err("Pilot write scope is limited to src/ and preview/ files".into());
        }
        if name.starts_with("preview/design-feedback") || name.starts_with("preview/design-agent") {
            return Err("Writer cannot edit its evidence harness".into());
        }
        allowed_writes.push(p);
    }
    if r.mode == AgentMode::Goal && allowed_writes.is_empty() {
        return Err("Writer requires explicit allowedWritePaths".into());
    }
    let caps = tokio::time::timeout(
        Duration::from_secs(20),
        crate::model_capabilities::capabilities(&r.provider, &r.model, false),
    )
    .await
    .map_err(|_| "Capability lookup timed out")??;
    if !caps.supports_chat || (!r.attachments.is_empty() && !caps.supports_vision) {
        return Err("Native vision/chat required; no Sight fallback".into());
    }
    let clamp = run_core::clamp_attachments(std::mem::take(&mut r.attachments));
    if !clamp.omitted.is_empty() {
        return Err("Required attachment omitted".into());
    }
    r.attachments = clamp.kept;
    r.test_after_edit_command = None;
    r.run_id = Some(format!("design-pilot-{}", run_id()));
    r.max_turns = Some(r.max_turns.unwrap_or(6).clamp(1, 8));
    r.num_ctx = Some(16384);
    r.num_predict = Some(r.num_predict.unwrap_or(2048).clamp(1, 4096));
    r.reflection_level = Some("off".into());
    r.auto_approve_commands = Some(false);
    r.require_diff_review = Some(false);
    // Writes are authorized only inside the explicitly isolated pilot workspace.
    // No shell, connectors, advisor, subagent, or dynamic tools enter this pilot.
    let allowed = [
        "read_file",
        "list_dir",
        "search_files",
        "write_file",
        "create_file",
    ];
    let subject = permission::GateSubject::for_mode(AgentMode::Goal);
    r.disabled_tools = tools::list_tools_for_workspace(&subject, Some(&root))
        .into_iter()
        .filter_map(|t| t["function"]["name"].as_str().map(str::to_string))
        .filter(|name| !allowed.contains(&name.as_str()))
        .collect();
    r.disabled_tools
        .extend(["connector_tools".into(), "connector_call".into()]);
    let id = r.run_id.clone().unwrap();
    let budget = Arc::new(Mutex::new(Budget {
        limit: input.max_attempts,
        model: r.model.clone(),
        attempts: vec![],
        output: output.clone(),
        allowed_writes,
    }));
    RUNS.get_or_init(Default::default)
        .lock()
        .unwrap()
        .insert(id.clone(), budget.clone());
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let host = daemon::RunHost::new(
        output.join("data"),
        Arc::new(move |_, _, e| {
            let _ = tx.send(e.clone());
        }),
    );
    let runs = output.join("runs");
    std::fs::create_dir_all(&runs).map_err(|e| e.to_string())?;
    let receipt = json!({"runId":id,"provider":r.provider,"model":r.model,"supportsVision":caps.supports_vision,"maxAttempts":input.max_attempts});
    crate::durable::write_atomic(
        &output.join("admission.json"),
        &serde_json::to_vec_pretty(&receipt).unwrap(),
    )?;
    host.start_design_pilot(r.clone(), runs.clone())?;
    let timer = tokio::time::sleep(Duration::from_secs(input.timeout_secs));
    tokio::pin!(timer);
    let mut reason = "done";
    let mut final_event = false;
    loop {
        tokio::select! {
            _=&mut timer => {reason="budget";let _=host.control(&id,crate::pty_wire::ChatControl::Stop);break},
            _=tokio::signal::ctrl_c() => {reason="cancelled";let _=host.control(&id,crate::pty_wire::ChatControl::Stop);break},
            event=rx.recv()=>{let Some(event)=event else{reason="failed";break};
                match &event {
                    AgentEvent::PermissionRequested{..}|AgentEvent::UserQuestionRequested{..} => {reason="human-decision-required";let _=host.control(&id,crate::pty_wire::ChatControl::Stop);break},
                    AgentEvent::RunError{error,..}=>{reason=if error.message.contains("provider-attempt budget exhausted"){"budget"}else{"failed"};final_event=true;break},
                    AgentEvent::RunResult{result,..}=>{if result["status"]!="done"{reason="incomplete"};final_event=true;break},
                    _=>()
                }
            }
        }
    }
    // Wait for RunLease retirement; never report a still-running writer as settled.
    let end = tokio::time::Instant::now() + Duration::from_secs(8);
    while host.status(&id).0.is_some() && tokio::time::Instant::now() < end {
        tokio::time::sleep(Duration::from_millis(25)).await
    }
    if host.status(&id).0.is_some() {
        reason = "incomplete"
    }
    let events = transcripts::read_events(&runs, &id)?;
    let assistant = events
        .iter()
        .rev()
        .find_map(|e| {
            if let AgentEvent::AssistantMessage { content, .. } = e {
                Some(
                    content
                        .iter()
                        .filter_map(|b| {
                            if let AgentContentBlock::Text { text } = b {
                                Some(text.as_str())
                            } else {
                                None
                            }
                        })
                        .collect::<String>(),
                )
            } else {
                None
            }
        })
        .unwrap_or_default();
    let attempts = budget.lock().unwrap().attempts.clone();
    let report = json!({"schemaVersion":1,"runId":id,"status":reason,"terminalObserved":final_event,"provider":r.provider,"model":r.model,"attempts":attempts,"output":assistant,"events":events.iter().map(|e|{let mut v=serde_json::to_value(e).unwrap();if v["type"]=="user_message" {v.as_object_mut().unwrap().remove("attachments");}v}).collect::<Vec<_>>()});
    crate::durable::write_atomic(
        &output.join("result.json"),
        &serde_json::to_vec_pretty(&report).unwrap(),
    )?;
    println!(
        "{}",
        json!({"runId":id,"status":reason,"attempts":attempts.len(),"report":output.join("result.json")})
    );
    if reason == "done" {
        Ok(())
    } else {
        Err(format!("Run stopped: {reason}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn dispatch_budget_reserves_retries_before_send_and_preserves_image_hashes() {
        let dir = std::env::temp_dir().join(format!("pilot-budget-{}", run_id()));
        std::fs::create_dir(&dir).unwrap();
        let bytes = b"unpredictable-image";
        let builder = reqwest::Client::new()
            .post("http://127.0.0.1:1/api/chat")
            .json(&json!({"model":"fixture","messages":[{"images":[STANDARD.encode(bytes)]}]}));
        let budget = Arc::new(Mutex::new(Budget {
            limit: 2,
            model: "fixture".into(),
            attempts: vec![],
            output: dir.clone(),
            allowed_writes: vec![],
        }));
        ACTIVE
            .scope(budget.clone(), async {
                before_send(&builder, "fixture").await.unwrap();
                before_send(&builder, "fixture").await.unwrap();
                assert!(before_send(&builder, "fixture")
                    .await
                    .unwrap_err()
                    .contains("budget exhausted"));
            })
            .await;
        let saved: Value =
            serde_json::from_slice(&std::fs::read(dir.join("attempts.json")).unwrap()).unwrap();
        assert_eq!(saved["attempts"].as_array().unwrap().len(), 2);
        assert_eq!(saved["attempts"][0]["imageSha256"][0], digest(bytes));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn writer_scope_cannot_edit_other_files_or_escape_through_a_symlink() {
        let dir = std::env::temp_dir().join(format!("pilot-scope-{}", run_id()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        let dir = std::fs::canonicalize(dir).unwrap();
        let id = run_id();
        let b = Arc::new(Mutex::new(Budget {
            limit: 1,
            model: "fixture".into(),
            attempts: vec![],
            output: dir.clone(),
            allowed_writes: vec![dir.join("src/allowed.txt")],
        }));
        RUNS.get_or_init(Default::default)
            .lock()
            .unwrap()
            .insert(id.clone(), b);
        assert!(check_write(&id, dir.to_str().unwrap(), "src/allowed.txt").is_ok());
        assert!(check_write(&id, dir.to_str().unwrap(), "src/other.txt").is_err());
        assert!(check_write(&id, dir.to_str().unwrap(), "../escape").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(std::env::temp_dir(), dir.join("src/link")).unwrap();
            assert!(check_write(&id, dir.to_str().unwrap(), "src/link/escape").is_err());
        }
        RUNS.get().unwrap().lock().unwrap().remove(&id);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
