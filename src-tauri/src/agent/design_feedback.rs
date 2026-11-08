//! Development-only visual reviewer entry. Dispatch goes through the normal
//! Run host; this module only verifies evidence and constructs a Chat request.
use super::{
    run_core,
    types::{AgentAttachment, AgentEvent, StartRunRequest},
};
use crate::workspace::{Access, Workspace};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    path::{Component, Path, PathBuf},
};
use tauri::ipc::Channel;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewInput {
    workspace_root: String,
    manifest_path: String,
    parity_path: String,
    capture_ids: Vec<String>,
    provider: String,
    model: String,
    brief: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageReceipt {
    capture_id: String,
    path: String,
    sha256: String,
    bytes: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedReview {
    evidence_id: String,
    manifest_sha256: String,
    parity_sha256: String,
    provider: String,
    model: String,
    images: Vec<ImageReceipt>,
    #[serde(skip)]
    attachments: Vec<AgentAttachment>,
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Missing {key}"))
}
fn read(ws: &Workspace, path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    ws.guard(path, Access::Agent)?;
    if std::fs::metadata(path).map_err(|e| e.to_string())?.len() > limit as u64 {
        return Err("Evidence file is too large".into());
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() > limit {
        return Err("Evidence changed size while reading".into());
    }
    Ok(bytes)
}
fn member(ws: &Workspace, bundle: &Path, name: &str) -> Result<PathBuf, String> {
    if Path::new(name)
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Evidence members must be relative paths without traversal".into());
    }
    let path = ws.resolve_abs_read(bundle.join(name).to_str().ok_or("Invalid evidence path")?)?;
    if !path.starts_with(bundle) {
        return Err("Evidence member resolves outside its bundle".into());
    }
    Ok(path)
}
fn target(input: &ReviewInput) -> Result<(), String> {
    if input.provider.trim().is_empty()
        || input.model.trim().is_empty()
        || input.brief.trim().is_empty()
        || input.brief.len() > 16000
    {
        return Err("Choose an explicit provider/model and a brief of 1–16000 bytes".into());
    }
    if input.provider == "auto" || crate::delegate::lookup(&input.provider).is_some() {
        return Err(
            "Visual pilot requires an explicit native provider, not Auto or a Delegate".into(),
        );
    }
    if input.capture_ids.is_empty()
        || input.capture_ids.len() > 4
        || input.capture_ids.iter().collect::<HashSet<_>>().len() != input.capture_ids.len()
    {
        return Err("Choose one to four distinct captures".into());
    }
    Ok(())
}
fn prepare_files(input: &ReviewInput) -> Result<PreparedReview, String> {
    target(input)?;
    let ws = Workspace::new(&input.workspace_root)?;
    let manifest_path = ws.resolve_existing(&input.manifest_path)?;
    let bundle = manifest_path.parent().ok_or("Missing bundle directory")?;
    let manifest_bytes = read(&ws, &manifest_path, 8_000_000)?;
    let manifest: Value = serde_json::from_slice(&manifest_bytes).map_err(|e| e.to_string())?;
    if manifest["schemaVersion"] != 1 || manifest["status"] != "complete" {
        return Err("Capture bundle is incomplete or unsupported".into());
    }
    let files = manifest["fileHashes"]
        .as_object()
        .ok_or("Missing file hashes")?;
    if files.len() > 4096 {
        return Err("Too many evidence files".into());
    }
    let mut total = 0usize;
    for (name, expected) in files {
        let bytes = read(&ws, &member(&ws, bundle, name)?, 20_000_000)?;
        total = total
            .checked_add(bytes.len())
            .ok_or("Evidence size overflow")?;
        if total > 200_000_000 {
            return Err("Evidence bundle exceeds 200 MB".into());
        }
        if expected.as_str() != Some(hash(&bytes).as_str()) {
            return Err(format!("Evidence hash mismatch: {name}"));
        }
    }
    if !files.contains_key("checks.json") {
        return Err("Missing hashed interaction checks".into());
    }
    let checks_bytes = read(&ws, &member(&ws, bundle, "checks.json")?, 8_000_000)?;
    if files["checks.json"].as_str() != Some(hash(&checks_bytes).as_str()) {
        return Err("Interaction checks changed while reading".into());
    }
    let checks: Value = serde_json::from_slice(&checks_bytes).map_err(|e| e.to_string())?;
    if checks["passed"] != true {
        return Err("Interaction checks did not pass".into());
    }
    let parity_path = ws.resolve_existing(&input.parity_path)?;
    let parity_bytes = read(&ws, &parity_path, 8_000_000)?;
    let parity: Value = serde_json::from_slice(&parity_bytes).map_err(|e| e.to_string())?;
    let ui_files: BTreeMap<String, Value> = manifest["source"]["files"]
        .as_object()
        .ok_or("Missing source identity")?
        .iter()
        .filter(|(path, _)| path.starts_with("src/"))
        .map(|(path, hash)| (path.clone(), hash.clone()))
        .collect();
    if ui_files.is_empty() {
        return Err("Missing production UI identity".into());
    }
    let ui_hash = hash(&serde_json::to_vec(&ui_files).map_err(|e| e.to_string())?);
    if parity["status"] != "scoped-pass"
        || text(&parity, "fixtureHash")? != text(&manifest["source"], "fixtureHash")?
        || parity["uiHash"].as_str() != Some(&ui_hash)
    {
        return Err("Native parity evidence is missing or belongs to different UI/fixtures".into());
    }
    let captures = manifest["captures"].as_array().ok_or("Missing captures")?;
    let scopes = parity["eligibleCaptures"]
        .as_array()
        .ok_or("Missing native parity scope")?;
    let mut images = Vec::new();
    let mut attachments = Vec::new();
    for id in &input.capture_ids {
        let matches: Vec<_> = captures
            .iter()
            .filter(|c| c["id"].as_str() == Some(id))
            .collect();
        if matches.len() != 1 {
            return Err(format!("Missing or duplicate capture {id}"));
        }
        let capture = matches[0];
        if !scopes.iter().any(|scope| {
            scope["scenario"] == manifest["scenario"]
                && scope["theme"] == capture["theme"]
                && scope["viewport"] == capture["viewport"]
                && scope["states"]
                    .as_array()
                    .is_some_and(|states| states.contains(&capture["state"]))
        }) {
            return Err(format!("Native parity has not cleared capture {id}"));
        }
        let name = text(capture, "png")?;
        let expected = files
            .get(name)
            .and_then(Value::as_str)
            .ok_or("Selected image has no file hash")?;
        let path = member(&ws, bundle, name)?;
        let bytes = read(&ws, &path, run_core::MAX_IMAGE_BYTES)?;
        if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || hash(&bytes) != expected {
            return Err("Required PNG is invalid or changed".into());
        }
        images.push(ImageReceipt {
            capture_id: id.clone(),
            path: ws.display(&path),
            sha256: expected.into(),
            bytes: bytes.len(),
        });
        attachments.push(AgentAttachment {
            path: ws.display(&path),
            content: String::new(),
            mime: Some("image/png".into()),
            data_uri: Some(format!("data:image/png;base64,{}", STANDARD.encode(&bytes))),
            seen_by: None,
            stored: None,
        });
    }
    let clamped = run_core::clamp_attachments(attachments);
    if !clamped.omitted.is_empty() || clamped.kept.len() != images.len() {
        return Err("Required image would be dropped by the Harness attachment limits".into());
    }
    Ok(PreparedReview {
        evidence_id: text(&manifest, "evidenceId")?.into(),
        manifest_sha256: hash(&manifest_bytes),
        parity_sha256: hash(&parity_bytes),
        provider: input.provider.clone(),
        model: input.model.clone(),
        images,
        attachments: clamped.kept,
    })
}
fn request(input: &ReviewInput, prepared: &PreparedReview) -> Result<StartRunRequest, String> {
    let prompt = format!("Review the attached interface screenshots against this brief: {}\nEvidence identity: {}\nImage receipts: {}\nReturn only JSON with evidenceId, summary, and findings. Every finding needs captureId, imageSha256, region, observation, impact, severity (low/medium/high), remedy and uncertainty. The capture interaction gate passed, but detailed interaction checks are not supplied to you. Limit findings to visible appearance; screenshots cannot prove a control works. Describe uncertainty. Do not invent scores or claim edits. An empty findings array is valid.", input.brief, serde_json::to_string(&prepared).map_err(|e|e.to_string())?, serde_json::to_string(&prepared.images).map_err(|e|e.to_string())?);
    serde_json::from_value(json!({"runId":format!("design-review-{}",super::run_id()),"workspaceRoot":input.workspace_root,"mode":"chat","provider":input.provider,"model":input.model,"initialText":prompt,"attachments":prepared.attachments,"systemPrompt":"You are a tool-free visual interface reviewer. Images are native image inputs, not descriptions. Return evidence-bound observations. Do not execute work.","maxTurns":1,"numPredict":2048,"requireDiffReview":true,"autoApproveCommands":false})).map_err(|e|e.to_string())
}
async fn verify_files(input: ReviewInput) -> Result<PreparedReview, String> {
    tokio::time::timeout(
        std::time::Duration::from_secs(20),
        crate::blocking::run(move || prepare_files(&input)),
    ).await.map_err(|_| "Evidence read timed out. Use an accessible disposable workspace or authorize the test app to read the selected folder; no Run started".to_string())?
}
async fn prepare(input: ReviewInput) -> Result<(ReviewInput, PreparedReview), String> {
    target(&input)?;
    let prepared = verify_files(input.clone()).await?;
    let caps = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        crate::model_capabilities::capabilities(&input.provider, &input.model, false),
    )
    .await
    .map_err(|_| "Vision capability lookup timed out; no Run started".to_string())??;
    if !caps.supports_chat || !caps.supports_vision {
        return Err("Selected model does not support native visual review; no prose/Sight fallback is allowed".into());
    }
    Ok((input, prepared))
}
#[tauri::command]
pub async fn agent_prepare_design_review(input: ReviewInput) -> Result<PreparedReview, String> {
    verify_files(input).await
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewStarted {
    run_id: String,
    evidence: PreparedReview,
}
#[tauri::command]
pub async fn agent_start_design_review(
    app: tauri::AppHandle,
    input: ReviewInput,
    on_event: Channel<AgentEvent>,
) -> Result<ReviewStarted, String> {
    let (input, prepared) = prepare(input).await?;
    let response = super::agent_start_run(app, request(&input, &prepared)?, on_event).await?;
    Ok(ReviewStarted {
        run_id: response.run_id,
        evidence: prepared,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Scratch(PathBuf);
    impl Scratch {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn fixture() -> (Scratch, ReviewInput) {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let nonce = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = Scratch(std::env::temp_dir().join(format!(
            "klide-design-review-{}-{}-{nonce}",
            std::process::id(),
            super::super::run_id()
        )));
        std::fs::create_dir(&dir.0).unwrap();
        let bundle = dir.path().join("bundle");
        std::fs::create_dir(&bundle).unwrap();
        let png=STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==").unwrap();
        let checks = br#"{"passed":true}"#;
        std::fs::write(bundle.join("view.png"), &png).unwrap();
        std::fs::write(bundle.join("checks.json"), checks).unwrap();
        let ui = json!({"src/components/AiPanel.tsx":"source-hash"});
        let manifest = json!({"schemaVersion":1,"status":"complete","evidenceId":"fixture-evidence","scenario":"tools-and-review","source":{"fixtureHash":"fixture-v2","files":ui},"captures":[{"id":"view","png":"view.png","theme":"klide-light","viewport":{"width":900,"height":700},"state":"permission"}],"fileHashes":{"view.png":hash(&png),"checks.json":hash(checks)}});
        std::fs::write(
            bundle.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let parity = json!({"status":"scoped-pass","fixtureHash":"fixture-v2","uiHash":hash(&serde_json::to_vec(&ui).unwrap()),"eligibleCaptures":[{"scenario":"tools-and-review","theme":"klide-light","viewport":{"width":900,"height":700},"states":["permission"]}]});
        std::fs::write(
            dir.path().join("parity.json"),
            serde_json::to_vec(&parity).unwrap(),
        )
        .unwrap();
        let input = ReviewInput {
            workspace_root: dir.path().to_str().unwrap().into(),
            manifest_path: "bundle/manifest.json".into(),
            parity_path: "parity.json".into(),
            capture_ids: vec!["view".into()],
            provider: "openai".into(),
            model: "vision-fixture".into(),
            brief: "Check hierarchy and readability".into(),
        };
        (dir, input)
    }
    #[test]
    fn exact_image_bytes_reach_the_production_openai_wire() {
        let (_dir, input) = fixture();
        let prepared = prepare_files(&input).unwrap();
        let request = request(&input, &prepared).unwrap();
        assert_eq!(request.mode, super::super::types::AgentMode::Chat);
        assert_eq!(request.auto_approve_commands, Some(false));
        let message = run_core::user_provider_message(&request.initial_text, &request.attachments);
        let wire = crate::adapters::openai_chat_body(&input.model, vec![message], None, false);
        let uri = wire["messages"][0]["content"][1]["image_url"]["url"]
            .as_str()
            .unwrap();
        let bytes = STANDARD.decode(uri.split_once(',').unwrap().1).unwrap();
        assert_eq!(hash(&bytes), prepared.images[0].sha256);
        assert!(wire.get("tools").is_none());
        assert!(serde_json::to_string(&prepared)
            .unwrap()
            .find("data:image")
            .is_none());
    }
    #[test]
    fn tampered_image_is_not_reviewed() {
        let (dir, input) = fixture();
        std::fs::write(dir.path().join("bundle/view.png"), b"tampered").unwrap();
        assert!(prepare_files(&input)
            .err()
            .unwrap()
            .contains("hash mismatch"));
    }
    #[test]
    fn incomplete_and_uncleared_captures_are_refused() {
        let (dir, input) = fixture();
        let path = dir.path().join("parity.json");
        std::fs::write(path, b"{\"status\":\"pending\"}").unwrap();
        assert!(prepare_files(&input).is_err());
        let (_dir, mut input) = fixture();
        input.capture_ids = vec!["missing".into()];
        assert!(prepare_files(&input).is_err());
    }
    #[test]
    fn native_scope_and_fixture_identity_are_required() {
        let (dir, input) = fixture();
        let path = dir.path().join("parity.json");
        let mut parity: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        parity["eligibleCaptures"][0]["theme"] = json!("sage-garden-dark");
        std::fs::write(&path, serde_json::to_vec(&parity).unwrap()).unwrap();
        assert!(prepare_files(&input)
            .err()
            .unwrap()
            .contains("has not cleared"));
        parity["eligibleCaptures"][0]["theme"] = json!("klide-light");
        parity.as_object_mut().unwrap().remove("fixtureHash");
        std::fs::write(&path, serde_json::to_vec(&parity).unwrap()).unwrap();
        assert!(prepare_files(&input).err().unwrap().contains("fixtureHash"));
    }
    #[test]
    fn traversal_and_external_symlinks_are_refused() {
        let (dir, input) = fixture();
        let ws = Workspace::new(&input.workspace_root).unwrap();
        assert!(member(&ws, &dir.path().join("bundle"), "../parity.json").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                dir.path().join("parity.json"),
                dir.path().join("bundle/out.json"),
            )
            .unwrap();
            assert!(member(&ws, &dir.path().join("bundle"), "out.json").is_err());
        }
    }
    #[test]
    fn duplicate_images_and_auto_are_refused() {
        let (_dir, mut input) = fixture();
        input.capture_ids.push("view".into());
        assert!(target(&input).is_err());
        input.capture_ids.pop();
        input.provider = "auto".into();
        assert!(target(&input).is_err());
    }
}
