# Klide Harness Contract

This document is the interface of the Klide-native Harness. The implementation
lives mostly in `src-tauri/src/agent/`, but callers and future contributors
should be able to understand the trust model from this file.

## Purpose

The Harness owns a Run from user intent to terminal state. It talks to a
Provider, exposes Tools to the model, emits Agent events, records a Transcript,
and pauses for the user whenever a Tool would cross a trust line.

UI surfaces observe the Harness. They do not reimplement the run loop.

## Modes

Modes are capability tiers:

| Mode | Tool surface | Trust rule |
|---|---|---|
| `chat` | No tools | The model can only answer from provided context. |
| `plan` | Built-in read-only tools | The model can inspect the Workspace, but cannot write files, run commands, use dynamic tools, or pause for approval. |
| `goal` | All built-in tools plus dynamic tools | Writes require Diff review; commands and dynamic tools require permission. |

Mode filtering happens twice:

1. The Harness advertises only the schemas available in the selected Mode.
2. The Harness re-checks the Tool capability at dispatch time before execution.

The second check is load-bearing. A Provider may hallucinate, replay, or return a
Tool call that was not advertised. The Harness still denies disallowed Tools.

## Goal Mode vs Goal Loops

`goal` mode is a capability tier: the model may use the full Tool surface, while
writes, commands, and pause points stay gated by the Harness.

A Goal Loop is a supervisor contract above one or more Runs. It should not
execute tools itself. It defines:

- the goal and definition of done
- context sources the worker may rely on
- gates that must pass before completion, such as plan review, delivery review,
  diff scope, command validation, budget, semantic review, and human approval
- iteration, revision, stall, time, and spend limits
- a recorded result with the final stop reason

Klide's first pure Goal Loop implementation lives in
`src/agent/goalLoop.ts`. It is deliberately separate from the Rust Harness loop:
the Harness keeps owning provider turns, Tool dispatch, Diff review, permission,
Transcript writes, and cancellation. Goal Loop state can be projected from
Mission, Validation contract, Budget ledger, and Transcript evidence.

In practical terms:

1. The design step creates a `GoalLoopSpec`.
2. A Run does the actual work through the existing Harness.
3. Validation evidence becomes gate attempts.
4. Failed gates route to a bounded revision, not an unbounded retry.
5. Completion means all required gates are clean, not merely that the Provider
   emitted a final assistant message.

## Tool Capabilities

Every Tool has one capability:

| Capability | Current Tool kind | Rule |
|---|---|---|
| `ReadWorkspace` | `ReadOnly` | May run in `plan` and `goal`. Must resolve paths through the Workspace module when touching files. |
| `WriteWorkspace` | `Write` | Goal-only. Produces a Diff proposal and waits for Diff review before writing. |
| `RunCommand` | `Command` | Goal-only. Produces a permission request and runs only after approval. |
| `PauseForUser` | `Pause` | Goal-only. Pauses the Run for typed user input. |
| `Network` | `Network` | Goal-only. Produces a permission request and reads from the network only after approval. |

Dynamic tools loaded from `.agents/tools.json` are shell-backed command tools.
They are always `RunCommand` capability, Goal-only, approval-gated, timeout
bounded, and Workspace-rooted. They are not available in Plan mode.

## Workspace-Rooted Invariant

The Workspace is the single folder open in Klide. Any Tool that reads or writes
paths must resolve those paths through `src-tauri/src/workspace.rs`.

Commands also run inside the Workspace. Dynamic tools may set `cwd` to
`workspace`, `.`, or a Workspace-relative directory. Absolute and relative cwd
values are accepted only if they resolve inside the Workspace and point to a
directory.

## Permission

Command-capability Tools are not executed by the Tool registry. The Harness:

1. Builds the command and cwd.
2. Runs a preflight that surfaces command arguments resolving outside the
   Workspace — absolute paths, `~`/`$HOME`/`$PWD` expansions, and relative
   `..` escapes resolved against the command cwd. (Transparency, not a sandbox.)
3. Emits `PermissionRequested`.
4. Waits for `agent_resolve_permission`.
5. Runs the command only when the decision is `allow`.
6. Emits `PermissionResolved` and the Tool result.

Approval scopes:

| Scope | Meaning |
|---|---|
| `once` | Run this exact command/cwd once. |
| `run` | Skip re-prompting for this exact command/cwd during the current Run. |
| `project` | Persist this exact command under `.klide/command-allowlist.json` for future Runs in the same Workspace. |

Rejected commands are remembered for the current Run. If the model proposes the
same command/cwd again, the Harness auto-declines and tells the model to take a
different approach.

The project allowlist remains backward-compatible with `commands: string[]` and
also accepts `rules: [{ "pattern": "cargo test *" }]`. Wildcard rules do not
silently approve commands that introduce new outside-Workspace absolute paths;
the Harness asks again so the path is visible to the user.

Network-capability Tools use the same pause/resume permission channel, but store
separate network targets. `web_search` uses the `web_search` target; `web_fetch`
uses `host:<domain>`, such as `host:docs.rs`. Project-scoped network approvals
persist under `.klide/network-allowlist.json` and never imply command approval.

## Diff Review

Write-capability Tools never write immediately. They create a `DiffProposal`.
The Harness emits `DiffProposed`, waits for the user, then either applies the
write or returns a rejection result to the model.

Applied writes create checkpoints so the user can roll back one edit, or revert
all remaining checkpoints for a Run.

Rejected edits are remembered by `<path>::<new_hash>` for the current Run. If
the model proposes the same resulting file contents again, the Harness
auto-declines.

## Dynamic Tool Config

Dynamic tools are read from:

- `~/.agents/tools.json`
- `<workspace>/.agents/tools.json`

Shape:

```json
{
  "tools": [
    {
      "name": "workspace_probe",
      "description": "Inspect the workspace with a custom command.",
      "command": "pwd",
      "cwd": "workspace",
      "timeout_secs": 30
    }
  ]
}
```

Rules:

- `name` must not shadow a built-in Tool. Built-ins win.
- `command` is shown to the user before execution.
- `args`, when supplied by the model, are appended to `command` and shown in the
  same permission request.
- `timeout_secs` defaults to 30 and is clamped to 1..1800.
- `cwd` defaults to the Workspace and must resolve inside it.

## Evidence

The Harness emits Agent events for:

- user messages
- assistant deltas and messages
- Tool starts and finishes
- permission requests and resolutions
- Diff proposals and resolutions
- file changes
- run terminal state

The Transcript is append-only JSONL. Mission Control and follow-up turns should
derive from these events rather than guessing from UI state.

Run summaries derive a Validation snapshot from the Transcript. The snapshot is
evidence, not a correctness proof:

- `passed`: required evidence exists and recorded commands succeeded.
- `failed`: required evidence is missing, or a recorded validation command
  failed.
- `unverified`: files changed and diff review happened, but no validation
  command was recorded.
- `skipped`: no file-changing work required validation evidence.

## Anti-Slop Rule

A Run is not "done" merely because the Provider stopped generating. For
implementation work, the Harness should make evidence visible: files touched,
commands run, checks passed or skipped, and known unverified risk.
