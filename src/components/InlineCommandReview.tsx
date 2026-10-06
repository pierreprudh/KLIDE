import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ProviderId } from "../agent/types";
import { ProviderLogo } from "./ai/icons";
import { ConnectorMark } from "./linkMark";
import { Kbd } from "./Kbd";
import { PythonMark } from "./fileMarks";
import { highlightCode } from "./markdown";
import { parseScriptCommand, type ScriptCommand } from "./scriptCommand";

type Props = {
  command: string;
  kind?: "command" | "network" | "message" | "worker" | "connector";
  /** For a connector tool: the connector id, for its mark. `peer` holds its
   *  label, said in words only when the mark alone wouldn't name it. */
  connector?: string;
  /** For a message: the peer it goes to, by thread title. For a worker
   *  dispatch: who is being sent and as what — "Claude Code implementer", two
   *  facts set apart by a space, not a dot. */
  peer?: string;
  /** For a worker dispatch: the Delegate's provider id, so the card wears its
   *  mark in front of the name — the same logo the picker and the rail use. */
  worker?: ProviderId;
  detail?: string;
  externalPaths?: string[];
  /** The Python a command would start, resolved by Rust with the exact PATH
   *  the command gets (command_env.rs). Shown on a script's card. */
  interpreter?: CommandInterpreter;
  onReject: () => void;
  onApproveOnce: () => void;
  /** Approve this exact command for the rest of the run (allowlist, session). */
  onApproveForRun?: () => void;
  /** Approve this exact command for future runs in this workspace (project
   *  allowlist, persisted). */
  onApproveForProject?: () => void;
  pattern?: string;
  onApprovePattern?: (pattern: string) => void;
  /** The card the run is blocked on answers the keyboard: ⏎ approves once,
   *  esc denies — from anywhere that isn't a text field. (The composer
   *  handles its own ⏎ / esc while it is empty, so the user never has to
   *  leave it.) Only one card on screen may hold this. */
  hotkeys?: boolean;
};

/** Mirrors Rust `command_env::Interpreter`. */
export type CommandInterpreter = {
  path: string;
  version?: string | null;
  /** The venv folder it belongs to, relative to the command's folder. */
  venv?: string | null;
};

/** `3.12.4 · .venv`, or `3.9.6 · /usr/bin` outside a venv. */
export function interpreterLabel(interpreter: CommandInterpreter): string {
  const where = interpreter.venv
    ?? interpreter.path.replace(/\/[^/]+$/, "").replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
  return [interpreter.version, where].filter(Boolean).join(" · ");
}

/** Is this key event already owned by a text field? Then the card stays out. */
function targetIsEditable(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
}

/** A bare icon action — no container, just the glyph, coloring on hover. Keeps
 *  the command card minimal per the design direction. The scope actions
 *  (this run, this project, a pattern) wear this: they are the quiet
 *  options, dimmer than the decision itself. */
function BareAction({
  label,
  tone,
  onClick,
  children,
}: {
  label: string;
  tone: "danger" | "accent" | "neutral";
  onClick: () => void;
  children: ReactNode;
}) {
  const hoverFg = tone === "danger" ? "var(--diff-remove)" : tone === "accent" ? "var(--accent)" : "var(--fg-strong)";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{
        flexShrink: 0,
        width: 20,
        height: 20,
        display: "grid",
        placeItems: "center",
        padding: 0,
        border: "none",
        background: "transparent",
        color: "var(--fg-dim)",
        cursor: "pointer",
        transition: "color var(--motion-fast) var(--ease-out)",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.color = hoverFg)}
      onMouseLeave={(e) => (e.currentTarget.style.color = "var(--fg-dim)")}
    >
      {children}
    </button>
  );
}

/** The decision itself, said in a word — "Run", "Deny" — with its key beside
 *  it when the card answers the keyboard. Text, not a glyph: a decision the
 *  run is blocked on should not have to be decoded from a check mark. No
 *  container; the accent colour alone marks the primary one. */
function WordAction({
  label,
  tone,
  keycap,
  onClick,
}: {
  label: string;
  tone: "danger" | "accent";
  keycap?: string;
  onClick: () => void;
}) {
  const fg = tone === "accent" ? "var(--accent)" : "var(--fg-subtle)";
  const hoverFg = tone === "accent" ? "var(--accent-hover)" : "var(--diff-remove)";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={keycap ? `${label} (${keycap})` : label}
      title={keycap ? `${label} (${keycap})` : label}
      style={{
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 22,
        padding: "0 2px",
        border: "none",
        background: "transparent",
        color: fg,
        font: "inherit",
        fontSize: 12,
        fontWeight: tone === "accent" ? 500 : 400,
        cursor: "pointer",
        transition: "color var(--motion-fast) var(--ease-out)",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.color = hoverFg)}
      onMouseLeave={(e) => (e.currentTarget.style.color = fg)}
    >
      {label}
      {keycap && <Kbd keys={[keycap]} />}
    </button>
  );
}

