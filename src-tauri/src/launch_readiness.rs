//! Whether a launch target can start on this machine right now — one answer
//! built from the checks that already exist, never a second copy of them.
//!
//! A target is a Provider id plus the model string a Run or Delegate would be
//! started with. The answer is one of five words with a reason and the time it
//! was observed: a CLI that does not resolve, a Delegate that is not logged
//! in, a hosted row with no key, a managed local server that is down, a
//! self-hosted endpoint that does not answer. A Delegate routed to another
//! source (`harness-source:`) is judged on that source — the bridge supplies
//! the credential, so the CLI's own login does not matter.
//!
//! Dispatch rechecks right before it starts anything and refuses only a
//! definite "no": `unknown` means Klide cannot tell, and the launch itself is
//! the check. The same answer is the shape a remote host will report later.

use serde::Serialize;
use std::path::Path;
use std::time::Duration;

use crate::providers::ProviderGroup;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Ready,
    /// Cannot run here at all: not installed, unknown id, or a pairing with
    /// no adapter.
    Unsupported,
    /// Installed but missing its credential: a CLI login or an API key.
    NeedsLogin,
    /// The server or endpoint it talks to is not answering.
    Offline,
    /// Klide has no check for it; the launch will tell.
    Unknown,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Readiness {
    pub provider: String,
    pub state: State,
    pub reason: String,
    /// Unix ms when the checks ran.
    pub observed_at: i64,
}

impl Readiness {
    /// A definite "it will not start" — the only answer dispatch refuses on.
    pub fn blocks_dispatch(&self) -> bool {
        matches!(self.state, State::Unsupported | State::NeedsLogin | State::Offline)
    }
}

/// Check `provider` with the `model` it would launch with. `scope` is the
/// Workspace whose `.env` may supply a key reference.
pub async fn check(provider: &str, model: Option<&str>, scope: Option<&Path>) -> Readiness {
    let (state, reason) = answer(provider, model.unwrap_or(""), scope).await;
    Readiness {
        provider: provider.to_string(),
        state,
        reason,
        observed_at: crate::agent::transcripts::now_ms(),
    }
}

async fn answer(provider: &str, model: &str, scope: Option<&Path>) -> (State, String) {
    if crate::agent::routing::is_auto(provider) {
        return (State::Unknown, "Auto picks a ready model when the run starts.".into());
    }
    if let Some(custom) = crate::custom_cli::get(provider) {
        let binary = custom.binary();
        let resolved = crate::blocking::run(move || crate::cli::resolve_command(&binary)).await;
        return match resolved {
            Ok(_) => (State::Ready, format!("{} is installed.", custom.label)),
            Err(error) => (State::Unsupported, error),
        };
    }
    if crate::delegate::lookup(provider).is_some() {
        return delegate(provider, model, scope).await;
    }
    source(provider, scope).await
}

/// A Delegate CLI: installed, then either its routed source or its own login.
async fn delegate(id: &str, model: &str, scope: Option<&Path>) -> (State, String) {
    let routed = match crate::harness_source::intelligence(model) {
        Ok(routed) => routed,
        Err(error) => return (State::Unsupported, error),
    };
    if let Some(selection) = &routed {
        let support = crate::harness_source::support(id, &selection.provider);
        if !support.supported {
            return (State::Unsupported, support.reason.unwrap_or_else(|| "Unsupported agent and source pair.".into()));
        }
    }
    let harness = id.to_string();
    let is_routed = routed.is_some();
    let checked = crate::blocking::run(move || {
        let adapter = crate::delegate::lookup(&harness).ok_or("Unknown agent.")?;
        let path = crate::cli::resolve_command(adapter.binary()).map_err(|e| format!("installed:{e}"))?;
        // A routed CLI never uses its own login; skip the subprocess.
        Ok(if is_routed { None } else { Some(adapter.check_auth(&path)) })
    })
    .await;
    match checked {
        Err(error) => match error.strip_prefix("installed:") {
            Some(missing) => (State::Unsupported, missing.to_string()),
            None => (State::Unknown, error),
        },
        Ok(None) => match routed {
            Some(selection) => source(&selection.provider, scope).await,
            None => (State::Unknown, "No source to check.".into()),
        },
        Ok(Some(auth)) => from_auth(id, auth),
    }
}

/// What a CLI's own login check said, as a readiness word.
fn from_auth(id: &str, auth: Result<(bool, String), String>) -> (State, String) {
    match auth {
        Ok((true, detail)) => (State::Ready, detail),
        Ok((false, detail)) => {
            let login = crate::delegate::lookup(id).and_then(|d| d.login_commands().into_iter().next());
            let reason = match login {
                Some(command) => format!("{detail}. Sign in with `{command}`."),
                None => detail,
            };
            (State::NeedsLogin, reason)
        }
        Err(error) => (State::Unknown, error),
    }
}

