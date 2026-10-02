//! Provider gateway — the opencodex proxy, run as a Klide-managed localhost
//! server.
//!
//! opencodex (`ocx`, MIT, `npm install -g opencodex`) is a local proxy that
//! speaks the OpenAI, Anthropic and Codex wires on one port and fans requests
//! out to ~40 upstream providers, authenticated with API keys *or* OAuth
//! logins. Klide needs no new adapter for it: `POST /v1/chat/completions` and
//! `GET /v1/models` are exactly what the custom (self-hosted) provider store
//! already drives, so the gateway lands as one `custom:` endpoint and every
//! surface — Focus, Workbench, Mission Control — sees a normal provider.
//!
//! This module therefore owns only the **process**: is `ocx` installed, is the
//! proxy answering, start it, stop it. Registering the endpoint is the
//! frontend's job (`src/gateway.ts` → `custom_provider_upsert`), which keeps
//! one writer for the custom-provider file.
//!
//! `ocx start` has one side effect Klide does not want: it injects
//! `openai_base_url` into `$CODEX_HOME/config.toml`, so the plain `codex` CLI —
//! and therefore Klide's Codex *delegate* — starts routing through the proxy.
//! Klide talks to the gateway over HTTP directly and needs none of that, so a
//! successful start is immediately followed by `ocx restore`, which un-injects
//! the Codex config while leaving the proxy serving. `gateway_status` reads the
//! config back so the UI can state which way Codex is actually pointed rather
//! than assuming.
//!
//! Stopping goes through `ocx stop` rather than a bare kill for the same
//! reason: the CLI is the only thing that unwinds its own injection.

use crate::cli::resolve_command;
use crate::local_servers::{local_server_stderr_path, LocalServerState};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The binary npm installs for opencodex.
pub(crate) const GATEWAY_BINARY: &str = "ocx";
/// The npm package that provides it. Scoped — a bare `opencodex` install 404s.
pub(crate) const GATEWAY_PACKAGE: &str = "@bitkyc08/opencodex";
/// opencodex's preferred port. It refuses to start a second live instance, so
/// a proxy already answering here is joined, never spawned over.
pub(crate) const GATEWAY_PORT: u16 = 10100;
/// Key under which a Klide-started proxy is filed in the shared registry.
const GATEWAY_KEY: &str = "opencodex";
/// How long a binary lookup is trusted before re-resolving. `resolve_command`
/// can spawn a login shell, and Settings polls status on a timer — without a
/// TTL, an uninstalled `ocx` would fork a shell every few seconds.
const RESOLVE_TTL: Duration = Duration::from_secs(30);
/// Poll budget for a cold start: 40 × 500ms. Node boot + catalog sync, not a
/// model load, so this is seconds rather than the minutes MLX needs.
const START_ATTEMPTS: usize = 40;

/// The OpenAI-compatible base URL to register as a custom provider.
pub(crate) fn gateway_base_url() -> String {
    format!("http://127.0.0.1:{GATEWAY_PORT}/v1")
}

/// opencodex's unauthenticated liveness probe.
fn gateway_health_url() -> String {
    format!("http://127.0.0.1:{GATEWAY_PORT}/healthz")
}

/// What Settings shows for the gateway. `managed` distinguishes "Klide started
/// this" from "something was already listening" — Stop means different things.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GatewayStatus {
    pub installed: bool,
    pub running: bool,
    /// True only when this app owns the process handle.
    pub managed: bool,
    /// Absolute path of the resolved binary, when installed.
    pub command_path: Option<String>,
    /// `http://127.0.0.1:10100/v1`.
    pub base_url: String,
    /// True while `$CODEX_HOME/config.toml` points the Codex CLI at the proxy.
    /// Klide un-injects after every start, so this is normally false — it turns
    /// true only if the injection was re-applied outside Klide.
    pub codex_routed: bool,
    pub detail: String,
    /// Set when a start succeeded but something after it didn't, e.g. the Codex
    /// config could not be un-injected. Never swallowed silently.
    pub warning: Option<String>,
}

// ── Binary resolution (TTL-cached) ──────────────────────────────────────────

static RESOLVED: Mutex<Option<(Instant, Result<String, String>)>> = Mutex::new(None);

fn resolve_gateway_binary() -> Result<String, String> {
    if let Some((at, cached)) = RESOLVED.lock().unwrap().as_ref() {
        if at.elapsed() < RESOLVE_TTL {
            return cached.clone();
        }
    }
    let resolved = resolve_command(GATEWAY_BINARY);
    *RESOLVED.lock().unwrap() = Some((Instant::now(), resolved.clone()));
    resolved
}

/// Resolve off the async runtime — a login-shell lookup is blocking work, and
/// stalling the runtime stalls every other pending `invoke()`.
async fn resolve_gateway_binary_async() -> Result<String, String> {
    tokio::task::spawn_blocking(resolve_gateway_binary)
        .await
        .map_err(|e| format!("Gateway lookup failed: {e}"))?
}

