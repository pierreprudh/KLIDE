// Throwaway page for the Remote machines UI (docs/REMOTE_MACHINES.md, Q6 —
// "Choosing the Machine in the UI"). No IPC; every fact is a fixture shaped
// like what the step-2 readiness check (Q5) would report about klide-box.
//
// Three surfaces, all on Klide's own recipes (composer surface, menu-glass
// picker, klide-button, Settings hairline rows):
//   1. composer — "Where it runs", the Codex / Claude-desktop environment
//      switch, in the Focus composer foot: Worktree · Checkout · klide-box.
//   2. add / folder / clone — Add project: Machine first, then a folder on it.
//   3. settings — Settings › Machines, readiness read as facts.
//
//   npx vite --port 1421  →  http://localhost:1421/preview/machine-picker.html
//   ?view=composer | add | folder | clone | settings
//   ?state=ready | owed (default — today's real box) | offline
//   ?theme=klide-light (default) | dark | …
import ReactDOM from "react-dom/client";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "../src/styles/tokens.css";
import type { Icon as PhosphorGlyph } from "@phosphor-icons/react";
import { Laptop } from "@phosphor-icons/react/dist/csr/Laptop";
import { HardDrives } from "@phosphor-icons/react/dist/csr/HardDrives";
import { Terminal } from "@phosphor-icons/react/dist/csr/Terminal";
import { Folder } from "@phosphor-icons/react/dist/csr/Folder";
import { CaretRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { ArrowElbowLeftUp } from "@phosphor-icons/react/dist/csr/ArrowElbowLeftUp";
import { Copy } from "@phosphor-icons/react/dist/csr/Copy";
import { ArrowClockwise } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { GitBranch } from "@phosphor-icons/react/dist/csr/GitBranch";
import { GitFork } from "@phosphor-icons/react/dist/csr/GitFork";
import { ArrowUp } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { Check } from "@phosphor-icons/react/dist/csr/Check";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "klide-light";
type State = "ready" | "owed" | "offline";
const INITIAL_STATE = (params.get("state") as State) ?? "owed";
type View = "composer" | "conversation" | "add" | "folder" | "clone" | "settings";
const INITIAL_VIEW = (params.get("view") as View) ?? "composer";

function G({ as: Glyph, size = 15 }: { as: PhosphorGlyph; size?: number }) {
  return <Glyph size={size} weight="light" aria-hidden="true" />;
}

/* ------------------------------------------------------------------ data */

type Tone = "ok" | "warn" | "bad" | "quiet";
const TONE: Record<Tone, string> = {
  ok: "var(--accent)",
  warn: "var(--warning)",
  bad: "var(--danger)",
  quiet: "var(--fg-subtle)",
};

type Fact = { label: string; value: string; tone?: Tone; fix?: string };

type Box = {
  word: string;
  tone: Tone;
  caption: string;
  facts: Fact[];
};

const BOX: Record<State, Box> = {
  ready: {
    word: "Ready",
    tone: "ok",
    caption: "Keeps going when this Mac sleeps",
    facts: [
      { label: "Reached", value: "over Tailscale · 38 ms" },
      { label: "Run host", value: "klide ptyd 0.6.12 · matches this Mac" },
      { label: "Claude Code", value: "2.1.274 · logged in" },
      { label: "GitHub", value: "gh · pierreprudh" },
      { label: "Checkouts", value: "~/src/KLIDE · main · clean" },
    ],
  },
  owed: {
    word: "2 logins owed",
    tone: "warn",
    caption: "Claude Code and gh need a login on the box",
    facts: [
      { label: "Reached", value: "over Tailscale · 41 ms" },
      { label: "Run host", value: "not installed — Klide installs it on the first Run", tone: "quiet" },
      { label: "Claude Code", value: "2.1.274 · not logged in", tone: "warn", fix: "ssh -t klide-box claude" },
      {
        label: "GitHub",
        value: "gh not logged in",
        tone: "warn",
        fix: "ssh -t klide-box 'gh auth login && gh auth setup-git'",
      },
      { label: "Checkouts", value: "none yet", tone: "quiet" },
    ],
  },
  offline: {
    word: "Not reached",
    tone: "bad",
    caption: "Is Tailscale on your personal account?",
    facts: [
      { label: "Reached", value: "no answer from 100.92.189.16", tone: "bad", fix: "tailscale switch <personal account>" },
    ],
  },
};

const TREE: Record<string, string[]> = {
  "/home/klide": ["src", ".config", ".klide"],
  "/home/klide/src": ["KLIDE", "scratch"],
  "/home/klide/src/KLIDE": ["docs", "preview", "scripts", "src", "src-tauri"],
  "/home/klide/src/scratch": [],
};
const REPOS: Record<string, string> = { "/home/klide/src/KLIDE": "main" };

/* ------------------------------------------------------------- local css */

// Only what Klide has no class for. Everything else is tokens.css as-is.
const css = `
.mp-row { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 7px 9px; border-radius: var(--radius-sm); cursor: pointer; color: var(--fg-strong);
  transition: background var(--motion-fast) var(--ease-out); }
.mp-row:hover { background: var(--menu-row-hover); }
.mp-row[aria-selected="true"] { background: var(--menu-row-active); }
.mp-row[aria-disabled="true"] { cursor: default; }
.mp-row[aria-disabled="true"]:hover { background: transparent; }
.mp-row:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
.mp-tile { width: 26px; height: 26px; flex-shrink: 0; display: grid; place-items: center; border-radius: 8px;
  background: var(--bg-elevated); border: 1px solid var(--border); color: var(--fg-subtle); }
.mp-eyebrow { padding: 9px 9px 3px; font-size: 9.5px; font-weight: 600; letter-spacing: .07em;
  text-transform: uppercase; color: var(--fg-dim); }
.mp-trigger { all: unset; display: flex; align-items: center; gap: 5px; height: 24px; padding: 0 6px;
  border-radius: var(--radius-sm); font-size: 11px; font-weight: 500; color: var(--fg-subtle); cursor: pointer;
  transition: color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out); }
.mp-trigger:hover, .mp-trigger[aria-expanded="true"] { color: var(--fg-strong); background: var(--bg-hover); }
.mp-trigger:focus-visible { outline: 2px solid var(--focus-ring); }
.mp-fix { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; margin-top: 3px;
  font: 11px var(--font-mono); color: var(--fg-subtle); transition: color var(--motion-fast) var(--ease-out); }
.mp-fix:hover { color: var(--fg-strong); }
.mp-harness { all: unset; cursor: pointer; padding: 3px 8px; border-radius: var(--radius-sm); font-size: 11.5px; color: var(--fg-dim); }
.mp-harness[data-on] { color: var(--fg-strong); background: var(--bg-hover); }
.mp-fact { display: contents; }
/* The context strip's twin on the other corner: the branch tab rises from the
   top-right, where-it-runs from the top-left. */
/* Stand-alone, no tab: just the machine's name over the chatbox's left edge. */
.mp-env-tab { align-self: center; margin-left: 10px; }
.mp-env-tab button { all: unset; display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 6px;
  border-radius: var(--radius-sm); font-size: 12.5px; color: var(--fg-subtle); cursor: pointer;
  transition: color var(--motion-fast) var(--ease-out); }
.mp-env-tab button:hover, .mp-env-tab button[aria-expanded="true"] { color: var(--fg-strong); }
.mp-env-tab button:focus-visible { outline: 2px solid var(--focus-ring); }
.mp-machine-label { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; color: var(--fg-subtle);
  font-size: 10.5px; opacity: .38; cursor: default; transition: opacity var(--motion-fast) var(--ease-out); }
.mp-machine-label:hover { opacity: .92; }
.mp-machine-label[data-remote] { opacity: .7; }
@keyframes mp-modal-in { from { opacity: 0; transform: translateY(6px) scale(.99) } to { opacity: 1; transform: none } }
`;

/* -------------------------------------------------------------- shared */

function Caption({ children, tone }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      style={{
        display: "block",
        marginTop: 1,
        fontSize: 10.5,
        lineHeight: 1.4,
        color: tone && tone !== "quiet" ? TONE[tone] : "var(--fg-dim)",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {children}
    </span>
  );
}

function FixLine({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="mp-fix"
      title="Copy the command"
      onClick={() => {
        void navigator.clipboard?.writeText(cmd);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      <span>{cmd}</span>
      <G as={copied ? Check : Copy} size={11} />
    </button>
  );
}

/* ====================================================== 1. the composer */

type Env = "worktree" | "checkout" | "klide-box";

const ENV_LABEL: Record<Env, string> = { worktree: "Worktree", checkout: "Checkout", "klide-box": "klide-box" };
const ENV_GLYPH: Record<Env, PhosphorGlyph> = { worktree: GitFork, checkout: Laptop, "klide-box": HardDrives };

function WhereItRuns({
  env,
  state,
  onPick,
  onSettings,
}: {
  env: Env;
  state: State;
  onPick: (e: Env) => void;
  onSettings: () => void;
}) {
  const [open, setOpen] = useState(params.get("menu") !== "0");
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Portalled and fixed, measured from the trigger — the composer card clips
  // (overflow: hidden), the same reason the real InlineMenu portals.
  const [pos, setPos] = useState<{ bottom: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = rootRef.current?.getBoundingClientRect();
      if (r) setPos({ bottom: Math.round(window.innerHeight - r.top + 8), left: Math.max(8, Math.round(r.left) - 4) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!rootRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const box = BOX[state];
  const boxUsable = state === "ready";
  const choose = (e: Env) => {
    onPick(e);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="mp-env-tab">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Where it runs"
        title="Where it runs"
        onClick={() => setOpen((o) => !o)}
      >
        <G as={env === "klide-box" ? HardDrives : Laptop} size={13} />
        <span>{env === "klide-box" ? "klide-box" : "This Mac"}</span>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden
          style={{ color: "var(--fg-dim)", transform: open ? "rotate(180deg)" : "none",
            transition: "transform var(--motion-fast) var(--ease-out)" }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && pos && createPortal(
        <div
          ref={menuRef}
          role="listbox"
          aria-label="Where it runs"
          className="picker-menu menu-glass"
          style={{
            position: "fixed",
            bottom: pos.bottom,
            left: pos.left,
            width: 272,
            transformOrigin: "bottom left",
            zIndex: 20,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              padding: "10px 12px 9px",
              borderBottom: "1px solid var(--panel-border)",
              background: "color-mix(in srgb, var(--panel-highlight) 30%, transparent)",
            }}
          >
            <span className="mp-tile">
              <G as={ENV_GLYPH[env]} size={14} />
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--fg-strong)" }}>Where it runs</div>
              <div style={{ fontSize: 10, color: "var(--fg-dim)", marginTop: 1 }}>
                This conversation's loop, shell and files
              </div>
            </div>
          </div>
          <div style={{ padding: 5 }}>
            <div className="mp-eyebrow">This Mac</div>
            <EnvRow
              glyph={GitFork}
              title="Worktree"
              caption="A fresh branch beside your checkout"
              selected={env === "worktree"}
              onClick={() => choose("worktree")}
            />
            <EnvRow
              glyph={Laptop}
              title="Checkout"
              caption="Edits the files you have open"
              selected={env === "checkout"}
              onClick={() => choose("checkout")}
            />
            <div className="mp-eyebrow">Remote machines</div>
            <EnvRow
              glyph={HardDrives}
              title="klide-box"
              caption={boxUsable ? box.caption : state === "owed" ? "2 logins owed on the box" : "Not reached — check Tailscale"}
              captionTone={boxUsable ? undefined : box.tone}
              selected={env === "klide-box"}
              dimmed={!boxUsable}
              trailing={boxUsable ? undefined : <ArrowUpRight />}
              onClick={() => (boxUsable ? choose("klide-box") : onSettings())}
            />
            <div style={{ height: 1, margin: "5px 4px", background: "var(--panel-border)" }} />
            <EnvRow glyph={Plus} title="Add a machine" caption="From ~/.ssh/config" quiet trailing={<ArrowUpRight />}
              onClick={onSettings} />
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

function ArrowUpRight() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ color: "var(--fg-dim)" }}>
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </svg>
  );
}

function EnvRow({
  glyph,
  title,
  caption,
  captionTone,
  selected,
  dimmed,
  quiet,
  trailing,
  onClick,
}: {
  glyph: PhosphorGlyph;
  title: string;
  caption: string;
  captionTone?: Tone;
  selected?: boolean;
  dimmed?: boolean;
  quiet?: boolean;
  trailing?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button type="button" role="option" aria-selected={selected} className="mp-row" onClick={onClick}>
      <span style={{ width: 20, display: "grid", placeItems: "center", color: "var(--fg-subtle)", opacity: dimmed ? 0.45 : 1 }}>
        <G as={glyph} size={15} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 12, color: quiet ? "var(--fg-subtle)" : dimmed ? "var(--fg-subtle)" : "var(--fg-strong)" }}>
          {title}
        </span>
        <Caption tone={captionTone}>{caption}</Caption>
      </span>
      {trailing ?? (selected && <span style={{ color: "var(--accent)", display: "flex" }}><G as={Check} size={13} /></span>)}
    </button>
  );
}

function ComposerStage({
  state,
  onSettings,
  started,
  onStart,
}: {
  state: State;
  onSettings: () => void;
  started: boolean;
  onStart: () => void;
}) {
  const [env, setEnv] = useState<Env>(started ? "klide-box" : "worktree");
  const [text, setText] = useState(started ? "" : "Fix the flaky worktree cleanup test and open a PR");
  const remote = env === "klide-box";
  const branch = env === "checkout" ? "main" : "klide/fix-worktree-cleanup";
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", padding: "0 24px 28px" }}>
      {started ? (
        <Transcript env={env} />
      ) : (
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ fontSize: 22, color: "var(--fg-strong)", letterSpacing: "-0.01em" }}>What should Kit do in KLIDE?</div>
          <div style={{ marginTop: 6, fontSize: 12.5, color: "var(--fg-subtle)" }}>
            {remote
              ? "Runs on klide-box. Close the lid; it keeps going and Klide replays what you missed."
              : env === "worktree"
                ? "Runs on this Mac, in its own worktree."
                : "Runs on this Mac, in the checkout you have open."}
          </div>
        </div>
      )}
      <div className="klide-focus-composer-dock" style={{ animation: "none" }}>
        {/* Start stage only: two tabs rise out of the chatbox — where it runs
            on the left, the branch on the right. Once the conversation has
            started both settle into the quiet status row under the box. */}
        {!started && (
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", minHeight: 34 }}>
            <WhereItRuns env={env} state={state} onPick={setEnv} onSettings={onSettings} />
            <div className="klide-focus-context-strip" role="group" aria-label="Task context">
              <button type="button" title={`On ${branch}`}>
                <G as={GitBranch} size={13} />
                {branch}
              </button>
            </div>
          </div>
        )}
        <div className="klide-composer-surface klide-focus-composer">
          <textarea
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={started ? "Reply to Kit…" : "Ask Kit…"}
          />
          <div className="klide-focus-composer-footer">
            <div className="klide-focus-provider-control">
              <button type="button" className="mp-trigger" aria-label="Add" style={{ padding: "0 5px" }}>
                <G as={Plus} size={14} />
              </button>
              <button type="button" className="mp-trigger">
                <ClaudeMark />
                Claude Code
              </button>
            </div>
            <div className="klide-focus-model-controls">
              <button type="button" className="mp-trigger">Sonnet 4.6</button>
              <button
                type="button"
                className="klide-focus-send"
                data-ready={text.trim() ? "true" : undefined}
                aria-label="Send task"
                onClick={() => !started && text.trim() && onStart()}
              >
                <G as={ArrowUp} size={14} />
              </button>
            </div>
          </div>
        </div>
        {started && (
          <div className="klide-ai-conversation-status">
            <span className="klide-ai-local-branch" title={`Conversation branch: ${branch}`}>{branch}</span>
            <span className="klide-ai-mode-note klide-ai-mode-note--muted" style={{ fontSize: 10.5, color: "var(--fg-subtle)", opacity: 0.38 }}>
              Review
            </span>
            <span
              className="mp-machine-label"
              data-remote={remote || undefined}
              title={
                remote
                  ? "Runs on klide-box — keeps going when this Mac sleeps. Reached over Tailscale · 38 ms."
                  : "Runs on this Mac."
              }
            >
              <G as={env === "klide-box" ? HardDrives : Laptop} size={12} />
              {remote ? "klide-box" : "This Mac"}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function Transcript({ env }: { env: Env }) {
  const remote = env === "klide-box";
  return (
    <div style={{ width: "min(720px, 100%)", flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: 22, padding: "32px 0 26px" }}>
      <div style={{ alignSelf: "flex-end", maxWidth: "75%", padding: "9px 13px", borderRadius: "var(--radius-lg)",
        background: "var(--bg-elevated)", border: "1px solid var(--border)", fontSize: 14, color: "var(--fg-strong)", lineHeight: 1.55 }}>
        Fix the flaky worktree cleanup test and open a PR
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <span style={{ width: 22, height: 22, flexShrink: 0 }}><ClaudeMark size={18} /></span>
        <div style={{ flex: 1, minWidth: 0, fontSize: 14, lineHeight: 1.6, color: "var(--fg)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, color: "var(--fg-subtle)", marginBottom: 8 }}>
            Worked for 1m 12s ›
            <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
          </div>
          The cleanup raced the worktree's own <code style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}>git gc</code>.
          I made removal wait for the lock and added a test that holds it.
          {remote ? " Tests pass on klide-box; the PR is open." : " Tests pass; the PR is open."}
        </div>
      </div>
    </div>
  );
}

function ClaudeMark({ size = 13 }: { size?: number }) {
  // Stand-in for ProviderLogo — the real one lives in components/ai/icons.tsx.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      {Array.from({ length: 8 }, (_, i) => (
        <rect key={i} x="11" y="2" width="2" height="9" rx="1" fill="#D97757" transform={`rotate(${i * 45} 12 12)`} />
      ))}
    </svg>
  );
}

/* ===================================================== 2. add a project */

function Modal({
  title,
  subtitle,
  children,
  foot,
  onClose,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  foot: ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "grid",
        placeItems: "center",
        background: "var(--modal-scrim)",
        backdropFilter: "blur(3px)",
        WebkitBackdropFilter: "blur(3px)",
      }}
    >
      <div
        role="dialog"
        aria-label={title}
        style={{
          width: "min(480px, 92vw)",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg)",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--panel-shadow)",
          overflow: "hidden",
          animation: "mp-modal-in var(--motion-med) var(--ease-out)",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            padding: "14px 14px 13px 18px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--fg-strong)" }}>{title}</div>
            <div style={{ marginTop: 2, fontSize: 12, color: "var(--fg-subtle)" }}>{subtitle}</div>
          </div>
          <button type="button" className="klide-button klide-button-subtle" aria-label="Close" onClick={onClose}
            style={{ minHeight: 26, padding: "0 6px" }}>
            <G as={X} size={14} />
          </button>
        </header>
        <div style={{ padding: "8px 9px 10px" }}>{children}</div>
        <footer
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 12px 10px 18px",
            borderTop: "1px solid var(--border)",
          }}
        >
          {foot}
        </footer>
      </div>
    </div>
  );
}

