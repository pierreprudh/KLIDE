// Per-model list prices for hosted inference providers. Mission Control
// surfaces `cost_usd` on each run row so the user can see what a session
// actually cost — but the model->price mapping is intentionally a small,
// hand-curated table, not a live API.
//
// Why hand-curated:
//   - The prices we care about are the published list prices for the most
//     common 2026 models. They change rarely (every few months) and are
//     public. A live API would add a network dependency and a freshness
//     question we don't need to answer.
//   - OpenRouter / arbitrary passthrough providers don't have a stable
//     per-model price from the user's perspective; we return `None` rather
//     than guess.
//
// This table answers one question — "what does this model id cost at list
// price" — and nothing about *whether* a run is billed. That is the
// Provider's call (`model_capabilities::price_class`): a subscription CLI or
// a local runtime is free whatever the model is called, so a `mistral:7b`
// under Ollama never reaches this table. Callers that only hold a model id
// (the Delegate transcript readers) get a list-price estimate, and say so.
//
// Prices are in USD per million tokens (the standard unit the providers
// themselves publish). Prompt caching is priced too, because with it on the
// cached share is most of a long Run's prompt: a cache *read* bills at the
// row's `cache_read_per_million` (a tenth of input or less), and an
// Anthropic cache *write* at 1.25× input for the five-minute lifetime and 2×
// for the hour. A row with no cache-read price is a provider without a
// prompt cache, and its whole prompt bills at the input rate.
//
// All numbers are list prices as of October 2026. Update by editing the table.

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPricing {
    /// USD per 1,000,000 uncached input tokens.
    pub input_per_million: f64,
    /// USD per 1,000,000 output tokens.
    pub output_per_million: f64,
    /// USD per 1,000,000 input tokens served from the prompt cache. `None`
    /// when the provider has no prompt cache.
    pub cache_read_per_million: Option<f64>,
}

/// What a turn's prompt was made of, as the provider counted it. `read`,
/// `write` and `write_long` are parts of `prompt`, never added to it.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct PromptTokens {
    pub prompt: i64,
    pub read: i64,
    /// Every token written to the cache, the one-hour ones included.
    pub write: i64,
    /// The one-hour share of `write`.
    pub write_long: i64,
}

impl PromptTokens {
    pub fn uncached(prompt: i64) -> Self {
        Self { prompt, ..Self::default() }
    }
}

const CACHE_WRITE_MULTIPLIER: f64 = 1.25;
const CACHE_WRITE_LONG_MULTIPLIER: f64 = 2.0;

impl ModelPricing {
    const fn new(input: f64, output: f64, cache_read: Option<f64>) -> Self {
        Self { input_per_million: input, output_per_million: output, cache_read_per_million: cache_read }
    }

    /// The bill for a token count at this price. Counts are clamped at 0 — a
    /// missing or negative field is zero, never a negative bill.
    pub fn cost(&self, input_tokens: i64, output_tokens: i64) -> f64 {
        self.cost_with_cache(PromptTokens::uncached(input_tokens), output_tokens)
    }

    /// The bill with the prompt split the way the provider billed it. A
    /// provider without a cache-read price bills its reads as input — the
    /// split is then only information, never a discount nobody gave.
    pub fn cost_with_cache(&self, prompt: PromptTokens, output_tokens: i64) -> f64 {
        let per = |tokens: f64, rate: f64| tokens * rate / 1_000_000.0;
        let read = prompt.read.max(0) as f64;
        let write_long = prompt.write_long.clamp(0, prompt.write.max(0)) as f64;
        let write_short = prompt.write.max(0) as f64 - write_long;
        let uncached = (prompt.prompt.max(0) as f64 - read - write_short - write_long).max(0.0);
        let read_rate = self.cache_read_per_million.unwrap_or(self.input_per_million);
        per(uncached, self.input_per_million)
            + per(read, read_rate)
            + per(write_short, self.input_per_million * CACHE_WRITE_MULTIPLIER)
            + per(write_long, self.input_per_million * CACHE_WRITE_LONG_MULTIPLIER)
            + per(output_tokens.max(0) as f64, self.output_per_million)
    }
}

