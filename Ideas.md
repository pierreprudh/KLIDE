1 - [x] Queue system for messages
2 - [x] Subagent gestion via KLide harness -> can delegated to claude or codex
3 - [x] OpenRouter Connexion
4 - Project Memory for agent continuity: a persistent, agent-oriented memory layer so another agent/session can pick up a task exactly where the previous one stopped. This should capture the goal, current plan, decisions made, files touched, blockers, next steps, and useful context lens/project graph signals.
5 - Global settings panel with stats 

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

## Project Memory
[x] Save end-of-session task summaries into project memory so future Klide agents can resume without rereading the whole conversation.
[x] Add a "summarize and hand off" action at the end of a run/chat.
[x] Store memory in a project-readable format with links to files, diffs, runs, and decisions.
[] Explore an automatic summarizer agent that watches completed/stopped runs and writes durable memory notes.
[] Decide whether `.klide/memory/` should be gitignored or committed per-repo (currently neither — it's plain workspace files).
[] Cross-link memory entries back to the file graph: click a file in `filesTouched` to jump to that file in the editor + the future Project Graph tab.

## Known bugs
- [] When switching away from a workbench view right after creating an AI panel, switching back creates the same AI panel (model) — the panel-preservation story is still per-view, not per-workspace.

## Basics
[x] Control file management from Klide
[x] Resize height options -> create like 2 on one column
[x] based on time and light/dark mode from machine directly
[x] Stop a chat
[x] Open windows view like git panel for File viewing

## SKills & harness
- Auto-generated skills — when the agent solves a problem, it writes a reusable skill so it never solves it from scratch twice. Persistent
  memory across sessions.
- Natural-language scheduling — "every morning, summarize X" → unattended cron runs through the gateway.
- Delegation framework, not chat — you assign tasks, Devin works async, you review draft PRs later. The human role is project manager +
  approver, not pair-programmer.
- CLI → cloud handoff — start a task locally with the CLI, /handoff escalates it to a long-running cloud agent. Same task, different
  execution tier.
- Auto-suggest : Problem/upgrade in the codebase past diagnosticed or others
- SKills like improve-codebase from the github [here](https://github.com/mattpocock/skills)
- [x] providers logo over subscription settings

## Housekeeping
- [ ] Rust `project_graph` command is now dead code (no frontend caller after the file-tree removal). Trivial delete.
- [ ] `src/contextTray.ts` (`lensItemsForPrompt`, `ProjectContextSnapshot`) is dead — no UI feeds the AI context lens any more. The Ideas.md parking lot already flagged this as not-yet-there, so it lands in the right place.


# ERRORS


Klide Light (default)
- Accent: #5A7B4C (soft sage green)
- Accent hover: #6B8E5A
- Background: #f7f4ed
- Foreground: #1c1c1c
- Border: #eceae4
Midnight (cursor-dark)
- Accent: #8EA2FF (blue-violet)
- Background: #11110F
- Foreground: #F0EFE9
- Border: #292824
VS Code Dark
- Accent: #007ACC (classic blue)
- Background: #1E1E1E
- Foreground: #FFFFFF
- Border: #2D2D30
GitHub Light
- Accent: #0969DA (blue)
- Background: #FFFFFF
- Foreground: #1F2328
- Border: #D8DEE4
Solarized Dark
- Accent: #B58900 (gold)
- Background: #002B36
- Foreground: #FDF6E3
- Border: #174652