//! Read-only discovery after the user chooses a connection method. No network
//! scanning, VPN changes, SSH connections or credential reads are performed.
use crate::machines::Machine;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Read;
use std::process::{Command, Stdio};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionMethod {
    Tailscale,
    Ssh,
    Vpn,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    label: String,
    ssh_host: String,
    source: &'static str,
    online: Option<bool>,
    supported: bool,
    detail: String,
    machine: Option<Machine>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    machines: Vec<Candidate>,
    message: String,
}

fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && !host.starts_with('-')
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-@:[]".contains(c))
}

fn ssh_aliases(config: &str) -> Vec<String> {
    let mut aliases = std::collections::BTreeSet::new();
    for line in config.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        let mut parts = line.splitn(2, |c: char| c.is_whitespace() || c == '=');
        if !parts.next().unwrap_or("").eq_ignore_ascii_case("host") {
            continue;
        }
        let Ok(values) = shell_words::split(
            parts
                .next()
                .unwrap_or("")
                .trim_start_matches([' ', '\t', '=']),
        ) else {
            continue;
        };
        for alias in values {
            if valid_host(&alias) {
                aliases.insert(alias);
            }
        }
    }
    aliases.into_iter().take(200).collect()
}

fn known_hosts(saved: Vec<Machine>, config: &str) -> Vec<Candidate> {
    let mut candidates = BTreeMap::new();
    for alias in ssh_aliases(config) {
        candidates.insert(
            alias.clone(),
            Candidate {
                label: alias.clone(),
                ssh_host: alias,
                source: "sshConfig",
                online: None,
                supported: true,
                detail: "SSH configuration".into(),
                machine: None,
            },
        );
    }
    for machine in saved {
        if !valid_host(&machine.ssh_host) {
            continue;
        }
        candidates.insert(
            machine.ssh_host.clone(),
            Candidate {
                label: machine.label().into(),
                ssh_host: machine.ssh_host.clone(),
                source: "saved",
                online: None,
                supported: true,
                detail: "Saved in Klide".into(),
                machine: Some(machine),
            },
        );
    }
    candidates.into_values().take(200).collect()
}

fn tailscale_peers(value: &serde_json::Value, saved: &[Machine]) -> Result<Vec<Candidate>, String> {
    if value["BackendState"].as_str() != Some("Running") {
        return Err("Connect Tailscale on this Mac, then refresh the list. You can also add an address manually.".into());
    }
    let mut peers = BTreeMap::new();
    if let Some(map) = value["Peer"].as_object() {
        for peer in map.values() {
            let ip = peer["TailscaleIPs"].as_array().and_then(|ips| {
                ips.iter()
                    .filter_map(|v| v.as_str())
                    .find(|s| s.parse::<std::net::IpAddr>().is_ok())
            });
            let Some(host) = ip else { continue };
            let dns = peer["DNSName"].as_str().unwrap_or("").trim_end_matches('.');
            let label = peer["HostName"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or(host);
            let os = peer["OS"].as_str().unwrap_or("");
            let existing = saved
                .iter()
                .find(|m| {
                    let address = m.ssh_host.rsplit('@').next().unwrap_or(&m.ssh_host);
                    address == host || (!dns.is_empty() && address == dns)
                })
                .cloned();
            peers.insert(
                host.to_string(),
                Candidate {
                    label: label.into(),
                    ssh_host: host.into(),
                    source: "tailscale",
                    online: peer["Online"].as_bool(),
                    supported: os.is_empty() || matches!(os.to_ascii_lowercase().as_str(), "linux" | "macos" | "windows"),
                    detail: if !os.is_empty() && !matches!(os.to_ascii_lowercase().as_str(), "linux" | "macos" | "windows") {
                        "No native SSH helper for this operating system".into()
                    } else {
                        "Tailscale · SSH check required".into()
                    },
                    machine: existing,
                },
            );
        }
    }
    let mut peers: Vec<_> = peers.into_values().take(200).collect();
    peers.sort_by(|a, b| {
        b.online
            .cmp(&a.online)
            .then_with(|| a.label.to_lowercase().cmp(&b.label.to_lowercase()))
    });
    Ok(peers)
}

fn tailscale_status(binary: &str) -> Result<serde_json::Value, String> {
    let mut child = Command::new(binary)
        .args(["status", "--json"])
        // macOS's bundled executable must run as CLI, never open its GUI.
        .env("TAILSCALE_BE_CLI", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| {
            "Could not read Tailscale. Open Tailscale and connect, then refresh.".to_string()
        })?;
    let output = child.stdout.take().ok_or("No Tailscale output")?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        output
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                "Tailscale did not respond. Check that it is running, then refresh.".into(),
            );
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
    };
    let bytes = reader
        .join()
        .map_err(|_| "Tailscale reader stopped")?
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("Open Tailscale and sign in, then refresh the list. You can also add an address manually.".into());
    }
    if bytes.len() > 1024 * 1024 {
        return Err("Tailscale returned too many devices. Add your machine by address.".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| {
        "Could not read the Tailscale device list. Add your machine by address or refresh.".into()
    })
}

