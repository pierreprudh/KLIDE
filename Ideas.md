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
- For visibility ? https://github.com/superloglabs/superlog

## Research report - 2026-06-09

Goal for this pass: understand the current competitor landscape, pull out product trends, and turn it into a concrete Klide implementation direction.

### Positioning

Klide should not try to become another Cursor-style editor. The stronger lane is:

> Local-first agent control plane for coding.

That means Klide is the place where Pierre can watch, resume, delegate, compare, review, and remember agent work across Codex, Claude Code, OpenRouter, local CLIs, future cloud agents, and project memory.

### Competitor tour

- Cursor: best reference for polished AI IDE flow. Takeaway: strong status language matters. Users need to see what is "in progress", "ready for review", and "done" without reading terminal noise.
- Claude Code: best reference for terminal-native trust. Takeaway: make every agent action inspectable, resumable, and controllable before changes feel scary.
- OpenAI Codex: best reference for cross-surface agent work. Takeaway: worktrees, skills, automations, and parallel agents should feel like one command center.
- Devin: best reference for async software teammate. Takeaway: Klide needs a review queue, draft outcome summaries, and visual QA hooks, not only live chat.
- Hermes Desktop / Ara: best reference for proactive agent OS. Takeaway: memory, subagents, and scheduled/background work should be first-class, but always with human approval.
- Letta: best reference for memory-first agents. Takeaway: Project Memory should become a navigable knowledge graph, not only handoff markdown.
- AgentRQ: best reference for HITL task orchestration. Takeaway: blocked / waiting / scheduled / running states should be visible and actionable.
- Superlog: best reference for observability. Takeaway: Klide should expose agent logs, tokens, cost, files touched, commands, and decisions as structured signals.
- Zed / Amp: best reference for premium restraint. Takeaway: the interface should feel fast, quiet, direct, and keyboard-friendly.
- GitHub Copilot cloud agent: best reference for GitHub-native async tasks. Takeaway: issues, branches, PRs, and agent sessions should connect cleanly.

### Trends

1. Async agent fleets: users will run several agents at once, not one chat at a time.
2. Background work with review queues: the valuable screen is "what needs my attention now?"
3. Memory and skills: agents need project-specific habits, context, and reusable workflows.
4. Human-in-the-loop approvals: premium tools make risk legible before execution.
5. Cloud/local hybrid execution: quick local CLI tasks plus longer cloud/worktree jobs.
6. Agent observability: tokens, cost, commands, files, diffs, and decisions should be visible.
7. Calm premium UX: fewer noisy panels, stronger hierarchy, more progressive disclosure.

### What Klide still needs

Priority 1 - Mission Control v3:
- Group runs by state: Running, Blocked, Ready for Review, Done.
- Add an attention queue for stopped/failed/completed runs that need Pierre.
- Add compact row summaries: delegate, model, branch/worktree, files touched, cost, last event.
- Add one-click actions: Resume, Open in Terminal, Open in other CLI, Review Diff, Save Memory.

Priority 2 - Agent Status Layer:
- Normalize agent/run states across Codex, Claude Code, OpenRouter, local shells, and future cloud runs.
- Add status chips that mean the same thing everywhere.
- Surface blockers explicitly: waiting for approval, command failed, merge conflict, needs API key, stopped by user.

Priority 3 - Project Memory v4:
- Make memory entries browseable by goal, files touched, decisions, and runs.
- Add automatic draft memory on completed/stopped runs, with a user approval step.
- Decide repo policy: commit `.klide/memory/`, gitignore it, or support both per workspace.
- Cross-link memory entries to files, diffs, and Mission Control runs.

Priority 4 - Premium Settings:
- Fix the settings open lag.
- Split settings into clean sections: Providers, Accounts, Harness, Skills, Usage, Privacy.
- Add provider details on hover for usage graphs.
- Support multi-account setup: personal/pro, per-provider identity, and selected default route.

Priority 5 - Proactive Suggestions:
- Suggest follow-up tasks after diagnostics, failed runs, or repeated errors.
- Suggest reusable skills when a workflow repeats.
- Suggest memory updates when a decision or implementation summary is detected.

### Premium UX direction

- Make the workbench fill the screen by default, with fewer floating-window surprises.
- Use calm surfaces, tighter spacing, and clear hierarchy over heavy decoration.
- Favor icons with tooltips for frequent actions.
- Keep terminal power, but summarize terminal meaning in human-readable status.
- Make "what changed?", "what is running?", and "what needs me?" answerable in under 3 seconds.
- Treat Project Memory, Mission Control, and Git Review as one connected workflow.

### Recommended next implementation slice

Start with Mission Control v3. It has the biggest strategic leverage because it turns Klide from a multi-panel agent launcher into an actual command center.

Small first slice:
1. Add shared run-state taxonomy and helpers.
2. Update Mission Control grouping to Running / Blocked / Ready for Review / Done.
3. Add attention badges and row-level quick actions.
4. Link completed runs to "Save Memory" and "Review Diff".
5. Polish visual hierarchy so this screen feels premium before adding more features.

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
- [x] When switching away from a workbench view right after creating an AI panel, switching back creates the same AI panel (model) — fixed by hydrating the workspace panel layout once instead of rebuilding AI panel instances on every workbench remount.

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

- fix Claude code routine design in mission control
- missing sub agents on claude convos (desktop screenshot)