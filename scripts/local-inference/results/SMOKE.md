# Live local inference smoke test

Tested 2026-10-06 in the current native Klide development build, using a disposable
workspace with a package.json containing version 0.6.7. This test used Llama 3.2
3B Q4_K_M, not the tuned Klide benchmark model.

| Check | Result |
| --- | --- |
| One-click direct setup | Downloaded the 2.02 GB GGUF and started llama.cpp from Klide settings |
| Original direct context | Failed: Work request contained 10,667 tokens, exceeding the 8,192-token server |
| Context correction | Managed launcher and provider metadata now use 16,384 tokens; memory estimates include an additional conservative allowance |
| Direct chat after fix | Returned `ready`; model also made unnecessary tool calls |
| Direct file tool | Real `read_file package.json` calls succeeded; model continued making calls and was stopped without the requested final version answer |
| AI provider selector | Klide option shows llama.cpp; Llama app option shows Llama app; the other setup is hidden |
| Existing conversations | Retained their original provider after switching |
| Focus selector | Visually verified Llama app shown and llama.cpp hidden when app setup is selected |
| Restart persistence | Llama app setup remained selected after restarting the isolated native test build |
| Llama app model discovery | Discovered the GGUF downloaded by Klide without a second model download |
| Llama app automatic context | Failed: Plan request contained 6,390 tokens, exceeding its automatically chosen 4,096-token context |
| Llama app configured at 16k | Returned `ready`; real file reads succeeded and final answer contained `0.6.7` |
| Llama app tool repetition | Repeated the same read three times; Klide's loop guard steered the model to finish |
| Automated checks | Five llama.cpp configuration/recommendation tests, provider mirror check, TypeScript and 29 frontend provider tests passed |
| Cleanup | Deleted the 2,019,377,736-byte test model cache and test-only model selection; restored Llama app context configuration and stopped temporary servers |
| Existing models | Verified all 92 model files recorded before the test remain present |

These checks establish live connectivity and structured tool execution. They do
not establish reliable coding quality for this small model. Llama app users must
configure sufficient model context for Klide's tool prompts; the settings guidance
now calls out 16k. External server context estimates are not a substitute for its
actual configured limit. The earlier performance benchmark remains an 8k test and
is not changed by the new managed-server default.
