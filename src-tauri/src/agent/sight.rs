//! Eyes for a blind model — what happens to a photo when the model a turn is
//! for cannot see it.
//!
//! Until now the composer refused the drop ("This model can't see images").
//! Now the turn goes out anyway: another model that *can* see looks at the
//! picture first and writes down what is there, and the blind model reads
//! that prose in the place the picture would have been. The description is
//! literal and exhaustive — text in the image verbatim, layout, UI state — so
//! a model fixing a bug from a screenshot gets the error line, not a mood.
//!
//! Which eyes, in order:
//!
//! 1. the pair Settings names (Harness settings → "Eyes model"), when usable;
//! 2. a vision model Ollama has installed and the server is up — free and
//!    the picture never leaves the machine, which is why it comes before
//! 3. a hosted model behind a key the user has entered, in registry order.
//!
//! A Subscription CLI is not a candidate yet: the headless chat turn folds
//! messages to prose and has no way to hand the CLI a file. The run's own pair
//! is never its own eyes, and the candidate is asked the same way auto routing
//! asks (`routing::inspect`): availability first, then the capability table.
//!
//! This runs once per turn inside the run loop, after `auto` has resolved to
//! a concrete pair and before the user message is recorded — so the
//! transcript holds the described attachment (`seen_by` set), a reopened
//! conversation replays prose to the blind model, and the thread still draws
//! the picture the person dropped. Every producer that enters `start_run`
//! gets this; a composer only decides whether to *offer* the drop
//! (`ai_sight_eyes`). The pure parts (`pick`, `lend`) are Tauri-free and
//! tested; `resolve` and `LiveEyes` are the async shells that feed them.

use crate::agent::types::{AgentAttachment, PreferredModel, StartRunRequest};
use crate::providers::{self, KeySource};
use serde::Serialize;
use std::time::Duration;

/// The pair that will describe pictures for a blind model.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Eyes {
    pub provider: String,
    pub model: String,
    pub source: EyesSource,
}

/// Where a pick came from, so a surface can say "your setting" vs "found
/// locally" without re-deriving it.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EyesSource {
    Setting,
    Local,
    Hosted,
}

impl Eyes {
    /// The `provider/model` label an attachment records in `seen_by`. Provider
    /// ids carry no `/`, so a reader splits on the first one.
    pub fn label(&self) -> String {
        format!("{}/{}", self.provider, self.model)
    }
}

/// One pair the resolver may pick, in the order it would pick it.
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub provider: String,
    pub model: String,
    pub source: EyesSource,
}

/// What a Candidate turned out to be.
#[derive(Clone, Debug, PartialEq)]
pub enum Verdict {
    Sees,
    NoKey,
    ServerDown,
    Blind,
    Unreachable(String),
}

/// Walk the candidates in order and keep the first that sees. Pure: the
/// facts come from the caller.
pub async fn pick<F, Fut>(candidates: &[Candidate], mut facts_of: F) -> Option<Eyes>
where
    F: FnMut(&Candidate) -> Fut,
    Fut: std::future::Future<Output = Verdict>,
{
    for candidate in candidates {
        if facts_of(candidate).await == Verdict::Sees {
            return Some(Eyes {
                provider: candidate.provider.clone(),
                model: candidate.model.clone(),
                source: candidate.source,
            });
        }
    }
    None
}