/// An inference source: a hosted key, a managed local server, a self-hosted
/// endpoint, or Nous Portal through Hermes.
async fn source(id: &str, scope: Option<&Path>) -> (State, String) {
    if id == crate::harness_source::NOUS {
        let hermes = crate::blocking::run(|| crate::cli::resolve_command("hermes")).await;
        return match hermes {
            Ok(_) => (State::Unknown, "Nous Portal sign-in is checked when the run starts.".into()),
            Err(_) => (State::Unsupported, "Nous Portal runs through Hermes, which is not installed.".into()),
        };
    }
    if let Some(custom) = crate::custom_providers::get(id) {
        let scope = scope.map(Path::to_path_buf);
        let token_id = id.to_string();
        let token = crate::blocking::run_infallible(move || crate::providers::custom_token(&token_id, scope.as_deref())).await;
        let mut request = reqwest::Client::new().get(custom.models_url()).timeout(Duration::from_secs(3));
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        let probe = request.send().await.map(|res| res.status().as_u16()).map_err(|e| e.to_string());
        return from_probe(&custom.label, probe);
    }
    let Some(row) = crate::providers::lookup(id) else {
        return (State::Unsupported, format!("Klide does not know the provider \"{id}\"."));
    };
    match row.group {
        ProviderGroup::Subscription => (State::Unsupported, format!("{} is an agent, not a model source.", row.label)),
        ProviderGroup::Local if row.is_local_server => {
            if crate::local_servers::local_server_is_up(id).await {
                (State::Ready, format!("{} is running.", row.label))
            } else {
                (State::Offline, format!("{} is not running. Start it from the model picker or Settings → Local servers.", row.label))
            }
        }
        ProviderGroup::Local => (State::Unknown, format!("Klide does not manage {}; the run will reach it or say why.", row.label)),
        ProviderGroup::Hosted => {
            let scope = scope.map(Path::to_path_buf);
            let key_id = id.to_string();
            let status = crate::blocking::run(move || crate::providers::key_status_in(&key_id, scope.as_deref())).await;
            match status {
                Ok(key) if key.has_key => (State::Ready, format!("{} key from {}.", row.label, key.source)),
                Ok(_) => (State::NeedsLogin, format!("No {} API key. Add one in Settings → API keys.", row.label)),
                Err(error) => (State::Unknown, error),
            }
        }
    }
}

/// A self-hosted endpoint's `/models` answer: any HTTP reply means it is up,
/// except one refusing the token.
fn from_probe(label: &str, probe: Result<u16, String>) -> (State, String) {
    match probe {
        Ok(401 | 403) => (State::NeedsLogin, format!("{label} refused the token.")),
        Ok(_) => (State::Ready, format!("{label} answered.")),
        Err(error) => (State::Offline, format!("{label} did not answer: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready(state: State) -> Readiness {
        Readiness { provider: "x".into(), state, reason: String::new(), observed_at: 0 }
    }

    #[test]
    fn only_a_definite_no_blocks_dispatch() {
        assert!(!ready(State::Ready).blocks_dispatch());
        assert!(!ready(State::Unknown).blocks_dispatch());
        for state in [State::Unsupported, State::NeedsLogin, State::Offline] {
            assert!(ready(state).blocks_dispatch(), "{state:?}");
        }
    }

    #[test]
    fn a_logged_out_cli_names_its_login_command() {
        let (state, reason) = from_auth("claude-code", Ok((false, "Not logged in".into())));
        assert_eq!(state, State::NeedsLogin);
        assert!(reason.starts_with("Not logged in. Sign in with `"), "{reason}");
        assert_eq!(from_auth("claude-code", Ok((true, "Logged in".into()))).0, State::Ready);
        assert_eq!(from_auth("claude-code", Err("spawn failed".into())).0, State::Unknown);
    }

    #[test]
    fn an_endpoint_that_answers_is_up_unless_it_refuses_the_token() {
        assert_eq!(from_probe("Box", Ok(200)).0, State::Ready);
        assert_eq!(from_probe("Box", Ok(404)).0, State::Ready);
        assert_eq!(from_probe("Box", Ok(401)).0, State::NeedsLogin);
        assert_eq!(from_probe("Box", Err("connection refused".into())).0, State::Offline);
    }

    #[tokio::test]
    async fn auto_and_unknown_ids_answer_without_probing() {
        assert_eq!(check("auto", None, None).await.state, State::Unknown);
        let unknown = check("no-such-provider", None, None).await;
        assert_eq!(unknown.state, State::Unsupported);
        assert!(unknown.observed_at > 0);
    }

    #[tokio::test]
    async fn a_subscription_row_is_not_a_source() {
        let (state, _) = source("claude-code", None).await;
        assert_eq!(state, State::Unsupported);
    }

    #[tokio::test]
    async fn a_routed_pair_without_an_adapter_is_unsupported_before_any_probe() {
        let model = r#"harness-source:{"provider":"openrouter","model":"x/y"}"#;
        let answer = check("omp", Some(model), None).await;
        assert_eq!(answer.state, State::Unsupported, "{}", answer.reason);
    }
}

#[cfg(test)]
mod live {
    /// `cargo test --lib launch_readiness::live -- --ignored --nocapture`:
    /// every worker's answer on this machine.
    #[tokio::test]
    #[ignore]
    async fn every_worker_on_this_machine() {
        for id in crate::agent::subagents::worker_ids() {
            let r = super::check(id, None, None).await;
            println!("{id:14} {:?} — {}", r.state, r.reason);
        }
    }
}
