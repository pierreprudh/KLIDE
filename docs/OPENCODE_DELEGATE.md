# OpenCode delegate integration

Klide supports OpenCode 1 and OpenCode 2 through the existing Delegate seam.
The Rust Run host still owns admission, cancellation and the Run lifecycle.
OpenCode owns its tools and provider loop; their activity is observed in Klide,
as with the other Delegate CLIs.

## Versions and placement

The headless transport probes the exact binary it will spawn on each turn.
V1 uses `run --attach` and `/event`; V2 uses `run --server` and `/api/event`.
No JavaScript runtime or `@opencode/client` dependency is added to Klide.

V2 servers launched by Klide are private, on a random loopback port with a
fresh password. The shared OpenCode service cannot safely carry two different
per-Run MCP identities or status callback URLs. PTY and Mission launches use
V2's `--standalone` for the same reason. Klide terminates its own server when
the turn finishes or the Run is cancelled.

The launch also sets `PWD` to its working directory: V2 reads that shell
variable to select a location, so setting only the process working directory
can select the directory from which Klide was launched instead.

## Streaming and recovery

V2's native events identify text by assistant message and the ordinal within
that content kind. Reasoning is streamed separately through Klide's thinking
display; it never becomes answer text. Recovery counts text and reasoning
blocks separately so a reasoning block cannot duplicate the answer.
Its CLI compatibility output uses different part IDs, so the transport reads
answer/tool content from the native stream and session/error information from
the CLI. This avoids displaying the same answer twice.

Before a resumed turn, Klide records the newest durable message. After the
CLI finishes, it pages backward through the projected messages to that
boundary and reconciles only this turn's answer and tool activity. This
recovers a dropped stream without replaying the prompt or an earlier answer.
The event connection itself does not replay missed events or reconnect;
a disconnected answer may pause until the durable tail is recovered.
Provider errors and interrupted executions remain failures.

V2 slash commands use its native session command API because `run --command`
was removed. Headless permissions retain the existing `run --auto` posture:
pending requests are approved once; explicit deny rules remain enforced by
OpenCode. This does not introduce per-tool Klide review of OpenCode's own
Tools. Klide's MCP capabilities still pass through the existing Rust permission
and coordination boundaries.

## History and credentials

Model discovery uses `opencode models --standalone` on V2, so a stale or
unavailable shared service cannot hide models from Klide's picker. V1 retains
`opencode models`. Both queries have a deadline; discovery sends no inference
request and lists the models OpenCode makes available through its providers.

Mission Control reads V1's `session`/`message`/`part` tables and V2's
`session_v2`/`session_message` projections using read-only SQLite connections.
V2 rows preserve parent Run links, terminal outcomes, text, tool inputs and
results, touched files, tokens and recorded cost. Reading history does not
start the shared service or a provider request.

The status plugin has separate V1 and V2 implementations in one default
export. The object entrypoint requires V1 1.18.29 or newer. V2 callbacks also
report the CLI session ID for Run linking.

V2 owns saved credentials in its SQLite database. Klide checks credential
presence without reading secret values and disables its V1 file-snapshot
account switcher for V2. Use OpenCode's `auth login`, `auth list` and
`auth switch <integration> <label>` commands to manage V2 accounts.

## Verification

Unit fixtures were captured from the official V2 2.0.27 CLI against a local
mock model. Tests cover native streaming, transcript recovery, pagination,
resume boundaries, reasoning/peer isolation, tool deduplication, failure
outcomes and the V2 history projections.

A reproducible smoke test starts a disposable local model that streams
reasoning before answer text, with isolated CLI
configuration, then runs the Rust transport through a new turn, a resumed
turn and a native command, including real status-plugin callbacks. It checks
that reasoning arrives before the answer and neither is duplicated:

```sh
python3 scripts/opencode-smoke.py --binary /path/to/opencode
```

It supports V1 and V2, uses no paid inference and does not upgrade the installed
CLI or modify its configuration. Loopback sockets must be permitted. Recorded
native fixtures live in `src-tauri/src/delegate/fixtures/opencode-v2/`.

Upstream contracts: [V2 API](https://opencode.ai/v2/docs/api),
[client](https://opencode.ai/v2/docs/build/client/),
[plugin lifecycle](https://opencode.ai/v2/docs/build/plugins/), and
[migration guide](https://opencode.ai/v2/docs/migrate-v1/).
