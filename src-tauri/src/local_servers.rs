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
            if let Ok(server) = resolve_command("mlx_lm.server") {
                return Ok((server, vec!["--model".to_string(), model]));
            }
            let python = if std::env::consts::OS == "macos" {
                "python3"
            } else {
                "python"
            };
            Ok((
                python.to_string(),
                vec![
                    "-m".to_string(),
                    "mlx_lm.server".to_string(),
                    "--model".to_string(),
                    model,
                ],
            ))
        }
        _ => Err(format!("{provider} is not a local server provider")),
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

    // Already running externally or previously started
    if local_server_ready(&provider).await {
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
}
