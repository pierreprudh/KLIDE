//! Auto model routing — the one place the `auto` Provider becomes a concrete
//! provider + model pair.
//!
//! Every Run enters through `start_run`, so resolving there means the AI panel,
//! a headless Mission attempt and a nested subagent all get the same answer
//! from the same rule. The rule itself is deliberately small and deterministic:
//!
//! 1. **Rule out** what cannot do the job — no API key, local server down, no
//!    tool support when the Mode needs tools, a context window the prompt
//!    won't fit in. These are gates, not scores: nothing a model does well
//!    puts it back in the pool.
//! 2. **Prefer** what the user starred, cheapest first. Nothing starred? The
//!    models installed locally, the Provider's default first.
//! 3. **Lock** the pick for the life of the conversation: a continuation of an
//!    `auto` thread reuses the pair its transcript already recorded
//!    (`read_run_origin`) rather than routing again — context accounting,
//!    compaction and the prompt cache are all per model.
//!
//! What this is *not*: a trained classifier, a per-turn re-route, or an LLM
//! call in front of every message. Fleet operators route because they have
//! millions of requests to learn from; Klide has one bench and knows what is on
//! it, which is the better signal at this scale. The pure parts (`rank`,
//! `judge`, `pick`) are Tauri-free and tested; `resolve` is the async shell
//! that feeds them provider facts.

use crate::agent::types::{AgentMode, PreferredModel, StartRunRequest};
use crate::providers::{self, KeySource};

/// The Provider id the picker sends when the user chooses "Auto". Mirrored in
/// `src/agent/providers.ts` (`AUTO_PROVIDER`); the drift test below keeps them
/// equal. The model half is the same word — a routed run has no model until
/// `resolve` gives it one.
pub const AUTO_PROVIDER: &str = "auto";
pub const AUTO_MODEL: &str = "auto";

pub fn is_auto(provider: &str) -> bool {
    provider.eq_ignore_ascii_case(AUTO_PROVIDER)
}

/// One model the router may pick. Built by `gather_candidates`; ranked by
/// `rank`; checked against the job by `judge`.
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub provider: String,
    pub model: String,
    /// The user starred this pair in a picker (`favModels.ts`).
    pub starred: bool,
    /// Served by a local runtime (Ollama). Free, and available only while the
    /// server is up.
    pub local: bool,
    /// USD per million input tokens. `None` = the price isn't known, which
    /// ranks after every known price — an unpriced pick is never "cheapest".
    pub input_per_million: Option<f64>,
}

/// What the run needs from whatever model it lands on.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Needs {
    /// Plan and Goal call tools; Chat does not.
    pub tools: bool,
    /// Tokens the first turn already carries: the message plus attachments
    /// plus the composer's context snapshot estimate.
    pub prompt_tokens: usize,
}

impl Needs {
    /// A window the pick must at least offer. The prompt needs room to be
    /// answered and to grow a few turns before compaction; twice the prompt
    /// plus a fixed allowance for the system prompt and tool schemas is the
    /// floor. Small and deliberately not clever.
    pub fn min_window(&self) -> usize {
        self.prompt_tokens * 2 + 4_096
    }
}

/// What a Provider says about one Candidate once asked.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Facts {
    pub supports_tools: bool,
    pub context_window: usize,
}

/// The gate's view of the one capabilities answer. The window is the same
/// number the gauge shows — probed from Ollama, read from a listing or a
/// manifest — and only an unknown one plans as the module's named default.
pub fn facts_from(caps: &crate::model_capabilities::ModelCapabilities) -> Facts {
    Facts {
        supports_tools: caps.supports_tools,
        context_window: caps.window_for_planning(),
    }
}

/// Why a Candidate was ruled out. Recorded on the `RouteResolved` event so the
/// Transcript shows not just the pick but what it beat and why.
#[derive(Clone, Debug, PartialEq)]
pub enum Rejection {
    NoKey,
    ServerDown,
    NoTools,
    WindowTooSmall { window: usize, needed: usize },
    Unreachable(String),
}

