//! Conservative model-fit estimates, separate from measured inference speed.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    pub id: &'static str,
    pub label: &'static str,
    pub maker: &'static str,
    pub description: &'static str,
    pub url: &'static str,
    pub quantization: &'static str,
    pub download_gb: f64,
    pub memory_gb: f64,
}
// Runtime estimates include weights, a 16k KV cache and working buffers.
pub const LOCAL_CONTEXT: usize = 16_384;
pub const KLIDE_MODEL: &str = "pierreprudh/klide-8b";
const KLIDE_DIGEST: &str = "c3c0bfb58561fba0d703d7dee5836c9c019a63f48d0980723c40e28a7a97d7b8";
const MODELS: &[ModelChoice] = &[
    ModelChoice {
        id: KLIDE_MODEL,
        label: "Klide 8B",
        maker: "klide",
        description: "Tuned for Klide’s tools and file edits.",
        url: "https://ollama.com/pierreprudh/klide-8b",
        quantization: "Q8_0",
        download_gb: 9.01,
        memory_gb: 12.5,
    },
    ModelChoice {
        id: "Qwen/Qwen3-8B-GGUF:Q4_K_M",
        label: "Qwen3 8B",
        maker: "qwen",
        description: "Reasoning, coding and everyday tasks.",
        url: "https://huggingface.co/Qwen/Qwen3-8B-GGUF",
        quantization: "Q4_K_M",
        download_gb: 5.0,
        memory_gb: 8.0,
    },
    ModelChoice {
        id: "bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M",
        label: "Llama 3.2 3B",
        maker: "meta",
        description: "A light option for everyday conversation.",
        url: "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF",
        quantization: "Q4_K_M",
        download_gb: 2.02,
        memory_gb: 4.0,
    },
    ModelChoice {
        id: "mistralai/Ministral-3-3B-Instruct-2512-GGUF:Q4_K_M",
        label: "Ministral 3 3B",
        maker: "mistral",
        description: "Compact, multilingual instruction following.",
        url: "https://huggingface.co/mistralai/Ministral-3-3B-Instruct-2512-GGUF",
        quantization: "Q4_K_M",
        download_gb: 2.15,
        memory_gb: 4.5,
    },
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    pub chip: String,
    pub memory_gb: Option<f64>,
    pub cpu_cores: usize,
    pub acceleration: &'static str,
}

fn sysctl(key: &str) -> Option<String> {
    let output = std::process::Command::new("/usr/sbin/sysctl")
        .args(["-n", key])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}