/// Build the ordered pool: the Settings pair, then what Ollama has installed,
/// then every hosted row with a default model. The blind pair itself and
/// Subscription CLIs are left out (see the module doc).
pub async fn gather(setting: Option<&PreferredModel>, blind: (&str, &str)) -> Vec<Candidate> {
    let mut pool: Vec<Candidate> = Vec::new();
    let same_as_blind = |provider: &str, model: &str| {
        provider.eq_ignore_ascii_case(blind.0) && model.eq_ignore_ascii_case(blind.1)
    };
    if let Some(pair) = setting {
        let provider = pair.provider.trim();
        let model = pair.model.trim();
        if !provider.is_empty()
            && !model.is_empty()
            && !providers::is_subscription_provider(provider)
            && !same_as_blind(provider, model)
        {
            pool.push(Candidate {
                provider: provider.to_string(),
                model: model.to_string(),
                source: EyesSource::Setting,
            });
        }
    }
    // Installed local models, only while the server answers — a listing that
    // fails means Ollama is down, and then there are no local eyes.
    if let Ok(tags) = crate::models::installed_ollama_models().await {
        for tag in tags {
            if same_as_blind("ollama", &tag) {
                continue;
            }
            pool.push(Candidate {
                provider: "ollama".to_string(),
                model: tag,
                source: EyesSource::Local,
            });
        }
    }
    for entry in providers::PROVIDERS {
        let KeySource::Hosted { .. } = entry.key else { continue };
        let Some(model) = entry.default_model else { continue };
        if same_as_blind(entry.id, model) {
            continue;
        }
        pool.push(Candidate {
            provider: entry.id.to_string(),
            model: model.to_string(),
            source: EyesSource::Hosted,
        });
    }
    pool
}

/// Ask the Provider about one Candidate: availability first (a missing key or
/// a down server is a verdict, not an error), then whether it sees.
async fn inspect(candidate: Candidate, workspace_root: Option<String>) -> Verdict {
    match providers::lookup(&candidate.provider).map(|e| e.key) {
        Some(KeySource::Hosted { .. }) => {
            let scope = workspace_root.as_deref().map(std::path::Path::new);
            match providers::provider_key_in(&candidate.provider, scope) {
                Ok(Some(key)) if !key.trim().is_empty() => {}
                _ => return Verdict::NoKey,
            }
        }
        Some(KeySource::Local) => {
            if !crate::local_servers::local_server_is_up(&candidate.provider).await {
                return Verdict::ServerDown;
            }
        }
        // A self-hosted endpoint has no key gate; an unreachable host shows
        // up when the description is asked for.
        None => {}
    }
    match crate::model_capabilities::capabilities(&candidate.provider, &candidate.model, false).await {
        Ok(caps) if caps.supports_vision => Verdict::Sees,
        Ok(_) => Verdict::Blind,
        Err(e) => Verdict::Unreachable(e),
    }
}

/// The eyes for one blind pair, or `None` when nothing on this machine or
/// behind a key can see. `setting` is the Settings pair, when the user named
/// one.
pub async fn resolve(
    setting: Option<&PreferredModel>,
    blind: (&str, &str),
    workspace_root: Option<&str>,
) -> Option<Eyes> {
    let pool = gather(setting, blind).await;
    pick(&pool, |c| inspect(c.clone(), workspace_root.map(str::to_string))).await
}

/// The composer's question before it accepts a drop: if this pair cannot see,
/// who would? `None` means the drop should still be refused.
#[tauri::command]
pub(crate) async fn ai_sight_eyes(
    provider: String,
    model: String,
    eyes_provider: Option<String>,
    eyes_model: Option<String>,
    workspace_root: Option<String>,
) -> Result<Option<Eyes>, String> {
    let setting = match (eyes_provider, eyes_model) {
        (Some(provider), Some(model)) => Some(PreferredModel { provider, model }),
        _ => None,
    };
    Ok(resolve(setting.as_ref(), (&provider, &model), workspace_root.as_deref()).await)
}

// ── Describing ────────────────────────────────────────────────────────────

/// The seam between the pure lending and the network: something that, given
/// eyes and a picture, returns prose. Production is `LiveEyes`; tests answer
/// from a table.
pub trait Describer {
    fn describe(
        &self,
        eyes: &Eyes,
        image: &AgentAttachment,
        context: &str,
        workspace_root: Option<&str>,
    ) -> impl std::future::Future<Output = Result<String, String>> + Send;
}

