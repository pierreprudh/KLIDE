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

## Tool Capabilities

Every Tool has one capability:

| Capability | Current Tool kind | Rule |
|---|---|---|
| `ReadWorkspace` | `ReadOnly` | May run in `plan` and `goal`. Must resolve paths through the Workspace module when touching files. |
| `WriteWorkspace` | `Write` | Goal-only. Produces a Diff proposal and waits for Diff review before writing. |
| `RunCommand` | `Command` | Goal-only. Produces a permission request and runs only after approval. |
| `PauseForUser` | `Pause` | Goal-only. Pauses the Run for typed user input. |
| `Network` | Reserved | Future network Tools should be permission-profiled explicitly. |

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

1. Builds the exact command and cwd.
2. Emits `PermissionRequested`.
3. Waits for `agent_resolve_permission`.
4. Runs the command only when the decision is `allow`.
5. Emits `PermissionResolved` and the Tool result.

Approval scopes:

| Scope | Meaning |
|---|---|
| `once` | Run this exact command/cwd once. |
| `run` | Skip re-prompting for this exact command/cwd during the current Run. |
| `project` | Currently treated like `run`; durable project policy should become an explicit future module. |

Rejected commands are remembered for the current Run. If the model proposes the
same command/cwd again, the Harness auto-declines and tells the model to take a
different approach.

## Diff Review

Write-capability Tools never write immediately. They create a `DiffProposal`.
The Harness emits `DiffProposed`, waits for the user, then either applies the
write or returns a rejection result to the model.

Applied writes create checkpoints so the user can roll back.

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
