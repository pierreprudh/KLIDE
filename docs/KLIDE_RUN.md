# `klide run` — Klide as a CLI agent

Status: step 1 shipped 2026-11-24 — slices 1–3 (`src-tauri/src/agent/cli_run.rs`,
end-to-end tests in `src-tauri/tests/cli_run.rs`) and 4–5 (`.github/actions/klide`,
klide-bot + review on `klide run`, OpenCode removed).
TODO.md › klide-bot › S6.

## Why

klide-bot answered in GitHub Actions through OpenCode. Pierre wants the bot
fully proprietary: Klide's own Harness, tools, permission engine and prompt,
with no third-party agent in the path. The same command makes Klide usable
from any terminal, script, Remote machine or other agent.

Two steps. **Step 1** (this doc): headless, one shot. **Step 2** (later): an
interactive terminal chat. Step 2 is a UI project and waits for step 1.

## What already existed

| Need | Already there |
|---|---|
| An agent loop without a window | `agent::daemon::RunHost` — `RunHost::new(data_dir, sink)` runs the Harness with no Tauri app; the CI watch, Schedules and the design pilot use it |
| A subcommand front door | `main.rs` dispatches `klide mcp …`, `klide ptyd …`, `klide scheduled` before the GUI starts |
| Keys without the Keychain | `providers::provider_key_in` reads `${VAR}` references and each Provider's env var |
| Unattended safety | CI watch firings run in Plan mode with every Tool that waits for an approval removed (`tools::unattended_read_only_disabled_tool_names`) |
| A Linux binary | `linux-host.yml` builds `klide` on ubuntu-24.04 on every push to `main` that changes its source and publishes it to the `host-<source>` prerelease with a `.sha256` |

So step 1 was a front door plus a terminal event sink, not a new agent.

## The command

```
klide run [options] "<task>"
klide run [options] - < task.md        # task from stdin
```

| Option | Default | Meaning |
|---|---|---|
| `--model <provider>/<model>` | `auto` | Any registry Provider; splits on the first `/` (`openrouter/deepseek/deepseek-v4.1-flash`, `deepseek/deepseek-chat`, `custom:x/model`) |
| `--work` | off | Work mode: edits apply without review. Without it: Plan mode, read-only |
| `--allow-commands` | off | With `--work`: shell commands run without a person (the full-auto rung). Never implied |
| `--cwd <dir>` | current dir | The Workspace |
| `--format text\|json` | `text` | `text`: the answer on stdout, one dim line per Tool on stderr. `json`: one `AgentEvent` per line on stdout |
| `--max-turns <n>` | 50 | Tool-turn cap |
| `--runs-dir <dir>` | a temp dir, deleted at exit | Keep the Transcript (e.g. to upload as a CI artifact) |

Exit codes: `0` finished, `1` the Run failed, `2` usage error, `3` no key
for the chosen Provider (names the variable), `130` interrupted (Ctrl-C
stops the Run cleanly).

## Behaviour

- **Nobody to ask.** Every permission, diff or question the Run raises is
  answered with a refusal, never left waiting. Plan mode drops the Tools that
  pause, as the CI watch does. `--work` keeps edits (applied, no review) and
  drops connectors, `spawn_subagent`, and `run_command` unless
  `--allow-commands`.
- **Hosting.** `RunHost::start_cli` — hosted like a Schedule, but the
  request's own command policy is kept (`--allow-commands` is the person's
  say-so on the command line).
- **Containment.** On macOS, unreviewed commands run in the Seatbelt
  sandbox as in the app. Linux has no sandbox yet; on a CI runner the VM is
  the boundary. `--help` says so.
- **Context.** A compact Rust system prompt (Kit, headless, its authority,
  nobody to ask) plus the Workspace's `AGENTS.md` / `CLAUDE.md` /
  `CONTEXT.md`, capped. The app's prompt is built in TypeScript
  (`system-prompt.ts`); moving it to Rust so both read one source is a
  follow-up.
- **Keys.** Exactly as the app resolves them: a `${VAR}` reference in
  `~/.klide/provider_refs.json` read from the Workspace's `.env` or the
  process environment, else the Keychain (macOS, only where Klide stored a
  key), else the Provider's own env var. In CI: set the variable.
- **No app state touched.** No conversation index, Schedule or Mission. Data
  dir is a temp dir unless `KLIDE_DATA_DIR` is set.

## Implementation slices

1. ✅ **Front door.** `main.rs`: `klide run` → `klide_lib::cli_run_main()`.
2. ✅ **Terminal sink.** Text and JSON; Ctrl-C → Stop.
3. ✅ **Unattended policy.** Request shaping + card refusals. Tests: unit
   (args, request, prompt) and end to end (`tests/cli_run.rs`: answer → 0;
   `--work` without `--allow-commands` never runs a command; missing key →
   3; usage → 2). Checked live on OpenRouter.
4. ✅ **Linux in CI.** A composite action `.github/actions/klide/` that
   downloads `klide-linux-x86_64` from the newest `host-<source>` release,
   checks its `.sha256`, keeps the first that answers `klide run --help`,
   installs the WebKitGTK runtime libraries it links against
   (`libwebkit2gtk-4.1-0 libgtk-3-0`; no display needed), and puts it on
   `PATH`. Workflows use it from `main`
   (`pierreprudh/KLIDE/.github/actions/klide@main`), never from a PR's tree.
5. ✅ **Switch the bots.** `klide-bot.yml` and `review.yml` call `klide run
   --model "$MODEL" --format json -` instead of `opencode run`; the answer
   is the run's last assistant message. Both `opencode.json` configs are
   gone. Done when klide-bot answers a PR comment with no OpenCode installed.

## Open questions

- **Binary weight in CI.** The Linux build links WebKitGTK even though `run`
  never opens a window. Fine for now (one apt step); a headless build without
  Tauri's GUI would be a plain binary and is worth it if the CLI becomes a
  product.
- **Model strings.** `KLIDE_BOT_MODEL` already uses the slash form, so no
  migration.
- **Delegates.** Should `klide run --agent claude-code` drive a Delegate
  headless too? Not for the bot (that would bring a third-party agent back).
  Later, if ever.
