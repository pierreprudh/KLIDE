// Local model servers — Ollama and MLX. Klide can start the server
// process on demand (spawn + poll until the HTTP endpoint answers), report
// whether it's up, and stop it. MLX needs extra care: model-id
// canonicalization (Ollama-style tags don't apply) and an HF cache dir so
// downloads land somewhere predictable.

use crate::{home_dir_path, resolve_command, MLX_DEFAULT_MODEL, OLLAMA_URL};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

// ── Local server management (Ollama, MLX) ───────────────────────────────

#[derive(Default)]
pub(crate) struct LocalServerState {
    processes: Mutex<HashMap<String, std::process::Child>>,
}

fn is_local_server_provider(provider: &str) -> bool {
    matches!(provider, "ollama" | "mlx")
}

fn local_server_command(provider: &str, model: &str) -> Result<(String, Vec<String>), String> {
    match provider {
        "ollama" => Ok(("ollama".to_string(), vec!["serve".to_string()])),
        "mlx" => {
            let model = canonical_mlx_model(model);
            // Gemma 4 ships the `gemma4_unified` multimodal arch, which mlx_lm
            // can't load ("Model type gemma4_unified not supported") — only
            // mlx-vlm does. Serve those through mlx_vlm.server, pairing the
            // matching MTP "assistant" drafter for speculative decoding when a
            // working one exists (see mtp_drafter_for).
            if is_gemma4_model(&model) {
                let mut args = vec!["--model".to_string(), model.clone()];
                if let Some(drafter) = mtp_drafter_for(&model) {
                    args.extend([
                        "--draft-model".to_string(),
                        drafter,
                        "--draft-kind".to_string(),
                        "mtp".to_string(),
                    ]);
                }
                return mlx_server_command("mlx_vlm.server", args);
            }
            // Llama / Qwen / gemma-2 presets load fine in the lighter mlx_lm.
            mlx_server_command("mlx_lm.server", vec!["--model".to_string(), model])
        }
        _ => Err(format!("{provider} is not a local server provider")),
    }
}

// Resolve an MLX server entry point: prefer the installed console script, fall
// back to `python -m <module>` so it works even when the script isn't on PATH.
fn mlx_server_command(module: &str, args: Vec<String>) -> Result<(String, Vec<String>), String> {
    if let Ok(server) = resolve_command(module) {
        return Ok((server, args));
    }
    let python = if std::env::consts::OS == "macos" {
        "python3"
    } else {
        "python"
    };
    let mut full = vec!["-m".to_string(), module.to_string()];
    full.extend(args);
    Ok((python.to_string(), full))
}

// Gemma 4 (12B, E4B, …) is the unified multimodal arch that needs mlx-vlm.
fn is_gemma4_model(model: &str) -> bool {
    model.to_lowercase().contains("gemma-4")
}

// The mlx-community MTP drafter for a `…-qat-Nbit` model is the same id with
// `-qat-` → `-qat-assistant-` (e.g. gemma-4-12B-it-qat-4bit →
// gemma-4-12B-it-qat-assistant-4bit), used via mlx_vlm `--draft-kind mtp`.
//
// Only the unified 12B/26B/31B drafters work: the E-series (E2B/E4B) drafter
// is broken upstream in mlx-vlm 0.6.3 (reshape crash in masked_embedder), so
// those return None and run drafter-free. Note: on a 16 GB Mac the 12B + its
// drafter is memory-heavy and may swap/OOM — it fits comfortably with more RAM.
fn mtp_drafter_for(model: &str) -> Option<String> {
    let lower = model.to_lowercase();
    if lower.contains("gemma-4-e") {
        return None;
    }
    if model.contains("-qat-") && !model.contains("assistant") {
        Some(model.replace("-qat-", "-qat-assistant-"))
    } else {
        None
    }
}

fn canonical_mlx_model(model: &str) -> String {
    let trimmed = model.trim();
    if trimmed.is_empty()
        || trimmed.contains(':')
        || (!trimmed.contains('/') && !trimmed.starts_with('.'))
    {
        MLX_DEFAULT_MODEL.to_string()
    } else {
        trimmed.to_string()
    }
}