/// The list price for a model id. `None` for an OpenRouter passthrough slug
/// (the underlying model isn't in the id) and any model name the table
/// doesn't recognise. Says nothing about whether the run is billed — see
/// `model_capabilities::price_class` for that.
pub fn list_price_for_model(model: &str) -> Option<ModelPricing> {
    let m = model.trim().to_ascii_lowercase();
    if m.is_empty() {
        return None;
    }
    // An Ollama-style `name:tag` (no vendor segment) is a local pull's id,
    // never a hosted API's — `deepseek-r1:8b` is not `deepseek-chat`.
    if m.contains(':') && !m.contains('/') {
        return None;
    }
    // OpenRouter passthrough — the underlying model price isn't in the id.
    if m.starts_with("openrouter/") || m.starts_with("opencode-go/") {
        return None;
    }
    // Anthropic (direct API). Most specific prefix first: `claude-opus-5-5`
    // before `claude-opus-5`, `claude-fable-5-1` before `claude-fable-5`.
    const ANTHROPIC: &[(&str, ModelPricing)] = &[
        ("claude-fable-5-1", ModelPricing::new(10.0, 50.0, Some(0.25))),
        ("claude-mythos-5-1", ModelPricing::new(10.0, 50.0, Some(0.25))),
        ("claude-fable-5", ModelPricing::new(10.0, 50.0, Some(1.0))),
        ("claude-mythos-5", ModelPricing::new(10.0, 50.0, Some(1.0))),
        ("claude-opus-5-5", ModelPricing::new(4.0, 20.0, Some(0.20))),
        ("claude-opus-5", ModelPricing::new(5.0, 25.0, Some(0.50))),
        ("claude-opus-4-8", ModelPricing::new(5.0, 25.0, Some(0.50))),
        ("claude-opus-4-7", ModelPricing::new(5.0, 25.0, Some(0.50))),
        ("claude-opus-4-6", ModelPricing::new(5.0, 25.0, Some(0.50))),
        ("claude-opus-4-5", ModelPricing::new(5.0, 25.0, Some(0.50))),
        ("claude-opus", ModelPricing::new(15.0, 75.0, Some(1.50))),
        ("claude-sonnet-5", ModelPricing::new(2.0, 10.0, Some(0.20))),
        ("claude-sonnet", ModelPricing::new(3.0, 15.0, Some(0.30))),
        ("claude-haiku-5-5", ModelPricing::new(0.10, 0.50, Some(0.01))),
        ("claude-haiku-4-5", ModelPricing::new(1.0, 5.0, Some(0.10))),
        ("claude-haiku", ModelPricing::new(0.80, 4.0, Some(0.08))),
    ];
    if let Some((_, price)) = ANTHROPIC.iter().find(|(prefix, _)| m.starts_with(prefix)) {
        return Some(*price);
    }
    // OpenAI (direct). Caching is automatic; a cached input token bills at
    // the published cached-input rate.
    if m.starts_with("gpt-5") {
        return Some(ModelPricing::new(2.5, 10.0, Some(0.25)));
    }
    if m.starts_with("gpt-4.1") {
        return Some(ModelPricing::new(2.5, 10.0, Some(0.625)));
    }
    if m.starts_with("gpt-4o") {
        return Some(ModelPricing::new(2.5, 10.0, Some(1.25)));
    }
    // Reasoning models — priced higher for output.
    if m.starts_with("o1") || m.starts_with("o3") || m.starts_with("o4") {
        return Some(ModelPricing::new(10.0, 40.0, Some(2.5)));
    }
    // Mistral (direct). No prompt cache.
    if m.contains("mistral-large") {
        return Some(ModelPricing::new(2.0, 6.0, None));
    }
    if m.contains("mistral") {
        return Some(ModelPricing::new(0.4, 2.0, None));
    }
    // DeepSeek (direct). One price for `deepseek-chat` and `deepseek-reasoner`
    // — the platform charges both the same per-token rate and differs only in
    // how much output the reasoner generates. Its disk cache is automatic and
    // a hit bills at a tenth.
    if m.starts_with("deepseek") {
        return Some(ModelPricing::new(0.28, 0.42, Some(0.028)));
    }
    // xAI. Cached prompt tokens bill at a quarter.
    if m.starts_with("grok-4") || m.starts_with("grok-4-") {
        return Some(ModelPricing::new(5.0, 15.0, Some(1.25)));
    }
    if m.starts_with("grok") {
        return Some(ModelPricing::new(3.0, 15.0, Some(0.75)));
    }
    None
}

