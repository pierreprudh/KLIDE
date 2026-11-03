# Registry model discovery

In Settings → Local AI → llama.cpp, select **Find more models**. Discovery reads
Klide's pinned Local AI registry revision, pinned Hugging Face file metadata, and
at most 512 KiB from each eligible GGUF header. It does not download full models.
Select a candidate and press **Start** to download, verify its size and SHA-256,
and launch it through Klide's managed llama.cpp setup. Stop the server to change
models. The selected candidate survives an app restart.

Discovery currently estimates fit on Apple Silicon with detected unified RAM.
It scans all registry recipes rather than requiring an exact hardware entry.
Discovery requires weights published by the model provider in a reviewed, matching
provider namespace. A community conversion does not qualify because it uses the
provider’s model name, or because its uploader has a Hub badge. The UI names the
actual publisher. Existing community selections remain accessible separately;
Klide’s own model is also separate from the provider suggestions.

Only single-file GGUFs in standard quantizations with stock llama.cpp provenance
are considered. Multi-card, vision, custom-runtime, and unpinned weights are
excluded. Recipes and shell commands are never executed.

The model budget leaves at least 4 GiB and 35% of RAM for other applications.
The estimate includes exact weight bytes, a conservative F16 KV cache for every
layer at Klide's 16,384-token context, and 2 GiB of working buffers. Hybrid models
use the maximum per-layer KV-head count. Unknown dimensions, unsupported
architectures and files outside the budget are excluded. Estimates do not prove
runtime compatibility, speed, tool reliability, or actual memory pressure.

On the M5 with 16 GiB, the provider-only metadata check finds LiquidAI’s
LFM2.5-2.6B Q4_0 (1.59 GB download, 4.5 GiB estimate). The previous
`unsloth/Qwen3.5-9B-GGUF` suggestion is excluded because it is a third-party
conversion. This result does not claim a real model load or Klide task test.

Provider identities: [LiquidAI model library](https://docs.liquid.ai/lfm/models/complete-library),
[Qwen official repository](https://github.com/QwenLM/Qwen3),
[Mistral official repository](https://huggingface.co/mistralai).

## Verify

```sh
# Unit tests, including tiny HTTP fixtures for download corruption/truncation.
cargo test --manifest-path src-tauri/Cargo.toml registry_models --lib
cargo test --manifest-path src-tauri/Cargo.toml llamacpp_models --lib

# Opt-in network metadata check; no multi-GB weight downloads.
cargo test --manifest-path src-tauri/Cargo.toml live_m5_16gb_discovery --lib -- --ignored --nocapture
```

For an actual model test, choose a candidate and Start, wait for Running, then ask
a short question in a new llama.cpp chat. Ask it to inspect a file in a temporary
workspace and confirm the tool executes. Use the native harness verification
workflow for repeatable acceptance; record model, context, memory pressure and
results separately from the metadata estimate. Start is the action that downloads
weights. Test one engine/model at a time.
