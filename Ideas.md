1 - [x] Queue system for messages
2 - [x] Subagent gestion via KLide harness -> can delegated to claude or codex
3 - [x] OpenRouter Connexion
4 - [x] Project Memory v1 — durable handoff notes in `.klide/memory/` with Goal / Plan / Decisions / Files touched / Next steps / Notes. Triggered manually from the AI panel's "Summarize" header action.
5 - [x] Global settings panel with stats — keychain-backed keys, harness settings editor, GitHub-style activity heatmap, provider breakdown

- need breakdown for OpenAI -> ( API / Codex ) & Anthropic -> (Claude code /API) + on hover details over graph + when settings get's opened there is a big lag  

6 - [x] Own window view for Git review (keeping the Existing details Ui view)
7 - [x] Real time Actualisation for git and files
8 - Add claude code extention from Vs code design instead of CLI design same for codex 
9 - better visuals to track on-going process from CLI ? 
10 - multi account setup (professional/private)
11 - Free mode curerntly where windows wandered everywhere and another mode to fullfill screen

Inspiration : 
- https://hermes-agent.nousresearch.com/desktop
- https://devin.ai
- https://zenbu.dev/
- https://www.letta.com Obsidian like memory - Dreaming agent ? 
- https://agentrq.com Worth take a look ? 
- https://ara.so 


# On-Go

Design to always fulfill screen

## Mission Control
[x] Markdown for mission control convos
[x] Resume and open — every CLI run in Mission Control has Resume (--resume/<id>) + Open in {other CLI} + Open in Terminal buttons. The row hover shows a single Resume icon. Resume/Open land the user in a new AI panel pinned to the chosen delegate (the AI panel is the natural home for an agent TUI).
[x] Sub-agent tree — runs nest under their parent so you can see a CLI delegate that spawned a Klide sub-run, and the sub-run's stats.
[x] Real token usage — actual cost / tokens surfaced per row.
[x] Brand logos — Anthropic, OpenAI, Claude Code, Codex, OpenCode logos per row.

## Project Memory
[x] Save end-of-session task summaries into project memory so future Klide agents can resume without rereading the whole conversation.
[x] Add a "summarize and hand off" action at the end of a run/chat.
[x] Store memory in a project-readable format with links to files, diffs, runs, and decisions.
[] Explore an automatic summarizer agent that watches completed/stopped runs and writes durable memory notes.
[] Decide whether `.klide/memory/` should be gitignored or committed per-repo (currently neither — it's plain workspace files).
[] Cross-link memory entries back to the file graph: click a file in `filesTouched` to jump to that file in the editor.

## Known bugs
- [] When switching away from a workbench view right after creating an AI panel, switching back creates the same AI panel (model) — the panel-preservation story is still per-view, not per-workspace.

## Basics
[x] Control file management from Klide
[x] Resize height options -> create like 2 on one column
[x] based on time and light/dark mode from machine directly
[x] Stop a chat
[x] Open windows view like git panel for File viewing
[x] Quick view file reader (`FileViewerPanel`) — read-only overlay for the selected file, no tab opened
[x] Activity bar split — top zone (6 tools) + bottom zone (Settings + Profile), separated by a hairline divider
[x] Profile modal — local IDE profile (avatar + identity + workspace), `⌘.`

## Skills & harness
[x] Skills install via `npx skills add <owner/repo>` from the SkillsModal → Install tab, full provenance-grouped loader (workspace / personal / Vercel / Matt Pocock / Anthropic).
[x] Auto-generated skills — when the agent solves a problem, the user clicks the "Save as skill" sparkle and the model writes a `SKILL.md` to `<workspace>/.klide/skills/<slug>/`. Persistent across sessions.
[x] Skills now come from four well-known locations: workspace `.agents/skills`, workspace `.klide/skills`, user `.agents/skills`, user `.claude/skills`.
- Natural-language scheduling — "every morning, summarize X" → unattended cron runs through the gateway.
- Delegation framework, not chat — you assign tasks, Devin works async, you review draft PRs later. The human role is project manager +
  approver, not pair-programmer.
- CLI → cloud handoff — start a task locally with the CLI, /handoff escalates it to a long-running cloud agent. Same task, different
  execution tier.
- Auto-suggest : Problem/upgrade in the codebase past diagnosticed or others
- SKills like improve-codebase from the github [here](https://github.com/mattpocock/skills)
- [x] providers logo over subscription settings


# ERRORS