impl Rejection {
    fn describe(&self) -> String {
        match self {
            Rejection::NoKey => "no API key".to_string(),
            Rejection::ServerDown => "server not running".to_string(),
            Rejection::NoTools => "cannot use tools".to_string(),
            Rejection::WindowTooSmall { window, needed } => {
                format!("{}k window, job needs {}k", window / 1000, needed / 1000)
            }
            Rejection::Unreachable(why) => format!("unreachable: {why}"),
        }
    }
}

/// The router's answer: a concrete pair plus the evidence.
#[derive(Clone, Debug, PartialEq)]
pub struct Resolved {
    pub provider: String,
    pub model: String,
    /// Why this one, in a phrase: `starred · $3/M · tools · 200k window`.
    pub reason: String,
    /// Candidates that ranked above the pick and what ruled each one out,
    /// as `provider model: why`. Empty when the top of the ranking won.
    pub skipped: Vec<String>,
}

/// Order the pool so the first Candidate that passes `judge` is the one to
/// run. Starred pairs first (cheapest first, unknown price last), then local
/// models (the Provider's default first, then by name), then everything else
/// by price. Ties break on provider then model so the order is stable across
/// runs — a router that picks differently on identical input is a bug.
pub fn rank(mut candidates: Vec<Candidate>, local_default: &str) -> Vec<Candidate> {
    let tier = |c: &Candidate| -> u8 {
        if c.starred {
            0
        } else if c.local {
            1
        } else {
            2
        }
    };
    let price = |c: &Candidate| -> f64 { c.input_per_million.unwrap_or(f64::INFINITY) };
    let is_default = |c: &Candidate| -> bool { c.local && ollama_tag_matches(&c.model, local_default) };
    candidates.sort_by(|a, b| {
        tier(a)
            .cmp(&tier(b))
            // Within the local tier the Provider's default model leads.
            .then_with(|| is_default(b).cmp(&is_default(a)))
            .then_with(|| price(a).total_cmp(&price(b)))
            .then_with(|| a.provider.cmp(&b.provider))
            .then_with(|| a.model.cmp(&b.model))
    });
    candidates
}

/// Ollama lists an installed model as `name:latest` while presets and defaults
/// are written bare; compare tag-insensitively so the default is recognised
/// whichever way it was spelled.
fn ollama_tag_matches(installed: &str, wanted: &str) -> bool {
    let bare = |m: &str| m.strip_suffix(":latest").unwrap_or(m).to_string();
    bare(installed) == bare(wanted)
}

/// Apply the job's Needs to what the Provider said about one Candidate.
/// Returns the reason phrase on a pass, the Rejection otherwise.
pub fn judge(candidate: &Candidate, facts: Result<Facts, Rejection>, needs: Needs) -> Result<String, Rejection> {
    let facts = facts?;
    if needs.tools && !facts.supports_tools {
        return Err(Rejection::NoTools);
    }
    let needed = needs.min_window();
    if facts.context_window < needed {
        return Err(Rejection::WindowTooSmall {
            window: facts.context_window,
            needed,
        });
    }
    let mut parts: Vec<String> = Vec::new();
    parts.push(if candidate.starred {
        "starred".to_string()
    } else if candidate.local {
        "local".to_string()
    } else {
        "cheapest".to_string()
    });
    parts.push(match candidate.input_per_million {
        Some(p) if p == 0.0 => "free".to_string(),
        Some(p) if p >= 1.0 => format!("${p:.0}/M"),
        Some(p) => format!("${p:.2}/M"),
        None => "unpriced".to_string(),
    });
    if facts.supports_tools {
        parts.push("tools".to_string());
    }
    parts.push(format!("{}k window", facts.context_window / 1000));
    Ok(parts.join(" · "))
}

/// Walk a ranked pool, asking `facts_of` about each Candidate in order, and
/// stop at the first that passes `judge` — so a starred model that fits costs
/// one probe, not one per installed model. The fact source is a parameter so
/// the policy runs against live Providers in `resolve` and against canned
/// answers in the tests below; there is one walk, not two.
pub async fn pick<F, Fut>(ranked: &[Candidate], needs: Needs, mut facts_of: F) -> Result<Resolved, String>
where
    F: FnMut(&Candidate) -> Fut,
    Fut: std::future::Future<Output = Result<Facts, Rejection>>,
{
    let mut skipped = Vec::new();
    for candidate in ranked {
        match judge(candidate, facts_of(candidate).await, needs) {
            Ok(reason) => {
                return Ok(Resolved {
                    provider: candidate.provider.clone(),
                    model: candidate.model.clone(),
                    reason,
                    skipped,
                })
            }
            Err(rejection) => skipped.push(skip_line(candidate, &rejection)),
        }
    }
    Err(no_candidate_message(needs, &skipped))
}

