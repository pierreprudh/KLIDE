Captured from the official `@opencode/cli-darwin-arm64` 2.0.27 binary on
2026-10-12, using a local OpenAI-compatible mock provider that streams
`Hello `, `from `, `V2.`. No provider credentials or paid inference were used.

`events.jsonl` contains the native `/api/event` session lifecycle and text
payloads; workspace paths were replaced with `/workspace`. `messages.json`
is the durable `/api/session/{id}/message` projection of the same turn.
These preserve the native message/ordinal identity, distinct from the CLI's
V1-compatible stdout part IDs.

API contract: https://opencode.ai/v2/docs/api
Client contract: https://opencode.ai/v2/docs/build/client/
