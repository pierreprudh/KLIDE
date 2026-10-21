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
//! 2. **Prefer** what the user starred, nearest the task's rung, cheapest
//!    first. Nothing starred? Each keyed Provider's ladder model for that
//!    rung (`providers::AutoLadder`) and what Ollama has installed, so a
//!    fresh install with one key gets a pick on day one.
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
use crate::providers::{self, AutoLadder, KeySource};

/// The Provider id the picker sends when the user chooses "Auto". Mirrored in
/// `src/agent/providers.ts` (`AUTO_PROVIDER`); the drift test below keeps them
/// equal. The model half is the same word — a routed run has no model until
/// `resolve` gives it one.
pub const AUTO_PROVIDER: &str = "auto";
pub const AUTO_MODEL: &str = "auto";
/// Where an Auto turn's system prompt names its model — the renderer writes
/// it, `start_run` replaces it with the routed (or locked) model. Mirrors
/// `ROUTED_MODEL_TOKEN` in `src/agent/providers.ts`.
pub const ROUTED_MODEL_TOKEN: &str = "{{klide:routed-model}}";

pub fn is_auto(provider: &str) -> bool {
    provider.eq_ignore_ascii_case(AUTO_PROVIDER)
}

/// How much model a task shape asks for. Three steps, not a score: a Provider
/// row names one model per rung (`providers::AutoLadder`), the task picks a
/// rung, and the nearest rung that has a passing Candidate wins — so a bench
/// with nothing at the wanted rung still gets an answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Rung {
    Light,
    Standard,
    Strong,
}

impl Rung {
    pub const ALL: [Rung; 3] = [Rung::Light, Rung::Standard, Rung::Strong];

    pub fn word(self) -> &'static str {
        match self {
            Rung::Light => "light",
            Rung::Standard => "standard",
            Rung::Strong => "strong",
        }
    }

    /// How many steps apart two rungs are. The ranking key: a Candidate at
    /// the wanted rung is 0, one rung off is 1, the far end is 2.
    pub fn distance(self, other: Rung) -> u8 {
        (self as i8 - other as i8).unsigned_abs()
    }

    fn up(self) -> Rung {
        match self {
            Rung::Light => Rung::Standard,
            Rung::Standard | Rung::Strong => Rung::Strong,
        }
    }

    /// The ladder's model at this rung.
    pub fn slot(self, ladder: &AutoLadder) -> Option<&'static str> {
        match self {
            Rung::Light => ladder.light,
            Rung::Standard => ladder.standard,
            Rung::Strong => ladder.strong,
        }
    }
}

/// A first turn at least this long is a big brief.
pub const BIG_PROMPT_TOKENS: usize = 16_000;
/// A first turn carrying at least this many attached files is a big brief.
pub const BIG_ATTACHMENTS: usize = 4;

/// The rung a task shape asks for. Chat is light; Plan and Goal are standard;
/// a big first turn — a long brief or several attached files — bumps one rung
/// up. Deliberately a few lines: the shape is read off the request, never off
/// a model call, so nothing new runs in front of the user's message.
pub fn rung_for(mode: &AgentMode, prompt_tokens: usize, attachments: usize) -> Rung {
    let base = match mode {
        AgentMode::Chat => Rung::Light,
        AgentMode::Plan | AgentMode::Goal => Rung::Standard,
    };
    if prompt_tokens >= BIG_PROMPT_TOKENS || attachments >= BIG_ATTACHMENTS {
        base.up()
    } else {
        base
    }
}

/// Blended $/M below which a model sits at `Light`, and from which it sits
/// at `Strong`. Read off the Anthropic and OpenAI ladders: Haiku and
/// gpt-5-mini blend under the first, Opus over the second, Sonnet and gpt-5
/// between.
pub const LIGHT_BELOW: f64 = 0.75;
pub const STRONG_FROM: f64 = 6.0;

/// The rung a starred model on no ladder answers from, read off its blended
/// price. Price is the one fact every market publishes about how much model
/// it is; a star without this took every rung at once, and the cheapest star
/// won every job — a Goal went to whatever was cheapest to ask.
pub fn rung_for_price(per_million: f64) -> Rung {
    if per_million < LIGHT_BELOW {
        Rung::Light
    } else if per_million < STRONG_FROM {
        Rung::Standard
    } else {
        Rung::Strong
    }
}

