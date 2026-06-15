// Per-model pricing for hosted inference providers. Mission Control surfaces
// `cost_usd` on each run row so the user can see what a session actually
// cost — but the model->price mapping is intentionally a small, hand-curated
// table, not a live API.
//
// Why hand-curated:
//   - The prices we care about are the published list prices for the most
//     common 2026 models. They change rarely (every few months) and are
//     public. A live API would add a network dependency and a freshness
//     question we don't need to answer.
//   - Subscription CLIs (claude-code, codex, opencode) and local models
//     (ollama, mlx, …) return `None` — there's no per-token bill to show.
//     Pricing those would be misleading.
//   - OpenRouter / arbitrary passthrough providers don't have a stable
//     per-model price from the user's perspective; we return `None` rather
//     than guess.
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

/// Resolve a per-model price. Returns `None` for local models, subscription
/// CLIs, OpenRouter passthrough (the underlying model isn't known), and any
/// model name we don't recognise — surfacing a cost on those would be
/// misleading.
pub fn pricing_for_model(model: &str) -> Option<ModelPricing> {
    let m = model.trim().to_ascii_lowercase();
    if m.is_empty() {
        return None;
    }
    // Local — free.
    if m.starts_with("llama")
        || m.starts_with("qwen")
        || m.starts_with("gemma")
        || m.starts_with("mistral:") // local mistral via ollama
        || m.starts_with("phi")
        || m.starts_with("lfm")
        || m.starts_with("lfm2")
        || m.starts_with("minimax")
        || m.starts_with("deepseek-coder")
        || m.starts_with("codestral")
        || m.contains("olmo")
        || m.contains("starcoder")
        || m.contains("granite")
    {
        return None;
    }
    // Subscription CLIs — the user already paid.
    if m == "claude-code" || m == "codex" || m == "opencode" {
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

/// Compute the run's USD cost from a model + token counts. Returns `None` when
/// the model has no known price (local, subscription, unknown). Token counts
/// are clamped at 0 — a missing or negative field is treated as zero rather
/// than producing a negative bill.
pub fn cost_for_run(model: &str, input_tokens: i64, output_tokens: i64) -> Option<f64> {
    let pricing = pricing_for_model(model)?;
    let input = input_tokens.max(0) as f64;
    let output = output_tokens.max(0) as f64;
    let dollars = input * pricing.input_per_million / 1_000_000.0
        + output * pricing.output_per_million / 1_000_000.0;
    Some(dollars)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_models_are_free() {
        for m in [
            "llama3.1:8b",
            "qwen3:14b",
            "gemma2:9b",
            "mistral:7b",
            "phi3:14b",
            "lfm2.5:1.2b",
            "minimax:8b",
            "deepseek-coder:6.7b",
        ] {
            assert_eq!(pricing_for_model(m), None, "{m} should be free (local)");
            assert_eq!(cost_for_run(m, 1_000_000, 1_000_000), None);
        }
    }

    #[test]
    fn subscription_clis_are_free() {
        for m in ["claude-code", "codex", "opencode"] {
            assert_eq!(pricing_for_model(m), None);
            assert_eq!(cost_for_run(m, 100, 100), None);
        }
    }

    #[test]
    fn passthrough_providers_have_no_known_price() {
        // OpenRouter / opencode-go don't expose the underlying model price.
        for m in ["openrouter/auto", "openrouter/anthropic/claude-3.5-sonnet", "opencode-go/minimax-m3"] {
            assert_eq!(pricing_for_model(m), None, "{m} passthrough should be None");
        }
    }

    #[test]
    fn hosted_anthropic_matches_published_prices() {
        assert_eq!(
            pricing_for_model("claude-opus-4-8"),
            Some(ModelPricing { input_per_million: 15.0, output_per_million: 75.0 })
        );
        assert_eq!(
            pricing_for_model("claude-sonnet-4-6"),
            Some(ModelPricing { input_per_million: 3.0, output_per_million: 15.0 })
        );
        assert_eq!(
            pricing_for_model("claude-haiku-4-5"),
            Some(ModelPricing { input_per_million: 0.80, output_per_million: 4.0 })
        );
    }

    #[test]
    fn hosted_openai_matches_published_prices() {
        assert_eq!(
            pricing_for_model("gpt-5"),
            Some(ModelPricing { input_per_million: 2.5, output_per_million: 10.0 })
        );
        assert_eq!(
            pricing_for_model("gpt-4.1"),
            Some(ModelPricing { input_per_million: 2.5, output_per_million: 10.0 })
        );
    }

    #[test]
    fn cost_scales_linearly_with_tokens() {
        // 1M input + 1M output at gpt-5 rates = 2.5 + 10 = 12.5 USD
        let c = cost_for_run("gpt-5", 1_000_000, 1_000_000).unwrap();
        assert!((c - 12.5).abs() < 1e-9);
        // Half a million each = 6.25
        let c = cost_for_run("gpt-5", 500_000, 500_000).unwrap();
        assert!((c - 6.25).abs() < 1e-9);
    }

    #[test]
    fn cost_clamps_negative_token_counts() {
        // A bad adapter could report a negative number if a wire format
        // changes. Don't produce a negative bill — treat it as zero.
        let c = cost_for_run("gpt-5", -10, -20).unwrap();
        assert_eq!(c, 0.0);
    }

    #[test]
    fn case_insensitive_model_match() {
        // Model names from providers vary in case; we lowercase before matching.
        assert_eq!(
            pricing_for_model("CLAUDE-SONNET-4-6"),
            pricing_for_model("claude-sonnet-4-6")
        );
        assert_eq!(pricing_for_model("GPT-5"), pricing_for_model("gpt-5"));
    }

    #[test]
    fn empty_and_unknown_model_return_none() {
        assert_eq!(pricing_for_model(""), None);
        assert_eq!(pricing_for_model("   "), None);
        assert_eq!(pricing_for_model("gpt-9001-future"), None);
        assert_eq!(cost_for_run("gpt-9001-future", 1, 1), None);
    }
}
