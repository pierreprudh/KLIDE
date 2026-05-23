# KIDE

> **Looks like a 2026 design tool. Works like VS Code.** Local models by default, online providers when you want them, real terminal built in.

KIDE is an opinionated IDE inspired by [Sinew](https://sinew-ide.com/). The structure is VS Code — activity bar, file explorer, tabs, editor, terminal, status bar. The surface is quiet, refined, and design-forward. The AI is native, not bolted on, and can edit files with your approval.

---

## Why KIDE

Most editors today fall into two camps:

- **Heavy** — VS Code, JetBrains. Powerful but busy chrome, slow cold start, AI bolted on as an afterthought.
- **Niche** — Zed, Lapce, Helix. Beautiful and fast, but you give up the VS Code muscle memory.

KIDE aims for a third spot: **VS Code's structure, Linear's aesthetic, Cursor's AI fluency** — with local models as a first-class option, not an afterthought.

## Principles

1. **Visually minimalist, structurally complete** — the full VS Code layout, but every pixel is considered. Quiet palette, generous whitespace, thin borders, restrained type.
2. **AI is built in, not bolted on** — the agent can read, propose, and write with diff review.
3. **Local first** — Ollama works out of the box; cloud is opt-in.
4. **Fast cold start** — Tauri shell, no Electron bloat.
5. **Familiar muscle memory** — VS Code keybindings and layout where it makes sense.

## Design

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0f0f0f` | Window background |
| `--bg-elevated` | `#161616` | Panels, sidebars |
| `--fg` | `#eaeaea` | Primary text |
| `--fg-muted` | `#888` | Secondary text, icons |
| `--border` | `#2a2a2a` | All dividers, 1px |
| `--accent` | `#7c8cff` | Active states only |
| UI font | `Inter, system-ui` | Sidebar, tabs, status bar |
| Code font | `JetBrains Mono` | Editor, terminal |

No drop shadows. No gradients. Subtle motion only. Icons only when they earn their place.

## Stack

| Layer | Tech | Why |
|---|---|---|
| App shell | **Tauri 2** (Rust) | ~10 MB binary, native webview, fast cold start |
| Editor | **Monaco** | The exact editor from VS Code, MIT licensed |
| Terminal | **xterm.js** + **portable-pty** | Same terminal VS Code uses, real PTY on Rust side |
| Frontend | **React + TypeScript + Vite** | Largest ecosystem of Monaco/xterm.js examples |
| Local AI | **Ollama** | Local LLM runtime, simple HTTP API |
| Online AI | **Anthropic** + **OpenAI** SDKs | Optional, model-agnostic plumbing |

## v0.1 — MVP scope

The structural skeleton of VS Code, filled in just enough to daily-drive:

- [x] **Layout shell** — activity bar (left), sidebar, tab strip, editor area, terminal panel (bottom), AI panel (right), status bar
- [x] **File explorer** — open folder, tree view, click to open
- [x] **Tabs** — multiple files open, click to switch, X to close
- [x] **Editor** — Monaco with syntax highlighting + Cmd+S
- [x] **Status bar** — filename, language, cursor position
- [~] **Terminal panel** — real shell via PTY (always-visible; toggle still TODO)
- [x] **AI panel** — streaming chat against local Ollama (native `tools` API)
- [~] **Agent mode** — `write_file` / `create_file` tools + diff modal wired, end-to-end verification still TODO

Post-MVP (don't start until above is done): command palette, settings UI, themes engine, extensions, debugger, source control, find-in-files.

## Status

🚧 **Pre-alpha — agent mode wiring in progress.** Follow [`GETTING_STARTED.md`](./GETTING_STARTED.md) to build along.

### Where we are right now (last session: 2026-05-23)

- ✅ Shell, explorer, tabs, editor, status bar, terminal, AI chat are all functional end-to-end.
- ✅ AI panel uses Ollama's **native `tools` API** (not a text-wrapper protocol). Confirmed working with `qwen2.5:7b`; `llama3.1:8b` also wired.
- ✅ Tools: `read_file`, `list_dir` (read-only, auto-execute) + `write_file`, `create_file` (gated by diff modal).
- ✅ `DiffModal.tsx` renders centered overlay with red/green line diff; `App.tsx` refreshes any open tab on apply so Cmd+S can't clobber an agent edit.
- ⚠️ **Open thread:** on the last `create_file` test, the modal didn't appear and the agent kept retrying. Tool result body needs to be expanded (`↳ create_file result` collapsible) to diagnose whether it returned `Rejected`, `Error`, or a stale `Diff review UI not implemented yet` string from a cached bundle.
- 📋 Next session: reproduce the create_file test, expand the tool result, fix the root cause, then verify a `write_file` round-trip.

## Build & run

```bash
npm install
npm run tauri dev
```

First Rust build takes 3–5 minutes; subsequent builds are seconds.

## Project layout

```
KIDE/
├── src/             React + TypeScript frontend (the UI)
├── src-tauri/       Rust backend (filesystem, terminal, AI bridges)
├── index.html       Webview entry
├── vite.config.ts   Vite dev server config
└── package.json     npm scripts & deps
```

## License

TBD — likely MIT.