/// Every rung a ladder names `model` at — OpenRouter's router sits on all
/// three. Empty for a model on no ladder.
pub fn rungs_on(ladder: &AutoLadder, model: &str) -> Vec<Rung> {
    Rung::ALL
        .into_iter()
        .filter(|rung| rung.slot(ladder) == Some(model))
        .collect()
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
    /// USD per million tokens, blended three input to one output
    /// (`models::model_blended_price`). `None` = the price isn't known, which
    /// ranks after every known price — an unpriced pick is never "cheapest".
    pub per_million: Option<f64>,
    /// The rungs this model fills: its Provider's ladder slots, `Light` for
    /// an installed local model, or — for a starred model on no ladder — the
    /// rung its price sits at (`rung_for_price`). Empty means unplaced, an
    /// unpriced star on no ladder, which ranks as if it were at the wanted
    /// rung.
    pub rungs: Vec<Rung>,
}

impl Candidate {
    /// Steps between this Candidate and the rung the task wants.
    fn distance(&self, wanted: Rung) -> u8 {
        self.rungs.iter().map(|r| r.distance(wanted)).min().unwrap_or(0)
    }

    /// The rung this Candidate answers the task from, when it has one.
    fn nearest(&self, wanted: Rung) -> Option<Rung> {
        self.rungs.iter().copied().min_by_key(|r| r.distance(wanted))
    }
}

/// What the run needs from whatever model it lands on.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Needs {
    /// Plan and Goal call tools; Chat does not.
    pub tools: bool,
    /// Tokens the first turn already carries: the message plus attachments
    /// plus the composer's context snapshot estimate.
    pub prompt_tokens: usize,
    /// The rung the task shape asks for (`rung_for`).
    pub rung: Rung,
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
    pub supports_chat: bool,
    pub supports_tools: bool,
    pub context_window: usize,
}

/// The gate's view of the one capabilities answer. The window is the same
/// number the gauge shows — probed from Ollama, read from a listing or a
/// manifest — and only an unknown one plans as the module's named default.
pub fn facts_from(caps: &crate::model_capabilities::ModelCapabilities) -> Facts {
    Facts {
        supports_chat: caps.supports_chat,
        supports_tools: caps.supports_tools,
        context_window: caps.window_for_planning(),
    }
}

/// Why a Candidate was ruled out. Recorded on the `RouteResolved` event so the
/// Transcript shows not just the pick but what it beat and why.
#[derive(Clone, Debug, PartialEq)]
pub enum Rejection {
    NoKey,
    NotListed,
    ServerDown,
    NoChat,
    NoTools,
    WindowTooSmall { window: usize, needed: usize },
    Unreachable(String),
}

