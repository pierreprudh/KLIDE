# Local inference benchmark

An opt-in Rust test compares the Klide model through its real streaming adapters.

| Coverage | Details |
| --- | --- |
| Included | Request builders, streaming loop, response parsers and Tauri chunk delivery |
| Excluded | Full agent harness and workspace tool execution |
| Tasks | Short explanation, long project summary, requested `read_file` call |
| Output | JSON retaining each response, timing, token count and request error |
| Aggregation | Three trials per task; warmup excluded |

## Settings

| Parameter | Required value |
| --- | --- |
| Model | Same Klide Q8 GGUF in both engines |
| Memory | Run only one engine/model at a time |
| Context | 8,192 tokens |
| Output cap | 256 tokens |
| Temperature | 0 |
| Seed | 42 |
| Thinking | Disabled |
| Ollama | Model `pierreprudh/klide-8b:latest` on port 11434 |
| llama.cpp | Alias `pierreprudh/klide-8b` on port 8081; Jinja enabled; context 8192; one parallel slot |

## Measurement flow

```mermaid
flowchart LR
    Model[Same GGUF and settings] --> Ollama[Run Ollama trials]
    Ollama --> Unload[Unload model]
    Unload --> CPP[Run llama.cpp trials]
    CPP --> Inspect[Check response correctness]
    Inspect --> Compare[Compare valid task timings]
```

## Run

Start the chosen server with the matching model and settings, then run from the
repository root. Unload the model before switching engines.

```bash
KLIDE_BENCH_PROVIDER=ollama \
KLIDE_BENCH_OUTPUT=/tmp/klide-ollama.json \
cargo test --manifest-path src-tauri/Cargo.toml \
  compare_klide_model_live -- --ignored --nocapture

KLIDE_BENCH_PROVIDER=llamacpp \
KLIDE_BENCH_OUTPUT=/tmp/klide-llamacpp.json \
cargo test --manifest-path src-tauri/Cargo.toml \
  compare_klide_model_live -- --ignored --nocapture
```

## Read the results

| Field or condition | Interpretation |
| --- | --- |
| Response time | End-to-end adapter request duration |
| First-text timestamp | First nonempty content/thinking chunk; may be absent for tool-only responses |
| Stream throughput | Completion tokens divided by time after first content/thinking; not isolated engine decode speed |
| Repeated prompts | Intentionally measure warm prefix reuse |
| Task correctness | Inspect responses before treating their timing as useful performance |

See the [measured report](results/REPORT.md) for results and limitations.
