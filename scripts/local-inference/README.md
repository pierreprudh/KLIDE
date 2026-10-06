# Klide model: Ollama vs llama.cpp

The ignored Rust test uses Klide's actual request builders, streaming loop,
parsers and Tauri chunk delivery. It does not run the full agent harness or
execute workspace tools. Synthetic prompts test short output, long prefill,
and a correctly parsed read_file call. Warm-up is excluded from aggregates.

Use the same Klide Q8 GGUF for both engines; run one engine/model at a time.
Context: 8192, output cap: 256, temperature: 0, seed: 42, thinking disabled.
The JSON files retain every output and any error. Stream throughput includes
all reported completion tokens divided by time after first content/thinking;
this is not an engine's isolated decode-time metric. Tool-only responses may
have no first-text timestamp. Repeated prompts intentionally test warm reuse.

Run from the repo root with each server ready:

```bash
KLIDE_BENCH_PROVIDER=ollama KLIDE_BENCH_OUTPUT=/tmp/klide-ollama.json cargo test --manifest-path src-tauri/Cargo.toml compare_klide_model_live -- --ignored --nocapture
KLIDE_BENCH_PROVIDER=llamacpp KLIDE_BENCH_OUTPUT=/tmp/klide-llamacpp.json cargo test --manifest-path src-tauri/Cargo.toml compare_klide_model_live -- --ignored --nocapture
```
