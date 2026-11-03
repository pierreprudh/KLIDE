# Registry model discovery

In Settings → Local AI → llama.cpp, select **Find more models**. Discovery reads
Klide's pinned Local AI registry revision, pinned Hugging Face file metadata, and
at most 512 KiB from each eligible GGUF header. It does not download full models.
Select a candidate and press **Start** to download, verify its size and SHA-256,
and launch it through Klide's managed llama.cpp setup. Stop the server to change
models. The selected candidate survives an app restart.

Discovery currently estimates fit on Apple Silicon with detected unified RAM.
It scans all registry recipes rather than requiring an exact hardware entry.
Only single-file GGUFs in standard quantizations with stock llama.cpp provenance
are considered. Multi-card, vision, custom-runtime, and unpinned weights are
excluded. Recipes and shell commands are never executed.

The model budget leaves at least 4 GiB and 35% of RAM for other applications.
The estimate includes exact weight bytes, a conservative F16 KV cache for every
layer at Klide's 16,384-token context, and 2 GiB of working buffers. Hybrid models
use the maximum per-layer KV-head count. Unknown dimensions, unsupported
architectures and files outside the budget are excluded. Estimates do not prove
runtime compatibility, speed, tool reliability, or actual memory pressure.

On the M5 with 16 GiB, the metadata check found LFM2.5-2.6B Q4_0 (1.59 GB download,
4.5 GiB estimate) and Qwen3.5-9B Q4_K_M (5.68 GB download, 9.3 GiB estimate).
Neither result claims a real model load or Klide task test on this machine.

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
