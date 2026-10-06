# Klide model: Ollama vs llama.cpp

Measured 2026-10-06 on Apple M5, 16 GB RAM, 10 CPU cores, Metal.
Runs use Klide's actual Rust streaming adapters, not the full agent harness.

Same Q8_0 Klide 8.5B GGUF in both engines:
`sha256:c3c0bfb58561fba0d703d7dee5836c9c019a63f48d0980723c40e28a7a97d7b8`.
Ollama 0.35.1; llama.cpp 8950 (4414c04b9).
Context 8192, temperature 0, seed 42, output limit 256, thinking disabled.
One engine loaded at a time. Three repetitions per scenario, medians below.

| Scenario | Ollama response time | llama.cpp response time | Behavior |
| --- | ---: | ---: | --- |
| Short explanation | 338 ms | 323 ms | Both emitted an unsolicited file tool call |
| Long project summary | 289 ms | 271 ms | Both emitted an unsolicited file tool call |
| Requested read_file | 282 ms | 299 ms | Correct tool and path in 3/3 trials for each engine |

There is no demonstrated meaningful performance advantage for replacing Ollama.
The requested tool call was approximately 6% slower through llama.cpp in this small sample;
that difference is too small and the sample too limited to establish a general ranking.

The explanation/summary responses failed their task, so their fast response times must
not be interpreted as useful prose generation throughput. With no tools supplied,
llama.cpp exposed the model's tool syntax as text; Ollama parsed it into tool calls.
The model or its prompt/template behavior needs investigation before a meaningful
coding-quality and longer-generation comparison.

The repeated prompts benefit from warm prefix reuse. Different engine chat templates
produce slightly different token counts on tool requests (Ollama 13 output tokens,
llama.cpp 12). No workspace tools were executed. First-text latency is absent for
structured tool-only responses. The stream throughput field is not an isolated engine
decode metric and is not used to rank these runs. Loading times are excluded; engine
startup was performed differently, so the warmup values are not comparable.

See ../README.md for reproducible commands, and ollama.json / llamacpp.json for full
responses, token counts, and per-trial timing. The benchmark-owned llama.cpp server
was stopped after measurement.