impl Rejection {
    fn describe(&self) -> String {
        match self {
            Rejection::NoKey => "no API key".to_string(),
            Rejection::NotListed => "not in this key's model list".to_string(),
            Rejection::ServerDown => "server not running".to_string(),
            Rejection::NoChat => "embedding model, cannot chat".to_string(),
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
    /// Why this one, in a phrase: `starred · $3.00/M blended · tools · 200k window`.
    pub reason: String,
    /// Candidates that ranked above the pick and what ruled each one out,
    /// as `provider model: why`. Empty when the top of the ranking won.
    pub skipped: Vec<String>,
}

/// Order the pool so the first Candidate that passes `judge` is the one to
/// run. Starred pairs first, then the rest; inside each, the Candidates
/// nearest the wanted rung lead, then Ollama's default model, then cheapest
/// first (unknown price last). A local model is free, so at its rung it
/// leads every hosted one; at the wrong rung a keyed hosted model that fits
/// the job leads it. Ties break on provider then model so the order is
/// stable across runs — a router that picks differently on identical input
/// is a bug.
pub fn rank(mut candidates: Vec<Candidate>, local_default: &str, wanted: Rung) -> Vec<Candidate> {
    let tier = |c: &Candidate| -> u8 {
        if c.starred {
            0
        } else {
            1
        }
    };
    let price = |c: &Candidate| -> f64 { c.per_million.unwrap_or(f64::INFINITY) };
    let is_default = |c: &Candidate| -> bool { c.local && ollama_tag_matches(&c.model, local_default) };
    candidates.sort_by(|a, b| {
        tier(a)
            .cmp(&tier(b))
            .then_with(|| a.distance(wanted).cmp(&b.distance(wanted)))
            // Among local models at one rung the Provider's default leads.
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
    if !facts.supports_chat {
        return Err(Rejection::NoChat);
    }
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
    if let Some(rung) = candidate.nearest(needs.rung) {
        parts.push(if rung == needs.rung {
            format!("{} rung", rung.word())
        } else {
            format!("{} rung for a {} job", rung.word(), needs.rung.word())
        });
    }
    parts.push(match candidate.per_million {
        Some(p) if p == 0.0 => "free".to_string(),
        Some(p) if p >= 10.0 => format!("${p:.0}/M blended"),
        Some(p) => format!("${p:.2}/M blended"),
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
    let prompt_tokens = prompt_tokens(request);
    Needs {
        tools: !matches!(request.mode, AgentMode::Chat),
        prompt_tokens,
        rung: rung_for(&request.mode, prompt_tokens, request.attachments.len()),
    }
}

/// Build the pool: the user's starred pairs (from the request — stars live in
/// the renderer's storage), each keyed hosted Provider's ladder, and whatever
/// Ollama has installed. Delegate CLIs are never candidates: they run on a
/// subscription with their own trust and cost model, and a routed run must
/// stay inside the Harness.
pub async fn gather_candidates(preferred: &[PreferredModel]) -> Vec<Candidate> {
    let mut pool: Vec<Candidate> = Vec::new();
    for pref in preferred {
        if providers::is_subscription_provider(&pref.provider) || is_auto(&pref.provider) {
            continue;
        }
        let entry = providers::lookup(&pref.provider);
        let known = entry.is_some() || crate::custom_providers::get(&pref.provider).is_some();
        if !known {
            continue;
        }
        let local = matches!(entry.map(|e| e.key), Some(KeySource::Local));
        let per_million = if local {
            Some(0.0)
        } else {
            crate::models::model_blended_price(&pref.provider, &pref.model).await
        };
        let rungs = if local {
            vec![Rung::Light]
        } else {
            match entry.map(|e| rungs_on(&e.auto, &pref.model)).unwrap_or_default() {
                placed if !placed.is_empty() => placed,
                _ => per_million.map(|p| vec![rung_for_price(p)]).unwrap_or_default(),
            }
        };
        pool.push(Candidate {
            provider: pref.provider.clone(),
            model: pref.model.clone(),
            starred: true,
            local,
            per_million,
            rungs,
        });
    }
    // Each keyed hosted Provider's ladder — the day-one pool for a user who
    // starred nothing. The key check is done here rather than left to the
    // gate so a Provider the user never set up is simply not on the bench,
    // instead of filling `skipped` with "no API key" above the pick. It
    // reads files (and the Keychain, when a key was pasted), so it runs
    // behind the blocking door.
    let keyed: Vec<&'static str> = crate::blocking::run_infallible(|| {
        providers::PROVIDERS
            .iter()
            .filter(|e| !e.auto.is_empty() && matches!(e.key, KeySource::Hosted { .. }))
            .filter(|e| matches!(providers::provider_key(e.id), Ok(Some(_))))
            .map(|e| e.id)
            .collect()
    })
    .await;
    for id in keyed {
        let Some(entry) = providers::lookup(id) else { continue };
        for rung in Rung::ALL {
            let Some(model) = rung.slot(&entry.auto) else { continue };
            if let Some(existing) = pool.iter_mut().find(|c| c.provider == id && c.model == model) {
                if !existing.rungs.contains(&rung) {
                    existing.rungs.push(rung);
                }
                continue;
            }
            pool.push(Candidate {
                provider: id.to_string(),
                model: model.to_string(),
                starred: false,
                local: false,
                per_million: crate::models::model_blended_price(id, model).await,
                rungs: vec![rung],
            });
        }
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
                per_million: Some(0.0),
                rungs: vec![Rung::Light],
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
            if !matches!(providers::provider_key(&candidate.provider), Ok(Some(_))) {
                return Err(Rejection::NoKey);
            }
            // A key can be valid and still not reach a model (a plan without
            // the large tier): the request would fail at once with a 403.
            if crate::models::key_lists_model(&candidate.provider, &candidate.model).await == Some(false) {
                return Err(Rejection::NotListed);
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
    let ranked = rank(pool, providers::OLLAMA_DEFAULT_MODEL, needs.rung);
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
            per_million: price,
            rungs: vec![],
        }
    }

    fn local(model: &str) -> Candidate {
        Candidate {
            provider: "ollama".into(),
            model: model.into(),
            starred: false,
            local: true,
            per_million: Some(0.0),
            rungs: vec![Rung::Light],
        }
    }

    /// An unstarred hosted model on its Provider's ladder.
    fn rung(provider: &str, model: &str, price: f64, at: Rung) -> Candidate {
        Candidate {
            provider: provider.into(),
            model: model.into(),
            starred: false,
            local: false,
            per_million: Some(price),
            rungs: vec![at],
        }
    }

    fn ok(tools: bool, window: usize) -> Result<Facts, Rejection> {
        Ok(Facts {
            supports_chat: true,
            supports_tools: tools,
            context_window: window,
        })
    }

    const GOAL: Needs = Needs {
        tools: true,
        prompt_tokens: 1_000,
        rung: Rung::Standard,
    };
    const CHAT: Needs = Needs {
        tools: false,
        prompt_tokens: 1_000,
        rung: Rung::Light,
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
            Rung::Light,
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
            Rung::Standard,
        );
        let order: Vec<&str> = ranked.iter().map(|c| c.model.as_str()).collect();
        assert_eq!(order, ["claude-haiku-4-5", "claude-opus-4-6", "some/unpriced"]);
    }

    #[test]
    fn local_default_leads_the_local_tier_whatever_its_tag() {
        let ranked = rank(
            vec![local("gemma3:4b"), local("llama3.1:8b:latest"), local("qwen3:8b")],
            "llama3.1:8b",
            Rung::Light,
        );
        assert_eq!(ranked[0].model, "llama3.1:8b:latest");
    }

    #[test]
    fn ranking_is_stable_on_identical_input() {
        let pool = vec![local("b"), local("a"), starred("x", "m", Some(1.0))];
        assert_eq!(rank(pool.clone(), "z", Rung::Standard), rank(pool, "z", Rung::Standard));
    }

    #[test]
    fn a_model_without_tools_is_never_picked_for_a_goal_run() {
        // The star is the strongest preference there is, and it still loses to
        // the gate: preference is a score, tool support is a wall.
        let ranked = rank(
            vec![starred("anthropic", "chatty", Some(1.0)), local("llama3.1:8b")],
            "llama3.1:8b",
            GOAL.rung,
        );
        let picked = pick(&ranked, GOAL, |c| ok(c.model != "chatty", 128_000)).unwrap();
        assert_eq!(picked.model, "llama3.1:8b");
        assert_eq!(picked.skipped, vec!["anthropic chatty: cannot use tools"]);
    }

    #[test]
    fn an_embedding_model_is_never_picked_even_for_chat() {
        let ranked = vec![local("bge-m3:latest"), local("qwen3.5:9b")];
        let picked = pick(&ranked, CHAT, |c| {
            let mut facts = ok(false, 8_192)?;
            facts.supports_chat = c.model != "bge-m3:latest";
            Ok(facts)
        })
        .unwrap();
        assert_eq!(picked.model, "qwen3.5:9b");
        assert_eq!(picked.skipped, vec!["ollama bge-m3:latest: embedding model, cannot chat"]);
    }

    #[test]
    fn chat_does_not_require_tools() {
        let ranked = rank(vec![starred("anthropic", "chatty", Some(1.0))], "llama3.1:8b", CHAT.rung);
        let picked = pick(&ranked, CHAT, |_| ok(false, 128_000)).unwrap();
        assert_eq!(picked.model, "chatty");
        assert_eq!(picked.reason, "starred · $1.00/M blended · 128k window");
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
            GOAL.rung,
        );
        let picked = pick(&ranked, GOAL, |_| ok(true, 200_000)).unwrap();
        assert_eq!(picked.model, "claude-sonnet-4-6");
        assert_eq!(picked.reason, "starred · $3.00/M blended · tools · 200k window");
        assert!(picked.skipped.is_empty());
    }

    #[test]
    fn missing_key_and_down_server_are_rejections_not_errors() {
        let ranked = rank(
            vec![starred("anthropic", "claude-sonnet-4-6", Some(3.0)), local("llama3.1:8b")],
            "llama3.1:8b",
            GOAL.rung,
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
            rung: Rung::Light,
        };
        assert_eq!(needs.min_window(), 24_096);
        let ranked = rank(vec![local("small"), local("big")], "big", Rung::Light);
        let picked = pick(&ranked, needs, |c| ok(true, if c.model == "small" { 8_192 } else { 128_000 }))
            .unwrap();
        assert_eq!(picked.model, "big");
        // `big` is the default and leads the tier, so nothing was skipped.
        assert!(picked.skipped.is_empty());
        let only_small = rank(vec![local("small")], "big", Rung::Light);
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
    fn rung_for_reads_the_task_shape_and_nothing_else() {
        assert_eq!(rung_for(&AgentMode::Chat, 1_000, 0), Rung::Light);
        assert_eq!(rung_for(&AgentMode::Plan, 1_000, 0), Rung::Standard);
        assert_eq!(rung_for(&AgentMode::Goal, 1_000, 0), Rung::Standard);
        // A big brief bumps one rung up; Strong has nowhere further to go.
        assert_eq!(rung_for(&AgentMode::Goal, BIG_PROMPT_TOKENS, 0), Rung::Strong);
        assert_eq!(rung_for(&AgentMode::Chat, 0, BIG_ATTACHMENTS), Rung::Standard);
        assert_eq!(rung_for(&AgentMode::Goal, BIG_PROMPT_TOKENS, BIG_ATTACHMENTS), Rung::Strong);
        assert_eq!(rung_for(&AgentMode::Chat, BIG_PROMPT_TOKENS - 1, BIG_ATTACHMENTS - 1), Rung::Light);
    }

    #[test]
    fn the_wanted_rung_beats_price_in_the_unstarred_pool() {
        let ladder = || {
            vec![
                rung("anthropic", "claude-opus-4-6", 15.0, Rung::Strong),
                rung("anthropic", "claude-haiku-4-5", 0.8, Rung::Light),
                rung("anthropic", "claude-sonnet-4-6", 3.0, Rung::Standard),
            ]
        };
        let order = |wanted: Rung| -> Vec<String> {
            rank(ladder(), "llama3.1:8b", wanted).into_iter().map(|c| c.model).collect()
        };
        assert_eq!(order(Rung::Light), ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"]);
        // One rung off on either side: the cheaper neighbour first.
        assert_eq!(order(Rung::Standard), ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-6"]);
        assert_eq!(order(Rung::Strong), ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"]);
        let picked = pick(&rank(ladder(), "llama3.1:8b", GOAL.rung), GOAL, |_| ok(true, 200_000)).unwrap();
        assert_eq!(picked.model, "claude-sonnet-4-6");
        assert_eq!(picked.reason, "cheapest · standard rung · $3.00/M blended · tools · 200k window");
    }

    #[test]
    fn a_keyed_standard_model_leads_a_free_local_one_for_a_standard_job() {
        // Chat (light) goes local; a Goal (standard) goes to the keyed model
        // that fits the job. Stars reorder this; nothing else does.
        let pool = || vec![local("llama3.1:8b"), rung("anthropic", "claude-sonnet-4-6", 3.0, Rung::Standard)];
        assert_eq!(rank(pool(), "llama3.1:8b", Rung::Light)[0].model, "llama3.1:8b");
        assert_eq!(rank(pool(), "llama3.1:8b", Rung::Standard)[0].model, "claude-sonnet-4-6");
    }

    #[test]
    fn a_rung_nobody_fills_falls_to_the_nearest_and_says_so() {
        let ranked = rank(vec![local("llama3.1:8b")], "llama3.1:8b", Rung::Standard);
        let picked = pick(&ranked, GOAL, |_| ok(true, 128_000)).unwrap();
        assert_eq!(picked.model, "llama3.1:8b");
        assert_eq!(picked.reason, "local · light rung for a standard job · free · tools · 128k window");
    }

    #[test]
    fn stars_nearest_the_rung_lead_the_stars() {
        let haiku = Candidate {
            rungs: vec![Rung::Light],
            ..starred("anthropic", "claude-haiku-4-5", Some(0.8))
        };
        let opus = Candidate {
            rungs: vec![Rung::Strong],
            ..starred("anthropic", "claude-opus-4-6", Some(15.0))
        };
        let first = |wanted: Rung| rank(vec![opus.clone(), haiku.clone()], "z", wanted)[0].model.clone();
        assert_eq!(first(Rung::Light), "claude-haiku-4-5");
        assert_eq!(first(Rung::Strong), "claude-opus-4-6");
        // Equidistant: cheapest wins, as before.
        assert_eq!(first(Rung::Standard), "claude-haiku-4-5");
        // A star on no ladder ranks as if it sat at the wanted rung.
        let unplaced = starred("custom:lab", "house-model", Some(1.0));
        assert_eq!(rank(vec![opus.clone(), unplaced], "z", Rung::Strong)[0].model, "house-model");
    }

    #[test]
    fn a_price_places_a_star_the_ladders_dont_name() {
        assert_eq!(rung_for_price(0.11), Rung::Light);
        assert_eq!(rung_for_price(LIGHT_BELOW), Rung::Standard);
        assert_eq!(rung_for_price(1.78), Rung::Standard);
        assert_eq!(rung_for_price(STRONG_FROM), Rung::Strong);
        // The ladders the bands were read off still agree with them.
        let blended = |m: &str| {
            let p = crate::pricing::list_price_for_model(m).unwrap();
            (3.0 * p.input_per_million + p.output_per_million) / 4.0
        };
        assert_eq!(rung_for_price(blended("claude-haiku-5-5")), Rung::Light);
        assert_eq!(rung_for_price(blended("claude-sonnet-5-5")), Rung::Standard);
        assert_eq!(rung_for_price(blended("claude-opus-5-5")), Rung::Strong);
        assert_eq!(rung_for_price(blended("gpt-5-mini")), Rung::Light);
        assert_eq!(rung_for_price(blended("gpt-5")), Rung::Standard);
    }

    #[test]
    fn a_goal_goes_to_the_cheapest_star_at_its_rung_not_the_cheapest_star() {
        // The bench that sent a Goal to GLM: OpenRouter stars on no ladder,
        // priced blended, each placed by its price.
        let star = |model: &str, p: f64| Candidate { rungs: vec![rung_for_price(p)], ..starred("openrouter", model, Some(p)) };
        let pool = vec![
            star("deepseek/deepseek-v4-flash", 0.11),
            star("z-ai/glm-5.2", 1.78),
            star("moonshotai/kimi-k2.7-code", 1.34),
            star("openai/gpt-5.6-sol", 8.0),
            Candidate { rungs: vec![Rung::Light], local: true, ..starred("ollama", "klide-8b:latest", Some(0.0)) },
        ];
        let first = |wanted| rank(pool.clone(), "llama3.1:8b", wanted)[0].model.clone();
        assert_eq!(first(Rung::Standard), "moonshotai/kimi-k2.7-code");
        assert_eq!(first(Rung::Light), "klide-8b:latest");
        assert_eq!(first(Rung::Strong), "openai/gpt-5.6-sol");
    }

    #[test]
    fn rungs_on_reads_every_slot_a_model_sits_at() {
        let anthropic = providers::lookup("anthropic").unwrap();
        assert_eq!(rungs_on(&anthropic.auto, "claude-sonnet-5-5"), vec![Rung::Standard]);
        assert_eq!(rungs_on(&anthropic.auto, "claude-3-opus"), Vec::<Rung>::new());
        let openrouter = providers::lookup("openrouter").unwrap();
        assert_eq!(rungs_on(&openrouter.auto, "openrouter/auto"), Rung::ALL.to_vec());
    }

    #[test]
    fn every_hosted_row_offers_auto_a_ladder_and_no_other_row_does() {
        // A new hosted Provider that forgets its ladder would be invisible to
        // Auto for a user who starred nothing; a local or subscription row
        // with one would put a Delegate, or a model nobody installed, in the
        // pool. Both are caught here, not in a bug report.
        for entry in providers::PROVIDERS {
            let hosted = matches!(entry.key, KeySource::Hosted { .. });
            assert_eq!(
                !entry.auto.is_empty(),
                hosted,
                "{}: hosted rows carry a ladder, others carry NO_LADDER",
                entry.id
            );
        }
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
        let line = ts
            .lines()
            .find(|l| l.contains("export const ROUTED_MODEL_TOKEN ="))
            .expect("ROUTED_MODEL_TOKEN in providers.ts");
        assert!(
            line.contains(&format!("\"{ROUTED_MODEL_TOKEN}\"")),
            "ROUTED_MODEL_TOKEN drifted: rust={ROUTED_MODEL_TOKEN:?} ts={line}"
        );
    }

    /// Live: what Auto picks on this machine, for each task shape. Reads the
    /// real keys and local servers and asks each Provider for capabilities;
    /// no model is ever sent a message. Prints the pick, the reason and what
    /// ranked above it, and fails only if a shape neither resolves nor says
    /// what it tried.
    /// `KLIDE_LIVE_STARS="openrouter z-ai/glm-5.2,ollama qwen3.5:9b"` adds
    /// stars, as the picker would send them.
    /// `cargo test --lib -- --ignored --nocapture auto_on_this_bench`
    #[test]
    #[ignore = "live: reads this machine's keys and local servers"]
    fn auto_on_this_bench() {
        let big = "x".repeat(70_000);
        let shapes: [(&str, &str, &str); 4] = [
            ("chat, short", "chat", "hi"),
            ("plan, short", "plan", "plan a refactor of the parser"),
            ("goal, short", "goal", "fix the failing test"),
            ("goal, 17k-token brief", "goal", big.as_str()),
        ];
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("live runtime");
        // Tests never fetch a listing on their own (`models::LISTINGS_OFFLINE`);
        // hand the gate each key's real one, as the running app would have it.
        let mut listings = Vec::new();
        for entry in providers::PROVIDERS.iter().filter(|e| !e.auto.is_empty()) {
            if !matches!(providers::provider_key(entry.id), Ok(Some(_))) {
                continue;
            }
            let listed = rt.block_on(crate::models::load_listing_live(entry.id));
            listings.push((entry, listed));
        }
        for (label, mode, text) in shapes {
            let request: StartRunRequest = serde_json::from_value(serde_json::json!({
                "workspaceRoot": null,
                "mode": mode,
                "provider": AUTO_PROVIDER,
                "model": AUTO_MODEL,
                "initialText": text,
                "context": null,
                "systemPrompt": null,
            }))
            .expect("request");
            let mut request = request;
            request.preferred_models = std::env::var("KLIDE_LIVE_STARS")
                .unwrap_or_default()
                .split(',')
                .filter_map(|pair| pair.trim().split_once(' '))
                .map(|(provider, model)| PreferredModel { provider: provider.into(), model: model.into() })
                .collect();
            let needs = needs_for(&request);
            match rt.block_on(resolve(&request)) {
                Ok(r) => {
                    println!("{label} [{}] → {} {}\n  why: {}", needs.rung.word(), r.provider, r.model, r.reason);
                    for s in &r.skipped {
                        println!("  above it: {s}");
                    }
                }
                Err(e) => {
                    println!("{label} [{}] → no pick\n  {e}", needs.rung.word());
                    assert!(e.contains("Auto"), "an unresolved shape must explain itself: {e}");
                }
            }
        }
        // A ladder slot the key's own listing doesn't name is a pick that
        // fails at the first request.
        for (entry, listed) in &listings {
            for rung in Rung::ALL {
                let Some(model) = rung.slot(&entry.auto) else { continue };
                let verdict = match listed {
                    Ok(ids) if ids.iter().any(|id| id == model) => "listed".to_string(),
                    Ok(ids) => format!("NOT in the key's {} listed models", ids.len()),
                    Err(e) => format!("listing failed: {e}"),
                };
                println!("ladder {} {} {model}: {verdict}", entry.id, rung.word());
            }
        }
    }
}