fn machine() -> Machine {
    let apple = cfg!(target_os = "macos") && cfg!(target_arch = "aarch64");
    let memory_gb = if cfg!(target_os = "macos") {
        sysctl("hw.memsize")
            .and_then(|s| s.parse::<u64>().ok())
            .map(|b| b as f64 / 1_073_741_824.0)
    } else {
        None
    };
    Machine {
        chip: sysctl("machdep.cpu.brand_string").unwrap_or_else(|| std::env::consts::ARCH.into()),
        memory_gb,
        cpu_cores: std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1),
        acceleration: if apple {
            "Metal · unified memory"
        } else {
            "CPU · conservative estimate"
        },
    }
}
fn budget(machine: &Machine) -> Option<f64> {
    // Leave at least 4 GiB and 35% of RAM for the OS and other applications.
    machine
        .memory_gb
        .map(|ram| (ram * 0.65).min(ram - 4.0).max(0.0))
}
fn recommend(machine: &Machine) -> Option<&'static str> {
    let available = budget(machine)?;
    let accelerated = machine.acceleration.starts_with("Metal");
    // Prefer Klide's tuned model when it fits, then Qwen on Metal.
    // CPU inference favours the two smaller general-purpose models.
    let order = if accelerated {
        [0, 1, 3, 2]
    } else if machine.cpu_cores >= 4 {
        [3, 2, 1, 0]
    } else {
        [2, 3, 1, 0]
    };
    order
        .into_iter()
        .map(|i| &MODELS[i])
        .find(|m| m.memory_gb <= available)
        .map(|m| m.id)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupInfo {
    machine: Machine,
    models: &'static [ModelChoice],
    recommended_model: Option<&'static str>,
    selected_model: Option<String>,
    memory_budget_gb: Option<f64>,
    runtime_installed: bool,
}
#[derive(Serialize, Deserialize)]
struct Config {
    model: String,
}
fn config_path() -> Result<PathBuf, String> {
    crate::cli::home_dir_path()
        .map(|h| h.join(".klide/llamacpp.json"))
        .ok_or("Could not find home directory".into())
}
pub(crate) fn selected_model() -> Option<String> {
    let config: Config = serde_json::from_slice(&std::fs::read(config_path().ok()?).ok()?).ok()?;
    MODELS
        .iter()
        .any(|m| m.id == config.model)
        .then_some(config.model)
}
pub(crate) fn launch_model() -> String {
    selected_model()
        .or_else(|| recommend(&machine()).map(str::to_owned))
        .unwrap_or_else(|| MODELS[2].id.to_owned())
}
pub(crate) fn launch_args(model: &str) -> Vec<String> {
    let source = if model == KLIDE_MODEL {
        vec![
            "-m".into(),
            klide_model_path().to_string_lossy().into_owned(),
        ]
    } else {
        vec!["-hf".into(), model.into()]
    };
    let mut args = source;
    args.extend([
        "--alias".into(),
        model.into(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        "8081".into(),
        "--jinja".into(),
        "--ctx-size".into(),
        LOCAL_CONTEXT.to_string(),
    ]);
    args
}
fn klide_model_path() -> PathBuf {
    crate::cli::home_dir_path()
        .unwrap_or_else(std::env::temp_dir)
        .join(".klide/models")
        .join(format!("klide-8b-{KLIDE_DIGEST}.gguf"))
}

/// The published Ollama model layer is a GGUF, which llama.cpp loads directly.
/// Pin its content digest and verify a streamed download before making it usable.
pub(crate) async fn ensure_model() -> Result<(), String> {
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncWriteExt;
    if launch_model() != KLIDE_MODEL {
        return Ok(());
    }
    let path = klide_model_path();
    if tokio::fs::try_exists(&path)
        .await
        .map_err(|e| e.to_string())?
    {
        return Ok(());
    }
    tokio::fs::create_dir_all(path.parent().unwrap())
        .await
        .map_err(|e| e.to_string())?;
    let url =
        format!("https://registry.ollama.ai/v2/pierreprudh/klide-8b/blobs/sha256:{KLIDE_DIGEST}");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(1800))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Could not download Klide's model: {e}"))?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let partial = path.with_extension("gguf.part");
    let mut file = tokio::fs::File::create(&partial)
        .await
        .map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        hash.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    if format!("{:x}", hash.finalize()) != KLIDE_DIGEST {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err("Klide model download checksum mismatch. Please retry.".into());
    }
    tokio::fs::rename(partial, path)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub(crate) async fn ai_llamacpp_setup_info() -> Result<SetupInfo, String> {
    tokio::task::spawn_blocking(|| {
        let machine = machine();
        let recommended_model = recommend(&machine);
        let memory_budget_gb = budget(&machine);
        SetupInfo {
            machine,
            models: MODELS,
            recommended_model,
            selected_model: selected_model(),
            memory_budget_gb,
            runtime_installed: crate::llamacpp_setup::server_path().is_ok(),
        }
    })
    .await
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub(crate) async fn ai_llamacpp_select_model(model: String) -> Result<(), String> {
    if crate::local_servers::local_server_is_up("llamacpp").await
        && selected_model().as_deref() != Some(model.as_str())
    {
        return Err("Stop llama.cpp before changing its model".into());
    }
    tokio::task::spawn_blocking(move || save_model(model))
        .await
        .map_err(|e| e.to_string())?
}
fn save_model(model: String) -> Result<(), String> {
    static SAVE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = SAVE.lock().map_err(|e| e.to_string())?;
    if !MODELS.iter().any(|m| m.id == model) {
        return Err("Choose a model from the llama.cpp setup list".into());
    }
    let path = config_path()?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(
        &tmp,
        serde_json::to_vec(&Config { model }).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(tmp, path).map_err(|e| e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn mac(ram: f64) -> Machine {
        Machine {
            chip: "Apple M2".into(),
            memory_gb: Some(ram),
            cpu_cores: 8,
            acceleration: "Metal · unified memory",
        }
    }
    #[test]
    fn launched_context_has_room_for_klide_tool_prompt() {
        let args = launch_args(MODELS[2].id);
        let index = args.iter().position(|arg| arg == "--ctx-size").unwrap();
        let context: usize = args[index + 1].parse().unwrap();
        assert!(
            context >= 10_667 + 4096,
            "Live Klide tool prompt must leave output room"
        );
        assert_eq!(
            crate::providers::lookup("llamacpp").unwrap().context_window,
            Some(context)
        );
    }
    #[test]
    fn recommendations_reserve_memory_for_other_apps() {
        assert_eq!(recommend(&mac(8.0)), Some(MODELS[2].id));
        assert_eq!(recommend(&mac(16.0)), Some(MODELS[1].id));
        assert_eq!(recommend(&mac(24.0)), Some(MODELS[0].id));
        assert_eq!(recommend(&mac(64.0)), Some(MODELS[0].id));
        assert_eq!(recommend(&mac(4.0)), None);
    }
    #[test]
    fn cpu_and_unknown_machines_do_not_get_large_recommendations() {
        let mut cpu = mac(64.0);
        cpu.acceleration = "CPU";
        assert_eq!(recommend(&cpu), Some(MODELS[3].id));
        cpu.cpu_cores = 2;
        assert_eq!(recommend(&cpu), Some(MODELS[2].id));
        cpu.memory_gb = None;
        assert_eq!(recommend(&cpu), None);
    }
    #[test]
    fn catalog_has_four_distinct_models_and_the_default_link() {
        assert_eq!(MODELS.len(), 4);
        let ids: std::collections::HashSet<_> = MODELS.iter().map(|m| m.id).collect();
        let makers: std::collections::HashSet<_> = MODELS.iter().map(|m| m.maker).collect();
        assert_eq!(ids.len(), 4);
        assert_eq!(makers.len(), 4);
        assert_eq!(MODELS[0].url, "https://ollama.com/pierreprudh/klide-8b");
        assert_eq!(crate::providers::LLAMACPP_DEFAULT_MODEL, KLIDE_MODEL);
    }
    #[test]
    fn alias_matches_the_selected_model() {
        for model in MODELS {
            let args = launch_args(model.id);
            if model.id == KLIDE_MODEL {
                assert_eq!(args[0], "-m");
                assert!(args[1].ends_with(".gguf"));
            } else {
                assert_eq!(args[1], model.id);
            }
            assert_eq!(args[3], model.id);
            assert!(args.iter().any(|a| a == "--jinja"));
        }
    }
}