function MachineRow({
  glyph,
  name,
  caption,
  word,
  tone,
  onClick,
  disabled,
}: {
  glyph: PhosphorGlyph;
  name: string;
  caption: string;
  word: string;
  tone: Tone;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button type="button" className="mp-row" aria-disabled={disabled || undefined} onClick={onClick}
      style={{ padding: "8px 9px", gap: 11 }}>
      <span className="mp-tile">
        <G as={glyph} size={14} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 13, color: "var(--fg-strong)" }}>{name}</span>
        <Caption>{caption}</Caption>
      </span>
      <span style={{ fontSize: 11.5, color: TONE[tone], whiteSpace: "nowrap" }}>{word}</span>
      <span style={{ display: "flex", color: "var(--fg-dim)", opacity: disabled ? 0 : 1 }}>
        <G as={CaretRight} size={12} />
      </span>
    </button>
  );
}

function AddProject({ state, view, setView }: { state: State; view: View; setView: (v: View) => void }) {
  const box = BOX[state];
  const [onBox, setOnBox] = useState(true);
  const [path, setPath] = useState("/home/klide/src/KLIDE");
  const [url, setUrl] = useState("github.com/pierreprudh/KLIDE");
  const machine = onBox ? "klide-box" : "this Mac";
  const close = () => setView("composer");

  if (view === "add") {
    return (
      <Modal
        title="Add project"
        subtitle="Which machine does it live on?"
        onClose={close}
        foot={
          <>
            <span style={{ flex: 1, fontSize: 11.5, color: "var(--fg-dim)" }}>
              Logins stay on each machine. Klide never copies a key.
            </span>
            <button type="button" className="klide-button klide-button-ghost" onClick={close}>
              Cancel
            </button>
          </>
        }
      >
        <MachineRow glyph={Laptop} name="This Mac" caption="Opens the macOS folder picker" word="" tone="quiet"
          onClick={() => { setOnBox(false); setPath("/Users/pierre/Documents/Private"); setView("folder"); }} />
        <MachineRow
          glyph={HardDrives}
          name="klide-box"
          caption={state === "ready" ? "klide@100.92.189.16 · Ubuntu 26.04" : box.caption}
          word={box.word}
          tone={box.tone}
          disabled={state === "offline"}
          onClick={() => {
            if (state === "offline") return;
            setOnBox(true);
            setPath("/home/klide/src/KLIDE");
            setView("folder");
          }}
        />
        <div className="mp-eyebrow" style={{ paddingTop: 12 }}>In ~/.ssh/config</div>
        <MachineRow glyph={Terminal} name="dev" caption="SSH · not checked yet" word="Add" tone="quiet" onClick={() => {}} />
        <MachineRow glyph={Terminal} name="prod" caption="SSH · not checked yet" word="Add" tone="quiet" onClick={() => {}} />
      </Modal>
    );
  }

  if (view === "clone") {
    const name = url.split("/").pop() || "repo";
    return (
      <Modal
        title={`Clone onto ${machine}`}
        subtitle={`Cloned with ${machine}'s own gh login.`}
        onClose={close}
        foot={
          <>
            <span style={{ flex: 1 }} />
            <button type="button" className="klide-button klide-button-ghost" onClick={() => setView("folder")}>
              Back
            </button>
            <button type="button" className="klide-button klide-button-primary">Clone</button>
          </>
        }
      >
        <div style={{ padding: "8px 9px 4px", display: "grid", gap: 12 }}>
          <label style={{ display: "grid", gap: 5, fontSize: 11.5, color: "var(--fg-subtle)" }}>
            Repository
            <input className="klide-field" value={url} onChange={(e) => setUrl(e.target.value)}
              style={{ padding: "0 10px", fontFamily: "var(--font-mono)", fontSize: 12 }} />
          </label>
          <label style={{ display: "grid", gap: 5, fontSize: 11.5, color: "var(--fg-subtle)" }}>
            Into
            <input className="klide-field" readOnly value={`/home/klide/src/${name}`}
              style={{ padding: "0 10px", fontFamily: "var(--font-mono)", fontSize: 12 }} />
          </label>
          {onBox && state === "owed" && (
            <div style={{ fontSize: 12, lineHeight: 1.5, color: "var(--warning)" }}>
              gh isn't logged in on klide-box, so a private repo won't clone yet.
              <FixLine cmd="ssh -t klide-box 'gh auth login && gh auth setup-git'" />
            </div>
          )}
        </div>
      </Modal>
    );
  }

  // folder
  const parent = path.replace(/\/[^/]+$/, "") || "/";
  const kids = TREE[path] ?? [];
  const branch = REPOS[path];
  return (
    <Modal
      title={`Add project on ${machine}`}
      subtitle="Pick a folder. A missing one is created."
      onClose={close}
      foot={
        <>
          <button type="button" className="klide-button klide-button-subtle" onClick={() => setView("clone")}>
            Clone instead…
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="klide-button klide-button-ghost" onClick={() => setView("add")}>
            Back
          </button>
          <button type="button" className="klide-button klide-button-primary">Add project</button>
        </>
      }
    >
      <div style={{ padding: "6px 9px 8px" }}>
        <input className="klide-field" value={path} onChange={(e) => setPath(e.target.value)}
          style={{ width: "100%", padding: "0 10px", fontFamily: "var(--font-mono)", fontSize: 12 }} />
      </div>
      <div style={{ maxHeight: 236, overflow: "auto" }}>
        {path !== "/home/klide" && (
          <button type="button" className="mp-row" onClick={() => setPath(parent)}>
            <span style={{ width: 20, display: "grid", placeItems: "center", color: "var(--fg-dim)" }}>
              <G as={ArrowElbowLeftUp} size={14} />
            </span>
            <span style={{ fontSize: 12.5, color: "var(--fg-subtle)" }}>..</span>
          </button>
        )}
        {kids.map((k) => {
          const full = `${path}/${k}`;
          return (
            <button type="button" key={k} className="mp-row" onClick={() => setPath(full)}>
              <span style={{ width: 20, display: "grid", placeItems: "center", color: "var(--fg-subtle)" }}>
                <G as={Folder} size={15} />
              </span>
              <span style={{ flex: 1, fontSize: 12.5 }}>{k}</span>
              {REPOS[full] && (
                <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--fg-dim)" }}>
                  <G as={GitBranch} size={12} />
                  {REPOS[full]}
                </span>
              )}
              <span style={{ display: "flex", color: "var(--fg-dim)" }}>
                <G as={CaretRight} size={12} />
              </span>
            </button>
          );
        })}
        {kids.length === 0 && <div style={{ padding: "10px 9px", fontSize: 12, color: "var(--fg-dim)" }}>Empty folder.</div>}
      </div>
      {onBox && (
        <div style={{ margin: "8px 9px 2px", fontSize: 11.5, lineHeight: 1.5, color: branch ? "var(--fg-subtle)" : "var(--fg-dim)" }}>
          {branch
            ? `A git checkout on ${branch}, clean. Each Run gets its own worktree inside it.`
            : "Not a git repository. Runs work in a worktree, so Klide will git init it — or clone instead."}
        </div>
      )}
    </Modal>
  );
}

