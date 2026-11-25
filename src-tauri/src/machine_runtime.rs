//! Remote execution and credential choices. Isolation is an actual mountless
//! Docker Sandbox; a failure never retries the command on the SSH host.
use crate::{
    delegate::shell_quote,
    machines::Machine,
    remote_platform::{HostOs, HostTarget},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Execution {
    #[default]
    Direct,
    Isolated,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Credential {
    #[default]
    Existing,
    Subscription,
    ApiKey,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRuntime {
    #[serde(default)]
    pub execution: Execution,
    #[serde(default)]
    pub credential: Credential,
}
impl RemoteRuntime {
    pub fn isolated(&self) -> bool {
        self.execution == Execution::Isolated
    }
}

/// Hashing avoids name length/character issues and makes one stable sandbox
/// per saved machine. Never accept a user-supplied shell command as a runtime.
pub fn sandbox_name(id: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("klide-{:x}", Sha256::digest(id.as_bytes()))[..30].to_string()
}
pub fn runtime_sandbox(id: &str, runtime: &RemoteRuntime) -> String {
    format!(
        "{}-{}",
        sandbox_name(id),
        match runtime.credential {
            Credential::Existing => "existing",
            Credential::Subscription => "subscription",
            Credential::ApiKey => "api",
        }
    )
}
pub fn host_data(id: &str, runtime: &RemoteRuntime) -> String {
    if *runtime == RemoteRuntime::default() {
        return "~/.klide/run-host".into();
    }
    format!(
        "~/.klide/run-host/{}-{}",
        sandbox_name(id),
        match runtime.credential {
            Credential::Existing => "existing",
            Credential::Subscription => "subscription",
            Credential::ApiKey => "api",
        }
    )
}
pub fn binary(id: &str, runtime: &RemoteRuntime, os: HostOs) -> String {
    if *runtime == RemoteRuntime::default() {
        return os.binary().into();
    }
    format!(
        "{}/{}",
        host_data(id, runtime),
        if os == HostOs::Windows {
            "klide.exe"
        } else {
            "klide"
        }
    )
}
pub fn install_sandbox(os: HostOs) -> Result<String, String> {
    match os {
        HostOs::Macos => Ok("set -eu; test \"$(uname -m)\" = arm64 || { echo 'Docker Sandboxes needs an Apple silicon Mac' >&2; exit 1; }; export PATH=\"/opt/homebrew/bin:/usr/local/bin:$PATH\"; if ! command -v brew >/dev/null; then echo 'Install Homebrew, then retry.' >&2; exit 1; fi; brew install docker/tap/sbx".into()),
        HostOs::Linux => Ok(r#"set -eu
if ! test -r /dev/kvm || ! test -w /dev/kvm; then echo 'Local isolation requires accessible /dev/kvm. Enable KVM or nested virtualization with your VPS provider, then retry. Direct execution is available without KVM.' >&2; exit 1; fi
if test "$(id -u)" = 0; then elevate=''; else elevate=sudo; fi
$elevate apt-get update
$elevate apt-get install -y curl ca-certificates
installer=$(mktemp)
trap 'rm -f "$installer"' EXIT
curl --fail --silent --show-error https://get.docker.com -o "$installer"
$elevate env REPO_ONLY=1 sh "$installer"
$elevate apt-get install -y docker-sbx
"#.into()),
        HostOs::Windows => Err("Use Linux or Apple silicon for isolated setup".into()),
    }
}

const PATH: &str = "export PATH=\"$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\";";

pub fn wrap(id: &str, runtime: &RemoteRuntime, command: &str, interactive: bool) -> String {
    if !runtime.isolated() {
        return command.into();
    }
    let marker = crate::machines::remote_path_word(&format!(
        "~/.klide/sandboxes/{}",
        runtime_sandbox(id, runtime)
    ));
    let flags = if interactive { "-it" } else { "-i" };
    format!("{PATH} test -f {marker} || {{ echo 'Prepare the isolated environment in machine setup first' >&2; exit 1; }}; exec sbx --no-input exec {flags} {} bash -lc {}", shell_quote(&runtime_sandbox(id, runtime)), shell_quote(command))
}
pub fn ssh(machine: &Machine, command: &str) -> Result<std::process::Output, String> {
    crate::machines::validate_machine(machine)?;
    crate::machine_install::ssh(
        &machine.ssh_host,
        &wrap(&machine.id, &machine.runtime, command, false),
    )
}
pub fn target(machine: &Machine) -> Result<HostTarget, String> {
    if !machine.runtime.isolated() {
        return crate::machine_install::detect_target(&machine.ssh_host);
    }
    let out = ssh(machine, "uname -sm")?;
    crate::remote_platform::parse_system(&String::from_utf8_lossy(&out.stdout))
}

/// Applies to the probe, sign-in and detached host alike. Explicit modes do
/// not inherit API credentials or alternative provider settings from a shell.
pub fn credential_context(id: &str, runtime: &RemoteRuntime, os: HostOs) -> String {
    if runtime.credential == Credential::Existing {
        return String::new();
    }
    let profile = format!(
        "~/.klide/machine-auth/{}/{}",
        sandbox_name(id),
        if runtime.credential == Credential::ApiKey {
            "api"
        } else {
            "subscription"
        }
    );
    if os == HostOs::Windows {
        let key = if runtime.credential == Credential::ApiKey {
            "$env:KLIDE_REMOTE_API_KEY_FILE=(Join-Path $env:CLAUDE_CONFIG_DIR 'api-key'); $env:ANTHROPIC_API_KEY=''; if (Test-Path -LiteralPath (Join-Path $env:CLAUDE_CONFIG_DIR 'api-key')) { $env:ANTHROPIC_API_KEY=[IO.File]::ReadAllText((Join-Path $env:CLAUDE_CONFIG_DIR 'api-key')).Trim() };"
        } else {
            ""
        };
        return format!("foreach ($n in @('ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY','KLIDE_REMOTE_API_KEY_FILE')) {{ Remove-Item -LiteralPath ('Env:'+ $n) -ErrorAction SilentlyContinue }}; $env:CLAUDE_CONFIG_DIR={}; {key}", crate::remote_platform::ps_path(&profile));
    }
    let key = if runtime.credential == Credential::ApiKey {
        if runtime.isolated() {
            "export ANTHROPIC_API_KEY=proxy-managed;"
        } else {
            "export KLIDE_REMOTE_API_KEY_FILE=\"$CLAUDE_CONFIG_DIR/api-key\"; export ANTHROPIC_API_KEY=\"$(cat \"$CLAUDE_CONFIG_DIR/api-key\" 2>/dev/null)\";"
        }
    } else {
        ""
    };
    format!("unset KLIDE_REMOTE_API_KEY_FILE ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_BASE_URL CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY; export CLAUDE_CONFIG_DIR={}; {key}", crate::machines::remote_path_word(&profile))
}

pub fn prepare_isolation(machine: &Machine, os: HostOs) -> Result<String, String> {
    if os == HostOs::Windows {
        return Err("Use an SSH-accessible Linux or Apple silicon host for isolated setup. Windows direct execution remains available.".into());
    }
    let install = install_sandbox(os)?;
    let name = shell_quote(&runtime_sandbox(&machine.id, &machine.runtime));
    let marker = crate::machines::remote_path_word(&format!(
        "~/.klide/sandboxes/{}",
        runtime_sandbox(&machine.id, &machine.runtime)
    ));
    // No workspace argument, shared skills, MCP servers, port publication or
    // host mounts. Docker's proxy, hypervisor and private-network defaults own
    // the isolation; do not replace them with a shell permission prompt.
    Ok(format!(
        r#"set -eu
{PATH}
if ! command -v sbx >/dev/null 2>&1; then
  {install}
fi
marker={marker}
if sbx --no-input inspect {name} >/dev/null 2>&1; then
  if ! test -f "$marker"; then echo 'An unmanaged sandbox already has this name. Choose another saved machine; Klide will not adopt or delete it.' >&2; exit 1; fi
else
  sbx login
  sbx create --name {name} --skills off --static-mcp none claude
  umask 077
  mkdir -p "$(dirname "$marker")"
  printf '%s' mountless > "$marker"
fi
sbx --no-input exec {name} true
printf 'Isolated environment ready. Host folders and personal logins were not mounted.\n'
"#
    ))
}

#[derive(Serialize)]
pub struct KeyChoice {
    pub id: String,
    pub label: String,
}
#[tauri::command]
pub async fn machine_api_keys() -> Result<Vec<KeyChoice>, String> {
    crate::blocking::run(|| {
        let saved = crate::provider_keys::list("anthropic");
        let legacy_slot = saved.keys.is_empty();
        let mut keys: Vec<_> = saved
            .keys
            .into_iter()
            .filter(|k| k.reference.is_none())
            .map(|k| KeyChoice {
                id: k.id,
                label: k.label,
            })
            .collect();
        if legacy_slot && crate::providers::main_slot_has_keychain_key("anthropic") {
            keys.push(KeyChoice {
                id: "main".into(),
                label: "Main Anthropic key".into(),
            });
        }
        Ok(keys)
    })
    .await
}
fn selected_key(id: &str) -> Result<String, String> {
    let saved = crate::provider_keys::list("anthropic");
    if id == "main" && saved.keys.is_empty() {
        return crate::providers::read_main_slot_key("anthropic")
            .ok_or("The Anthropic key is no longer available".into());
    }
    let key = saved
        .keys
        .iter()
        .find(|k| k.id == id && k.reference.is_none())
        .ok_or("Choose a saved Anthropic API key")?;
    crate::providers::read_keychain_secret(&format!("anthropic#{}", key.id))
        .ok_or("The selected key is no longer available in Keychain".into())
}
#[tauri::command]
pub async fn machine_authorize_api_key(id: String, key_id: String) -> Result<(), String> {
    crate::blocking::run(move || {
        let machine = crate::machines::get(&id).ok_or("Machine is no longer configured")?;
        crate::machines::validate_machine(&machine)?;
        if machine.runtime.credential != Credential::ApiKey { return Err("Select API key authentication before authorizing a key".into()); }
        let secret = selected_key(&key_id)?;
        if secret.trim().is_empty() || secret.contains(['\r', '\n', '\0']) { return Err("The saved API key is invalid".into()); }
        let os = target(&machine)?.os;
        let command = if machine.runtime.isolated() {
            format!("{PATH} sbx secret set anthropic --sandbox {} --force", shell_quote(&runtime_sandbox(&machine.id, &machine.runtime)))
        } else if os == HostOs::Windows {
            os.command(&format!("$ErrorActionPreference='Stop'; $p={}; New-Item -ItemType Directory -Force -Path $p | Out-Null; & icacls $p /inheritance:r /grant:r ($env:USERNAME+':(OI)(CI)F') | Out-Null; if ($LASTEXITCODE -ne 0) {{ throw 'Could not protect credential directory' }}; $value=[Console]::In.ReadToEnd(); [IO.File]::WriteAllText((Join-Path $p 'api-key'),$value)", crate::remote_platform::ps_path(&format!("~/.klide/machine-auth/{}/api", sandbox_name(&machine.id)))))
        } else {
            format!("set -eu; umask 077; p={}; mkdir -p \"$p\"; chmod 700 \"$p\"; t=$(mktemp \"$p/key.XXXXXX\"); trap 'rm -f \"$t\"' EXIT; cat > \"$t\"; chmod 600 \"$t\"; mv -f \"$t\" \"$p/api-key\"", crate::machines::remote_path_word(&format!("~/.klide/machine-auth/{}/api", sandbox_name(&machine.id))))
        };
        // Neither the secret nor a remote diagnostic may cross IPC. SSH stdin
        // carries it with no TTY, shell interpolation, argv or temporary Mac file.
        crate::machine_install::ssh_input(&machine.ssh_host, &command, secret.into_bytes())
            .map_err(|_| "Could not authorize the selected key on this machine. Check the connection and credential storage, then retry.".to_string())?;
        if machine.runtime.isolated() {
            let receipt = format!("~/.klide/machine-auth/{}/api-authorized", sandbox_name(&machine.id));
            crate::machine_install::ssh(&machine.ssh_host, &format!("set -eu; umask 077; p={}; mkdir -p \"$(dirname \"$p\")\"; printf '%s' {} > \"$p\"", crate::machines::remote_path_word(&receipt), shell_quote(&key_id)))?;
        }
        Ok(())
    }).await
}

pub fn api_key_authorized(machine: &Machine, os: HostOs) -> bool {
    let path = if machine.runtime.isolated() {
        format!(
            "~/.klide/machine-auth/{}/api-authorized",
            sandbox_name(&machine.id)
        )
    } else {
        format!(
            "~/.klide/machine-auth/{}/api/api-key",
            sandbox_name(&machine.id)
        )
    };
    let command = if os == HostOs::Windows {
        os.command(&format!(
            "if (!(Test-Path -LiteralPath {})) {{ exit 1 }}",
            crate::remote_platform::ps_path(&path)
        ))
    } else {
        format!("test -s {}", crate::machines::remote_path_word(&path))
    };
    crate::machine_install::ssh(&machine.ssh_host, &command).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_machines_keep_direct_execution_and_existing_credentials() {
        let machine: Machine =
            serde_json::from_str(r#"{"id":"old","sshHost":"dev@mini"}"#).unwrap();
        assert_eq!(machine.runtime, RemoteRuntime::default());
        assert_eq!(wrap("old", &machine.runtime, "echo hi", false), "echo hi");
        assert_eq!(host_data("old", &machine.runtime), "~/.klide/run-host");
    }
    #[test]
    fn isolation_wraps_the_entire_command_and_never_falls_back() {
        let runtime = RemoteRuntime {
            execution: Execution::Isolated,
            credential: Credential::ApiKey,
        };
        let command = wrap("id;$(touch /tmp/nope)", &runtime, "cat 'a'; echo b", false);
        assert!(command.contains("exec sbx --no-input exec -i 'klide-"));
        assert!(!command.contains("|| sh"));
        assert!(command.contains("exit 1; }; exec sbx"));
        assert!(!command.contains("touch"));
        assert_ne!(host_data("one", &runtime), host_data("two", &runtime));
        assert!(credential_context("one", &runtime, HostOs::Linux)
            .contains("ANTHROPIC_API_KEY=proxy-managed"));
    }
    #[cfg(unix)]
    #[test]
    fn failing_sandbox_preserves_exit_status_without_executing_on_host() {
        use std::os::unix::fs::PermissionsExt;
        let root =
            std::env::temp_dir().join(format!("klide-runtime-{}", crate::pty_host::now_ms()));
        std::fs::create_dir_all(root.join(".local/bin")).unwrap();
        std::fs::create_dir_all(root.join(".klide/sandboxes")).unwrap();
        let fake = root.join(".local/bin/sbx");
        std::fs::write(&fake, "#!/bin/sh\ncat >/dev/null\nexit 43\n").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o700)).unwrap();
        let runtime = RemoteRuntime {
            execution: Execution::Isolated,
            credential: Credential::Subscription,
        };
        std::fs::write(
            root.join(".klide/sandboxes")
                .join(runtime_sandbox("test", &runtime)),
            "mountless",
        )
        .unwrap();
        let marker = root.join("must-not-exist");
        let command = wrap(
            "test",
            &runtime,
            &format!("touch {}", shell_quote(marker.to_str().unwrap())),
            false,
        );
        let output = std::process::Command::new("sh")
            .args(["-c", &command])
            .env("HOME", &root)
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(43));
        assert!(
            !marker.exists(),
            "an isolated command must never run on the parent host"
        );
        std::fs::remove_file(
            root.join(".klide/sandboxes")
                .join(runtime_sandbox("test", &runtime)),
        )
        .unwrap();
        let output = std::process::Command::new("sh")
            .args(["-c", &command])
            .env("HOME", &root)
            .output()
            .unwrap();
        assert!(
            !output.status.success(),
            "unmanaged or missing environments fail closed"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn credential_modes_have_distinct_sandboxes_and_hosts() {
        let mut runtime = RemoteRuntime {
            execution: Execution::Isolated,
            credential: Credential::Subscription,
        };
        let subscription = (
            runtime_sandbox("mini", &runtime),
            host_data("mini", &runtime),
            binary("mini", &runtime, HostOs::Linux),
        );
        runtime.credential = Credential::ApiKey;
        assert_ne!(subscription.0, runtime_sandbox("mini", &runtime));
        assert_ne!(subscription.1, host_data("mini", &runtime));
        assert_ne!(subscription.2, binary("mini", &runtime, HostOs::Linux));
    }
    #[test]
    fn explicit_subscription_scrubs_inherited_api_authentication() {
        let runtime = RemoteRuntime {
            execution: Execution::Direct,
            credential: Credential::Subscription,
        };
        for os in [HostOs::Linux, HostOs::Macos, HostOs::Windows] {
            let context = credential_context("one", &runtime, os);
            assert!(context.contains("ANTHROPIC_API_KEY"));
            assert!(context.contains("CLAUDE_CONFIG_DIR"));
            assert!(context.contains("subscription"));
            assert!(!context.contains("proxy-managed"));
        }
    }
}
