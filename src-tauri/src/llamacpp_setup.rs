//! App-local runtime installation; no package manager or administrator required.
use crate::cli::{home_dir_path, resolve_command};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::time::Duration;

fn runtime_dir() -> Result<PathBuf, String> {
    home_dir_path()
        .map(|h| h.join(".klide/runtimes/llamacpp"))
        .ok_or_else(|| "Could not find your home directory".into())
}

fn find_server(dir: &std::path::Path) -> Option<PathBuf> {
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.is_file() && path.file_name()?.to_str()? == "llama-server" {
            return Some(path);
        }
        if path.is_dir() {
            if let Some(found) = find_server(&path) {
                return Some(found);
            }
        }
    }
    None
}

pub(crate) fn server_path() -> Result<String, String> {
    if let Ok(path) = resolve_command("llama-server") {
        return Ok(path);
    }
    find_server(&runtime_dir()?.join("installed"))
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "llama.cpp is not installed. Use Set up & start on a Mac, or install llama-server on your platform.".into())
}

pub(crate) async fn ensure_installed() -> Result<(), String> {
    static INSTALL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = INSTALL.lock().await;
    if server_path().is_ok() {
        return Ok(());
    }
    if std::env::consts::OS != "macos" {
        return Err("Automatic llama.cpp installation currently supports Mac. Install llama-server and try Start again.".into());
    }
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        _ => return Err("Unsupported Mac architecture".into()),
    };
    let client = reqwest::Client::builder()
        .user_agent("Klide")
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;
    // The latest release may be a source-only tag; search recent binary releases.
    let releases: serde_json::Value = client
        .get("https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10")
        .send()
        .await
        .map_err(|e| format!("Could not check llama.cpp releases: {e}"))?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let suffix = format!("-bin-macos-{arch}.tar.gz");
    let asset = releases
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| r["draft"] != true)
        .flat_map(|r| r["assets"].as_array().into_iter().flatten())
        .find(|a| a["name"].as_str().is_some_and(|n| n.ends_with(&suffix)))
        .ok_or("No compatible official llama.cpp binary release found")?;
    let url = asset["browser_download_url"]
        .as_str()
        .ok_or("Release has no download URL")?;
    if !url.starts_with("https://github.com/ggml-org/llama.cpp/releases/download/") {
        return Err("Unexpected llama.cpp download URL".into());
    }
    let digest = asset["digest"]
        .as_str()
        .and_then(|d| d.strip_prefix("sha256:"))
        .ok_or("Official release is missing its SHA-256 digest")?;
    let bytes = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Could not download llama.cpp: {e}"))?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    if format!("{:x}", Sha256::digest(&bytes)) != digest {
        return Err("llama.cpp download checksum mismatch".into());
    }
    let dir = runtime_dir()?;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let archive = dir.join("runtime.tar.gz");
        let staging = dir.join("staging");
        if staging.exists() {
            std::fs::remove_dir_all(&staging).map_err(|e| e.to_string())?;
        }
        std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
        std::fs::write(&archive, bytes).map_err(|e| e.to_string())?;
        let output = std::process::Command::new("/usr/bin/tar")
            .arg("-xzf")
            .arg(&archive)
            .arg("-C")
            .arg(&staging)
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(format!(
                "Could not unpack llama.cpp: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        if find_server(&staging).is_none() {
            return Err("Downloaded runtime is missing llama-server".into());
        }
        let installed = dir.join("installed");
        if installed.exists() {
            std::fs::remove_dir_all(&installed).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&staging, installed).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(archive);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(())
}

#[tauri::command]
pub(crate) async fn ai_llamacpp_install() -> Result<(), String> {
    ensure_installed().await
}