/// What a run on this model id would have cost at list price. For a
/// Delegate CLI's transcript, which names the model but runs on the user's
/// subscription — the number is what the session *would* have billed, and
/// the surfaces that show it say "cost" in that sense. A Harness run knows
/// its Provider and asks `model_capabilities::cost_for_run` instead.
pub fn list_price_cost(model: &str, input_tokens: i64, output_tokens: i64) -> Option<f64> {
    Some(list_price_for_model(model)?.cost(input_tokens, output_tokens))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_pulls_and_cli_names_are_simply_unknown_here() {
        // Whether a run is billed is the Provider's call, not this table's:
        // an Ollama pull with no hosted namesake is unknown, and one *with* a
        // hosted namesake (`mistral:7b`) is priced like it — the class check
        // in `model_capabilities` is what keeps a local run free.
        for m in ["llama3.1:8b", "qwen3:14b", "gemma2:9b", "phi3:14b", "lfm2.5:1.2b", "claude-code", "codex", "omp"] {
            assert_eq!(list_price_for_model(m), None, "{m}");
        }
        // The two DeepSeek spellings are told apart by the `:tag` an Ollama
        // pull carries — an untagged id is the hosted API.
        let hosted = Some(ModelPricing::new(0.28, 0.42, Some(0.028)));
        assert_eq!(list_price_for_model("deepseek-chat"), hosted);
        assert_eq!(list_price_for_model("deepseek-reasoner"), hosted);
        assert_eq!(list_price_for_model("deepseek-r1:8b"), None);
    }

    #[test]
    fn passthrough_providers_have_no_known_price() {
        // OpenRouter / opencode-go don't expose the underlying model price.
        for m in [
            "openrouter/auto",
            "openrouter/anthropic/claude-3.5-sonnet",
            "opencode-go/minimax-m3",
        ] {
            assert_eq!(list_price_for_model(m), None, "{m} passthrough should be None");
        }
    }

    #[test]
    fn hosted_anthropic_matches_published_prices() {
        let price = |m: &str| list_price_for_model(m).unwrap();
        assert_eq!(price("claude-opus-5-5"), ModelPricing::new(4.0, 20.0, Some(0.20)));
        assert_eq!(price("claude-opus-5"), ModelPricing::new(5.0, 25.0, Some(0.50)));
        assert_eq!(price("claude-opus-4-8"), ModelPricing::new(5.0, 25.0, Some(0.50)));
        assert_eq!(price("claude-fable-5-1"), ModelPricing::new(10.0, 50.0, Some(0.25)));
        assert_eq!(price("claude-sonnet-5-5"), ModelPricing::new(2.0, 10.0, Some(0.20)));
        assert_eq!(price("claude-sonnet-4-6"), ModelPricing::new(3.0, 15.0, Some(0.30)));
        assert_eq!(price("claude-haiku-5-5"), ModelPricing::new(0.10, 0.50, Some(0.01)));
        assert_eq!(price("claude-haiku-4-5"), ModelPricing::new(1.0, 5.0, Some(0.10)));
    }

    #[test]
    fn hosted_openai_matches_published_prices() {
        assert_eq!(list_price_for_model("gpt-5"), Some(ModelPricing::new(2.5, 10.0, Some(0.25))));
        assert_eq!(list_price_for_model("gpt-4.1"), Some(ModelPricing::new(2.5, 10.0, Some(0.625))));
    }

    #[test]
    fn cached_prompt_bills_reads_cheap_and_writes_at_a_premium() {
        // Opus 5.5: $4 input, $0.20 cache read, writes 1.25× / 2×.
        let price = list_price_for_model("claude-opus-5-5").unwrap();
        let prompt = PromptTokens { prompt: 1_000_000, read: 600_000, write: 300_000, write_long: 100_000 };
        // 100k uncached × 4 + 600k × 0.20 + 200k × 5 + 100k × 8, per million.
        let expected = 0.4 + 0.12 + 1.0 + 0.8;
        assert!((price.cost_with_cache(prompt, 0) - expected).abs() < 1e-9);
        // No split is the plain input price, the old behaviour.
        assert_eq!(price.cost_with_cache(PromptTokens::uncached(1_000_000), 0), 4.0);
    }

    #[test]
    fn a_provider_without_a_cache_bills_reads_as_input() {
        let price = list_price_for_model("mistral-large-latest").unwrap();
        let prompt = PromptTokens { prompt: 1_000_000, read: 900_000, ..PromptTokens::default() };
        assert!((price.cost_with_cache(prompt, 0) - 2.0).abs() < 1e-9);
    }

    #[test]
    fn cost_scales_linearly_with_tokens() {
        // 1M input + 1M output at gpt-5 rates = 2.5 + 10 = 12.5 USD
        let c = list_price_cost("gpt-5", 1_000_000, 1_000_000).unwrap();
        assert!((c - 12.5).abs() < 1e-9);
        // Half a million each = 6.25
        let c = list_price_cost("gpt-5", 500_000, 500_000).unwrap();
        assert!((c - 6.25).abs() < 1e-9);
    }

    #[test]
    fn cost_clamps_negative_token_counts() {
        // A bad adapter could report a negative number if a wire format
        // changes. Don't produce a negative bill — treat it as zero.
        let c = list_price_cost("gpt-5", -10, -20).unwrap();
        assert_eq!(c, 0.0);
    }

    #[test]
    fn case_insensitive_model_match() {
        // Model names from providers vary in case; we lowercase before matching.
        assert_eq!(
            list_price_for_model("CLAUDE-SONNET-4-6"),
            list_price_for_model("claude-sonnet-4-6")
        );
        assert_eq!(list_price_for_model("GPT-5"), list_price_for_model("gpt-5"));
    }

    #[test]
    fn empty_and_unknown_model_return_none() {
        assert_eq!(list_price_for_model(""), None);
        assert_eq!(list_price_for_model("   "), None);
        assert_eq!(list_price_for_model("gpt-9001-future"), None);
        assert_eq!(list_price_cost("gpt-9001-future", 1, 1), None);
    }
}
