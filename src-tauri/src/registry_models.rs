//! Registry discovery uses pinned weights and bounded GGUF metadata, never recipe commands.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, sync::Mutex};
const GIB: f64 = 1_073_741_824.;
const HEADER_BYTES: usize = 512 * 1024;
static DISCOVERED: Mutex<Vec<Candidate>> = Mutex::new(Vec::new());
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Candidate {
    pub id: String,
    pub label: String,
    pub maker: String,
    pub description: String,
    pub url: String,
    pub quantization: String,
    pub download_gb: f64,
    pub memory_gb: f64,
    pub registry_source: String,
    #[serde(default)]
    pub publisher: String,
    #[serde(default)]
    pub provider_release: bool,
    repo: String,
    revision: String,
    file: String,
    sha256: String,
    bytes: u64,
}
fn hex(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|b| b.is_ascii_hexdigit())
}
fn component(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}
fn valid_source(repo: &str, revision: &str, file: &str) -> bool {
    repo.split('/').count() == 2
        && repo.split('/').all(component)
        && hex(revision, 40)
        && component(file)
        && file.ends_with(".gguf")
}
// Reviewed provider namespaces. A model's name or a Hub verification badge
// alone does not establish who published its weights.
fn provider_publisher(family: &str, repo: &str) -> Option<(&'static str, &'static str)> {
    let (maker, owner) = match family {
        "qwen" => ("qwen", "Qwen"),
        "lfm" | "liquid" => ("liquid", "LiquidAI"),
        "mistral" => ("mistral", "mistralai"),
        "llama" | "meta" => ("meta", "meta-llama"),
        _ => return None,
    };
    repo.split_once('/')
        .filter(|(publisher, _)| publisher.eq_ignore_ascii_case(owner))
        .map(|_| (maker, owner))
}
fn model_id(file: &str, sha: &str) -> String {
    format!(
        "registry/{}@{}",
        file.trim_end_matches(".gguf"),
        sha.get(..12).unwrap_or("invalid")
    )
}
impl Candidate {
    pub fn refresh_publisher(&mut self) {
        self.publisher = self.repo.split('/').next().unwrap_or("").into();
        self.provider_release = provider_publisher(&self.maker, &self.repo).is_some();
    }
    pub fn valid(&self) -> bool {
        valid_source(&self.repo, &self.revision, &self.file)
            && hex(&self.sha256, 64)
            && self.id == model_id(&self.file, &self.sha256)
            && self.bytes > 0
            && self.memory_gb.is_finite()
            && self.memory_gb > self.bytes as f64 / GIB
    }
    fn download_url(&self) -> String {
        format!(
            "https://huggingface.co/{}/resolve/{}/{}",
            self.repo, self.revision, self.file
        )
    }
    pub fn path(&self) -> std::path::PathBuf {
        crate::cli::home_dir_path()
            .unwrap_or_else(std::env::temp_dir)
            .join(".klide/models")
            .join(format!("registry-{}.gguf", self.sha256))
    }
}
pub(crate) fn cached() -> Vec<Candidate> {
    DISCOVERED.lock().map(|v| v.clone()).unwrap_or_default()
}
pub(crate) fn find(id: &str) -> Option<Candidate> {
    cached().into_iter().find(|m| m.id == id && m.valid())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Discovery {
    pub models: Vec<Candidate>,
    checked: usize,
    unavailable: usize,
}
struct Source {
    key: String,
    label: String,
    about: String,
    repo: String,
    revision: String,
    file: String,
    quant: String,
    maker: String,
    publisher: String,
}
fn sources(cat: &Value) -> Result<Vec<Source>, String> {
    if cat["schema"] != "local-ai-registry/catalog/4" {
        return Err("Unsupported model registry version".into());
    }
    let mut found = BTreeMap::new();
    for (key, r) in cat["recipes"]
        .as_object()
        .ok_or("Missing registry recipes")?
    {
        let l = &r["launch"];
        if !l["image"]
            .as_str()
            .unwrap_or("")
            .starts_with("ghcr.io/ggml-org/llama.cpp@sha256:")
            || l["cards"].as_u64().unwrap_or(1) > 1
            || l["vision"] == true
        {
            continue;
        }
        if !r["proof"].as_array().is_some_and(|p| {
            p.iter().any(|p| {
                p["withdrawn"] != true
                    && p["archived"] != true
                    && p["captured"] != true
                    && p["gates"]
                        .as_str()
                        .is_some_and(|g| g.split_whitespace().any(|v| v == "load"))
            })
        }) {
            continue;
        }
        let Some(weights) = l["weights"].as_array().filter(|w| w.len() == 1) else {
            continue;
        };
        let w = &weights[0];
        let file = w["files"].as_str().or_else(|| {
            w["files"]
                .as_array()
                .filter(|f| f.len() == 1)
                .and_then(|f| f[0].as_str())
        });
        let (Some(repo), Some(revision), Some(file)) =
            (w["repo"].as_str(), w["revision"].as_str(), file)
        else {
            continue;
        };
        if !valid_source(repo, revision, file) {
            continue;
        }
        let model = &cat["models"][r["model"].as_str().unwrap_or("")];
        let Some((maker, publisher)) =
            provider_publisher(model["family"].as_str().unwrap_or(""), repo)
        else {
            continue;
        };
        // Standard quantizations only; special ternary/Hadamard runtimes are not portable.
        let upper = file.to_ascii_uppercase();
        let Some(quant) = [
            "Q4_K_M", "Q4_K_S", "Q4_0", "Q5_K_M", "Q5_K_S", "Q5_0", "Q6_K", "Q8_0",
        ]
        .into_iter()
        .find(|q| upper.ends_with(&format!("-{q}.GGUF"))) else {
            continue;
        };
        found
            .entry(format!("{repo}@{revision}/{file}"))
            .or_insert_with(|| Source {
                key: key.clone(),
                label: model["name"].as_str().unwrap_or(repo).into(),
                about: if model["reasoning"] == true {
                    "Reasoning model · adapted to Klide’s 16k context."
                } else {
                    "Chat model · adapted to Klide’s 16k context."
                }
                .into(),
                repo: repo.into(),
                revision: revision.into(),
                file: file.into(),
                quant: quant.into(),
                maker: maker.into(),
                publisher: publisher.into(),
            });
    }
    Ok(found.into_values().collect())
}
async fn bounded(mut response: reqwest::Response, max: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > max {
            return Err("Metadata exceeds size limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
// A truncated tokenizer at the end of the bounded header is fine; missing dimensions are not.
fn dimensions(bytes: &[u8]) -> Option<BTreeMap<String, Value>> {
    struct Reader<'a> {
        b: &'a [u8],
        p: usize,
    }
    impl Reader<'_> {
        fn take(&mut self, n: usize) -> Option<&[u8]> {
            let end = self.p.checked_add(n)?;
            let b = self.b.get(self.p..end)?;
            self.p = end;
            Some(b)
        }
        fn u32(&mut self) -> Option<u32> {
            Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?))
        }
        fn u64(&mut self) -> Option<u64> {
            Some(u64::from_le_bytes(self.take(8)?.try_into().ok()?))
        }
        fn string(&mut self) -> Option<String> {
            let n = usize::try_from(self.u64()?).ok()?;
            Some(std::str::from_utf8(self.take(n)?).ok()?.into())
        }
        fn value(&mut self, t: u32) -> Option<Value> {
            Some(match t {
                0 | 1 | 7 => Value::from(self.take(1)?[0] as u64),
                2 | 3 => Value::from(u16::from_le_bytes(self.take(2)?.try_into().ok()?) as u64),
                4 | 5 => Value::from(self.u32()? as u64),
                6 => {
                    self.take(4)?;
                    Value::Null
                }
                8 => Value::String(self.string()?),
                9 => {
                    let kind = self.u32()?;
                    let n = self.u64()?;
                    if n > 1_000_000 || kind == 9 {
                        return None;
                    }
                    let mut max = 0;
                    for _ in 0..n {
                        max = max.max(self.value(kind)?.as_u64().unwrap_or(0));
                    }
                    Value::from(max)
                }
                10 | 11 => Value::from(self.u64()?),
                12 => {
                    self.take(8)?;
                    Value::Null
                }
                _ => return None,
            })
        }
    }
    let mut r = Reader { b: bytes, p: 0 };
    if r.take(4)? != b"GGUF" || !matches!(r.u32()?, 2 | 3) {
        return None;
    }
    r.u64()?;
    let count = r.u64()?.min(100_000);
    let mut out = BTreeMap::new();
    for _ in 0..count {
        let Some(k) = r.string() else {
            break;
        };
        let Some(t) = r.u32() else {
            break;
        };
        let Some(v) = r.value(t) else {
            break;
        };
        if !k.contains("tokenizer") {
            out.insert(k, v);
        }
    }
    Some(out)
}
fn memory(bytes: u64, header: &[u8]) -> Option<f64> {
    let d = dimensions(header)?;
    let arch = d.get("general.architecture")?.as_str()?;
    if !["llama", "qwen2", "qwen3", "qwen35", "lfm2"].contains(&arch) {
        return None;
    }
    let num = |key: &str| d.get(&format!("{arch}.{key}"))?.as_u64();
    if num("context_length")? < crate::llamacpp_models::LOCAL_CONTEXT as u64 {
        return None;
    }
    let layers = num("block_count")?;
    let heads = num("attention.head_count")?;
    let kv = num("attention.head_count_kv")?;
    let dim = num("embedding_length")?.checked_div(heads)?;
    let key = num("attention.key_length").unwrap_or(dim);
    let value = num("attention.value_length").unwrap_or(dim);
    if layers == 0
        || layers > 512
        || kv == 0
        || kv > 256
        || key == 0
        || key > 1024
        || value == 0
        || value > 1024
    {
        return None;
    }
    // Full F16 KV for every layer overestimates hybrid models deliberately.
    let cache = (crate::llamacpp_models::LOCAL_CONTEXT as u64)
        .checked_mul(layers)?
        .checked_mul(kv)?
        .checked_mul(key + value)?
        .checked_mul(2)?;
    Some((bytes as f64 + cache as f64) / GIB + 2.)
}
async fn read_header(response: reqwest::Response) -> Result<Vec<u8>, String> {
    if response.status() != reqwest::StatusCode::PARTIAL_CONTENT
        || !response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("bytes 0-"))
    {
        return Err("Server did not honor metadata-only range request".into());
    }
    bounded(response, HEADER_BYTES).await
}
async fn inspect(
    client: &reqwest::Client,
    s: Source,
    budget: f64,
) -> Result<Option<Candidate>, String> {
    let response = client
        .get(format!(
            "https://huggingface.co/api/models/{}/revision/{}?blobs=true",
            s.repo, s.revision
        ))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let meta: Value = serde_json::from_slice(&bounded(response, 4 * 1024 * 1024).await?)
        .map_err(|e| e.to_string())?;
    let file = meta["siblings"]
        .as_array()
        .and_then(|f| f.iter().find(|f| f["rfilename"] == s.file))
        .ok_or("Weight metadata missing")?;
    let bytes = file["size"]
        .as_u64()
        .or_else(|| file["lfs"]["size"].as_u64())
        .ok_or("Missing weight size")?;
    let sha = file["lfs"]["sha256"]
        .as_str()
        .filter(|v| hex(v, 64))
        .ok_or("Missing weight checksum")?;
    if bytes == 0 || bytes as f64 / GIB + 2. > budget {
        return Ok(None);
    }
    let mut m = Candidate {
        id: model_id(&s.file, sha),
        label: s.label,
        maker: s.maker,
        publisher: s.publisher,
        provider_release: true,
        description: s.about,
        url: format!("https://huggingface.co/{}", s.repo),
        quantization: s.quant,
        download_gb: bytes as f64 / 1e9,
        memory_gb: 0.,
        registry_source: format!(
            "https://github.com/sybil-solutions/local-ai-registry/blob/{}/registry/recipes/{}.json",
            crate::local_model_catalog::REVISION,
            s.key
        ),
        repo: s.repo,
        revision: s.revision,
        file: s.file,
        sha256: sha.into(),
        bytes,
    };
    let response = client
        .get(m.download_url())
        .header(
            reqwest::header::RANGE,
            format!("bytes=0-{}", HEADER_BYTES - 1),
        )
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let header = read_header(response).await?;
    let estimate = memory(bytes, &header).ok_or("Memory requirements unknown")?;
    if estimate > budget {
        return Ok(None);
    }
    m.memory_gb = (estimate * 10.).ceil() / 10.;
    if m.memory_gb > budget {
        return Ok(None);
    }
    Ok(Some(m))
}
#[tauri::command]
pub(crate) async fn ai_llamacpp_discover_models() -> Result<Discovery, String> {
    let machine = tokio::task::spawn_blocking(crate::llamacpp_models::machine)
        .await
        .map_err(|e| e.to_string())?;
    if !machine.acceleration.starts_with("Metal") {
        return Err("Registry memory estimates currently require Apple unified memory.".into());
    }
    let budget = crate::llamacpp_models::budget(&machine).ok_or("RAM could not be detected")?;
    let cat: Value = serde_json::from_slice(&crate::local_model_catalog::fetch_catalog().await?)
        .map_err(|e| e.to_string())?;
    let sources = sources(&cat)?;
    let checked = sources.len().min(100);
    let mut unavailable = 0;
    let mut models = Vec::new();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let mut sources = sources.into_iter().take(100);
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        while tasks.len() < 4 {
            let Some(source) = sources.next() else {
                break;
            };
            let client = client.clone();
            tasks.spawn(async move { inspect(&client, source, budget).await });
        }
        let Some(result) = tasks.join_next().await else {
            break;
        };
        match result {
            Ok(Ok(Some(m))) => models.push(m),
            Ok(Ok(None)) => (),
            _ => unavailable += 1,
        }
    }
    models.sort_by(|a, b| {
        a.memory_gb
            .total_cmp(&b.memory_gb)
            .then(a.label.cmp(&b.label))
    });
    let mut ids = std::collections::BTreeSet::new();
    models.retain(|m| ids.insert(m.id.clone()));
    *DISCOVERED.lock().map_err(|e| e.to_string())? = models.clone();
    Ok(Discovery {
        models,
        checked,
        unavailable,
    })
}
pub(crate) async fn ensure(m: Candidate) -> Result<(), String> {
    if !m.valid() {
        return Err("Invalid registry model selection".into());
    }
    let path = m.path();
    if tokio::fs::metadata(&path)
        .await
        .is_ok_and(|f| f.len() == m.bytes)
    {
        return Ok(());
    }
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3600))
        .build()
        .map_err(|e| e.to_string())?
        .get(m.download_url())
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    download_verified(response, &path, m.bytes, &m.sha256).await
}
async fn download_verified(
    mut response: reqwest::Response,
    path: &std::path::Path,
    bytes: u64,
    sha256: &str,
) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncWriteExt;
    tokio::fs::create_dir_all(path.parent().unwrap())
        .await
        .map_err(|e| e.to_string())?;
    let partial = path.with_extension("gguf.part");
    let result = async {
        let mut file = tokio::fs::File::create(&partial)
            .await
            .map_err(|e| e.to_string())?;
        let mut hash = Sha256::new();
        let mut downloaded = 0u64;
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            downloaded += chunk.len() as u64;
            if downloaded > bytes {
                return Err("Model download exceeds its pinned size".into());
            }
            hash.update(&chunk);
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
            crate::local_setup::download("llamacpp", downloaded, Some(bytes));
        }
        if downloaded != bytes || format!("{:x}", hash.finalize()) != sha256 {
            return Err("Model download failed integrity verification. Please retry.".into());
        }
        file.sync_all().await.map_err(|e| e.to_string())?;
        drop(file);
        tokio::fs::rename(&partial, path)
            .await
            .map_err(|e| e.to_string())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(partial).await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn header(arch: &str, layers: u32, context: u32) -> Vec<u8> {
        fn string(b: &mut Vec<u8>, s: &str) {
            b.extend((s.len() as u64).to_le_bytes());
            b.extend(s.as_bytes());
        }
        let mut b = b"GGUF".to_vec();
        b.extend(3u32.to_le_bytes());
        b.extend(0u64.to_le_bytes());
        b.extend(6u64.to_le_bytes());
        string(&mut b, "general.architecture");
        b.extend(8u32.to_le_bytes());
        string(&mut b, arch);
        for (k, v) in [
            ("block_count", layers),
            ("context_length", context),
            ("embedding_length", 4096),
            ("attention.head_count", 16),
            ("attention.head_count_kv", 4),
        ] {
            string(&mut b, &format!("{arch}.{k}"));
            b.extend(4u32.to_le_bytes());
            b.extend(v.to_le_bytes());
        }
        b
    }
    #[test]
    fn provider_identity_requires_the_matching_official_namespace() {
        assert_eq!(
            provider_publisher("qwen", "Qwen/Qwen3-8B-GGUF"),
            Some(("qwen", "Qwen"))
        );
        assert_eq!(
            provider_publisher("lfm", "LiquidAI/LFM2.5-2.6B-GGUF"),
            Some(("liquid", "LiquidAI"))
        );
        for repo in [
            "unsloth/Qwen3.5-9B-GGUF",
            "Qwen-community/Qwen3-GGUF",
            "random/Qwen",
            "LiquidAI/Qwen-GGUF",
        ] {
            assert_eq!(provider_publisher("qwen", repo), None);
        }
        assert_eq!(provider_publisher("unknown", "Qwen/model"), None);
    }
    #[test]
    fn weights_alone_do_not_establish_fit() {
        let h = header("qwen3", 32, 32768);
        // 16k * 32 layers * 4 KV heads * (256+256) * F16 = 2GiB.
        assert_eq!(memory(6 * 1_073_741_824, &h), Some(10.));
        assert!(memory(7 * 1_073_741_824, &h).unwrap() > 10.4);
        assert_eq!(memory(1, &header("unknown", 32, 32768)), None);
        assert_eq!(memory(1, &header("qwen3", 32, 8192)), None);
        assert_eq!(memory(1, &h[..h.len() - 2]), None);
        assert_eq!(memory(1, &header("qwen3", u32::MAX, 32768)), None);
    }
    #[test]
    fn per_layer_arrays_use_conservative_maximum() {
        let mut h = header("lfm2", 30, 128000);
        h.truncate(h.len() - 8);
        h.extend(9u32.to_le_bytes());
        h.extend(4u32.to_le_bytes());
        h.extend(3u64.to_le_bytes());
        for v in [0u32, 8, 0] {
            h.extend(v.to_le_bytes());
        }
        assert_eq!(dimensions(&h).unwrap()["lfm2.attention.head_count_kv"], 8);
    }
    #[test]
    fn paths_and_quantizations_are_restricted() {
        assert!(valid_source(
            "owner/model",
            &"a".repeat(40),
            "model-Q4_0.gguf"
        ));
        for file in ["../x.gguf", "a.gguf,b.gguf", "x/y.gguf"] {
            assert!(!valid_source("owner/model", &"a".repeat(40), file));
        }
        assert!(!valid_source(
            "owner/model/extra",
            &"a".repeat(40),
            "x.gguf"
        ));
        let mut cat = serde_json::json!({"schema":"local-ai-registry/catalog/4","models":{"test":{"family":"qwen"}},"recipes":{"cpu/test":{"model":"test","proof":[{"gates":"load chat"}],"launch":{"image":"ghcr.io/ggml-org/llama.cpp@sha256:abc","weights":[{"repo":"Qwen/model","revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","files":["model-Q4_0.gguf"]}]}}}});
        assert_eq!(sources(&cat).unwrap().len(), 1);
        cat["recipes"]["cpu/test"]["launch"]["weights"][0]["files"] = "model-Q4_0.gguf".into();
        assert_eq!(sources(&cat).unwrap().len(), 1);
        cat["recipes"]["cpu/test"]["launch"]["weights"][0]["files"] =
            "model-Q4_0.gguf,mmproj.gguf".into();
        assert!(sources(&cat).unwrap().is_empty());
        cat["recipes"]["cpu/test"]["launch"]["weights"][0]["files"] = "model-Q4_0.gguf".into();
        cat["recipes"]["cpu/test"]["launch"]["weights"][0]["repo"] = "unsloth/Qwen3-model".into();
        assert!(sources(&cat).unwrap().is_empty());
        cat["recipes"]["cpu/test"]["launch"]["weights"][0]["repo"] = "Qwen/model".into();
        cat["recipes"]["cpu/test"]["launch"]["cards"] = 2.into();
        assert!(sources(&cat).unwrap().is_empty());
        cat["recipes"]["cpu/test"]["launch"]["cards"] = 1.into();
        cat["recipes"]["cpu/test"]["proof"][0]["withdrawn"] = true.into();
        assert!(sources(&cat).unwrap().is_empty());
    }
    #[tokio::test]
    async fn metadata_requests_never_accept_a_full_weight_response() {
        for (status, size, success) in [
            (200, 20, false),
            (206, 20, true),
            (206, HEADER_BYTES + 1, false),
        ] {
            let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
            let url = format!("http://{}", server.server_addr());
            let thread = std::thread::spawn(move || {
                let response = tiny_http::Response::from_data(vec![0; size])
                    .with_status_code(status)
                    .with_header(
                        tiny_http::Header::from_bytes(
                            "Content-Range",
                            format!("bytes 0-{}/1000000000", size - 1),
                        )
                        .unwrap(),
                    );
                let _ = server.recv().unwrap().respond(response);
            });
            let response = reqwest::get(url).await.unwrap();
            assert_eq!(read_header(response).await.is_ok(), success);
            thread.join().unwrap();
        }
    }
    #[tokio::test]
    async fn only_complete_verified_downloads_are_promoted() {
        use sha2::{Digest, Sha256};
        let root = std::env::temp_dir().join(format!(
            "klide-download-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = root.join("model.gguf");
        for (data, size, hash, success) in [
            (
                b"GGUF good".to_vec(),
                9,
                format!("{:x}", Sha256::digest(b"GGUF good")),
                true,
            ),
            (b"GGUF evil".to_vec(), 9, "a".repeat(64), false),
            (b"short".to_vec(), 9, "a".repeat(64), false),
            (b"oversized data".to_vec(), 9, "a".repeat(64), false),
        ] {
            let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
            let url = format!("http://{}", server.server_addr());
            let thread = std::thread::spawn(move || {
                server
                    .recv()
                    .unwrap()
                    .respond(tiny_http::Response::from_data(data))
                    .unwrap()
            });
            let response = reqwest::get(url).await.unwrap();
            assert_eq!(
                download_verified(response, &path, size, &hash)
                    .await
                    .is_ok(),
                success
            );
            thread.join().unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), b"GGUF good");
            assert!(!path.with_extension("gguf.part").exists());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    #[ignore = "Metadata-only live check; reads pinned catalog, HF metadata and bounded headers"]
    async fn live_m5_16gb_discovery() {
        let result = ai_llamacpp_discover_models().await.unwrap();
        for m in &result.models {
            eprintln!(
                "{} {}: {:.2} GB download, {:.1} GiB memory",
                m.label, m.quantization, m.download_gb, m.memory_gb
            );
            assert!(m.valid() && m.memory_gb <= 10.4);
        }
        eprintln!(
            "checked {}, unavailable {}",
            result.checked, result.unavailable
        );
        assert!(result.models.iter().all(|m| m.provider_release));
        assert!(!result.models.iter().any(|m| m.repo.starts_with("unsloth/")));
        assert!(result
            .models
            .iter()
            .any(|m| m.repo == "LiquidAI/LFM2.5-2.6B-GGUF"));
    }
}