fn hf_hub_cache_dir() -> Option<PathBuf> {
    std::env::var_os("HF_HUB_CACHE")
        .map(PathBuf::from)
        .or_else(|| home_dir_path().map(|home| home.join(".cache").join("huggingface").join("hub")))
}

fn ensure_mlx_cache_dir() -> Result<Option<PathBuf>, String> {
    let Some(cache_dir) = hf_hub_cache_dir() else {
        return Ok(None);
    };
    std::fs::create_dir_all(&cache_dir).map_err(|e| {
        format!(
            "Failed to create Hugging Face cache dir {}: {e}",
            cache_dir.display()
        )
    })?;
    Ok(Some(cache_dir))
}

fn local_server_stderr_path(provider: &str) -> PathBuf {
    if cfg!(unix) {
        PathBuf::from(format!("/tmp/klide-{provider}-stderr.log"))
    } else {
        std::env::temp_dir().join(format!("klide-{provider}-stderr.log"))
    }
}

async fn mlx_server_ready() -> bool {
    tokio::net::TcpStream::connect("127.0.0.1:8080")
        .await
        .is_ok()
}

// mlx_lm.server opens its HTTP port *before* it downloads/loads the model, so a
// bare TCP check reports "ready" while the first real request still blocks on a
// multi-minute model load (Hugging Face fetch on first run, Metal load after).
// Fire one tiny completion so startup only reports ready once the model truly
// answers — the first user message then hits a warm model instead of eating the
// cold load. Returns false on error; the caller treats warm-up as best-effort.
async fn warm_mlx_model(model: &str) -> bool {
    let body = serde_json::json!({
        "model": model,
        "messages": [{ "role": "user", "content": "hi" }],
        "max_tokens": 1,
        "stream": false,
    });
    reqwest::Client::new()
        .post("http://127.0.0.1:8080/v1/chat/completions")
        .json(&body)
        // First run downloads the weights; give it room before giving up.
        .timeout(Duration::from_secs(600))
        .send()
        .await
        .map(|res| res.status().is_success())
        .unwrap_or(false)
}

async fn local_server_ready(provider: &str) -> bool {
    match provider {
        "ollama" => reqwest::get(format!("{OLLAMA_URL}/api/tags"))
            .await
            .map(|res| res.status().is_success())
            .unwrap_or(false),
        "mlx" => mlx_server_ready().await,
        _ => false,
    }
}

fn local_server_start_attempts(provider: &str) -> usize {
    match provider {
        // First MLX run can include Hugging Face download + Metal model load.
        "mlx" => 360,
        _ => 40,
    }
}

