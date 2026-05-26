# CLAUDE.md — KIDE project context

This file is loaded automatically when Claude Code works in this directory. Read it first.

## What KIDE is

KIDE is a code editor Pierre is building from scratch. Inspired by [Sinew](https://sinew-ide.com/). The goal is a small, fast, AI-first IDE that **looks like a 2026 design tool** but **works like VS Code**.

Pierre is new to building desktop apps and is learning Rust as he goes. Frame technical explanations for a smart beginner — explain what each piece does, cite docs, and prefer fewer-moving-parts solutions.

## Vision in one sentence

**VS Code's structure, Linear's aesthetic, Cursor's AI fluency — Tauri-light, local-model-first.**

## Design philosophy

"Minimalist" here is a **visual/UX principle**, not a feature-pruning principle.

| ✅ Do | ❌ Don't |
|---|---|
| Keep VS Code's structural layout (activity bar, sidebar, tabs, editor, status bar, panel) | Strip out structural elements to "simplify" |
| Quiet light/dark palettes with shared app + terminal tokens | Saturated accent colors, gradients, drop shadows |
| Generous whitespace, thin 1px borders, no heavy dividers | Boxes, frames, busy chrome |
| Restrained type — Atkinson Hyperlegible for UI, Monaspace for code | Multiple display fonts, decorative weights |
| Subtle, considered motion (fades, no bounces) | Springy animations |
| Icons only when they earn their place | Icon-for-every-button maximalism |

If a UI element doesn't serve clarity, it doesn't ship.

## Stack

| Layer | Tech | Notes |
|---|---|---|
| Shell | **Tauri 2** | Rust backend, native webview, ~10 MB binary |
| Editor | **Monaco** via `@monaco-editor/react` | Same editor as VS Code |
| Terminal | **xterm.js** + Rust **portable-pty** | Real shell, not a sandbox |
| Frontend | **React 18 + TypeScript + Vite** | (default scaffold) |
| Local AI | **Ollama** HTTP API on `localhost:11434` | Default model: `llama3.2:3b` |
| Online AI | Anthropic + OpenAI SDKs | Optional, keys live on Rust side |

## Repo layout

```
KIDE/
├── README.md            Project pitch + status
├── GETTING_STARTED.md   Step-by-step build guide (M1.5 → M7)
├── CLAUDE.md            This file
├── src/                 React + TypeScript frontend
│   ├── main.tsx           React boot
│   ├── App.tsx            Root layout
│   └── App.css            Global resets + tokens
└── src-tauri/           Rust backend
    ├── Cargo.toml
    ├── src/lib.rs         Tauri commands + plugin registration
    └── capabilities/      Frontend → backend permissions
```

## v0.1 MVP scope

Pierre is building toward this checklist. Don't suggest features outside it without flagging it as post-MVP.

- [ ] Activity bar (left, vertical, icon-only) — Explorer / Search / AI panel toggles
- [ ] File explorer sidebar with folder open + tree view
- [ ] Tabs for multiple open files
- [ ] Monaco editor with syntax highlighting + Cmd+S
- [ ] Status bar (bottom) — current file, language, cursor position
- [ ] Built-in terminal panel (toggleable, bottom)
- [ ] AI side panel — chat with local Ollama, streaming
- [ ] Agent mode — model proposes file edits, user accepts/rejects via diff review

Post-MVP (do not start until above is shipped): command palette, settings UI, themes engine, extensions, debugger, source control, find-in-files, multi-language Monaco workers.

## Development

```bash
npm install            # one-time
npm run tauri dev      # full dev loop (Vite + Rust hot reload)
```

First Rust build is 3–5 min on M-series; later builds are seconds. Leave `tauri dev` running — frontend changes hot-reload.

## Working conventions

- **Two halves, two languages.** Frontend = TypeScript/React in `src/`. Backend = Rust in `src-tauri/`. They talk via `invoke()` (request/reply) and `emit`/`listen` (events/streams).
- **Streams use events**, not return values. Terminal output, AI tokens, file watchers → `app.emit("name", payload)` from Rust, `listen("name", cb)` from React.
- **No API keys in the frontend.** AI provider keys, OAuth tokens — Rust side only, via `tauri-plugin-store` or OS keychain.
- **Workspace-rooted file access.** Agent mode tool calls must verify target paths are inside the currently opened folder before writing.
- **Styling: inline styles for now.** Don't introduce a CSS framework (Tailwind, etc.) before MVP — keeps the surface small. Promote to CSS modules or Stylex if/when needed.

## Working with Pierre (pacing)

- **One step at a time.** After any scaffold, install, or non-trivial edit, stop and let him verify it works before stacking the next change. Don't batch "install → edit → restyle" into one go.
- **Show, don't assume.** Each step should end with a clear "you should see X" so he can confirm the layer is healthy before moving on.
- **Explain why, not just what.** He's learning the stack; a one-line justification ("Monaco is VS Code's editor, MIT licensed") goes a long way.

## Reference

- Tauri 2 docs — <https://v2.tauri.app>
- Monaco React — <https://github.com/suren-atoyan/monaco-react>
- xterm.js — <https://xtermjs.org/docs/>
- Ollama API — <https://github.com/ollama/ollama/blob/main/docs/api.md>
- Inspiration — <https://sinew-ide.com/>