#[tauri::command]
pub async fn machine_discover(method: ConnectionMethod) -> Result<Discovery, String> {
    crate::blocking::run(move || {
        let saved = crate::machines::list();
        if matches!(method, ConnectionMethod::Tailscale) {
            let binary = [Some(std::path::PathBuf::from("/Applications/Tailscale.app/Contents/MacOS/Tailscale")), crate::cli::home_dir_path().map(|home| home.join("Applications/Tailscale.app/Contents/MacOS/Tailscale"))].into_iter().flatten().find(|path| path.is_file()).map(|path| path.to_string_lossy().into_owned()).or_else(|| crate::cli::resolve_command("tailscale").ok());
            let Some(binary) = binary else { return Ok(Discovery { machines: vec![], message: "Install Tailscale and connect this Mac to your network, then refresh. You can also add a Tailscale address manually.".into() }); };
            return Ok(match tailscale_status(&binary).and_then(|value| tailscale_peers(&value, &saved)) {
                Ok(machines) => Discovery { machines, message: "Choose a device on your Tailscale network. The remote machine still needs SSH and a supported OS and architecture.".into() },
                Err(message) => Discovery { machines: vec![], message },
            });
        }
        let config = crate::cli::home_dir_path().and_then(|home| std::fs::File::open(home.join(".ssh/config")).ok()).map(|file| { let mut text = String::new(); let _ = file.take(1024 * 1024).read_to_string(&mut text); text }).unwrap_or_default();
        Ok(Discovery { machines: known_hosts(saved, &config), message: if matches!(method, ConnectionMethod::Vpn) { "Connect WireGuard, ZeroTier, OpenVPN or your VPN first. Choose a saved SSH address or add a private address manually." } else { "Choose a saved machine or a host from your SSH configuration. You can also add any SSH address manually." }.into() })
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_literal_ssh_aliases_are_offered() {
        assert_eq!(ssh_aliases("Host staging prod\n Host * !blocked\nHost=\"home\" # note\nhost dev\nHost -oProxyCommand=bad\n IdentityFile secret"), vec!["dev", "home", "prod", "staging"]);
    }
    #[test]
    fn malformed_or_spaced_host_names_are_not_split_into_fake_devices() {
        assert!(ssh_aliases("Host \"not a host\"\nHost \"unfinished").is_empty());
    }
    #[test]
    fn tailscale_devices_keep_offline_and_unsupported_states_and_reuse_saved_hosts() {
        let saved = Machine {
            id: "dev".into(),
            label: Some("Saved dev".into()),
            ssh_host: "pierre@100.64.0.2".into(),
            checkouts: Default::default(), inference: None,
        };
        let value = serde_json::json!({"BackendState":"Running", "Self":{"HostName":"this-mac"}, "Peer":{
            "a":{"HostName":"linux", "OS":"linux", "TailscaleIPs":["100.64.0.2"], "Online":true},
            "b":{"HostName":"mini", "OS":"macOS", "TailscaleIPs":["100.64.0.3"], "Online":false},
            "w":{"HostName":"windows", "OS":"windows", "TailscaleIPs":["100.64.0.4"], "Online":false},
            "d":{"HostName":"phone", "OS":"android", "TailscaleIPs":["100.64.0.5"], "Online":false},
            "c":{"HostName":"invalid", "TailscaleIPs":["-oProxyCommand=bad"]}
        }});
        let peers = tailscale_peers(&value, &[saved]).unwrap();
        assert_eq!(peers.len(), 4);
        assert_eq!(peers[0].machine.as_ref().unwrap().id, "dev");
        let mini=peers.iter().find(|p|p.label=="mini").unwrap();
        assert!(mini.supported); assert_eq!(mini.online,Some(false));
        assert!(peers.iter().find(|p|p.label=="windows").unwrap().supported);
        assert!(!peers.iter().find(|p|p.label=="phone").unwrap().supported);
        assert!(tailscale_peers(&serde_json::json!({"BackendState":"NeedsLogin"}), &[]).is_err());
    }
}
