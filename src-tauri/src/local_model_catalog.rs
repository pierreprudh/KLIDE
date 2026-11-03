//! Read-only adapter for a reviewed Local AI registry revision. Never executes recipes.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const REVISION: &str = "873bb2f8e6b468127939d76ec14245b85e162aa8";
const MAX_BYTES: usize = 12 * 1024 * 1024;

#[derive(Deserialize)]
struct Catalog {
    schema: String,
    cards: BTreeMap<String, Card>,
    recipes: BTreeMap<String, serde_json::Value>,
    models: BTreeMap<String, serde_json::Value>,
}
#[derive(Deserialize)]
struct Card {
    name: String,
    vram_gb: f64,
    picks: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogView {
    revision: &'static str,
    hardware: Vec<HardwareView>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HardwareView {
    id: String,
    name: String,
    memory_gb: f64,
    recipes: Vec<RecipeView>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecipeView {
    id: String,
    model: String,
    engine: String,
    context: Option<u64>,
    decode_tps: Option<f64>,
    prefill_tps: Option<f64>,
    evidence: String,
    date: Option<String>,
    source: String,
    needs: serde_json::Value,
}

fn project(bytes: &[u8]) -> Result<CatalogView, String> {
    let cat: Catalog = serde_json::from_slice(bytes).map_err(|_| "The model catalog could not be read")?;
    if cat.schema != "local-ai-registry/catalog/4" {
        return Err("This catalog version is not supported. Update Klide to read it.".into());
    }
    let mut hardware = Vec::new();
    for (id, card) in cat.cards {
        let recipes = card.picks.iter().take(3).filter_map(|key| {
            if key.split('/').any(|p| p.is_empty() || p == "." || p == "..")
                || !key.chars().all(|c| c.is_ascii_alphanumeric() || "-._/".contains(c)) { return None; }
            let recipe = cat.recipes.get(key)?;
            let proof = recipe["proof"].as_array()?.first()?;
            if proof["withdrawn"] == true || proof["archived"] == true || proof["captured"] == true { return None; }
            let gates = proof["gates"].as_str().unwrap_or("");
            let full = ["load", "chat", "reasoning", "tools", "context", "speed"].iter()
                .all(|g| gates.split_whitespace().any(|v| v == *g));
            let evidence = if proof["legacy"] == true { "Limited upstream checks" }
                else if proof["proxy"] != serde_json::Value::Null && proof["proxy"] != false { "Tested on related hardware" }
                else if full { "Upstream six-check evidence" } else { "Limited upstream checks" };
            let model = recipe["model"].as_str()?;
            Some(RecipeView {
                id: key.clone(),
                model: cat.models.get(model).and_then(|m| m["name"].as_str()).unwrap_or(model).into(),
                engine: recipe["engine"].as_str()?.into(),
                context: recipe["launch"]["ctx"].as_u64(),
                decode_tps: proof["tps"].as_f64(),
                prefill_tps: proof["prefill"].as_f64(),
                evidence: evidence.into(),
                date: proof["at"].as_str().map(str::to_string),
                source: format!("https://github.com/sybil-solutions/local-ai-registry/blob/{REVISION}/registry/recipes/{key}.json"),
                needs: recipe["needs"].clone(),
            })
        }).collect::<Vec<_>>();
        if !recipes.is_empty() { hardware.push(HardwareView { id, name: card.name, memory_gb: card.vram_gb, recipes }); }
    }
    hardware.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.memory_gb.total_cmp(&b.memory_gb)));
    Ok(CatalogView { revision: REVISION, hardware })
}

#[tauri::command]
pub async fn ai_local_model_catalog() -> Result<CatalogView, String> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30))
        .build().map_err(|e| e.to_string())?;
    let mut response = client.get(format!("https://raw.githubusercontent.com/sybil-solutions/local-ai-registry/{REVISION}/dist/catalog.json"))
        .send().await.map_err(|_| "Could not reach the model catalog. Check your connection and retry.")?
        .error_for_status().map_err(|e| format!("Could not load the model catalog: {}", e.status().map(|s| s.as_u16()).unwrap_or(0)))?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Catalog download was interrupted. Please retry.")? {
        if bytes.len() + chunk.len() > MAX_BYTES { return Err("Model catalog exceeds the size limit".into()); }
        bytes.extend_from_slice(&chunk);
    }
    project(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "Downloads the pinned public catalog; no model downloads or inference"]
    async fn pinned_upstream_catalog_is_readable() {
        let view = ai_local_model_catalog().await.unwrap();
        assert!(!view.hardware.is_empty());
        assert!(view.hardware.iter().all(|h| !h.recipes.is_empty() && h.memory_gb.is_finite() && h.memory_gb >= 0.0));
        assert!(view.hardware.iter().flat_map(|h| &h.recipes).all(|r| r.source.contains(REVISION)));
        eprintln!("Catalog {REVISION}: {} hardware entries", view.hardware.len());
    }
    fn fixture() -> serde_json::Value { serde_json::json!({
        "schema":"local-ai-registry/catalog/4", "models": {"test":{"name":"Test model"}},
        "cards":{"apple":{"name":"Apple M2","vram_gb":16,"picks":["apple/m2/test"]}},
        "recipes":{"apple/m2/test":{"model":"test","engine":"llama.cpp@pinned","launch":{"ctx":16384},
            "proof":[{"gates":"load chat reasoning tools context speed","tps":20,"at":"2026-11-01"}]}}
    }) }
    #[test]
    fn preserves_evidence_without_inventing_missing_measurements() {
        let view = project(&serde_json::to_vec(&fixture()).unwrap()).unwrap();
        let r = &view.hardware[0].recipes[0];
        assert_eq!(r.model, "Test model");
        assert_eq!(r.decode_tps, Some(20.0));
        assert_eq!(r.prefill_tps, None);
        assert!(r.source.contains(REVISION));
        assert_eq!(r.evidence, "Upstream six-check evidence");
    }
    #[test]
    fn withdrawals_and_unknown_contracts_are_not_recommended() {
        let mut f = fixture();
        f["recipes"]["apple/m2/test"]["proof"][0]["withdrawn"] = true.into();
        assert!(project(&serde_json::to_vec(&f).unwrap()).unwrap().hardware.is_empty());
        f["schema"] = "future".into();
        assert!(project(&serde_json::to_vec(&f).unwrap()).is_err());
    }
    #[test]
    fn legacy_and_proxy_proofs_do_not_claim_exact_hardware_validation() {
        let mut f = fixture();
        f["recipes"]["apple/m2/test"]["proof"][0]["proxy"] = "sibling-card".into();
        assert_eq!(project(&serde_json::to_vec(&f).unwrap()).unwrap().hardware[0].recipes[0].evidence, "Tested on related hardware");
        f["recipes"]["apple/m2/test"]["proof"][0]["legacy"] = true.into();
        assert_eq!(project(&serde_json::to_vec(&f).unwrap()).unwrap().hardware[0].recipes[0].evidence, "Limited upstream checks");
    }
}