/** How many lines of a script the card shows before "N more lines". */
const SCRIPT_PREVIEW_LINES = 3;

/** A Python script under its card's header: the program as code, no gutter,
 *  first lines only until asked — every line is one click away, nothing is
 *  hidden for good. */
function ScriptBody({ script }: { script: ScriptCommand }) {
  const [open, setOpen] = useState(false);
  const extra = script.lines.length - SCRIPT_PREVIEW_LINES;
  const shown = open || extra <= 0 ? script.lines : script.lines.slice(0, SCRIPT_PREVIEW_LINES);
  return (
    <div style={{ flexBasis: "100%", minWidth: 0, borderTop: "1px solid var(--border)", paddingTop: 6 }}>
      <pre
        style={{
          margin: 0,
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          lineHeight: 1.55,
          color: "var(--fg-muted)",
          overflowX: "auto",
          maxHeight: open ? 280 : undefined,
          overflowY: open ? "auto" : undefined,
        }}
      >
        <code style={{ fontFamily: "inherit" }}>{highlightCode(shown.join("\n"))}</code>
      </pre>
      {extra > 0 && (
        <button
          type="button"
          onClick={() => setOpen((was) => !was)}
          style={{ marginTop: 2, padding: 0, border: "none", background: "none", font: "inherit", fontSize: 11, color: "var(--fg-subtle)", cursor: "pointer" }}
        >
          {open ? "Show less" : `${extra} more line${extra === 1 ? "" : "s"}`}
        </button>
      )}
    </div>
  );
}

/** Shell-command approval — minimal: the command in mono with a `$` prompt,
 *  the quiet scope options as bare icons (approve-for-run 📌,
 *  approve-for-project 🗂, pattern), a hairline, then the decision in words
 *  (Deny · Run) with its keys when the card answers them. No heavy framing,
 *  no icon containers. Lives inline under the requesting turn. A network
 *  target and a message from another agent take the same card: the message
 *  shows the peer where the `$` would be, then the text. */
