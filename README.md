<div align="center">

# Klide

### A quiet agentic control surface for coding.

Local models by default · online providers when you want them · real agent terminals built in.

<br/>

[![Tauri 2](https://img.shields.io/badge/Tauri-2-FFC131?style=flat-square&logo=tauri&logoColor=black)](https://v2.tauri.app)
[![Rust](https://img.shields.io/badge/Rust-backend-000000?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org)
[![React 18](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Ollama](https://img.shields.io/badge/Ollama-local_first-000000?style=flat-square&logo=ollama&logoColor=white)](https://ollama.com)

![Status](https://img.shields.io/badge/status-pre--alpha-E0A458?style=flat-square)
![Platform](https://img.shields.io/badge/platform-macOS_·_Linux_·_Windows-555555?style=flat-square)
![Binary](https://img.shields.io/badge/binary-~10_MB-4263EB?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-555555?style=flat-square)

</div>

---

**Klide is a small, fast, AI-native coding control surface.** It keeps the VS Code structure you already know — activity bar, explorer, tabs, editor, terminal, status bar — but the center of gravity is the agent loop: modes, context, diffs, skills, and workspace state are available when needed instead of always shouting for attention. Local models run out of the box, and the agent doesn't just chat: it reads your code, drafts a plan, and edits files behind a diff you approve. No Electron bloat, no busy chrome, no black-box autonomy.

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
| Local AI | **Ollama** | Local LLM runtime, native `tools` API |
| Providers | **Anthropic · OpenAI · Gemini · Mistral …** | Provider switcher; keys live on the Rust side |

## Features

**Editor & shell**
- Activity bar, file-tree explorer, multi-file tabs, Monaco editor with `Cmd+S`
- Real shell via PTY (toggleable), status bar with file / language / cursor
- Light + dark themes shared across app, editor, and terminal — including a full per-theme terminal ANSI palette

**AI panel**
- **Streaming chat** — all providers stream token-by-token through a single Rust `ai_chat` command, so keys never enter the webview
- **Multi-provider** — local Ollama, direct/API providers, and delegate subscription CLIs (Claude Code · Codex), all behind one switcher
- **Real delegate terminals** — Claude Code and Codex run inside embedded PTYs, preserving the actual CLI UI instead of a chat imitation
- **Chat / Plan / Goal modes** — Chat has no tools, Plan is read-only, Goal can propose diff-reviewed edits (`Tab` to switch)
- **Quiet agent controls** — mode switching, provider selection, context pressure, history, skills, project rules, and diff review stay close to the work without becoming a dashboard
- **Context Lens (experimental)** — Klide infers a small working set from the active file, project movement, memory notes, and your draft prompt
- **`@`-mentions** — fuzzy-pick workspace files to attach as context
- **Slash commands** — `/chat`, `/plan`, `/goal`, `/clear`, `/explain`, `/init`
- **Keychain-stored keys** — API keys live in the OS keychain (env vars as fallback); managed from Settings → API
- Auto-loads project rules from `AGENTS.md` / `CLAUDE.md`

**Agent operations**
- **Mission Control** — read-only board for local Claude Code / Codex / Klide runs, with transcript preview and session metadata
- **Project Memory** — a working-map experiment for project areas, recent movement, notes, and relationships

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

**v0.2 — in progress**

- [x] Plan / Build modes, `@`-mentions, slash commands, project-rules loading
- [x] Provider switcher — Ollama, OpenAI-compatible APIs, and subscription CLIs all live
- [x] Streaming through Rust for every provider
- [x] API keys stored in the OS keychain, managed from Settings
- [x] Quiet agent control surface with mode switching, provider choice, context pressure, skills, rules, history, and diff review
- [x] Real Claude Code / Codex delegate PTYs in the AI panel
- [x] Mission Control read-only run inspector
- [ ] Context Lens / Project Memory: keep iterating until it feels like project intelligence, not context plumbing
- [ ] Verify Anthropic direct API end-to-end; add Google Gemini direct API
- [ ] Command palette · find-in-files · editable harness settings · checkpoint rollback

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
