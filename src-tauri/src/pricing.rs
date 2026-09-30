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
// themselves publish). Cache reads are *not* priced (the input_tokens we
// receive from the providers already excludes them); cache *writes* are
// priced at the same rate as input — Anthropic charges 25% more for cache
// writes, but the difference is small and not all providers expose the
// breakdown, so we keep one input number.
//
// All numbers are list prices as of June 2026. Update by editing the table.

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPricing {
    /// USD per 1,000,000 input tokens (excludes cache reads).
    pub input_per_million: f64,
    /// USD per 1,000,000 output tokens.
    pub output_per_million: f64,
}

impl ModelPricing {
    /// The bill for a token count at this price. Counts are clamped at 0 — a
    /// missing or negative field is zero, never a negative bill.
    pub fn cost(&self, input_tokens: i64, output_tokens: i64) -> f64 {
        let input = input_tokens.max(0) as f64;
        let output = output_tokens.max(0) as f64;
        input * self.input_per_million / 1_000_000.0 + output * self.output_per_million / 1_000_000.0
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
    // Anthropic (direct API).
    if m.starts_with("claude-opus") {
        return Some(ModelPricing {
            input_per_million: 15.0,
            output_per_million: 75.0,
        });
    }
    if m.starts_with("claude-sonnet") {
        return Some(ModelPricing {
            input_per_million: 3.0,
            output_per_million: 15.0,
        });
    }
    if m.starts_with("claude-haiku") {
        return Some(ModelPricing {
            input_per_million: 0.80,
            output_per_million: 4.0,
        });
    }
    // OpenAI (direct).
    if m.starts_with("gpt-5") {
        return Some(ModelPricing {
            input_per_million: 2.5,
            output_per_million: 10.0,
        });
    }
    if m.starts_with("gpt-4.1") {
        return Some(ModelPricing {
            input_per_million: 2.5,
            output_per_million: 10.0,
        });
    }
    if m.starts_with("gpt-4o") {
        return Some(ModelPricing {
            input_per_million: 2.5,
            output_per_million: 10.0,
        });
    }
    // Reasoning models — priced higher for output.
    if m.starts_with("o1") || m.starts_with("o3") || m.starts_with("o4") {
        return Some(ModelPricing {
            input_per_million: 10.0,
            output_per_million: 40.0,
        });
    }
    // Mistral (direct).
    if m.contains("mistral-large") {
        return Some(ModelPricing {
            input_per_million: 2.0,
            output_per_million: 6.0,
        });
    }
    if m.contains("mistral") {
        return Some(ModelPricing {
            input_per_million: 0.4,
            output_per_million: 2.0,
        });
    }
    // DeepSeek (direct). One price for `deepseek-chat` and `deepseek-reasoner`
    // — the platform charges both the same per-token rate and differs only in
    // how much output the reasoner generates. Cache-hit input is cheaper
    // (~$0.028/M); like every other row here we price the cache-miss rate,
    // since the API's `prompt_tokens` doesn't split the two.
    if m.starts_with("deepseek") {
        return Some(ModelPricing {
            input_per_million: 0.28,
            output_per_million: 0.42,
        });
    }
    // xAI.
    if m.starts_with("grok-4") || m.starts_with("grok-4-") {
        return Some(ModelPricing {
            input_per_million: 5.0,
            output_per_million: 15.0,
        });
    }
    if m.starts_with("grok") {
        return Some(ModelPricing {
            input_per_million: 3.0,
            output_per_million: 15.0,
        });
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
        let hosted = Some(ModelPricing {
            input_per_million: 0.28,
            output_per_million: 0.42,
        });
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
        assert_eq!(
            list_price_for_model("claude-opus-4-8"),
            Some(ModelPricing {
                input_per_million: 15.0,
                output_per_million: 75.0
            })
        );
        assert_eq!(
            list_price_for_model("claude-sonnet-4-6"),
            Some(ModelPricing {
                input_per_million: 3.0,
                output_per_million: 15.0
            })
        );
        assert_eq!(
            list_price_for_model("claude-haiku-4-5"),
            Some(ModelPricing {
                input_per_million: 0.80,
                output_per_million: 4.0
            })
        );
    }

    #[test]
    fn hosted_openai_matches_published_prices() {
        assert_eq!(
            list_price_for_model("gpt-5"),
            Some(ModelPricing {
                input_per_million: 2.5,
                output_per_million: 10.0
            })
        );
        assert_eq!(
            list_price_for_model("gpt-4.1"),
            Some(ModelPricing {
                input_per_million: 2.5,
                output_per_million: 10.0
            })
        );
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