export function InlineCommandReview({
  command,
  kind = "command",
  peer,
  worker,
  connector,
  detail,
  externalPaths = [],
  interpreter,
  onReject,
  onApproveOnce,
  onApproveForRun,
  onApproveForProject,
  pattern,
  onApprovePattern,
  hotkeys = false,
}: Props) {
  // A command that is entirely a Python script shows as one: the mark where
  // `$` would be, the files it writes in the reason line, the program below.
  // No pattern offer — `python3 *` would approve every script there is.
  const script = useMemo(() => (kind === "command" ? parseScriptCommand(command) : null), [kind, command]);
  const canApprovePattern = !script && !!pattern && !!onApprovePattern && pattern !== command;
  // ⏎ approves once, esc denies — but only when no text field owns the key,
  // and never a key something else already answered (the composer prevents
  // default on the ⏎ it handles, so an approval is never counted twice).
  useEffect(() => {
    if (!hotkeys) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || targetIsEditable(e)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Enter") { e.preventDefault(); onApproveOnce(); }
      else if (e.key === "Escape") { e.preventDefault(); onReject(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hotkeys, onApproveOnce, onReject]);
  const approveRunLabel =
    kind === "connector" ? "Approve this tool for this run"
      : kind === "network" ? "Approve target for this run"
      : kind === "message" ? "Approve messages from this agent for this run"
        : "Approve for this run";
  // The decision, in the verb the kind calls for.
  const approveOnceLabel =
    kind === "worker" ? "Dispatch"
      : kind === "message" ? "Accept"
      : kind === "command" ? "Run"
        : "Allow";
  const rejectLabel = kind === "message" ? "Decline" : kind === "worker" ? "Cancel" : "Deny";
  const hasScopeActions = !!onApproveForRun || !!onApproveForProject || (kind === "command" && canApprovePattern);
  const approveProjectLabel =
    kind === "connector" ? "Approve this tool for this project"
      : kind === "network" ? "Approve target for this project"
        : "Approve for this project";
  return (
    <div
      className="ai-qa-card"
      style={{
        // A touch narrower than the composer below it, centered.
        margin: "0 16px 8px",
        display: "flex",
        alignItems: "center",
        flexWrap: script ? "wrap" : undefined,
        gap: 8,
        rowGap: script ? 6 : undefined,
        padding: "7px 10px",
        borderRadius: 10,
        border: "1px solid var(--border)",
        background: "color-mix(in srgb, var(--bg-elevated) 90%, transparent)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          display: "grid",
          gap: 2,
        }}
      >
        <span
          style={{
            minWidth: 0,
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.5,
            color: "var(--fg-strong)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={command}
        >
          {kind === "command" && !script && <span style={{ color: "var(--fg-dim)", userSelect: "none" }}>$ </span>}
          {script && (
            <span title={interpreter?.path ?? "Python"} style={{ display: "inline-flex", verticalAlign: "-2px", marginRight: 7 }}>
              <PythonMark size={13} />
            </span>
          )}
          {kind === "connector" && connector && (
            // The mark, then — for anything but GitHub, whose mark says it — the
            // connector's name, set apart from the tool by space, not a dot.
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, verticalAlign: "bottom", marginRight: 7 }}>
              <ConnectorMark connector={connector} size={13} />
              {connector !== "github" && peer && <span style={{ color: "var(--accent)", fontWeight: 500 }}>{peer}</span>}
            </span>
          )}
          {kind === "message" && peer && <span style={{ color: "var(--accent)", fontWeight: 500 }}>@{peer} </span>}
          {kind === "worker" && peer && (
            <span style={{ color: "var(--accent)", fontWeight: 500, display: "inline-flex", alignItems: "center", gap: 6, verticalAlign: "bottom" }}>
              {worker && <ProviderLogo id={worker} size={14} />}
              <span>{peer} →</span>
            </span>
          )}{kind === "worker" && peer && " "}
          {script ? script.head : command}
          {script && interpreter && (
            // Which Python this is — the version and where it lives — so the
            // environment is answered before Run, not discovered after.
            <span
              title={interpreter.path}
              style={{ marginLeft: 8, fontFamily: "var(--font-ui)", fontSize: 11, color: "var(--fg-dim)" }}
            >
              {interpreterLabel(interpreter)}
            </span>
          )}
        </span>
        {(detail || externalPaths.length > 0 || (script && script.writes.length > 0)) && (
          <span
            style={{
              minWidth: 0,
              fontSize: 11,
              lineHeight: 1.35,
              color: "var(--fg-subtle)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={[script?.writes.length ? `Writes ${script.writes.join(", ")}.` : "", detail, externalPaths.length ? `Outside workspace: ${externalPaths.join(", ")}` : ""].filter(Boolean).join(" ")}
          >
            {/* A script's write targets lead: in a narrow panel the line
                truncates, and the file is what the reader needs. */}
            {script && script.writes.length > 0 && (
              <>
                Writes{" "}
                {script.writes.map((path, i) => (
                  <span key={path}>
                    {i > 0 && ", "}
                    <span style={{ fontFamily: "var(--font-mono)" }}>{path.split("/").pop()}</span>
                  </span>
                ))}
                .{detail ? " " : ""}
              </>
            )}
            {detail}
            {externalPaths.length > 0 ? `${detail ? " " : ""}Outside workspace: ${externalPaths.join(", ")}` : ""}
          </span>
        )}
      </span>
      <span style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>
        {onApproveForRun && (
          <BareAction label={approveRunLabel} tone="neutral" onClick={onApproveForRun}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="17" x2="12" y2="22" />
              <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
            </svg>
          </BareAction>
        )}
        {onApproveForProject && (
          <BareAction label={approveProjectLabel} tone="neutral" onClick={onApproveForProject}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
            </svg>
          </BareAction>
        )}
        {kind === "command" && canApprovePattern && (
          <BareAction label={`Approve pattern: ${pattern}`} tone="neutral" onClick={() => onApprovePattern!(pattern!)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 6h16M4 12h10M4 18h7" />
              <path d="m17 14 1 2 2 .5-1.4 1.5.2 2-1.8-.9-1.8.9.2-2L14 16.5l2-.5Z" />
            </svg>
          </BareAction>
        )}
        {hasScopeActions && (
          // A hairline between the options and the decision, the card's one
          // divider.
          <span aria-hidden="true" style={{ width: 1, height: 14, background: "var(--border)", margin: "0 2px" }} />
        )}
        <WordAction label={rejectLabel} tone="danger" keycap={hotkeys ? "Esc" : undefined} onClick={onReject} />
        <WordAction label={approveOnceLabel} tone="accent" keycap={hotkeys ? "↵" : undefined} onClick={onApproveOnce} />
      </span>
      {script && <ScriptBody script={script} />}
    </div>
  );
}