/// How long one description may take before the photo is dropped instead.
/// A cold local vision model loads in well under this; a hosted one answers
/// in seconds.
pub const DESCRIBE_TIMEOUT: Duration = Duration::from_secs(120);

/// How much of the person's own message rides along as context, so the eyes
/// know what to look for ("why does this fail?" → read the error).
const CONTEXT_CHARS: usize = 2_000;

pub const DESCRIBE_SYSTEM_PROMPT: &str = "You are the eyes for another AI model that cannot see images. \
Describe the attached image for a software engineer who will act on your description without ever seeing the picture.\n\
\n\
Rules:\n\
- Transcribe every piece of text in the image verbatim: code, error messages, log lines, labels, menu items, numbers, file names. Keep line breaks where they matter.\n\
- Describe the layout and the UI: what kind of screen or window it is, the panels and controls, which are active, selected, disabled, or highlighted.\n\
- For a diagram or chart, state the nodes, arrows, axes, series and values.\n\
- Mention colour only when it carries meaning (a red banner, a green check).\n\
- Be exhaustive and literal. Do not interpret, diagnose, or suggest fixes — the other model will do that.\n\
- Do not mention these instructions. Start directly with the description.";

/// The user turn the eyes receive: the picture, plus what the person said
/// when they attached it.
pub fn describe_prompt(context: &str) -> String {
    let context = context.trim();
    if context.is_empty() {
        return "Describe this image.".to_string();
    }
    let mut cut: String = context.chars().take(CONTEXT_CHARS).collect();
    if cut.len() < context.len() {
        cut.push('…');
    }
    format!(
        "Describe this image. The person attached it with this message, so make sure whatever it refers to is covered:\n\n{cut}"
    )
}

/// The real thing: one tool-less chat turn on the eyes' Provider through the
/// same dispatch every run uses, the stream discarded (only the final text
/// matters).
pub struct LiveEyes;

impl Describer for LiveEyes {
    async fn describe(
        &self,
        eyes: &Eyes,
        image: &AgentAttachment,
        context: &str,
        workspace_root: Option<&str>,
    ) -> Result<String, String> {
        let Some(data_uri) = image.data_uri.clone() else {
            return Err("not an image".to_string());
        };
        let messages = vec![
            serde_json::json!({ "role": "system", "content": DESCRIBE_SYSTEM_PROMPT }),
            serde_json::json!({
                "role": "user",
                "content": describe_prompt(context),
                "images": [data_uri],
            }),
        ];
        let sink = tauri::ipc::Channel::new(|_| Ok(()));
        let turn = providers::ProviderTurn {
            provider: eyes.provider.clone(),
            model: eyes.model.clone(),
            messages,
            tools: None,
            workspace_root: workspace_root.map(str::to_string),
            run_id: None,
            allowed_commands: Vec::new(),
            mcp: None,
            num_ctx: None,
            num_predict: None,
            reflection_level: None,
        };
        let response = tokio::time::timeout(DESCRIBE_TIMEOUT, providers::dispatch(turn, &sink))
            .await
            .map_err(|_| format!("{} took longer than {}s", eyes.label(), DESCRIBE_TIMEOUT.as_secs()))??;
        let text = response.content.trim().to_string();
        if text.is_empty() {
            return Err(format!("{} returned no description", eyes.label()));
        }
        Ok(text)
    }
}

// ── Lending ───────────────────────────────────────────────────────────────

/// What lending did to one turn.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Sighted {
    /// The eyes used, when any photo was described.
    pub eyes: Option<Eyes>,
    /// How many photos now ride as prose.
    pub described: usize,
    /// Photos dropped, in the context snapshot's `omitted` shape.
    pub omitted: Vec<serde_json::Value>,
}

/// The photos on a turn nobody has described yet.
pub fn undescribed_photos(attachments: &[AgentAttachment]) -> usize {
    attachments
        .iter()
        .filter(|a| a.data_uri.is_some() && a.seen_by.is_none())
        .count()
}

