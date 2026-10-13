# Provider documentation and brand assets

Verified against the providers' official websites on 2026-10-13. Logos are
bundled in `public/` and shared through `ProviderLogo`; no runtime request to
a provider's website is needed. Settings opens documentation in the system browser.

| Provider | Official documentation | Logo source | Local asset |
| --- | --- | --- | --- |
| DeepSeek | https://api-docs.deepseek.com/ | Existing bundled whale mark retained | `public/deepseek-logo.png` |
| Amp | https://ampcode.com/docs/cli | https://ampcode.com/app-icon.svg?v=4 (linked by official docs) | `public/amp-logo.svg` |
| Cursor | https://cursor.com/docs/cli/overview | https://cursor.com/docs-static/favicon.svg (linked by official docs) | `public/cursor-logo.svg` |
| Factory | https://docs.factory.com/droid-cli/overview | https://factory.com/icon.svg (brand logo named in official site metadata) | `public/factory-logo.svg` |
| Hermes | https://hermes-agent.nousresearch.com/docs/user-guide/cli/ | https://hermes-agent.nousresearch.com/docs/img/logo.png and `logo-dark.png` (official docs theme pair) | `public/hermes-logo.png`, `public/hermes-logo-dark.png` |

Amp, Cursor, and Factory retain their published icon colors and backgrounds.
Hermes uses the official light/dark pair. DeepSeek keeps its blue whale.

## Adapter references

- Amp: [execute mode](https://ampcode.com/docs/cli/execute-mode), [threads](https://ampcode.com/docs/threads), [streaming JSON](https://ampcode.com/docs/cli/streaming-json).
- Cursor: [parameters](https://cursor.com/docs/cli/reference/parameters), [headless mode](https://cursor.com/docs/cli/headless).
- Factory: [CLI reference](https://docs.factory.com/droid-cli/cli-reference), [Droid Exec](https://docs.factory.com/droid-exec/overview).
- Hermes: [CLI commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands).
- DeepSeek: [first API call](https://api-docs.deepseek.com/), [function calling](https://api-docs.deepseek.com/guides/function_calling).

The CLI adapters currently implement launch and plain-text headless turns.
These references also document structured output; fetching the docs does not
mean structured event parsing, session import, or per-session MCP wiring has
been implemented.

## Hermes API setup in Klide

Settings → Subscription → Hermes API setup selects DeepSeek, OpenRouter,
Anthropic, or OpenAI and an exact model ID. A blank key reuses the provider's
existing Klide key; a pasted key is saved through Klide's provider keychain
store. The non-secret selection is saved in `~/.klide/hermes.json`.

New Focus, terminal, and Mission launches pass Hermes `--provider` and, when
Klide's model is Default, the saved `--model`. Keys are resolved in the process
host and passed through the provider's environment variable. They are not
placed in shell commands, spawn envelopes, or the Hermes selection file.
Hermes's own configuration files are not edited. “Use Hermes defaults” removes
Klide's override while retaining the API provider's shared key.

Changing setup requires a new terminal session; a running Hermes process keeps
its original configuration. This setup does not configure optional web-search,
image-generation, or other tool-service credentials.

## Intelligence source in the chatbox

The agent picker retains its original design. With Hermes selected, open the
model control (the `default` dropdown) to choose API, Local, Self-hosted, or
Subscription, then a source and model. This choice is stored with the conversation,
while Hermes remains the agent. API choices reuse Klide's existing keys. Local
and self-hosted choices use their OpenAI-compatible endpoint; subscription choices
use accounts already authenticated within Hermes and require an exact model ID.

The configured default still uses Settings → Subscription → Hermes API setup
or Hermes's own defaults when no Klide setup is saved. Start a new interactive
Hermes session to apply a changed source. A running CLI retains its launch config.
If Hermes's `.env` would override the selected key or URL, the launch reports the
conflicting variable instead of silently using another credential or endpoint.

## Shared provider catalog and compatibility

Hermes's intelligence menus now derive API, Local, Self-hosted, and Subscription
rows from the same catalog as Klide's base selector, including custom CLI rows.
Hermes does not maintain a separate Subscription list. The Codex row exposes
Klide's cached Codex model catalog while Hermes uses its own Codex authentication.
All registered hosted API sources can supply Hermes inference; OpenAI-compatible
providers without a dedicated Hermes mapping carry their endpoint and key as an
OpenAI-compatible source.

Subscription CLIs that do not expose a supported Hermes inference route are
visible with a “Needs bridge” indicator and an explanatory tooltip. They do not
silently replace Hermes with that CLI. Full harness/provider interchangeability
still requires these model-endpoint bridges and compatibility adapters for the
other harnesses. Shared catalog visibility is not proof of runtime compatibility.
