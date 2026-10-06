# Klide model: Ollama vs llama.cpp

No clear performance advantage from replacing Ollama was demonstrated.

## Configuration

| Parameter | Value |
| --- | --- |
| Date | 2026-10-06 |
| Hardware | Apple M5; 16 GB RAM; 10 CPU cores; Metal |
| Model | Identical Klide 8.5B Q8_0 GGUF in both engines |
| Ollama | 0.35.1 |
| llama.cpp | 8950 (`4414c04b9`) |
| Context / output cap | 8,192 / 256 tokens |
| Temperature / seed | 0 / 42 |
| Thinking | Disabled |
| Runs | Three warm trials per task; median response time; one engine loaded at a time |
| Path | Klide's actual Rust streaming adapters |

GGUF SHA-256:

```text
c3c0bfb58561fba0d703d7dee5836c9c019a63f48d0980723c40e28a7a97d7b8
```

## Results

| Task | Ollama | llama.cpp | Behavior |
| --- | ---: | ---: | --- |
| Requested `read_file` | 282 ms | 299 ms | Correct tool and path in 3/3 trials for each engine |
| Short explanation | 338 ms | 323 ms | Both emitted an unsolicited file tool call |
| Long project summary | 289 ms | 271 ms | Both emitted an unsolicited file tool call |

## Interpretation and limitations

| Finding | Meaning |
| --- | --- |
| Requested tool call | Approximately 6% slower through llama.cpp; too few trials to establish a general ranking |
| Explanation / summary | Failed tasks; timings cannot be interpreted as useful prose throughput |
| No tools supplied | llama.cpp exposed tool syntax as text; Ollama parsed it into tool calls |
| Next comparison | Investigate model/prompt/template behavior before measuring longer generation and coding quality |
| Warm reuse | Repeated prompts benefit from prefix caching |
| Output token counts | Tool request: Ollama 13, llama.cpp 12; engine templates differ |
| Scope | No full agent harness or workspace tool execution |
| First-text latency | Absent for structured tool-only responses |
| Stream throughput | Includes stream delivery overhead; not an isolated engine decode metric; not used to rank runs |
| Loading | Excluded; startup methods differ, so warmup times are not comparable |
| Other providers | MLX, LM Studio and Llama app were not measured |
| Cleanup | Benchmark-owned llama.cpp server stopped after measurement |

## Evidence

| Artifact | Contents |
| --- | --- |
| [Reproduction instructions](../README.md) | Settings, prerequisites and commands |
| [Ollama trials](ollama.json) | Full responses, token counts and per-trial timing |
| [llama.cpp trials](llamacpp.json) | Full responses, token counts and per-trial timing |