/// Describe every undescribed photo on the turn with `eyes`, in place. A
/// photo the eyes could not read is dropped and named in `omitted`; the turn
/// goes on without it rather than failing. `eyes == None` drops them all —
/// a blind model must never receive bytes it cannot take.
pub async fn lend<D: Describer>(
    request: &mut StartRunRequest,
    eyes: Option<Eyes>,
    describer: &D,
) -> Sighted {
    let mut out = Sighted::default();
    let context = request.initial_text.clone();
    let workspace_root = request.workspace_root.clone();
    let attachments = std::mem::take(&mut request.attachments);
    let mut kept = Vec::with_capacity(attachments.len());
    for mut attachment in attachments {
        if attachment.data_uri.is_none() || attachment.seen_by.is_some() {
            kept.push(attachment);
            continue;
        }
        let Some(eyes) = eyes.as_ref() else {
            out.omitted.push(serde_json::json!({
                "reason": "no model could see this image",
                "path": attachment.path,
            }));
            continue;
        };
        match describer
            .describe(eyes, &attachment, &context, workspace_root.as_deref())
            .await
        {
            Ok(description) => {
                attachment.content = description;
                attachment.seen_by = Some(eyes.label());
                out.described += 1;
                kept.push(attachment);
            }
            Err(error) => {
                out.omitted.push(serde_json::json!({
                    "reason": format!("{} could not read this image: {error}", eyes.label()),
                    "path": attachment.path,
                }));
            }
        }
    }
    request.attachments = kept;
    if out.described > 0 {
        out.eyes = eyes;
    }
    out
}

/// The run loop's one call: if this turn carries photos its own model cannot
/// see, find eyes and lend them. A turn without photos, or on a model that
/// sees, is untouched and costs no network.
pub async fn lend_eyes(request: &mut StartRunRequest) -> Option<Sighted> {
    if undescribed_photos(&request.attachments) == 0 {
        return None;
    }
    // Conservative on the unknown side, like the composer: a pair whose facts
    // cannot be read is treated as blind, and the eyes answer instead.
    let sees = crate::model_capabilities::capabilities(&request.provider, &request.model, false)
        .await
        .map(|caps| caps.supports_vision)
        .unwrap_or(false);
    if sees {
        return None;
    }
    let eyes = resolve(
        request.eyes.as_ref(),
        (&request.provider, &request.model),
        request.workspace_root.as_deref(),
    )
    .await;
    Some(lend(request, eyes, &LiveEyes).await)
}