fn skip_line(candidate: &Candidate, rejection: &Rejection) -> String {
    format!("{} {}: {}", candidate.provider, candidate.model, rejection.describe())
}

/// The error a user reads when nothing on the bench can take the job. Names
/// what was tried so the fix is obvious (star a model, add a key, start
/// Ollama) instead of "no model available".
fn no_candidate_message(needs: Needs, skipped: &[String]) -> String {
    let job = if needs.tools {
        "a run that uses tools"
    } else {
        "a chat"
    };
    if skipped.is_empty() {
        return format!(
            "Auto found no model for {job}: star a model in the picker, add an API key, or start Ollama."
        );
    }
    format!(
        "Auto found no model for {job}. Ruled out: {}.",
        skipped.join("; ")
    )
}

/// Tokens the first turn already carries, before any model answers.
pub fn prompt_tokens(request: &StartRunRequest) -> usize {
    let text = request.initial_text.chars().count() / 4;
    let attachments: usize = request
        .attachments
        .iter()
        .map(|a| a.content.chars().count() / 4)
        .sum();
    let snapshot = request
        .context
        .as_ref()
        .map(|c| c.estimated_tokens)
        .unwrap_or(0);
    text + attachments + snapshot
}

pub fn needs_for(request: &StartRunRequest) -> Needs {
    Needs {
        tools: !matches!(request.mode, AgentMode::Chat),
        prompt_tokens: prompt_tokens(request),
    }
}

/// Build the pool: the user's starred pairs (from the request — stars live in
/// the renderer's storage) plus whatever Ollama has installed. Delegate CLIs
/// are never candidates: they run on a subscription with their own trust and
/// cost model, and a routed run must stay inside the Harness.
pub async fn gather_candidates(preferred: &[PreferredModel]) -> Vec<Candidate> {
    let mut pool: Vec<Candidate> = Vec::new();
    for pref in preferred {
        if providers::is_subscription_provider(&pref.provider) || is_auto(&pref.provider) {
            continue;
        }
        let known = providers::lookup(&pref.provider).is_some()
            || crate::custom_providers::get(&pref.provider).is_some();
        if !known {
            continue;
        }
        let local = matches!(
            providers::lookup(&pref.provider).map(|e| e.key),
            Some(KeySource::Local)
        );
        let input_per_million = if local {
            Some(0.0)
        } else {
            crate::models::model_input_price(&pref.provider, &pref.model).await
        };
        pool.push(Candidate {
            provider: pref.provider.clone(),
            model: pref.model.clone(),
            starred: true,
            local,
            input_per_million,
        });
    }
    // Installed local models. A listing failure means Ollama is down — that is
    // a fact about the bench, not an error in routing, so the pool simply has
    // no local rows and the message at the end says so.
    if let Ok(tags) = crate::models::installed_ollama_models().await {
        for tag in tags {
            let already = pool
                .iter()
                .any(|c| c.provider == "ollama" && ollama_tag_matches(&c.model, &tag));
            if already {
                continue;
            }
            pool.push(Candidate {
                provider: "ollama".to_string(),
                model: tag,
                starred: false,
                local: true,
                input_per_million: Some(0.0),
            });
        }
    }
    pool
}

/// Ask the Provider about one Candidate. Availability first (a missing key or
/// a down server is a Rejection, not an error), then tool support and the
/// context window.
async fn inspect(candidate: Candidate) -> Result<Facts, Rejection> {
    let entry = providers::lookup(&candidate.provider);
    match entry.map(|e| e.key) {
        Some(KeySource::Hosted { .. }) => {
            if providers::provider_key(&candidate.provider).is_err() {
                return Err(Rejection::NoKey);
            }
        }
        Some(KeySource::Local) => {
            if !crate::local_servers::local_server_is_up(&candidate.provider).await {
                return Err(Rejection::ServerDown);
            }
        }
        // Self-hosted endpoint: its token is optional on the wire, so there is
        // no key gate; an unreachable host surfaces from the tools probe.
        None => {}
    }
    let caps = crate::model_capabilities::capabilities(&candidate.provider, &candidate.model, false)
        .await
        .map_err(Rejection::Unreachable)?;
    Ok(facts_from(&caps))
}