#[tauri::command]
pub(crate) async fn ai_local_server_start(
    provider: String,
    model: String,
    concurrency: Option<u32>,
    state: tauri::State<'_, LocalServerState>,
) -> Result<bool, String> {
    if !is_local_server_provider(&provider) {
        return Err(format!("{provider} is not a local server provider"));
    }

    // Already running externally or previously started. Still warm the model:
    // the port can be up while the model is unloaded / mid-download.
    if local_server_ready(&provider).await {
        if provider == "mlx" {
            let _ = warm_mlx_model(&canonical_mlx_model(&model)).await;
        }
        return Ok(true);
    }

    {
        let procs = state.processes.lock().map_err(|e| e.to_string())?;
        if procs.contains_key(&provider) {
            return Ok(true);
        }
    }

    let (cmd, args) = local_server_command(&provider, &model)?;

    let hf_cache_dir = if provider == "mlx" {
        ensure_mlx_cache_dir()?
    } else {
        None
    };

    let stderr_path = local_server_stderr_path(&provider);
    let stderr_file = std::fs::File::create(&stderr_path)
        .map_err(|e| format!("Failed to create stderr log: {e}"))?;

    let mut command = Command::new(&cmd);
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr_file));
    if let Some(cache_dir) = hf_cache_dir {
        command.env("HF_HUB_CACHE", cache_dir);
    }
    // Ollama reads OLLAMA_NUM_PARALLEL at server launch — how many requests it
    // serves concurrently (e.g. several AI panels at once). Only meaningful for
    // a server Klide launches; an already-running ollama keeps its own value.
    if provider == "ollama" {
        if let Some(n) = concurrency.filter(|n| *n >= 1) {
            command.env("OLLAMA_NUM_PARALLEL", n.to_string());
        }
    }

    let mut child = command.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("Command not found: {cmd}. Make sure {provider} is installed.")
        } else {
            format!("Failed to start {provider}: {e}")
        }
    })?;

    // Quick check for immediate exit (wrong args, missing module, etc.)
    tokio::time::sleep(Duration::from_millis(300)).await;
    if let Ok(Some(status)) = child.try_wait() {
        let stderr = std::fs::read_to_string(&stderr_path).unwrap_or_default();
        let msg = if stderr.trim().is_empty() {
            format!("{provider} exited immediately with {status}")
        } else {
            format!("{provider} exited immediately: {stderr}")
        };
        return Err(msg);
    }

    // MLX first run can take minutes if it has to download and compile/load
    // the model; Ollama usually answers quickly.
    for _ in 0..local_server_start_attempts(&provider) {
        tokio::time::sleep(Duration::from_millis(500)).await;

        match child.try_wait() {
            Ok(Some(_)) => {
                let stderr = std::fs::read_to_string(&stderr_path).unwrap_or_default();
                let msg = if stderr.trim().is_empty() {
                    format!("{provider} process exited before the HTTP port came up")
                } else {
                    format!("{provider} process exited: {stderr}")
                };
                return Err(msg);
            }
            Ok(None) => {}
            Err(e) => return Err(format!("Failed to check {provider} status: {e}")),
        }

        if local_server_ready(&provider).await {
            // Port is up but mlx_lm.server still has to load the model; block on
            // a warm-up so the first user message lands on a ready model.
            if provider == "mlx" {
                let _ = warm_mlx_model(&canonical_mlx_model(&model)).await;
            }
            let mut procs = state.processes.lock().map_err(|e| e.to_string())?;
            procs.insert(provider, child);
            return Ok(true);
        }
    }

    // Timeout — clean up and show last stderr lines
    let _ = child.kill();
    let _ = child.wait();
    let stderr = std::fs::read_to_string(&stderr_path).unwrap_or_default();
    if stderr.trim().is_empty() {
        Ok(false)
    } else {
        Err(format!(
            "{provider} timed out starting. Last stderr:\n{stderr}"
        ))
    }
}

#[tauri::command]
pub(crate) fn ai_local_server_stop(
    provider: String,
    state: tauri::State<'_, LocalServerState>,
) -> Result<bool, String> {
    if !is_local_server_provider(&provider) {
        return Err(format!("{provider} is not a local server provider"));
    }

    let child = {
        let mut procs = state.processes.lock().map_err(|e| e.to_string())?;
        procs.remove(&provider)
    };

    if let Some(mut c) = child {
        let _ = c.kill();
        let _ = c.wait();
    }

    Ok(false)
}

#[tauri::command]
pub(crate) async fn ai_local_server_status(provider: String) -> Result<bool, String> {
    if !is_local_server_provider(&provider) {
        return Ok(false);
    }
    Ok(local_server_ready(&provider).await)
}

/// The signed-in ollama.com account, read from the local daemon. `ollama
/// signin` stores its session with the server, and `POST {OLLAMA_URL}/api/me`
/// (GET answers 405) returns the account JSON when one exists — a pure status
/// read: no browser, no prompt, no token handling on Klide's side.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OllamaAccountStatus {
    running: bool,
    signed_in: bool,
    name: Option<String>,
    plan: Option<String>,
    detail: String,
}

