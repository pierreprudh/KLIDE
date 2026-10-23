# klide-bot — plan

Status: **draft for review** (2026-10-23). Nothing past S0 is built. The design
behind it is in [SOFTWARE_FACTORY.md](SOFTWARE_FACTORY.md); the TODO list is
under *klide-bot* in `TODO.md`.

## Goal

One bot on `pierreprudh/KLIDE`, like `@claude`, that **reviews** every PR
(shipped in #267) and **fixes** a PR when asked in a comment, on any model, with
its own name. Nothing loops on its own: a human starts every fix.

Why not a provider's bot: each one runs only its own company's models — Claude
Code Action (`@claude`), Codex code review (`@codex review` / `@codex fix it`),
Gemini Code Assist and `run-gemini-cli`, Copilot code review, Cursor Bugbot.
OpenCode takes any model string, so the bot is OpenCode on `REVIEW_MODEL` /
`FIX_MODEL`, the same harness/model independence as the product.

## Slices — one PR each, in order

### S0 — Turn the reviewer on

Pierre adds the secret `OPENROUTER_API_KEY` and the variable `REVIEW_MODEL`,
puts a spend limit on the key, and creates the `review-override` label.

- **Done when** three real PRs carry a review comment and a `review` status,
  with no `error` on a good model.
- After about a week of reviews that hold up, branch protection on `main`
  requires `review`.

### S1 — Its own identity

Pierre creates a personal GitHub App `klide-bot` (Contents, Pull requests,
Issues, Statuses: write), installed on KLIDE only; secrets `KLIDE_BOT_APP_ID` and
`KLIDE_BOT_PRIVATE_KEY`. The workflows mint a token with
`actions/create-github-app-token` and act as `klide-bot[bot]`.

Needed, not cosmetic: a commit pushed with the default `GITHUB_TOKEN` triggers
no workflow, so a bot fix would get neither CI nor a re-review. An App token
does trigger them.

- **Done when** the review comment and status come from `klide-bot[bot]`.

### S2 — `/fix` by comment

A comment `/fix`, `/fix <instruction>` or `/fix model=<model>` on a PR:

1. Checks out the PR branch with the App token.
2. Runs OpenCode on `FIX_MODEL` (falls back to `REVIEW_MODEL`) to fix **only**
   the blocking findings in the sticky review comment, plus the instruction.
   It may edit files and run only `npx tsc --noEmit` and `npx vitest run`;
   Rust is left to CI, which needs the macOS runner.
3. Commits once as `klide-bot[bot]` and pushes to the PR branch — never `main`.
4. That push follows a failed review, so the reviewer re-runs by itself.

Loop: review fails → `/fix` → review re-runs → human merges. Only
OWNER/MEMBER/COLLABORATOR can trigger it; `concurrency: fix-<PR>` allows one
fix per PR at a time. A fix that produces no diff comments why and pushes
nothing.

- **Done when** a planted rule break on a test PR goes red → `/fix` → green.

### S3 — Codex as a second opinion (optional)

Add `AGENTS.md` with a *Review guidelines* section pointing to
`.github/review/REVIEW.md` and `CLAUDE.md`; Pierre turns on Codex automatic
reviews. Codex comments only; the required check stays klide-bot's.

Side effect: local Codex, OpenCode and omp sessions start reading Klide's rules
through `AGENTS.md`. Today only Claude Code gets them, through `CLAUDE.md`.

- **Done when** a PR carries both reviews and Codex cites a `REVIEW.md` rule.

### S4 — Automatic rework (later)

A failed review starts a fix by itself, at most 2 tries, then labels the PR
`needs-pierre`. The first automated trigger after the reviewer, so it waits
until S2's fixes have earned trust. Not to build now.

### Out of scope

Mission Control showing these runs and *Take over* — phase 2 in
[SOFTWARE_FACTORY.md](SOFTWARE_FACTORY.md).

## Decisions for Pierre

Recommendation first.

| # | Question | Recommend | Alternative |
|---|---|---|---|
| D1 | Bot identity | **Own GitHub App `klide-bot`**: its own name, its pushes trigger CI | Fine-grained PAT: simpler, but commits show as Pierre |
| D2 | Command word | **`/fix`**, matching `/review` | `@klide-bot fix`: reads like `@claude`, but the handle must match the App name |
| D3 | Fix model | **A separate `FIX_MODEL`**, defaulting to `REVIEW_MODEL` | One model for both |
| D4 | Codex second opinion | **Yes, if the ChatGPT plan includes Codex cloud** (no extra cost) | Skip |
| D5 | OpenCode's official action | **No: keep the pinned `opencode run`.** The action installs the *latest* OpenCode via `curl \| bash` with no pin, and latest may be V2, whose config differs | Use it for less YAML |

## Risks

- **A PR can steer the fixer.** Text in a diff can instruct the model, and in
  S2 the model writes code. Limits: a human starts every fix, it pushes only to
  the PR branch, and CI plus the human merge remain the last brakes.
- **Cost.** A fix costs more than a review (it writes code and runs tests).
  The spend limit on the OpenRouter key caps both.
- **Fork PRs get no secrets,** so neither the review nor the fix runs on them.
  Fine while every PR comes from this repo's own people.