// ── Status ──────────────────────────────────────────────────────────────────

async fn gateway_running() -> bool {
    reqwest::Client::new()
        .get(gateway_health_url())
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .is_ok()
}

/// `$CODEX_HOME/config.toml`, the file `ocx start` injects into — the same
/// file the Codex adapter names for its status hook, so the two can never
/// disagree about where the CLI's config lives.
pub(crate) fn codex_config_path(env: &dyn crate::delegate::Env) -> Option<std::path::PathBuf> {
    use crate::delegate::Delegate;
    crate::delegate::Codex.config_file(env)
}

/// Whether the Codex CLI is currently pointed at the proxy. Read from the file
/// rather than remembered, so a `ocx restore back` run in a terminal — or a
/// leftover injection from before Klide started — is reported truthfully.
fn codex_routed_to_gateway() -> bool {
    let Some(path) = codex_config_path(&crate::delegate::ProcessEnv) else {
        return false;
    };
    let Ok(config) = std::fs::read_to_string(path) else {
        return false;
    };
    config.contains(&format!("openai_base_url = \"{}\"", gateway_base_url()))
}

/// The one place the status wording lives, kept pure so it can be asserted
/// without a proxy on the machine.
fn gateway_detail(installed: bool, running: bool, managed: bool) -> String {
    match (installed, running, managed) {
        (false, false, _) => format!(
            "Not installed. Run `npm install -g {GATEWAY_PACKAGE}`, then `{GATEWAY_BINARY} init`."
        ),
        // Something answers the port without the CLI being on PATH — a service
        // install, or another app squatting 10100. Say so instead of "ready".
        (false, true, _) => format!(
            "Something is answering port {GATEWAY_PORT}, but `{GATEWAY_BINARY}` is not on PATH."
        ),
        (true, false, _) => "Installed and stopped.".to_string(),
        (true, true, true) => format!("Running on port {GATEWAY_PORT}, started by Klide."),
        (true, true, false) => {
            format!("Running on port {GATEWAY_PORT}, started outside Klide.")
        }
    }
}

async fn build_status(managed: bool, warning: Option<String>) -> GatewayStatus {
    let resolved = resolve_gateway_binary_async().await;
    let installed = resolved.is_ok();
    let running = gateway_running().await;
    let codex_routed = tokio::task::spawn_blocking(codex_routed_to_gateway)
        .await
        .unwrap_or(false);
    GatewayStatus {
        installed,
        running,
        managed: managed && running,
        command_path: resolved.ok(),
        base_url: gateway_base_url(),
        codex_routed,
        detail: gateway_detail(installed, running, managed && running),
        warning,
    }
}

/// Whether Klide still owns a live proxy process. Reaps the handle when the
/// process has exited on its own, so "managed" never reports a zombie.
fn reap_managed(state: &LocalServerState) -> Result<bool, String> {
    let mut procs = state.processes().lock().map_err(|e| e.to_string())?;
    let Some(child) = procs.get_mut(GATEWAY_KEY) else {
        return Ok(false);
    };
    match child.try_wait() {
        Ok(Some(_)) => {
            procs.remove(GATEWAY_KEY);
            Ok(false)
        }
        Ok(None) => Ok(true),
        Err(e) => Err(format!("Failed to check {GATEWAY_BINARY} status: {e}")),
    }
}

#[tauri::command]
pub(crate) async fn gateway_status(
    state: tauri::State<'_, LocalServerState>,
) -> Result<GatewayStatus, String> {
    let managed = reap_managed(&state)?;
    Ok(build_status(managed, None).await)
}

// ── Start / stop ────────────────────────────────────────────────────────────

