<div align="center">

# Klide

### Looks like a 2026 design tool. Works like VS Code.

Local models by default · online providers when you want them · a real terminal built in.

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

**Klide is a small, fast, AI-native code editor.** It keeps the VS Code structure you already know — activity bar, explorer, tabs, editor, terminal, status bar — and wraps it in a quiet, design-forward surface where every pixel is considered. Local models run out of the box, and the agent doesn't just chat: it reads your code, drafts a plan, and edits files behind a diff you approve. No Electron bloat, no busy chrome, no AI bolted on as an afterthought.

> **VS Code's structure · Linear's aesthetic · Cursor's AI fluency** — Tauri-light and local-model-first.

---

## Why Klide

Most editors today fall into two camps:

- **Heavy** — VS Code, JetBrains. Powerful, but busy chrome, slow cold start, AI bolted on after the fact.
- **Niche** — Zed, Lapce, Helix. Beautiful and fast, but you give up the VS Code muscle memory.

Klide aims for a third spot, and treats local models as a first-class option rather than a fallback. It's an opinionated IDE inspired by [Sinew](https://sinew-ide.com/), with a nod to [Cursor](https://cursor.com) and [Cline](https://cline.bot).

## Principles

1. **Visually minimalist, structurally complete** — the full VS Code layout, but quiet palette, generous whitespace, thin borders, restrained type.
2. **AI is built in, not bolted on** — the agent reads, plans, and writes with diff review. Plan mode investigates; Build mode edits.
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
- Streaming chat against local Ollama via the native `tools` API
- **Plan / Build modes** — Plan is read-only and proposes; Build edits files behind a diff you approve (`Tab` to switch)
- **`@`-mentions** — fuzzy-pick workspace files to attach as context
- **Slash commands** — `/plan`, `/build`, `/clear`, `/explain`, `/init`
- **Provider switcher** — Local / Subscription / API, grouped with brand logos
- Auto-loads project rules from `AGENTS.md` / `CLAUDE.md`

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
- [x] Provider switcher (Ollama live; others staged)
- [ ] Wire subscription + API providers behind the switcher
- [ ] Command palette · find-in-files · settings depth

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