#[tauri::command]
pub(crate) async fn ollama_account_status() -> Result<OllamaAccountStatus, String> {
    let not_signed_in = |running: bool, detail: &str| OllamaAccountStatus {
        running,
        signed_in: false,
        name: None,
        plan: None,
        detail: detail.to_string(),
    };
    let response = reqwest::Client::new()
        .post(format!("{OLLAMA_URL}/api/me"))
        .timeout(Duration::from_secs(4))
        .send()
        .await;
    let response = match response {
        Ok(res) => res,
        Err(_) => {
            return Ok(not_signed_in(
                false,
                "Ollama server is not running — start it in Local AI.",
            ))
        }
    };
    // Signed-out daemons (and older ones without /api/me) answer with an
    // error status; both read as "no account" rather than a hard failure.
    if !response.status().is_success() {
        return Ok(not_signed_in(true, "Not signed in to ollama.com."));
    }
    let body: serde_json::Value = match response.json().await {
        Ok(v) => v,
        Err(_) => return Ok(not_signed_in(true, "Not signed in to ollama.com.")),
    };
    let name = body
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let plan = body
        .get("plan")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let Some(account) = name.clone().or_else(|| {
        body.get("email")
            .and_then(|v| v.as_str())
            .map(str::to_string)
    }) else {
        return Ok(not_signed_in(true, "Not signed in to ollama.com."));
    };
    let detail = match &plan {
        Some(p) => format!("Signed in as {account} · {p} plan"),
        None => format!("Signed in as {account}"),
    };
    Ok(OllamaAccountStatus {
        running: true,
        signed_in: true,
        name,
        plan,
        detail,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mlx_model_canonicalization_rejects_ollama_style_tags() {
        assert_eq!(canonical_mlx_model("gemma4:12b-mlx"), MLX_DEFAULT_MODEL);
        assert_eq!(canonical_mlx_model("gemma-4-4b-it"), MLX_DEFAULT_MODEL);
        assert_eq!(
            canonical_mlx_model("mlx-community/Llama-3.1-8B-Instruct-4bit"),
            "mlx-community/Llama-3.1-8B-Instruct-4bit"
        );
    }

    #[test]
    fn mlx_command_routes_gemma4_to_vlm_and_others_to_lm() {
        // Gemma 4 (unified multimodal arch) must go through mlx_vlm.server.
        for model in [
            "mlx-community/gemma-4-12B-it-qat-4bit",
            "mlx-community/gemma-4-E4B-it-qat-4bit",
        ] {
            let (cmd, args) = local_server_command("mlx", model).unwrap();
            assert!(cmd.contains("mlx_vlm.server") || args.contains(&"mlx_vlm.server".to_string()));
        }

        // Llama / gemma-2 load fine in the lighter mlx_lm.server.
        for model in [
            "mlx-community/Llama-3.1-8B-Instruct-4bit",
            "mlx-community/gemma-2-9b-it-4bit",
        ] {
            let (cmd, args) = local_server_command("mlx", model).unwrap();
            assert!(cmd.contains("mlx_lm.server") || args.contains(&"mlx_lm.server".to_string()));
        }
    }

    #[test]
    fn mtp_drafter_paired_for_unified_12b_but_not_e_series() {
        // 12B unified: MTP drafter wired (its drafter works).
        let (_, args) =
            local_server_command("mlx", "mlx-community/gemma-4-12B-it-qat-4bit").unwrap();
        assert!(args.contains(&"--draft-kind".to_string()));
        assert!(args.contains(&"mtp".to_string()));
        assert!(args.contains(&"mlx-community/gemma-4-12B-it-qat-assistant-4bit".to_string()));

        // E4B: no drafter (broken upstream in mlx-vlm 0.6.3).
        let (_, args) =
            local_server_command("mlx", "mlx-community/gemma-4-E4B-it-qat-4bit").unwrap();
        assert!(!args.contains(&"--draft-kind".to_string()));

        assert_eq!(
            mtp_drafter_for("mlx-community/gemma-4-12B-it-qat-4bit").as_deref(),
            Some("mlx-community/gemma-4-12B-it-qat-assistant-4bit")
        );
        assert_eq!(
            mtp_drafter_for("mlx-community/gemma-4-E4B-it-qat-4bit"),
            None
        );
    }
}