/* ====================================================== 3. settings row */

function SettingsMachines({ state }: { state: State }) {
  const box = BOX[state];
  return (
    <div style={{ width: "min(680px, 100%)", margin: "0 auto", padding: "40px 24px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div style={{ flex: 1, fontSize: 18, color: "var(--fg-strong)", letterSpacing: "-0.01em" }}>Machines</div>
        <button type="button" className="klide-button klide-button-subtle" style={{ fontSize: 12 }}>
          <G as={ArrowClockwise} size={13} /> Checked just now
        </button>
        <button type="button" className="klide-button klide-button-secondary" style={{ fontSize: 12 }}>
          <G as={Plus} size={13} /> Add machine
        </button>
      </div>
      <p style={{ margin: "6px 0 22px", fontSize: 13, lineHeight: 1.5, color: "var(--fg-subtle)", maxWidth: 520 }}>
        Where a Run's loop, shell and files can live. A Run on a Remote machine keeps going when this Mac sleeps;
        Klide replays what you missed.
      </p>

      <MachineBlock glyph={Laptop} name="This Mac" word="Ready" tone="ok" where="MacBook Pro · macOS 26" />
      <MachineBlock
        glyph={HardDrives}
        name="klide-box"
        word={box.word}
        tone={box.tone}
        where="klide@100.92.189.16 · Ubuntu 26.04 · 3 vCPU · 3.2 GB"
        facts={box.facts}
        actions
      />

      <div style={{ marginTop: 18, fontSize: 11.5, color: "var(--fg-dim)" }}>
        Also in ~/.ssh/config: dev, prod. Add one and Klide checks it before it's offered.
      </div>
    </div>
  );
}

function MachineBlock({
  glyph,
  name,
  word,
  tone,
  where,
  facts,
  actions,
}: {
  glyph: PhosphorGlyph;
  name: string;
  word: string;
  tone: Tone;
  where: string;
  facts?: Fact[];
  actions?: boolean;
}) {
  return (
    <section style={{ padding: "14px 0 16px", borderTop: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
        <span className="mp-tile">
          <G as={glyph} size={14} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span style={{ fontSize: 13, color: "var(--fg-strong)" }}>{name}</span>
            <span style={{ fontSize: 11.5, color: TONE[tone] }}>{word}</span>
          </div>
          <Caption>{where}</Caption>
        </div>
        {actions && (
          <>
            <button type="button" className="klide-button klide-button-subtle" style={{ fontSize: 12, minHeight: 26 }}>
              Open shell
            </button>
            <button type="button" className="klide-button klide-button-subtle" style={{ fontSize: 12, minHeight: 26 }}>
              Remove
            </button>
          </>
        )}
      </div>
      {facts && (
        <div style={{ display: "grid", gridTemplateColumns: "96px 1fr", rowGap: 6, columnGap: 12, margin: "12px 0 0 37px", fontSize: 12 }}>
          {facts.map((f) => (
            <div key={f.label} className="mp-fact">
              <span style={{ color: "var(--fg-dim)" }}>{f.label}</span>
              <span style={{ color: f.tone ? (f.tone === "quiet" ? "var(--fg-subtle)" : TONE[f.tone]) : "var(--fg)" }}>
                {f.value}
                {f.fix && <span style={{ display: "block" }}><FixLine cmd={f.fix} /></span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ page */

function Page() {
  const [view, setView] = useState<View>(INITIAL_VIEW);
  const [state, setState] = useState<State>(INITIAL_STATE);
  const dialog = view === "add" || view === "folder" || view === "clone";
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "var(--bg)", color: "var(--fg)", fontFamily: "var(--font-ui)" }}>
      <style>{css}</style>
      {/* harness chrome — not part of the design */}
      <div style={{ display: "flex", gap: 2, padding: "8px 10px", borderBottom: "1px dashed var(--border)", flexShrink: 0 }}>
        {(["composer", "conversation", "add", "folder", "clone", "settings"] as View[]).map((v) => (
          <button key={v} type="button" className="mp-harness" data-on={view === v || undefined} onClick={() => setView(v)}>
            {v}
          </button>
        ))}
        <span style={{ width: 14 }} />
        {(["ready", "owed", "offline"] as State[]).map((s) => (
          <button key={s} type="button" className="mp-harness" data-on={state === s || undefined} onClick={() => setState(s)}>
            {s}
          </button>
        ))}
      </div>
      <div style={{ position: "relative", flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "auto" }}>
        {view === "settings" ? (
          <SettingsMachines state={state} />
        ) : (
          <ComposerStage
            key={`${state}-${view === "conversation"}`}
            state={state}
            started={view === "conversation"}
            onStart={() => setView("conversation")}
            onSettings={() => setView("settings")}
          />
        )}
        {dialog && <AddProject key={state} state={state} view={view} setView={setView} />}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Page />);
