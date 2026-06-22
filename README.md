<div align="center">

# Klide

### A quiet agentic control surface for coding.

Local models by default · online providers when you want them · real agent terminals built in.

<br/>

[![Tauri 2](https://img.shields.io/badge/Tauri-2-FFC131?style=flat-square&logo=tauri&logoColor=black)](https://v2.tauri.app)
[![Rust](https://img.shields.io/badge/Rust-backend-000000?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Ollama](https://img.shields.io/badge/Ollama-local_first-000000?style=flat-square&logo=ollama&logoColor=white)](https://ollama.com)

![Status](https://img.shields.io/badge/status-v0.4--shipped-7A9F4A?style=flat-square)
![Platform](https://img.shields.io/badge/platform-macOS_·_Linux_·_Windows-555555?style=flat-square)
![Binary](https://img.shields.io/badge/binary-~10_MB-4263EB?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-555555?style=flat-square)

</div>

---

**Klide is a small, fast, AI-native coding control surface.** It keeps the VS Code structure you already know — activity bar, explorer, tabs, editor, terminal, status bar — but the center of gravity is the agent loop: modes, context, diffs, skills, and workspace state are available when needed instead of always shouting for attention. Local models run out of the box, and the agent doesn't just chat: it reads your code, drafts a plan, edits files behind a diff you approve, and runs commands — tests, builds, linters — behind an approval you grant. No Electron bloat, no busy chrome, no black-box autonomy.

> **VS Code's structure · Linear's aesthetic · agent harness transparency** — Tauri-light and local-model-first.

---

## Why Klide

Most editors today fall into two camps:

- **Heavy** — VS Code, JetBrains. Powerful, but busy chrome, slow cold start, AI bolted on after the fact.
- **Niche** — Zed, Lapce, Helix. Beautiful and fast, but you give up the VS Code muscle memory.

Klide aims for a third spot: not the next Cursor, but a calm operator surface for code work where the agent can act, the risky parts are gated, and the UI stays quiet until you need deeper control. It's an opinionated IDE inspired by [Sinew](https://sinew-ide.com/), with a nod to [Ara](https://ara.so/), [Cursor](https://cursor.com), and [Cline](https://cline.bot).

## Principles

1. **Visually minimalist, structurally complete** — the full VS Code layout, but quiet palette, generous whitespace, thin borders, restrained type.
2. **Agent control without clutter** — modes, tools, skills, context, task state, and diff review are reachable at the point of action, not permanently exposed.
3. **Local first** — Ollama works out of the box; subscription and API providers are opt-in.
4. **Fast cold start** — Tauri shell, ~10 MB binary, native webview.
5. **Familiar muscle memory** — VS Code layout and keybindings where it makes sense.

## Design

| Token | Value (light / dark) | Used for |
|---|---|---|
| Theme | Light + dark | App shell and terminal share theme tokens |
| `--bg` | `#FBFBFA` / `#11110F` | Window background |
| `--bg-elevated` | `#F4F4F2` / `#171715` | Panels, sidebars |
| `--fg` | `#555552` / `#C8C6BE` | Primary text |
| `--border` | `#E8E7E3` / `#292824` | All dividers, 1px |
| `--accent` | `#4263EB` / `#8EA2FF` | Active states only |
| UI font | `Atkinson Hyperlegible` | Sidebar, tabs, status bar |
| Code font | `Monaspace` | Editor, terminal |

No drop shadows. No gradients. Subtle motion only. Icons only when they earn their place.

## Stack

| Layer | Tech | Why |
|---|---|---|
| App shell | **Tauri 2** (Rust) | ~10 MB binary, native webview, fast cold start |
| Editor | **Monaco** | The exact editor from VS Code, MIT licensed |
| Terminal | **xterm.js** + **portable-pty** | Same terminal VS Code uses, real PTY on the Rust side |
| Frontend | **React + TypeScript + Vite** | Largest ecosystem of Monaco / xterm.js examples |
| Local AI | **Ollama · MLX** | Ollama for local tool-capable runs; MLX for Apple Silicon chat via `mlx_lm.server` |
| Providers | **Anthropic · OpenAI-compatible APIs · Mistral · xAI** | Provider switcher; keys live on the Rust side |

## Features

**Editor & shell**
- Activity bar, stackable file explorer, multi-file tabs, Monaco editor with `Cmd+S`
- Real shell via PTY (toggleable), status bar with file / language / cursor
- Light + dark themes shared across app, editor, and terminal — including a full per-theme terminal ANSI palette

**AI panel**
- **Streaming chat** — all providers stream token-by-token through a single Rust `ai_chat` command, so keys never enter the webview
- **Multi-provider** — local Ollama/MLX, direct/API providers, OpenAI-compatible providers, and delegate subscription CLIs (Claude Code · Codex · OpenCode), all behind one switcher
- **Real delegate terminals** — Claude Code, Codex, and OpenCode run inside embedded PTYs, preserving the actual CLI UI instead of a chat imitation
- **Chat / Plan / Goal modes** — Chat has no tools, Plan is read-only, Goal can propose diff-reviewed edits and run approval-gated commands (`Tab` to switch)
- **Quiet agent controls** — mode switching, provider selection, context pressure, history, skills, project rules, and diff review stay close to the work without becoming a dashboard
- **`@`-mentions** — fuzzy-pick workspace files to attach as context
- **Slash commands** — `/chat`, `/plan`, `/goal`, `/clear`, `/explain`, `/init`
- **Keychain-stored keys** — API keys live in the OS keychain (env vars as fallback); managed from Settings → API
- Auto-loads project rules from `AGENTS.md` / `CLAUDE.md`, plus skills from workspace and user skill folders

**Agent harness**
- **One agent loop, in Rust** — every mode runs through the same loop; the panel starts runs and renders the event stream. Tools are defined once in Rust (16 read/edit/inspect tools + approval-gated `run_command`); the frontend fetches schemas over IPC. See [`KLIDE_HARNESS_SCHEMA.md`](./KLIDE_HARNESS_SCHEMA.md) for the full tool list and lineage.
- **`run_command`** — the agent runs tests, builds, typechecks, and linters to verify its own work. Every command is shown for approval before it runs, killed after a configurable timeout, and "approve for this run" stops re-prompting repeated commands.
- **Edit contract** — numbered file reads + indentation-tolerant search/replace + a post-edit syntax check, so edits land cleanly even on small local models.
- **Tunable** — turn cap, command timeout, parallel tool calls, and per-model context windows are all configurable in Settings → Harness.
- **Eval net** — golden scenarios drive the real tool layer (`cargo test`) so harness changes can't silently regress reads, edits, or command handling.

**Agent operations**
- **Mission Control** — run board for Klide and delegate runs answering "what's running / what needs me / what changed" at a glance: per-run reasons + next action, evidence (last event, branch, files touched, tokens/cost, sub-agent count, memory status), transcript preview, resume, and "open in another CLI" handoff
- **Project Memory** — durable handoff notes in `.klide/memory/`; completed runs draft a note you accept, edit, or skip before it becomes durable, plus a manual summarize action — all browsable in a centered Memory modal

## Roadmap

**v0.1 — MVP** &nbsp;✅ _shipped_

- [x] Layout shell — activity bar, sidebar, tabs, editor, terminal, AI panel, status bar
- [x] File explorer — open folder, tree view, click to open
- [x] Tabs — multiple files, switch, close
- [x] Editor — Monaco with syntax highlighting + `Cmd+S`
- [x] Status bar — filename, language, cursor position
- [x] Terminal panel — real shell via PTY, toggleable
- [x] AI panel — streaming chat against local Ollama (native `tools` API)
- [x] Agent mode — `write_file` / `create_file` with diff review

**v0.2 — shipped** (verified 2026-06-08)

- [x] Plan / Build modes, `@`-mentions, slash commands, project-rules loading
- [x] Provider switcher — Ollama, OpenAI-compatible APIs, and subscription CLIs all live
- [x] Streaming through Rust for every provider
- [x] API keys stored in the OS keychain, managed from Settings
- [x] Quiet agent control surface with mode switching, provider choice, context pressure, skills, rules, history, and diff review
- [x] Real Claude Code / Codex / OpenCode delegate PTYs in the AI panel
- [x] Mission Control v2 — inspect runs, resume delegate sessions, and hand off a run to another CLI
- [x] Project Memory v1 — summarize a session into durable `.klide/memory/` markdown and browse it in a centered modal
- [x] Skills install + uninstall via `npx skills add`, with provenance grouping (Vercel / Matt Pocock / Anthropic / Personal / Workspace)
- [x] "Save as skill" sparkle — auto-generates a `SKILL.md` for reusable patterns in finished sessions
- [x] Profile modal — local IDE profile (avatar + identity + workspace), `⌘.`
- [x] Command palette · find-in-files · editable harness settings · checkpoint rollback
- [x] Live provider smoke matrix verified for Ollama, MLX, Anthropic direct API, one OpenAI-compatible API, and Claude Code / Codex / OpenCode delegates
- [x] Premium polish pass on the always-visible chrome (ActivityBar, TabBar, StatusBar, WelcomeScreen)
- [x] Parked: Context Lens/project graph heuristics. If revived, feed Memory/summarization instead of silently injecting chat context.

**v0.3 — shipped**

- [x] Self-hosted providers — add your own OpenAI-compatible endpoints (label + base URL + keychain token) in Settings; they appear in the provider picker under "Self-hosted", with live model listing and per-endpoint default model
- [x] Collapsible, glass-headed provider picker that scales to many providers
- [x] Project Memory v3 — touched-file links, run metadata, and automatic durable notes for completed Klide runs
- [x] Skills install/uninstall plus "Save as skill" generation from finished sessions
- [x] Mission Control handoff polish — resume/open delegate sessions in the right CLI surface, nested sub-agent runs, token/cost/file summaries, and brand marks
- [x] Workspace-rooted filesystem hardening — file reads/writes flow through checked Rust commands instead of broad webview FS permissions
- [x] Codebase Interview — `userAnswerQuestion` pause tool plus `/interview` for capturing project decisions

**v0.4 — Review Queue + Evidence Layer** &nbsp;✅ _shipped_

- [x] Mission Control answers "what is running?", "what needs me?", and "what changed?" at a glance — quiet rows, attention queue, per-run reasons + one next action.
- [x] Evidence summaries per run — last meaningful event, branch, files touched, diff/review entry point, tokens/cost, sub-agent count, and saved-memory status (`· memory` chip), consistent across Klide and delegate runs.
- [x] Delegate observability — Claude sub-agent visibility (counts `Agent`/`Task` calls, excludes sidechain turns) and symmetric routine badging.
- [x] Reviewable memory — completed runs draft a note you accept, edit, or skip in the Memory modal before it becomes durable.
- [x] Settings open instantly — sections mount on first visit, so per-provider status calls don't block the surface.
- [x] Delegate account switching — save and switch Codex / Claude Code / OpenCode CLI logins from Settings without minting tokens.
- [x] Parked (intentionally): natural-language scheduling and proactive suggestions — until the review/evidence loop has more daily mileage.

**Agent harness capability** &nbsp;✅ _shipped_

- [x] `run_command` — approval-gated shell execution so the agent can run tests/build/lint and verify its own work
- [x] Configurable turn cap (default 50) + command timeout (default 180s) + per-run command allowlist
- [x] Eval foundation — golden tool-layer scenarios run as `cargo test`; documented tool schema + lineage in `KLIDE_HARNESS_SCHEMA.md`
- [x] Scripted model-loop eval — fake provider turns choose tools, real tools execute, and tool results replay into the next provider message
- [x] Project-persistent command allowlist — "Approve for project" stores exact `run_command` approvals in `.klide/command-allowlist.json`
- [x] Test-after-edit — optional Settings → Harness command runs after accepted edits, alongside built-in Rust/JSON syntax checks
- [x] Provider seam extracted into `run_agent_loop` — production calls `ai_chat` through `RealProviderCaller`; tests can inject a mock provider caller
- [ ] Next: split the remaining loop shell from pure run decisions, so full model-loop tests can run without `tauri::AppHandle`

## Build & run

```bash
npm install
npm run tauri dev
```

First Rust build takes 3–5 minutes; subsequent builds are seconds. Leave `tauri dev` running — frontend changes hot-reload. See [`GETTING_STARTED.md`](./GETTING_STARTED.md) for the step-by-step build guide.

## Project layout

```
Klide/
├── src/             React + TypeScript frontend (the UI)
├── src-tauri/       Rust backend (filesystem, terminal, AI bridges)
├── index.html       Webview entry
├── vite.config.ts   Vite dev server config
└── package.json     npm scripts & deps
```

## License

MIT (intended) — to be finalized.
