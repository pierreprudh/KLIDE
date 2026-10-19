# Klide Project Memory — Schema and Tool Contract

Source of truth:

- Rust types and persistence: `src-tauri/src/memory.rs`
- Native Harness Tool registry: `src-tauri/src/agent/tools.rs`
- Entry JSON Schema: `schemas/klide-memory-entry.schema.json`
- Tool-call JSON Schema: `schemas/klide-memory-tools.schema.json`

## Entry schema v1

One durable entry is one Markdown file under
`<workspace>/.klide/memory/<id>.md`. Frontmatter contains stable machine fields;
the body remains readable Markdown.

| Field | Shape | Meaning |
|---|---|---|
| `schemaVersion` | integer, currently `1` | Durable schema version |
| `id` | plain string component | Stable id and file stem |
| `kind` | enum | `run`, `handoff`, `decision`, `convention`, `fact`, `failure`, or `pattern` |
| `reviewState` | enum | `proposed`, `reviewed`, `superseded`, or `stale` |
| `tags` | string array | Small retrieval hints |
| `sourceRefs` | source array | Evidence links |
| `supersedes` | memory id or null | Older knowledge replaced by this entry |
| `goal` | string | Short outcome/context statement |
| `decisions` | string array | Durable decisions |
| `filesTouched` | path array | Workspace-relative paths |
| `notes` | Markdown | Supporting explanation |
| `runId` | string or null | Compatibility shortcut for the source Run |

`reviewState` appears on durable entries even though drafts live separately in
the frontend draft store. Rust stamps every entry crossing `memory_write` as
`reviewed`; the renderer cannot forge a durable proposed/stale state.

### Source reference

```json
{
  "sourceType": "run",
  "id": "run-123",
  "label": "Permission refactor",
  "path": "src-tauri/src/agent/permission.rs",
  "lineStart": 40,
  "lineEnd": 88
}
```

Required fields are `sourceType` and `id`. `path` is Workspace-relative. A
remote adapter must never expose the entry's absolute `path` field.

### Markdown example

```markdown
---
schemaVersion: 1
date: 2026-08-31T14:00:00Z
runId: run-123
provider: klide
model: local-model
mode: goal
status: done
title: Keep command trust in Rust
kind: decision
reviewState: reviewed
tags: ["harness","trust"]
sourceRefs: [{"sourceType":"run","id":"run-123"}]
---

# Goal

Keep renderer input from granting command trust.

# Decisions

- Only the fingerprint-bound Rust approval store populates the allowlist.
```

Legacy files without the v1 fields load as reviewed `handoff` entries with an
empty provenance list. Rewriting them is not required. Entries declaring a
newer schema version are not interpreted as v1.

## Retrieval contract

The first engine uses deterministic local ranking. It requires every normalized
query term to match somewhere in the same entry, then weights fields:

| Field | Weight per term |
|---|---:|
| title | 10 |
| goal | 8 |
| decisions | 7 |
| run id | 6 |
| files touched | 6 |
| tags | 6 |
| source references | 5 |
| notes | 3 |

Ties prefer the newest entry and then stable id order. Normal search excludes
non-reviewed entries. Results are capped at 20 and include `score`,
`matchedFields`, a bounded excerpt, the structured entry, and provenance.

The weights are an implementation detail, not a public compatibility promise.
The input/output shapes are the contract; SQLite FTS or local embeddings may
replace ranking later.

## Native Tool contract

Both Tools have capability `ReadProjectMemory` and wire spelling
`read_project_memory`. They are available in Plan and Goal, never Chat.

### `memory_search`

```json
{
  "query": "permission architecture",
  "kinds": ["decision", "failure"],
  "maxResults": 5,
  "includeInactive": false
}
```

- `query` is required.
- `kinds` is optional.
- `maxResults` defaults to 5 and clamps to 1–20.
- `includeInactive` defaults to false.
- Tool metadata contains `{ query, hits }`.

### `memory_read`

```json
{
  "memoryId": "2026-08-31-1400-keep-command-trust-in-rust",
  "includeInactive": false
}
```

The visible result is authoritative Markdown. Tool metadata contains the parsed
entry (without the absolute `path` — Tool metadata is stamped into the durable
Transcript, which crosses the machine boundary). The id validator and Workspace
resolver prevent traversal outside the memory directory. Reading a
proposed/superseded/stale entry requires `includeInactive: true` and returns the
Markdown behind a `[historical evidence …]` marker, mirroring `memory_search`'s
recall rule.

### Store resolution

Both Tools and the `memory_*` commands resolve `.klide/memory/` against the
**main checkout**: a linked git worktree (the default isolation for Races,
Tasks, and Missions) hops through its `.git` file back to the project that owns
the store, so isolated runs recall — and write — the same durable memory. Read
paths never create the directory; only `memory_write` does.

## MCP mapping

The embedded `klide mcp coordination` server exposes `memory_search` and
`memory_read` using the native Tool schemas and dispatch functions. The bridge
binds the Workspace to the authenticated Delegate session. The MCP client cannot
choose a filesystem root or publish memory. Recall preserves provenance and the
native inactive-entry policy, and removes absolute entry paths.

Hermes Focus turns receive this server through ACP's session-specific
`mcpServers`. Claude Code, Codex and OpenCode receive it through their existing
per-session wiring. Hermes terminal sessions and explicit-reasoning CLI turns
do not yet consume this ACP wiring.

The broader resource mapping remains planned:

| Klide domain | MCP primitive |
|---|---|
| `memory_search` | Tool |
| `memory_read` | Tool |
| One reviewed entry | Resource at a Klide-owned `memory://` URI |
| Entry/schema changes | Resource/tool-list change notification where supported |

The adapter must remove absolute paths from external responses and bind every
request to the Workspace selected by Klide. It must not implement its own
ranking, storage, review state, or authorization policy.

## Proposal Tool

`memory_propose({title, kind, notes, why, evidence: {path, quote}})` accepts
file-backed lessons in native Plan/Goal and authenticated Delegate MCP. `kind`
is decision/convention/fact/failure/pattern. Title, notes, rationale and quote
are limited to 160/4,000/1,000/2,000 UTF-8 bytes. The quote must occur exactly in
an Agent-readable Workspace file. Host identity stamps Run provenance; caller
fields cannot override it. The result identifies a pending draft, not a memory
entry. Transcript capability: `propose_project_memory`.

Proposals live outside the Markdown recall store. Human review may edit and
publish a proposal through `memory_proposal_review`; no agent-facing equivalent
exists. Published entries retain the captured quote, source file hash and Run
reference. Pending proposals expire after 30 days, cap at 10 per Workspace and
share the main checkout's store across linked worktrees.
