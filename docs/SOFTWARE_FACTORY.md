# Software factory

Klide's design for a factory, in the language of the `software-factory` skill
(mattpocock/skills, `skills/in-progress/software-factory`): **tasks** whose
**runs** start on a **trigger**, execute on a disposable **runner**, and keep
their only memory in the ticket tracker, the git host and the orchestrator. A
run never waits for a human; it ends, and a human's later change triggers a new
one. Decided in a grilling session on 2026-10-23.

Two phases, in order: first a factory that builds Klide, then Klide as the
control panel for remote factories. Only phase 1 is built.

## Phase 1 — a factory that builds Klide

### The problem

PRs merge with one brake out of three. Automated checks run (`ci.yml`), but no
automated review reads a diff cold, and human review is "merge directly". The
skill's rule is brakes before accelerators, one trigger at a time, so the first
task adds a brake and no speed.

### Services

| Service | Product |
|---|---|
| Ticket tracker | none yet — work lives in `TODO.md` and the changelog |
| Ticket source | none yet |
| Git host | GitHub (`pierreprudh/KLIDE`) |
| Orchestrator | GitHub Actions |
| Runner | an Actions runner (`ubuntu-latest`) |
| Observability platform | none: the Actions run page and the PR comment suffice |

### Task: automated review

`.github/workflows/review.yml`, rulebook `.github/review/REVIEW.md`, agent
config `.github/review/opencode.json`.

1. **Trigger** — a PR opens, reopens or leaves draft; a push follows a *failed*
   review; or someone with write access comments `/review` (optionally
   `/review model=<opencode model>`). A push after a pass keeps the pass.
   Docs-only PRs (`*.md`, `docs/`) pass without a run.
2. **Does** — OpenCode (`opencode-ai`, pinned) runs read-only — edit, bash,
   web and subagents denied, 40 steps at most — on `REVIEW_MODEL` through
   OpenRouter. It judges the diff against `REVIEW.md`, edits one sticky PR
   comment, and sets the `review` commit status: `success`, `failure`
   (blocking findings) or `error` (no verdict, or the run broke).
3. **Triggers next** — nothing. There is no rework task: the author fixes.
4. **Human re-enters** — reads the comment, fixes and pushes, or applies the
   `review-override` label when the reviewer is wrong (the label holds for the
   PR until removed). Merge waits for `ci` and `review` to be green.
5. **Duplicates** — `concurrency: review-<PR>` with `cancel-in-progress`: one
   review per PR, a newer event cancels the stale one.

The model is not the agent's choice, the same principle as the product (see
CONTEXT.md, *harness and model independence*): `REVIEW_MODEL` is a repository
variable, changed in Settings without a code edit, and a `/review model=…`
comment overrides it for one PR so models can be compared on real diffs.

### Setup (once, by hand)

The workflow is inert until `REVIEW_MODEL` is set: it posts no status, so
nothing can be required yet.

- Secret `OPENROUTER_API_KEY`; variable `REVIEW_MODEL`, e.g.
  `openrouter/<vendor>/<model>`.
- A monthly spend limit on the OpenRouter key.
- Branch protection on `main`: require the `review` status.
- Create the `review-override` label.

### Known limits

- The reviewer reads `REVIEW.md` from the PR's own head, so a PR can edit its
  rulebook. Acceptable while every PR comes from this repo's own people.
- A verdict is the model's word. A PR crafted to talk the reviewer into a pass
  can get one; human merge stays the last brake.

### Next tasks, one at a time

Planned as klide-bot in [KLIDE_BOT.md](KLIDE_BOT.md).

Each waits until the brake before it has earned trust: a **rework task**
(fixes only what the review named, capped at two tries before `needs Pierre`),
then a **ratchet task** for the open review findings, then a **retro task**
that turns repeated misses into new `REVIEW.md` lines.

## Phase 2 — Klide as the control panel

Not built. Factory runs stay remote; Klide shows them and hands them back.

- **Vocabulary** — a factory run is a **Run** whose source is remote (GitHub),
  beside the Harness and Delegate sources. Mission Control groups those Runs by
  the workflow that ran them. The skill's *Task* does not enter CONTEXT.md;
  Klide's Task keeps its meaning (a queued todo, the intent).
- **Take over** — a failed or waiting factory run offers *Take over*: the PR
  branch checks out into an isolated worktree (the `runIsolation` policy) and
  an AI panel opens there with the reviewer's findings and the PR link
  pre-filled, not sent. The operator picks the agent and model.
- **Out of scope** — Klide does not become the orchestrator. Clocks and
  automatic triggers are scheduling, parked in CLAUDE.md until budget/capacity
  in dispatch, validation contracts and durable background execution land.