/// Fold what lending did into the request's context snapshot, which is what
/// `ContextSnapshot` records and the panel reads: the attachments as they now
/// are, plus the drops. Same shape `start_run` uses for the clamp.
pub fn record(request: &mut StartRunRequest, sighted: &Sighted) {
    if request.context.is_none() && sighted.omitted.is_empty() && sighted.described == 0 {
        return;
    }
    let mut snapshot = request
        .context
        .take()
        .unwrap_or_else(|| crate::agent::types::AgentContextSnapshot {
            memory: None,
            workspace_root: request.workspace_root.clone(),
            attachments: Vec::new(),
            lens_items: Vec::new(),
            estimated_tokens: 0,
            omitted: Vec::new(),
        });
    snapshot.attachments = request.attachments.clone();
    snapshot.omitted.extend(sighted.omitted.iter().cloned());
    request.context = Some(snapshot);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::types::AgentMode;
    use std::sync::Mutex;

    fn candidate(provider: &str, model: &str, source: EyesSource) -> Candidate {
        Candidate {
            provider: provider.into(),
            model: model.into(),
            source,
        }
    }

    fn pick_sync(
        candidates: &[Candidate],
        mut facts: impl FnMut(&Candidate) -> Verdict,
    ) -> Option<Eyes> {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("test runtime")
            .block_on(pick(candidates, |c| std::future::ready(facts(c))))
    }

    #[test]
    fn the_first_candidate_that_sees_wins_in_order() {
        let pool = vec![
            candidate("anthropic", "claude", EyesSource::Setting),
            candidate("ollama", "llama3.1:8b", EyesSource::Local),
            candidate("ollama", "gemma3:12b", EyesSource::Local),
            candidate("openai", "gpt-5", EyesSource::Hosted),
        ];
        let eyes = pick_sync(&pool, |c| match (c.provider.as_str(), c.model.as_str()) {
            ("anthropic", _) => Verdict::NoKey,
            (_, "llama3.1:8b") => Verdict::Blind,
            _ => Verdict::Sees,
        })
        .expect("eyes");
        assert_eq!(eyes.model, "gemma3:12b");
        assert_eq!(eyes.source, EyesSource::Local);
        assert_eq!(eyes.label(), "ollama/gemma3:12b");
    }

    #[test]
    fn nothing_sees_means_no_eyes() {
        let pool = vec![
            candidate("ollama", "x", EyesSource::Local),
            candidate("openai", "gpt-5", EyesSource::Hosted),
        ];
        let eyes = pick_sync(&pool, |c| {
            if c.provider == "ollama" {
                Verdict::ServerDown
            } else {
                Verdict::Unreachable("boom".into())
            }
        });
        assert_eq!(eyes, None);
    }

    #[test]
    fn the_prompt_carries_the_persons_message_when_there_is_one() {
        assert_eq!(describe_prompt("  "), "Describe this image.");
        let p = describe_prompt("why does this fail?");
        assert!(p.contains("why does this fail?"), "{p}");
        let long = "x".repeat(CONTEXT_CHARS + 50);
        let p = describe_prompt(&long);
        assert!(p.ends_with('…'));
        assert!(p.len() < long.len() + 200);
    }

    /// Answers from a table, records what it was asked.
    struct TableEyes {
        answers: Mutex<Vec<Result<String, String>>>,
        asked: Mutex<Vec<(String, String)>>,
    }

    impl Describer for TableEyes {
        async fn describe(
            &self,
            eyes: &Eyes,
            image: &AgentAttachment,
            context: &str,
            _workspace_root: Option<&str>,
        ) -> Result<String, String> {
            self.asked
                .lock()
                .unwrap()
                .push((image.path.clone(), format!("{}|{}", eyes.label(), context)));
            self.answers.lock().unwrap().remove(0)
        }
    }

    fn photo(path: &str) -> AgentAttachment {
        AgentAttachment {
            path: path.into(),
            content: String::new(),
            mime: Some("image/png".into()),
            data_uri: Some("data:image/png;base64,AAAA".into()),
            seen_by: None,
        }
    }

    fn document(path: &str) -> AgentAttachment {
        AgentAttachment {
            path: path.into(),
            content: "fn main() {}".into(),
            mime: None,
            data_uri: None,
            seen_by: None,
        }
    }

    fn request(attachments: Vec<AgentAttachment>) -> StartRunRequest {
        StartRunRequest {
            run_id: None,
            workspace_root: Some("/tmp/ws".into()),
            mode: AgentMode::Chat,
            provider: "ollama".into(),
            model: "llama3.1:8b".into(),
            initial_text: "what's wrong here?".into(),
            attachments,
            context: None,
            system_prompt: None,
            disabled_tools: Vec::new(),
            num_ctx: None,
            num_predict: None,
            reflection_level: None,
            max_parallel_tools: None,
            max_turns: None,
            command_timeout_secs: None,
            test_after_edit_command: None,
            goal: None,
            command_allowlist: Vec::new(),
            require_diff_review: None,
            auto_approve_commands: None,
            parent_id: None,
            mission_id: None,
            mission_task_id: None,
            preferred_models: Vec::new(),
            eyes: None,
            routed: None,
        }
    }

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("test runtime")
            .block_on(f)
    }

    #[test]
    fn lending_describes_photos_in_place_and_leaves_documents_alone() {
        let eyes = Eyes {
            provider: "ollama".into(),
            model: "gemma3:12b".into(),
            source: EyesSource::Local,
        };
        let table = TableEyes {
            answers: Mutex::new(vec![Ok("A terminal showing EADDRINUSE.".into())]),
            asked: Mutex::new(Vec::new()),
        };
        let mut req = request(vec![document("main.rs"), photo("shot.png")]);
        let sighted = block_on(lend(&mut req, Some(eyes.clone()), &table));
        assert_eq!(sighted.described, 1);
        assert_eq!(sighted.eyes, Some(eyes));
        assert!(sighted.omitted.is_empty());
        assert_eq!(req.attachments.len(), 2);
        let seen = &req.attachments[1];
        assert_eq!(seen.seen_by.as_deref(), Some("ollama/gemma3:12b"));
        assert_eq!(seen.content, "A terminal showing EADDRINUSE.");
        assert!(seen.data_uri.is_some(), "the picture stays for the thread");
        assert!(req.attachments[0].seen_by.is_none());
        // The eyes were told what the person asked.
        let asked = table.asked.lock().unwrap();
        assert_eq!(asked.len(), 1);
        assert!(asked[0].1.ends_with("what's wrong here?"));
    }

    #[test]
    fn a_photo_the_eyes_cannot_read_is_dropped_and_named() {
        let eyes = Eyes {
            provider: "openai".into(),
            model: "gpt-5".into(),
            source: EyesSource::Hosted,
        };
        let table = TableEyes {
            answers: Mutex::new(vec![Err("401".into()), Ok("fine".into())]),
            asked: Mutex::new(Vec::new()),
        };
        let mut req = request(vec![photo("a.png"), photo("b.png")]);
        let sighted = block_on(lend(&mut req, Some(eyes), &table));
        assert_eq!(sighted.described, 1);
        assert_eq!(req.attachments.len(), 1);
        assert_eq!(req.attachments[0].path, "b.png");
        assert_eq!(sighted.omitted.len(), 1);
        assert_eq!(sighted.omitted[0]["path"], "a.png");
        assert!(sighted.omitted[0]["reason"]
            .as_str()
            .unwrap()
            .starts_with("openai/gpt-5 could not read this image"));
    }

    #[test]
    fn no_eyes_drops_every_photo_so_a_blind_model_never_gets_bytes() {
        let table = TableEyes {
            answers: Mutex::new(Vec::new()),
            asked: Mutex::new(Vec::new()),
        };
        let mut req = request(vec![photo("a.png"), document("x.md")]);
        let sighted = block_on(lend(&mut req, None, &table));
        assert_eq!(sighted.described, 0);
        assert_eq!(sighted.eyes, None);
        assert_eq!(req.attachments.len(), 1);
        assert_eq!(req.attachments[0].path, "x.md");
        assert_eq!(sighted.omitted[0]["reason"], "no model could see this image");
        assert!(table.asked.lock().unwrap().is_empty());
    }

    #[test]
    fn record_refreshes_the_snapshot_with_what_the_run_now_carries() {
        let mut req = request(vec![photo("a.png")]);
        req.attachments[0].seen_by = Some("ollama/gemma3:12b".into());
        req.attachments[0].content = "desc".into();
        let sighted = Sighted {
            eyes: None,
            described: 1,
            omitted: vec![serde_json::json!({ "reason": "r", "path": "b.png" })],
        };
        record(&mut req, &sighted);
        let snapshot = req.context.expect("snapshot");
        assert_eq!(snapshot.attachments.len(), 1);
        assert_eq!(snapshot.attachments[0].seen_by.as_deref(), Some("ollama/gemma3:12b"));
        assert_eq!(snapshot.omitted.len(), 1);
    }

    #[test]
    fn an_untouched_turn_leaves_a_missing_snapshot_missing() {
        let mut req = request(vec![document("x.md")]);
        record(&mut req, &Sighted::default());
        assert!(req.context.is_none());
    }
}
