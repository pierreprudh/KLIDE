# TODO

Working notes for the next sessions. Most recent context: the multi-provider AI
backend (streaming + keychain keys) just landed on
`ai-panel/tool-support-and-thinking`.

## Next up — #3 Anthropic direct API

Anthropic is the flagship provider but its direct API is still `available: false`
in the switcher (`src/components/AiPanel.tsx`). It can't reuse
`openai_compatible_chat` — different shape:

- [ ] Add `anthropic_chat` in `src-tauri/src/lib.rs` — endpoint `https://api.anthropic.com/v1/messages`, header `x-api-key` + `anthropic-version`, **not** bearer auth.
- [ ] Request: system prompt is a top-level `system` field (not a message); messages are `user`/`assistant` only.
- [ ] Stream: SSE with `event:`/`data:` lines (`content_block_delta` → `delta.text`); reassemble `tool_use` blocks for tool calls.
- [ ] Map tool calls back into the shape `parseToolCallsFromChunk` expects.
- [ ] Add `anthropic` to `provider_key` (`ANTHROPIC_API_KEY` fallback) and to the keychain-managed list in `SettingsPanel.tsx` (`API_KEY_PROVIDERS`).
- [ ] Flip `anthropic` to `available: true` once it streams end-to-end.

## Small follow-ups

- [ ] After saving a key in Settings, refresh the AI panel connection immediately (today it re-checks only on provider re-select).
- [ ] Finish or shelve `gemini-cli` — `subscription_cli_chat` currently returns an error for it.
- [ ] Label the subscription CLI family (Claude Code / Codex) as **chat-only** in the UI — agent/diff mode can't run through them.

## Later (rest of v0.2)

- [ ] Command palette (`Cmd+P` / `Cmd+Shift+P`)
- [ ] Find-in-files (needs a Rust ripgrep-style search command)
- [ ] Settings depth

## Verify before shipping the branch

- [ ] Streaming types in token-by-token for Ollama and an API provider.
- [ ] Tool calls still fire after a streamed response (agent mode).
- [ ] Saving/clearing an API key in Settings → API works and the pill updates.
- [ ] `cargo check` + `npx tsc --noEmit` both clean.