/// Route one `auto` request: build the pool from the request's stars and the
/// local bench, rank it, and walk it against live Provider facts.
pub async fn resolve(request: &StartRunRequest) -> Result<Resolved, String> {
    let needs = needs_for(request);
    let pool = gather_candidates(&request.preferred_models).await;
    let ranked = rank(pool, providers::OLLAMA_DEFAULT_MODEL);
    pick(&ranked, needs, |c| inspect(c.clone())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The walk is async only so `resolve` can await Providers; the policy
    /// itself is synchronous. Tests answer from a table and run the walk to
    /// completion on a current-thread runtime, so each case reads as plain
    /// input → output. Shadows the glob-imported `super::pick` on purpose.
    fn pick(
        ranked: &[Candidate],
        needs: Needs,
        mut facts_of: impl FnMut(&Candidate) -> Result<Facts, Rejection>,
    ) -> Result<Resolved, String> {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("test runtime")
            .block_on(super::pick(ranked, needs, |c| std::future::ready(facts_of(c))))
    }

    fn starred(provider: &str, model: &str, price: Option<f64>) -> Candidate {
        Candidate {
            provider: provider.into(),
            model: model.into(),
            starred: true,
            local: false,
            input_per_million: price,
        }
    }

    fn local(model: &str) -> Candidate {
        Candidate {
            provider: "ollama".into(),
            model: model.into(),
            starred: false,
            local: true,
            input_per_million: Some(0.0),
        }
    }

    fn ok(tools: bool, window: usize) -> Result<Facts, Rejection> {
        Ok(Facts {
            supports_tools: tools,
            context_window: window,
        })
    }

    const GOAL: Needs = Needs {
        tools: true,
        prompt_tokens: 1_000,
    };
    const CHAT: Needs = Needs {
        tools: false,
        prompt_tokens: 1_000,
    };

    #[test]
    fn starred_ranks_before_local_before_the_rest() {
        let ranked = rank(
            vec![
                local("qwen3:8b"),
                Candidate {
                    starred: false,
                    ..starred("openai", "gpt-4.1", Some(2.0))
                },
                starred("anthropic", "claude-sonnet-4-6", Some(3.0)),
            ],
            "llama3.1:8b",
        );
        let order: Vec<&str> = ranked.iter().map(|c| c.model.as_str()).collect();
        assert_eq!(order, ["claude-sonnet-4-6", "qwen3:8b", "gpt-4.1"]);
    }

    #[test]
    fn within_stars_cheapest_first_and_unpriced_last() {
        let ranked = rank(
            vec![
                starred("openrouter", "some/unpriced", None),
                starred("anthropic", "claude-opus-4-6", Some(15.0)),
                starred("anthropic", "claude-haiku-4-5", Some(0.8)),
            ],
            "llama3.1:8b",
        );
        let order: Vec<&str> = ranked.iter().map(|c| c.model.as_str()).collect();
        assert_eq!(order, ["claude-haiku-4-5", "claude-opus-4-6", "some/unpriced"]);
    }

    #[test]
    fn local_default_leads_the_local_tier_whatever_its_tag() {
        let ranked = rank(
            vec![local("gemma3:4b"), local("llama3.1:8b:latest"), local("qwen3:8b")],
            "llama3.1:8b",
        );
        assert_eq!(ranked[0].model, "llama3.1:8b:latest");
    }

    #[test]
    fn ranking_is_stable_on_identical_input() {
        let pool = vec![local("b"), local("a"), starred("x", "m", Some(1.0))];
        assert_eq!(rank(pool.clone(), "z"), rank(pool, "z"));
    }

    #[test]
    fn a_model_without_tools_is_never_picked_for_a_goal_run() {
        // The star is the strongest preference there is, and it still loses to
        // the gate: preference is a score, tool support is a wall.
        let ranked = rank(
            vec![starred("anthropic", "chatty", Some(1.0)), local("llama3.1:8b")],
            "llama3.1:8b",
        );
        let picked = pick(&ranked, GOAL, |c| ok(c.model != "chatty", 128_000)).unwrap();
        assert_eq!(picked.model, "llama3.1:8b");
        assert_eq!(picked.skipped, vec!["anthropic chatty: cannot use tools"]);
    }

    #[test]
    fn chat_does_not_require_tools() {
        let ranked = rank(vec![starred("anthropic", "chatty", Some(1.0))], "llama3.1:8b");
        let picked = pick(&ranked, CHAT, |_| ok(false, 128_000)).unwrap();
        assert_eq!(picked.model, "chatty");
        assert_eq!(picked.reason, "starred · $1/M · 128k window");
    }

    #[test]
    fn a_starred_model_beats_a_cheaper_unstarred_one() {
        let ranked = rank(
            vec![
                Candidate {
                    starred: false,
                    ..starred("openai", "gpt-4.1-mini", Some(0.4))
                },
                starred("anthropic", "claude-sonnet-4-6", Some(3.0)),
            ],
            "llama3.1:8b",
        );
        let picked = pick(&ranked, GOAL, |_| ok(true, 200_000)).unwrap();
        assert_eq!(picked.model, "claude-sonnet-4-6");
        assert_eq!(picked.reason, "starred · $3/M · tools · 200k window");
        assert!(picked.skipped.is_empty());
    }

    #[test]
    fn missing_key_and_down_server_are_rejections_not_errors() {
        let ranked = rank(
            vec![starred("anthropic", "claude-sonnet-4-6", Some(3.0)), local("llama3.1:8b")],
            "llama3.1:8b",
        );
        let err = pick(&ranked, GOAL, |c| {
            if c.local {
                Err(Rejection::ServerDown)
            } else {
                Err(Rejection::NoKey)
            }
        })
        .unwrap_err();
        assert_eq!(
            err,
            "Auto found no model for a run that uses tools. Ruled out: \
anthropic claude-sonnet-4-6: no API key; ollama llama3.1:8b: server not running."
        );
    }

    #[test]
    fn the_window_must_hold_the_prompt_with_room_to_answer() {
        let needs = Needs {
            tools: false,
            prompt_tokens: 10_000,
        };
        assert_eq!(needs.min_window(), 24_096);
        let ranked = rank(vec![local("small"), local("big")], "big");
        let picked = pick(&ranked, needs, |c| ok(true, if c.model == "small" { 8_192 } else { 128_000 }))
            .unwrap();
        assert_eq!(picked.model, "big");
        // `big` is the default and leads the tier, so nothing was skipped.
        assert!(picked.skipped.is_empty());
        let only_small = rank(vec![local("small")], "big");
        let err = pick(&only_small, needs, |_| ok(true, 8_192)).unwrap_err();
        assert!(err.contains("8k window, job needs 24k"), "{err}");
    }

    #[test]
    fn an_empty_bench_tells_the_user_what_to_do() {
        let err = pick(&[], CHAT, |_| ok(true, 1)).unwrap_err();
        assert_eq!(
            err,
            "Auto found no model for a chat: star a model in the picker, add an API key, or start Ollama."
        );
    }

    #[test]
    fn frontend_auto_sentinel_matches() {
        // Same seam as `delegate::tests::frontend_delegate_ids_match_all`: the
        // renderer sends this word as the Provider id, and the only thing that
        // makes "auto" mean the same on both sides is this test.
        let ts = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/agent/providers.ts"),
        )
        .expect("read src/agent/providers.ts");
        let line = ts
            .lines()
            .find(|l| l.contains("export const AUTO_PROVIDER ="))
            .expect("AUTO_PROVIDER in providers.ts");
        assert!(
            line.contains(&format!("\"{AUTO_PROVIDER}\"")),
            "AUTO_PROVIDER drifted: rust={AUTO_PROVIDER:?} ts={line}"
        );
        let line = ts
            .lines()
            .find(|l| l.contains("export const AUTO_MODEL ="))
            .expect("AUTO_MODEL in providers.ts");
        assert!(
            line.contains(&format!("\"{AUTO_MODEL}\"")),
            "AUTO_MODEL drifted: rust={AUTO_MODEL:?} ts={line}"
        );
    }
}
