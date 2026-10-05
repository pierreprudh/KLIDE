//! Conservative model-fit estimates, separate from measured inference speed.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    pub id: &'static str,
    pub label: &'static str,
    pub download_gb: f64,
    pub memory_gb: f64,
}
// Runtime estimates include weights, an 8k KV cache and working buffers.
const MODELS: &[ModelChoice] = &[
    ModelChoice {
        id: "Qwen/Qwen3-1.7B-GGUF:Q8_0",
        label: "Qwen3 1.7B · Fast",
        download_gb: 1.9,
        memory_gb: 3.5,
    },
    ModelChoice {
        id: "Qwen/Qwen3-4B-GGUF:Q4_K_M",
        label: "Qwen3 4B · Balanced",
        download_gb: 2.5,
        memory_gb: 4.5,
    },
    ModelChoice {
        id: "Qwen/Qwen3-8B-GGUF:Q4_K_M",
        label: "Qwen3 8B · More capable",
        download_gb: 5.0,
        memory_gb: 7.5,
    },
    ModelChoice {
        id: "Qwen/Qwen3-14B-GGUF:Q4_K_M",
        label: "Qwen3 14B · Higher quality",
        download_gb: 9.0,
        memory_gb: 12.0,
    },
    ModelChoice {
        id: "Qwen/Qwen3-32B-GGUF:Q4_K_M",
        label: "Qwen3 32B · Highest quality",
        download_gb: 20.0,
        memory_gb: 25.0,
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
    MODELS
        .iter()
        .enumerate()
        .rev()
        .find(|(i, m)| {
            m.memory_gb <= available
                && (accelerated || (*i <= 1 && machine.cpu_cores >= 4) || *i == 0)
        })
        .map(|(_, m)| m.id)
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
        .unwrap_or_else(|| MODELS[0].id.to_owned())
}
pub(crate) fn launch_args(model: &str) -> Vec<String> {
    vec![
        "-hf".into(),
        model.into(),
        "--alias".into(),
        model.into(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        "8081".into(),
        "--jinja".into(),
        "--ctx-size".into(),
        "8192".into(),
    ]
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
    fn recommendations_reserve_memory_for_other_apps() {
        assert_eq!(recommend(&mac(8.0)), Some(MODELS[0].id));
        assert_eq!(recommend(&mac(16.0)), Some(MODELS[2].id));
        assert_eq!(recommend(&mac(24.0)), Some(MODELS[3].id));
        assert_eq!(recommend(&mac(64.0)), Some(MODELS[4].id));
        assert_eq!(recommend(&mac(4.0)), None);
    }
    #[test]
    fn cpu_and_unknown_machines_do_not_get_large_recommendations() {
        let mut cpu = mac(64.0);
        cpu.acceleration = "CPU";
        assert_eq!(recommend(&cpu), Some(MODELS[1].id));
        cpu.cpu_cores = 2;
        assert_eq!(recommend(&cpu), Some(MODELS[0].id));
        cpu.memory_gb = None;
        assert_eq!(recommend(&cpu), None);
    }
    #[test]
    fn alias_matches_the_selected_model() {
        for model in MODELS {
            let args = launch_args(model.id);
            assert_eq!(args[1], model.id);
            assert_eq!(args[3], model.id);
            assert!(args.iter().any(|a| a == "--jinja"));
        }
    }
}
