# Klide Memory Engine

Klide owns the memory system. It does not delegate storage, retrieval, review,
or learning policy to an external provider. MCP is an interoperability adapter
that lets Delegate CLIs reach the same engine; Kit and Missions use the Rust
domain directly.

![Klide Memory Engine architecture](public/memory-engine-architecture.svg)

## Product promise

Every agent running through Klide can recover reviewed project knowledge, show
where that knowledge came from, and propose new learning without silently
turning model output into durable fact.

The engine distinguishes three products that are often collapsed into one:

| Layer | Meaning | Authority |
|---|---|---|
| Run memory | Immutable evidence and summaries from a Run | Transcript + Run evidence |
| Project Memory | Reviewed decisions, facts, conventions, failures, patterns, and handoffs | `.klide/memory/*.md` |
| Skill | Reviewed procedure the agent should follow | Workspace Skill files |

## Ownership boundary

The Rust core owns:

- the versioned memory schema;
- Workspace-rooted Markdown persistence;
- deterministic local retrieval;
- review state and supersession;
- provenance back to Runs, Transcripts, commits, and files;
- the native Harness capability;
- the future MCP server adapter.

React owns presentation and draft review. It may request operations through
typed commands, but it does not rank memories or become a second memory engine.

An index is always derived. Markdown stays authoritative and readable without
Klide. The first retrieval implementation scans those files directly. A later
SQLite FTS or local-embedding index may accelerate the same contract, but must
be rebuildable from Markdown.

## Recall lifecycle

![Klide Memory recall lifecycle](public/memory-recall-lifecycle.svg)

1. A Run emits an append-only Transcript and evidence.
2. A model may generate a memory draft from that evidence.
3. The user accepts, edits, merges, or rejects the draft.
4. Accepted knowledge is written as reviewed Project Memory.
5. Plan and Goal Runs search that memory through native Harness Tools.
6. Tool calls and returned provenance land in the Transcript.
7. A future embedded MCP server exposes the same Rust functions to Delegates.

## Trust invariants

1. A draft is not Project Memory.
2. Crossing `memory_write` is the durable review boundary; written entries are
   stamped `reviewed` by Rust regardless of renderer input.
3. Normal recall excludes `superseded` and `stale` entries.
4. Every durable entry can carry source references. Retrieval returns them in
   Tool metadata rather than flattening away provenance.
5. Memory reads have their own `ReadProjectMemory` capability. A Transcript
   never mislabels them as Workspace-file reads or Conversation-history reads.
6. Memory ids are plain components. Reads cannot traverse outside
   `.klide/memory/`.
7. No external service, network request, or remote account is required.

## PR sequence

### PR 1 — Memory engine foundation

This slice establishes the contract:

- schema v1 with kinds, review state, tags, provenance, and supersession;
- deterministic offline search with kind filters and inactive-memory policy;
- native `memory_search` and `memory_read` Tools in Plan and Goal;
- `read_project_memory` capability recorded on Tool events;
- JSON Schemas, architecture documentation, and website-ready SVGs;
- Rust round-trip, ranking, security, capability, and registry tests.

It deliberately does not auto-inject memory. Models recall explicitly, which
makes retrieval inspectable while the ranking and UX are proven.

### PR 2 — Recall evidence and review UX

- add typed `MemoryRecalled`, `MemoryDrafted`, and `MemoryPublished` events;
- show recalled memories in the Context snapshot and Mission Control;
- add bounded pre-run recall behind a per-Workspace setting;
- show source, match reason, token cost, and active/stale state in Memory.

### PR 3 — Embedded MCP server

- add `klide mcp memory` over stdio;
- expose the same `memory_search` and `memory_read` domain operations;
- register the server per Delegate adapter without global configuration drift;
- keep secrets and Workspace selection inside Klide;
- add protocol conformance and Delegate round-trip tests.

Kit and Missions continue calling Rust directly. The MCP process is an adapter,
not the owner and not a loopback dependency.

### PR 4 — Local consolidation and Skill learning

- propose duplicate merges and stale/superseded transitions;
- link contradictions to their evidence;
- distill repeated reviewed patterns into Skill drafts;
- run consolidation locally through the selected Ollama or MLX model;
- require review before changing durable memory or Skills.

## Success criteria

The system is successful when a user can answer these questions without reading
raw agent output:

- What prior knowledge influenced this Run?
- Why did that memory match?
- Which Run, Transcript, commit, or file supports it?
- Is it reviewed, stale, or superseded?
- What new learning is waiting for my approval?