#[tauri::command]
pub(crate) async fn gateway_start(
    state: tauri::State<'_, LocalServerState>,
) -> Result<GatewayStatus, String> {
    // Already up (externally, or from an earlier start). opencodex refuses a
    // second live instance, so joining is the only correct move.
    if gateway_running().await {
        let managed = reap_managed(&state)?;
        return Ok(build_status(managed, None).await);
    }
    if reap_managed(&state)? {
        return Ok(build_status(true, None).await);
    }

    let binary = resolve_gateway_binary_async().await?;
    let stderr_path = local_server_stderr_path(GATEWAY_KEY);
    let stderr_file = std::fs::File::create(&stderr_path)
        .map_err(|e| format!("Failed to create stderr log: {e}"))?;

    // `ocx start` runs in the foreground and holds the port; the service
    // manager route (`ocx service install`) is deliberately not used, so the
    // proxy's lifetime stays visible in this app rather than in launchd.
    let mut child = Command::new(&binary)
        .arg("start")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr_file))
        .spawn()
        .map_err(|e| format!("Failed to start {GATEWAY_BINARY}: {e}"))?;

    let fail = |child: &mut std::process::Child, prefix: &str| -> String {
        let _ = child.kill();
        let _ = child.wait();
        let stderr = std::fs::read_to_string(&stderr_path).unwrap_or_default();
        if stderr.trim().is_empty() {
            prefix.to_string()
        } else {
            format!("{prefix}\n{stderr}")
        }
    };

    // Wrong flags, an un-run `ocx init`, or a port clash all exit at once.
    tokio::time::sleep(Duration::from_millis(300)).await;
    if let Ok(Some(status)) = child.try_wait() {
        return Err(fail(
            &mut child,
            &format!("{GATEWAY_BINARY} exited immediately with {status}."),
        ));
    }

    for _ in 0..START_ATTEMPTS {
        tokio::time::sleep(Duration::from_millis(500)).await;
        match child.try_wait() {
            Ok(Some(_)) => {
                return Err(fail(
                    &mut child,
                    &format!("{GATEWAY_BINARY} exited before the proxy port came up."),
                ))
            }
            Ok(None) => {}
            Err(e) => return Err(format!("Failed to check {GATEWAY_BINARY} status: {e}")),
        }
        if gateway_running().await {
            state
                .processes()
                .lock()
                .map_err(|e| e.to_string())?
                .insert(GATEWAY_KEY.to_string(), child);
            return Ok(build_status(true, restore_native_codex(&binary).await).await);
        }
    }

    Err(fail(
        &mut child,
        &format!("{GATEWAY_BINARY} timed out starting on port {GATEWAY_PORT}."),
    ))
}

/// Undo the Codex config injection `ocx start` performs, leaving the proxy
/// serving. Klide reaches the gateway over HTTP, so it has no use for the
/// injection — and silently repointing the user's `codex` CLI (and the Codex
/// delegate under it) would be a surprise. Returns a warning to carry into the
/// status when the un-injection failed; a *stale* injection is worse than none,
/// so the failure is reported rather than swallowed.
async fn restore_native_codex(binary: &str) -> Option<String> {
    let binary = binary.to_string();
    let output = tokio::task::spawn_blocking(move || {
        Command::new(&binary).arg("restore").output()
    })
    .await;
    let failed = match output {
        Err(e) => Some(format!("restore task failed: {e}")),
        Ok(Err(e)) => Some(format!("could not run `{GATEWAY_BINARY} restore`: {e}")),
        Ok(Ok(out)) if !out.status.success() => {
            Some(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
        Ok(Ok(_)) => None,
    }?;
    Some(format!(
        "The Codex CLI is still routed through the gateway — {failed}. \
         Run `{GATEWAY_BINARY} restore` to point it back at OpenAI."
    ))
}

#[tauri::command]
pub(crate) async fn gateway_stop(
    state: tauri::State<'_, LocalServerState>,
) -> Result<GatewayStatus, String> {
    // `ocx stop` is the only clean shutdown: it stops the proxy by PID *and*
    // strips the Codex config injection. A bare kill would leave the Codex CLI
    // (and Klide's Codex delegate) pointed at a dead port.
    let stop_error = match resolve_gateway_binary_async().await {
        Ok(binary) => tokio::task::spawn_blocking(move || Command::new(&binary).arg("stop").output())
            .await
            .map_err(|e| format!("{GATEWAY_BINARY} stop task failed: {e}"))?
            .map_err(|e| format!("Failed to run `{GATEWAY_BINARY} stop`: {e}"))
            .and_then(|out| {
                if out.status.success() {
                    Ok(())
                } else {
                    Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
                }
            })
            .err(),
        Err(e) => Some(e),
    };

    // Reap our own handle either way — the CLI may have stopped a proxy that
    // isn't the child we spawned.
    let child = state
        .processes()
        .lock()
        .map_err(|e| e.to_string())?
        .remove(GATEWAY_KEY);
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }

    let status = build_status(false, None).await;
    if status.running {
        let reason = stop_error.unwrap_or_default();
        return Err(if reason.is_empty() {
            format!("Port {GATEWAY_PORT} is still answering after stop.")
        } else {
            format!("Could not stop opencodex: {reason}")
        });
    }
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_is_the_openai_wire_root_the_custom_store_expects() {
        // `custom_providers::CustomProvider::chat_url` appends
        // `/chat/completions`, so the registered base must stop at `/v1`.
        assert_eq!(gateway_base_url(), "http://127.0.0.1:10100/v1");
        assert_eq!(gateway_health_url(), "http://127.0.0.1:10100/healthz");
    }

    #[test]
    fn detail_separates_not_installed_from_squatted_port() {
        // The scoped package name — `npm i -g opencodex` 404s.
        assert!(gateway_detail(false, false, false).contains("npm install -g @bitkyc08/opencodex"));
        // A live port without the CLI is not "ready" — say what was seen.
        assert!(gateway_detail(false, true, false).contains("not on PATH"));
        assert_eq!(gateway_detail(true, false, false), "Installed and stopped.");
        assert!(gateway_detail(true, true, true).contains("started by Klide"));
        assert!(gateway_detail(true, true, false).contains("started outside Klide"));
    }
}
