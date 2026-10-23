# Review checklist

You are reviewing one Klide pull request. Klide is a Tauri 2 desktop editor:
TypeScript/React in `src/`, Rust in `src-tauri/`. Read `CONTEXT.md` for the
domain vocabulary and `CLAUDE.md` for the architecture when a rule below needs
context. Judge the diff only, not code it did not touch.

## Blocking — a PR that breaks one of these fails

1. **One agent loop.** The agent loop lives in Rust (`src-tauri/src/agent/`).
   No frontend code dispatches tools or loops over model turns.
2. **Tools are defined once in Rust** as a `ToolEntry`. No duplicate TS tool
   schemas; the frontend fetches them over IPC.
3. **No raw `invoke` in components.** Covered command families go through
   `src/ipc/` wrappers or a domain data layer.
4. **No new sync Tauri command doing IO.** IO-bearing commands are `async fn`
   whose body runs in `blocking::run`.
5. **Durable state goes through `durable.rs`** (atomic replace, flushed
   appends). Interior corruption is an error, never a silent `continue`.
6. **No API keys in the frontend** — not in localStorage, React state or logs.
   Keys live in the Keychain; self-hosted tokens are `${VAR}` references.
7. **Workspace-rooted file access.** Agent tools verify a path is inside the
   workspace before reading or writing.
8. **Generated mirrors are not hand-edited**
   (`src/agent/providerCatalog.generated.ts`); a provider fact changes on its
   Rust registry row.
9. **Prompt-cache prefix.** A Run's request opens with the exact bytes of the
   one before it: no per-turn content in the system prompt, no history rewrite
   outside compaction.
10. **Coordination** has two doors (native Tools, the Delegate MCP bridge) and
    no third; an adapter never trusts a caller-supplied actor.
11. **Correctness** — a bug the diff introduces: wrong logic, a race, an
    unhandled error path, a broken test, a type hole papered over with `any`.

## Non-blocking — mention, do not fail

- Icons come from `src/icons.tsx`; brand/provider/file marks are the exception.
- Design: no chips/pills or status dots, no saturated accents, gradients or
  drop shadows; colours come from `src/styles/tokens.css`.
- Code reads like its neighbours: comment density, naming, idiom.
- Vocabulary drifts from `CONTEXT.md` (a term under its _Avoid_ list).

## Output

Write a short review in Markdown: each finding as `file:line — what is wrong —
why it matters`, blocking findings first. No praise, no summary of the diff.
If nothing is wrong, say so in one line.

The very last line must be exactly one of:

VERDICT: PASS
VERDICT: FAIL

FAIL if and only if there is at least one blocking finding.
