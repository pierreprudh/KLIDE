import { memo, useEffect, useState, type ReactElement, type ReactNode } from "react";
import type { Msg } from "./types";
import { DelegateConsole } from "../lazySurfaces";
import {
  COORDINATION_TOOL_NAMES,
  parseDeliveryReason,
  peerName,
  usePeerIndex,
  type DeliveredEnvelopeRef,
} from "./coordinationPeers";
import { readCoordinationSnapshot, type CoordinationEnvelope, type CoordinationEnvelopeSnapshot } from "../../agent/coordination";
import { DotGridLoader, ProviderLogo, ToolIcon } from "./icons";
import { renderMarkdown, splitThinking, stripPlanJson } from "../markdown";
import { providerName } from "../../agent/providers";
import type { ProviderId } from "../../agent/types";
import { formatElapsed, useElapsed } from "./WorkingRow";
import { MIN_STACKED_CALLS, toolCallKey, toolRunLabel } from "./toolRuns";

// Premium thinking block. Renders as a soft card with a pulsing dot while the
// agent is still streaming, a rotating chevron, and a markdown body so code
// blocks inside the reasoning render properly. Open by default while the
// message is still streaming (no content yet), collapsed once the answer
// arrives — matches Claude Code's "thought process" disclosure.
function normalizeThinking(text: string): string {
  return text.replace(/\n+/g, " ").replace(/\s{2,}/g, " ").trim();
}

export function ThinkingBlock({
  text,
  streaming,
  startedAt,
  thinkingMs,
}: {
  text: string;
  streaming: boolean;
  /** Epoch ms reasoning began — the live timer counts from here. */
  startedAt?: number;
  /** Settled reasoning span; drawn as "Thought for 4.2s" when known. */
  thinkingMs?: number;
}) {
  return (
    <details open={streaming} className={`klide-think${streaming ? " is-streaming" : ""}`} style={{ margin: "2px 0 6px" }}>
      <summary
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "1px 0",
          cursor: "pointer",
          listStyle: "none",
          userSelect: "none",
          color: "var(--fg-dim)",
        }}
      >
        {streaming ? (
          <ThinkingLiveLabel startedAt={startedAt} />
        ) : (
          <span style={{ fontSize: 10, fontWeight: 600, fontFamily: "var(--font-mono)" }}>
            {thinkingMs !== undefined ? `Thought for ${formatElapsed(thinkingMs)}` : "Thought process"}
          </span>
        )}
        <span
          aria-hidden
          className="klide-think-chev"
          style={{
            width: 8,
            height: 8,
            display: "grid",
            placeItems: "center",
            opacity: 0.7,
            transition: "transform var(--motion-fast) var(--ease-out)",
          }}
        >
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </summary>
      <div
        style={{
          margin: "5px 0 2px",
          paddingLeft: 11,
          borderLeft: "1px solid var(--border)",
          fontSize: 12,
          lineHeight: 1.6,
          color: "var(--fg-subtle)",
        }}
      >
        {renderMarkdown(normalizeThinking(text))}
      </div>
    </details>
  );
}

// The streaming header: a shimmer sweeping through "Thinking" and a live
// timer beside it, the same pair the Working row wears — one language for
// "the model is busy". Its own component so the 100ms tick re-renders only
// this label, never the reasoning body under it.
function ThinkingLiveLabel({ startedAt }: { startedAt?: number }) {
  const elapsed = useElapsed(startedAt);
  return (
    <>
      <span className="ai-working-label" style={{ fontSize: 10, fontWeight: 600, fontFamily: "var(--font-mono)" }}>
        Thinking
      </span>
      <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>{elapsed}</span>
    </>
  );
}

// Every flavour of "the model is thinking out loud" a message can carry,
// merged in arrival order: the structured block the adapter captured
// (Anthropic / Ollama), an inline `<think>…</think>` leak, and the bare
// plan-JSON fallback smaller local models emit. AiPanel uses this to hoist a
// folded tool run's reasoning out of the fold — the thought process reads as
// the agent's voice, not as tool work, so it must not disappear into the
// "N tool calls" row.
export function extractThinking(m: Msg): string {
  if (m.role !== "assistant") return "";
  const { thinking: inlineThinking, content: cleaned } = splitThinking(m.content);
  const { thinking: planThinking } = stripPlanJson(cleaned);
  return [m.thinking, inlineThinking, planThinking].filter(Boolean).join("\n\n");
}

// Pull the most human-meaningful value out of a tool's args for the inline
// summary — `read_file README.md`, not a JSON block. Live events pass the
// input object; transcript replay passes it JSON-stringified.
function summarizeArgs(args: unknown): string {
  let v: unknown = args;
  if (typeof v === "string") {
    const raw: string = v;
    try {
      v = JSON.parse(raw);
    } catch {
      return raw.slice(0, 80);
    }
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const key of ["path", "pattern", "query", "url", "command", "title", "text"]) {
      const val = o[key];
      if (typeof val === "string" && val) return val.length > 80 ? val.slice(0, 79) + "…" : val;
    }
    const first = Object.values(o).find((x) => typeof x === "string" && x) as string | undefined;
    if (first) return first.length > 80 ? first.slice(0, 79) + "…" : first;
    const keys = Object.keys(o);
    return keys.length ? `{ ${keys.join(", ")} }` : "";
  }
  return "";
}

// `spawn_subagent` reads as a delegation, not a tool call: a middot, the
// @role it handed to, and the task in plain prose — expandable to the full task
// when it's long. No JSON, no "spawn_subagent(...)" — the report follows below.
// A call that named a worker wears that Delegate's mark and name in front of
// the role, the same way the dispatch card does: "Claude Code implementer".
function SubagentCallRow({ args }: { args: unknown }) {
  const o = (args ?? {}) as Record<string, unknown>;
  const subagent = typeof o.subagent === "string" ? o.subagent : "subagent";
  const worker = typeof o.worker === "string" && o.worker.trim() ? (o.worker.trim() as ProviderId) : null;
  const task = typeof o.task === "string" ? o.task.replace(/\s+/g, " ").trim() : "";
  const long = task.length > 96;
  const short = long ? task.slice(0, 95) + "…" : task;
  return (
    <details style={{ margin: "5px 0 -3px" }}>
      <summary style={{ display: "flex", alignItems: "center", gap: 7, padding: 0, cursor: long ? "pointer" : "default", listStyle: "none", userSelect: "none", minWidth: 0 }}>
        <span aria-hidden style={{ color: "var(--fg-dim)", flexShrink: 0 }}>·</span>
        <span style={{ fontSize: 12, color: "var(--fg-subtle)", flexShrink: 0 }}>Delegated to</span>
        {worker && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0, fontSize: 12, color: "var(--fg-strong)" }}>
            <ProviderLogo id={worker} size={13} />
            <span>{providerName(worker)}</span>
          </span>
        )}
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, fontWeight: 500, color: "var(--accent)", flexShrink: 0 }}>{worker ? subagent : `@${subagent}`}</span>
        {short && (
          <span style={{ fontSize: 12, color: "var(--fg-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>· {short}</span>
        )}
      </summary>
      {long && (
        <div style={{ margin: "3px 0 3px 13px", padding: "6px 10px", fontSize: 12, lineHeight: 1.55, color: "var(--fg-subtle)", background: "color-mix(in srgb, var(--bg-elevated) 60%, var(--bg))", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}>
          {task}
        </div>
      )}
    </details>
  );
}

function coordinationArg(args: unknown, key: string): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function AgentCoordinationCallRow({ name, args, count = 1 }: { name: string; args: unknown; count?: number }) {
  const titles = usePeerIndex();
  const targetId = coordinationArg(args, name === "agent_send" ? "toRunId" : "runId")
    || coordinationArg(args, "fromRunId");
  // A Run id is a conversation id, so the thread's own title is its name.
  const target = targetId ? peerName(targetId, titles) : "";
  const body = coordinationArg(args, "body");
  const kind = coordinationArg(args, "kind") || "instruction";
  const waits = !!args
    && typeof args === "object"
    && !Array.isArray(args)
    && (args as Record<string, unknown>).waitForReply === true;
  const action = name === "agent_send"
    ? (kind === "question" || waits ? "Asked" : "Messaged")
    : name === "agent_wait"
      ? "Waiting for"
      : name === "agent_cancel"
        ? "Cancelling"
        : name === "agent_read_result"
          ? "Reading result from"
          : "Checked agent network";
  return <CoordinationLine verb={action} peerId={targetId} peer={target} body={body} count={count} />;
}

// The one line every agent-to-agent event is drawn as — the sender's call
// ("Asked @peer · body"), the receiver's delivery ("Asked by @peer · body"),
// and a message still waiting for its turn. The verb, the peer by thread
// title, the sentence. A long body folds open under it.
function CoordinationLine({
  verb,
  peerId,
  peer,
  body,
  count = 1,
  trailing,
  margin = "5px 0 -3px",
}: {
  verb: string;
  peerId: string;
  peer: string;
  body: string;
  /** How many identical messages this one line stands for. */
  count?: number;
  /** The right end: what is still to happen, when anything is. */
  trailing?: ReactNode;
  margin?: string;
}) {
  const preview = body.length > 96 ? `${body.slice(0, 95)}…` : body;
  const folds = body.length > 96;
  const [hover, setHover] = useState(false);
  return (
    // Quieter than the prose around it — a line about the plumbing, not the
    // conversation. Full strength under the pointer.
    <details
      style={{ margin, opacity: hover ? 1 : 0.72, transition: "opacity var(--motion-fast) var(--ease-out)" }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <summary
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: 0,
          cursor: folds ? "pointer" : "default",
          listStyle: "none",
          userSelect: "none",
          minWidth: 0,
        }}
      >
        <span style={{ fontSize: 12, color: "var(--fg-subtle)", flexShrink: 0 }}>{verb}</span>
        {peer && (
          <span title={peerId} style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, fontWeight: 500, color: "var(--accent)", flexShrink: 0 }}>
            @{peer}
          </span>
        )}
        {preview && (
          <span style={{ fontSize: 12, color: "var(--fg-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            · {preview}
          </span>
        )}
        {count > 1 && (
          <span style={{ fontSize: 12, color: "var(--fg-dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }} title={`${count} identical messages`}>
            · ×{count}
          </span>
        )}
        {trailing && <span style={{ ...COMPACT_MONO, marginLeft: "auto", color: "var(--fg-dim)", flexShrink: 0 }}>{trailing}</span>}
      </summary>
      {folds && (
        <div style={{ margin: "3px 0 3px 13px", padding: "6px 10px", fontSize: 12, lineHeight: 1.55, color: "var(--fg-subtle)", background: "color-mix(in srgb, var(--bg-elevated) 60%, var(--bg))", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", whiteSpace: "pre-wrap" }}>
          {body}
        </div>
      )}
    </details>
  );
}

// A shell call's only interesting arg is the command line itself — expanded,
// it reads as a command, not as the JSON envelope it travelled in. Covers the
// harness tool and the delegate CLIs' names for the same thing.
function commandArg(name: string, args: unknown): string | null {
  if (!/^(run_command|bash|shell)$/i.test(name)) return null;
  let v: unknown = args;
  if (typeof v === "string") {
    const raw: string = v;
    try {
      v = JSON.parse(raw);
    } catch {
      return raw.trim() || null;
    }
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const cmd = (v as Record<string, unknown>).command;
    if (typeof cmd === "string" && cmd.trim()) return cmd;
  }
  return null;
}

// Minimalist tool-call line, à la Claude Code's `⏺ Read(file)`: one slim
// mono row — tool glyph, tool name, primary arg — expandable to the full
// args JSON (or, for a shell call, the bare command line).
/** A result row the call above it owns — drawn under the call, so what came
 *  back sits with what asked for it. `active` while the tool is still running. */
export type AttachedResult = { msg: Extract<Msg, { role: "tool" }>; active: boolean };

// Every call keeps its icon and name, a second `read_file` included: a bare
// path on a branch read as the first call's result, not a call of its own.
// A turn that speaks *and* makes a wall of calls — "I'll set up a todo list
// and read the code", then seven `update_todo_list` rows — keeps its sentence
// in view and folds the rows under it, behind the same "N tool calls" row a
// prose-free stretch gets from AiPanel. The sentence is the agent explaining
// itself; the rows are the machinery it explained. Open while the work is
// still running, so the only thing moving on screen is never hidden.
function InlineToolRun({ count, names, working, children }: { count: string; names: string; working: boolean; children: ReactNode }) {
  const [opened, setOpened] = useState(false);
  const open = opened || working;
  return (
    <>
      <ToolRunRow count={count} names={names} expanded={open} onToggle={() => setOpened((was) => !was)} />
      <div className="klide-tool-run-body" data-open={open ? "true" : "false"}>
        <div>{children}</div>
      </div>
    </>
  );
}

function ToolCallRow({ name, args, count = 1, result }: { name: string; args: unknown; count?: number; result?: AttachedResult }) {
  const call =
    name === "spawn_subagent" ? (
      <SubagentCallRow args={args} />
    ) : COORDINATION_TOOL_NAMES.has(name) ? (
      <AgentCoordinationCallRow name={name} args={args} count={count} />
    ) : (
      <ToolCallDisclosure name={name} args={args} />
    );
  if (!result) return call;
  return (
    <>
      {call}
      <ToolResultRow content={result.msg.content} active={result.active} toolName={result.msg.toolName} observedBy={result.msg.observedBy} nested />
    </>
  );
}

function ToolCallDisclosure({ name, args }: { name: string; args: unknown }) {
  const command = commandArg(name, args);
  const argsText = command ?? formatJson(args);
  const summary = summarizeArgs(args);
  return (
    <details style={{ margin: "5px 0 -3px" }}>
      <summary
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0",
          cursor: "pointer",
          listStyle: "none",
          userSelect: "none",
          minWidth: 0,
          // Tool machinery sits one indent step (14px) inside the prose /
          // thought-process edge, so the hierarchy is spatial, not just tonal.
          paddingLeft: 14,
        }}
      >
        {/* One token step dimmer than prose across the whole row: tool
            work is machinery, and it should recede next to the thought
            process and the answer rather than compete with them. */}
        <span aria-hidden style={{ display: "grid", placeItems: "center", color: "var(--fg-dim)", flexShrink: 0 }}>
          <ToolIcon name={name} />
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11.5,
            color: "var(--fg-subtle)",
            fontWeight: 500,
            flexShrink: 0,
          }}
        >
          {name}
        </span>
        {summary && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11.5,
              color: "var(--fg-dim)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {summary}
          </span>
        )}
      </summary>
      {argsText && (
        <pre
          style={{
            margin: "3px 0 3px 34px",
            padding: "6px 10px",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: "var(--fg-subtle)",
            background: "color-mix(in srgb, var(--bg-elevated) 60%, var(--bg))",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            overflowX: "auto",
            // A command is one long line — wrap it. JSON keeps its shape and
            // scrolls instead.
            whiteSpace: command ? "pre-wrap" : "pre",
            wordBreak: command ? "break-word" : undefined,
            lineHeight: 1.5,
            maxWidth: "calc(100% - 34px)",
            boxSizing: "border-box",
          }}
        >
          {argsText}
        </pre>
      )}
    </details>
  );
}

// The one row a stretch of tool work collapses to. It wears the same icon and
// mono type as the rows it stands in for, so opening it changes the amount on
// screen and nothing else — a summary that looked like a different kind of
// object would read as a new concept rather than as the same rows, folded.
export function ToolRunRow({
  count,
  names,
  expanded,
  onToggle,
}: {
  count: string;
  names: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        // The row that hosts this owns its spacing and its gutter — a margin
        // here would push the text off the mark sitting beside it. The 22px
        // box matches that mark so the two centre on the same line.
        margin: 0,
        minHeight: 22,
        padding: 0,
        border: "none",
        background: "transparent",
        cursor: "pointer",
        textAlign: "left",
        minWidth: 0,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.opacity = "0.82";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.opacity = "1";
      }}
    >
      <span
        aria-hidden
        style={{
          display: "grid",
          placeItems: "center",
          color: "var(--fg-subtle)",
          flexShrink: 0,
          // Closed points down, at the rows it will bring; open points up, at
          // the row that will put them away — and it gets there by flipping,
          // never by turning. Down and up are 180° apart, so a rotation sweeps
          // the tip through pointing-right on every click: a lateral arc, on a
          // control that has not moved. Interpolating scaleY from 1 to -1
          // passes through a flat line instead, so the mark changes direction
          // without travelling.
          transform: expanded ? "rotate(90deg) scaleY(-1)" : "rotate(90deg) scaleY(1)",
          // The same duration and curve as the box it opens: a chevron that
          // finishes before the rows do reads as two separate events.
          transition: "transform var(--motion-slow) var(--ease-out)",
        }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M9 5l7 7-7 7" />
        </svg>
      </span>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11.5,
          // Same one-step-dimmer recipe as the rows it folds away (see
          // ToolCallRow): the summary is still tool machinery, not prose.
          color: "var(--fg-subtle)",
          fontWeight: 500,
          flexShrink: 0,
        }}
      >
        {count}
      </span>
      {names && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11.5,
            color: "var(--fg-dim)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {names}
        </span>
      )}
    </button>
  );
}

function stripToolNarration(content: string, hasToolCalls: boolean): string {
  if (!hasToolCalls) return content;
  return content
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (/^Applied:\s*[A-Za-z_]\w*\s*\(/.test(trimmed)) return false;
      if (/^[A-Za-z_]\w*\s+tool result\s*:/i.test(trimmed)) return false;
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// First line of a tool result, trimmed for the collapsed summary row.
function summarizeResult(content: string): { line: string; extra: string } {
  const lines = content.split("\n");
  let line = (lines.find((l) => l.trim()) ?? "").trim().replace(/:$/, "");
  if (line.length > 72) line = line.slice(0, 71) + "…";
  const count = lines.length;
  return { line, extra: count > 1 ? `${count} lines` : "" };
}

// Indented result line under its tool call — `⎿ <first line> · N lines`,
// expandable to the full markdown-rendered content. Errors tint the
// connector with --danger; in-flight calls pulse.
function ToolResultRow({
  content,
  active,
  toolName,
  observedBy,
  nested = false,
}: {
  content: string;
  active: boolean;
  toolName?: string;
  /** Provider id when a delegate CLI ran this itself. The row says so: Klide
   *  applied no capability, permission gate or diff review to it. */
  observedBy?: string;
  /** Drawn directly under its own call row, which already names the tool —
   *  the result line carries only what came back. */
  nested?: boolean;
}) {
  const pending = active && /^Running /.test(content);
  const isError = /^(Tool error from|Error:)/.test(content);
  const isSubagent = toolName === "spawn_subagent";
  const isCoordination = !!toolName && COORDINATION_TOOL_NAMES.has(toolName);
  const { line, extra } = summarizeResult(content);
  const label = isSubagent
    ? (pending ? "subagent working…" : "subagent report")
    : isCoordination
      ? (pending ? "coordination in progress…" : "coordination update")
    : nested
      ? null
    : toolName || (pending ? content.replace(/^Running\s+/, "").replace(/\.\.\.$/, "") : "tool");
  return (
    // 48 = the call rows' 14px machinery indent + the 34px elbow offset,
    // so results keep their nesting depth under the calls above them.
    <details className="klide-tool-result-row" style={{ margin: pending ? "0 0 5px" : "-2px 0 6px", paddingLeft: 48 }}>
      <summary
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: 0,
          cursor: pending ? "default" : "pointer",
          listStyle: "none",
          userSelect: "none",
          minWidth: 0,
          color: isError ? "var(--danger)" : "var(--fg-dim)",
        }}
      >
        {pending ? (
          <DotGridLoader size={11} label="Tool running" />
        ) : (
          <span
            aria-hidden
            style={{
              position: "relative",
              width: 15,
              height: 14,
              flexShrink: 0,
              transform: "translateY(-2px)",
            }}
          >
            <span
              style={{
                position: "absolute",
                left: 5,
                top: 0,
                bottom: 3,
                width: 1,
                borderRadius: 999,
                background: "currentColor",
                opacity: 0.48,
              }}
            />
            <span
              style={{
                position: "absolute",
                left: 5,
                right: 0,
                bottom: 3,
                height: 1,
                borderRadius: 999,
                background: "currentColor",
                opacity: 0.48,
              }}
            />
          </span>
        )}
        {(pending || label) && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: isError ? "var(--danger)" : "var(--fg-subtle)",
              flexShrink: 0,
              whiteSpace: "nowrap",
            }}
          >
            {pending ? "running" : label}
          </span>
        )}
        {(pending ? label : line) && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: isError ? "var(--danger)" : "var(--fg-dim)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {pending ? label : line}
          </span>
        )}
        {!pending && extra && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10.5,
              color: "var(--fg-dim)",
              flexShrink: 0,
            }}
          >
            · {extra}
          </span>
        )}
        {observedBy && (
          <span
            title={`Run by ${providerName(observedBy as ProviderId)} under its own permissions — not reviewed by Klide`}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10.5,
              color: "var(--fg-dim)",
              flexShrink: 0,
              whiteSpace: "nowrap",
            }}
          >
            · via {providerName(observedBy as ProviderId)}
          </span>
        )}
      </summary>
      {!pending && (
        <div
          style={{
            margin: "3px 0 3px 13px",
            padding: "6px 10px",
            fontSize: 12,
            lineHeight: 1.55,
            color: "var(--fg-subtle)",
            background: "color-mix(in srgb, var(--bg-elevated) 60%, var(--bg))",
            border: "1px solid var(--border)",
            // An accent left-rail marks output that came back from a subagent.
            ...(isSubagent ? { borderLeft: "2px solid var(--accent)" } : null),
            borderRadius: "var(--radius-sm)",
          }}
        >
          {/* A subagent report is written *as* markdown — render it. Every
              other tool result is raw program output (grep hits, file
              contents, command stdout): markdown-rendering it mangles the
              text it's supposed to show — `**` turns italic, backticks turn
              into code chips, asterisks vanish. */}
          {isSubagent ? (
            renderMarkdown(content)
          ) : (
            <pre
              style={{
                margin: 0,
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                lineHeight: 1.5,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {content}
            </pre>
          )}
        </div>
      )}
    </details>
  );
}

function formatJson(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

// Quiet per-message stats — centered under the answer, barely-there by
// default, full strength on hover (see .klide-msg-meta in tokens.css).
// Order: tok/s, tokens, time, total, TTFT — spacing alone separates the
// parts; every one is self-labeled, so a glyph between them is noise.
function MessageMeta({ meta }: { meta: { ms?: number; modelMs?: number; tokens?: number; promptTokens?: number; ttftMs?: number; tps?: number; exact?: boolean; costUsd?: number } }) {
  const parts: string[] = [];
  if (meta.tps) parts.push(`${meta.tps} tok/s`);
  if (meta.tokens) parts.push(`${meta.exact ? "" : "~"}${meta.tokens.toLocaleString()} tokens`);
  // The duration slot is the model's own time when the harness measured it.
  // Wall clock only earns its own slot when it's meaningfully longer — that
  // gap is tool execution and time the turn sat waiting on a diff review.
  const durationMs = meta.modelMs ?? meta.ms;
  if (durationMs !== undefined) parts.push(`${formatDuration(durationMs)} ${meta.modelMs !== undefined ? "model" : "elapsed"}`);
  if (meta.modelMs !== undefined && meta.ms !== undefined && meta.ms - meta.modelMs >= 1000) {
    parts.push(`${formatDuration(meta.ms)} total`);
  }
  if (meta.ttftMs !== undefined) parts.push(`TTFT ${formatDuration(meta.ttftMs)}`);
  // Cost last, so the eye lands on it. Sub-cent turns show "<$0.01".
  if (meta.costUsd !== undefined && meta.costUsd > 0) {
    parts.push(meta.costUsd < 0.01 ? "<$0.01" : `$${meta.costUsd.toFixed(meta.costUsd < 1 ? 3 : 2)}`);
  }
  if (parts.length === 0) return null;
  return (
    <div
      className="klide-msg-meta"
      title="This response only. Model speed excludes tool execution. Tokens and cost exclude external CLI agents; their usage is unavailable here."
      style={{
        marginTop: 6,
        display: "flex",
        justifyContent: "center",
        flexWrap: "wrap",
        gap: 14,
        fontSize: 10,
        fontFamily: "var(--font-mono)",
        color: "var(--fg-dim)",
        letterSpacing: "0.02em",
        userSelect: "none",
      }}
    >
      <span>This response</span>
      {parts.map((p, i) => (
        <span key={i}>{p}</span>
      ))}
    </div>
  );
}

// Fold glyph that marks a compaction — three collapsing rules, echoing the
// "many turns → fewer" idea. Shared by every compaction state.
function CompactionGlyph() {
  return (
    <span aria-hidden style={{ display: "grid", placeItems: "center", color: "currentColor", flexShrink: 0 }}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 4h10" />
        <path d="M5 8h6" />
        <path d="M6.5 12h3" />
      </svg>
    </span>
  );
}

// A thin hairline used to fill the gutter of the full-width (manual) layout.
function Hairline() {
  return <span aria-hidden style={{ flex: 1, height: 1, background: "var(--border)", minWidth: 12 }} />;
}

const COMPACT_MONO = { fontFamily: "var(--font-mono)", fontSize: 11.5 } as const;

function compactSummaryCard(summary: string, centered: boolean) {
  return (
    <div
      style={{
        margin: centered ? "7px 0 2px" : "5px 0 3px 20px",
        padding: "7px 11px",
        fontSize: 12,
        lineHeight: 1.55,
        color: "var(--fg-subtle)",
        background: "color-mix(in srgb, var(--bg-elevated) 60%, var(--bg))",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
      }}
    >
      {renderMarkdown(summary)}
    </div>
  );
}

// Context-compaction. Two layouts, picked by `source`:
//   "agent"  → a slim, left-aligned mono row in the tool-call idiom, so an
//              inline/automatic compaction nests in the run's tool flow.
//   "manual" → a full-width divider row (hairline · label · hairline), reading
//              as a deliberate conversation boundary the user asked for.
// Three states either way: running (loader), error (danger), done (expandable).
export function CompactionRow({
  count,
  summary,
  status = "done",
  error,
  source = "agent",
  messages,
  toolCalls,
}: {
  count?: number;
  summary?: string;
  status?: "running" | "done";
  error?: string | null;
  source?: "manual" | "agent";
  messages?: number;
  toolCalls?: number;
}) {
  const label =
    error != null
      ? "Compaction failed"
      : status === "running"
        ? "Compacting"
        : "Compacted";
  // Done marker reports the folded slice as "N messages + M tool calls"; older
  // markers without the breakdown fall back to the plain turn count.
  const doneDetail =
    messages != null || toolCalls != null
      ? `${messages ?? 0} message${messages === 1 ? "" : "s"} + ${toolCalls ?? 0} tool call${toolCalls === 1 ? "" : "s"}`
      : `${count ?? 0} earlier turn${count === 1 ? "" : "s"}`;
  const detail =
    error != null
      ? error
      : status === "running"
        ? "older turns…"
        : doneDetail;
  const tone = error != null ? "var(--danger)" : "var(--fg-subtle)";
  const leading =
    error != null ? (
      <CompactionGlyph />
    ) : status === "running" ? (
      <DotGridLoader size={11} label="Compacting" />
    ) : (
      <CompactionGlyph />
    );

  // ---- Manual: full-width divider row -------------------------------------
  if (source === "manual") {
    const head = (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexShrink: 0, color: tone }}>
        {leading}
        <span style={{ ...COMPACT_MONO, color: error != null ? "var(--danger)" : "var(--fg-strong)", fontWeight: 500 }}>{label}</span>
        <span style={{ ...COMPACT_MONO, color: tone }}>{detail}</span>
      </span>
    );
    if (status === "done" && summary) {
      return (
        <details style={{ margin: "12px 0" }}>
          <summary style={{ display: "flex", alignItems: "center", gap: 12, cursor: "pointer", listStyle: "none", userSelect: "none" }}>
            <Hairline />
            {head}
            <Hairline />
          </summary>
          {compactSummaryCard(summary, true)}
        </details>
      );
    }
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "12px 0" }}>
        <Hairline />
        {head}
        <Hairline />
      </div>
    );
  }

  // ---- Agent: slim left-aligned tool-style row ----------------------------
  if (status === "done" && summary) {
    return (
      <details style={{ margin: "5px 0" }}>
        <summary style={{ display: "flex", alignItems: "center", gap: 8, padding: 0, cursor: "pointer", listStyle: "none", userSelect: "none", minWidth: 0, color: "var(--fg-subtle)" }}>
          {leading}
          <span style={{ ...COMPACT_MONO, color: "var(--fg-strong)", fontWeight: 500, flexShrink: 0 }}>{label}</span>
          <span style={{ ...COMPACT_MONO, color: "var(--fg-subtle)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{detail}</span>
        </summary>
        {compactSummaryCard(summary, false)}
      </details>
    );
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "5px 0", color: tone }}>
      {leading}
      <span style={{ ...COMPACT_MONO, color: error != null ? "var(--danger)" : "var(--fg-strong)", fontWeight: 500, flexShrink: 0 }}>{label}</span>
      <span style={{ ...COMPACT_MONO, color: tone, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{detail}</span>
    </div>
  );
}

// The body of a delivered message lives in the coordination journal, not in
// the transcript, so the row reads it once it is on screen. One local read
// per row; the journal is small and already on disk.
function useEnvelopeBodies(workspaceRoot: string | null | undefined, ids: string[]): Map<string, CoordinationEnvelope> {
  const [bodies, setBodies] = useState<Map<string, CoordinationEnvelope>>(() => new Map());
  const key = ids.join("|");
  useEffect(() => {
    if (!workspaceRoot || !key) return;
    let cancelled = false;
    readCoordinationSnapshot(workspaceRoot)
      .then((snapshot) => {
        if (cancelled) return;
        const found = new Map<string, CoordinationEnvelope>();
        for (const entry of snapshot.envelopes) found.set(entry.envelope.id, entry.envelope);
        setBodies(found);
      })
      .catch(() => { /* Unreadable journal: the row still names who wrote and what kind. */ });
    return () => { cancelled = true; };
  }, [workspaceRoot, key]);
  return bodies;
}

/** Identical neighbours — same verb, same peer, same words — become one line
 *  with a count. Two "ping from A" in a row are two messages, and the count
 *  says so without the reader taking the repeat for a glitch. */
function foldIdentical<T>(items: T[], keyOf: (item: T) => string | null): { item: T; count: number }[] {
  const out: { item: T; count: number }[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    const key = keyOf(item);
    if (last && key !== null && keyOf(last.item) === key) last.count += 1;
    else out.push({ item, count: 1 });
  }
  return out;
}

// Messages another agent left for this conversation, delivered at a turn
// boundary. Drawn in the same line as the sender's call, from the other side:
// "Asked by @peer · body". The panel hoists this row into the top of the
// response it opened, so it shares that response's model mark.
export function AgentInboxRow({
  delivered,
  workspaceRoot,
}: {
  delivered: DeliveredEnvelopeRef[];
  workspaceRoot?: string | null;
}) {
  const titles = usePeerIndex();
  const bodies = useEnvelopeBodies(workspaceRoot, delivered.map((ref) => ref.envelopeId));
  const bodyOf = (ref: DeliveredEnvelopeRef) => bodies.get(ref.envelopeId)?.body.replace(/\s+/g, " ").trim() ?? "";
  return (
    <>
      {foldIdentical(delivered, (ref) => `${ref.kind}\n${ref.from}\n${bodyOf(ref)}`).map(({ item: ref, count }) => (
        <CoordinationLine
          key={ref.envelopeId}
          verb={inboundVerb(ref.kind)}
          peerId={ref.from}
          peer={peerName(ref.from, titles)}
          body={bodyOf(ref)}
          count={count}
        />
      ))}
    </>
  );
}

// What a peer's message does to this conversation, by kind — the receiving
// side of the sender's "Asked" / "Messaged".
function inboundVerb(kind: string): string {
  switch (kind) {
    case "question": return "Asked by";
    case "answer": return "Answered by";
    case "handoff": return "Handed off by";
    case "progress": return "Progress from";
    default: return "Instructed by";
  }
}

// Messages another agent has queued for this conversation that the Run has
// not taken in yet, once the user has let them through — the ones still to be
// reviewed sit on the approval card by the composer instead. They arrive at
// the next turn boundary; until then the panel would otherwise show nothing.
// Same slim idiom as the sender's call row: the verb, the peer by name, the
// sentence. The right end says what is left to happen.
export function PendingInboxRow({ pending }: { pending: CoordinationEnvelopeSnapshot[] }) {
  const titles = usePeerIndex();
  const fromOf = (e: CoordinationEnvelopeSnapshot) => (e.envelope.from.type === "run" ? e.envelope.from.runId : "operator");
  const bodyOf = (e: CoordinationEnvelopeSnapshot) => e.envelope.body.replace(/\s+/g, " ").trim();
  return (
    <>
      {foldIdentical(pending, (e) => `${e.envelope.kind}\n${fromOf(e)}\n${bodyOf(e)}\n${e.deliveryState}`).map(({ item: e, count }) => (
        <CoordinationLine
          key={e.envelope.id}
          verb={inboundVerb(e.envelope.kind)}
          peerId={fromOf(e)}
          peer={peerName(fromOf(e), titles)}
          body={bodyOf(e)}
          count={count}
          trailing={e.deliveryState === "delivered" ? "delivered" : "for its next turn"}
          margin="0"
        />
      ))}
    </>
  );
}

// Course-correction glyph for a steering marker: an arrow that bends away,
// echoing the "you were heading in circles — turn" idea.
function SteeringGlyph() {
  return (
    <span aria-hidden style={{ display: "grid", placeItems: "center", color: "currentColor", flexShrink: 0 }}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 11a5 5 0 0 1 5-5h5" />
        <path d="M10 3l3 3-3 3" />
      </svg>
    </span>
  );
}

// Loop-monitor steering marker: a slim, left-aligned row in the same idiom as an
// inline compaction, so it nests quietly in the run's flow. The `reason` is the
// short line the harness recorded ("Loop detected — `read_file` called 3× …").
export function SteeringRow({ reason }: { reason: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "5px 0", color: "var(--fg-subtle)" }}>
      <SteeringGlyph />
      <span style={{ ...COMPACT_MONO, color: "var(--fg-strong)", fontWeight: 500, flexShrink: 0 }}>Steered</span>
      <span style={{ ...COMPACT_MONO, color: "var(--fg-subtle)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{reason}</span>
    </div>
  );
}

// The run's terminal failure, in the same visual family as the "Starting
// {provider} local server…" line: a centered mono label between two hairlines.
// The message wraps below rather than ellipsizing — a timeout's advice ("try a
// smaller or pre-warmed model") is the useful half, and a truncated error is
// the one row that must never hide its tail.
export function RunFailedRow({ message }: { message: string }) {
  const hairline = (
    <span
      aria-hidden="true"
      style={{
        height: 1,
        flex: "1 1 44px",
        minWidth: 28,
        maxWidth: 72,
        background: "color-mix(in srgb, var(--border) 82%, transparent)",
      }}
    />
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5, width: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%", maxWidth: "min(520px, 100%)" }}>
        {hairline}
        <span style={{ ...COMPACT_MONO, color: "var(--danger)", fontWeight: 500, flexShrink: 0 }}>
          Run failed
        </span>
        {hairline}
      </div>
      <div style={{ ...COMPACT_MONO, color: "var(--fg-subtle)", textAlign: "center", maxWidth: "min(520px, 92%)", lineHeight: 1.5 }}>
        {message}
      </div>
    </div>
  );
}

/**
 * The line for a turn the app was closed on — the RunFailedRow family
 * (centered, hairlines), but nothing failed, so quiet ink rather than red, and
 * one plain verb to move on. `onRetry` is the panel's resend; a read-only
 * surface renders the line without it.
 */
export function RunInterruptedRow({ onRetry, disabled }: { onRetry?: () => void; disabled?: boolean }) {
  const hairline = (
    <span
      aria-hidden="true"
      style={{
        height: 1,
        flex: "1 1 44px",
        minWidth: 28,
        maxWidth: 72,
        background: "color-mix(in srgb, var(--border) 82%, transparent)",
      }}
    />
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5, width: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%", maxWidth: "min(520px, 100%)" }}>
        {hairline}
        <span style={{ ...COMPACT_MONO, color: "var(--fg-subtle)", fontWeight: 500, flexShrink: 0 }}>
          Interrupted
        </span>
        {hairline}
      </div>
      <div style={{ ...COMPACT_MONO, color: "var(--fg-subtle)", textAlign: "center", maxWidth: "min(520px, 92%)", lineHeight: 1.5 }}>
        Klide closed before this turn answered.
        {onRetry && (
          <>
            {" "}
            <button
              type="button"
              onClick={onRetry}
              disabled={disabled}
              style={{
                ...COMPACT_MONO,
                background: "none",
                border: 0,
                padding: 0,
                color: disabled ? "var(--fg-dim)" : "var(--fg)",
                cursor: disabled ? "default" : "pointer",
                textDecoration: "underline",
                textDecorationColor: "var(--border)",
                textUnderlineOffset: 3,
              }}
            >
              Retry
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * What stands in for the first token on a turn that will not stream: the
 * panel's loader, the status word with its shimmer, and a clock that counts
 * from `since` — the same three parts the Working row under a tool turn
 * wears, so "the model is busy" reads the same everywhere. On the Delegate
 * headless path no token comes until the whole reply does, and the clock is
 * what keeps a minute of that from reading as a stall.
 */
export function WorkingSince({ since }: { since?: number }) {
  // The user turn's own timestamp when it has one; otherwise the moment this
  // line appeared, held for as long as it stays mounted.
  const [mountedAt] = useState(() => Date.now());
  const from = since ?? mountedAt;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - from) / 1000));
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <span
      role="status"
      aria-label={`Working, ${clock} elapsed`}
      style={{ ...COMPACT_MONO, color: "var(--fg-dim)", letterSpacing: "0.02em", display: "inline-flex", alignItems: "center", height: 22, gap: 8 }}
    >
      <DotGridLoader size={11} label="Working" />
      <span className="ai-working-label">Working</span>
      <span aria-hidden="true" style={{ opacity: 0.6 }}>·</span>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{clock}</span>
    </span>
  );
}

type MessageBodyOptions = {
  /** Skip the ThinkingBlock — the caller renders it elsewhere (AiPanel
   *  hoists a folded tool run's reasoning above the "N tool calls" row). */
  hideThinking?: boolean;
  /** Lets a delivered-agent-message row fetch its bodies from the journal. */
  workspaceRoot?: string | null;
  /** This turn's tool results, by call key (`toolCallKey`) — each call row
   *  draws its own underneath. See `pairToolResults`. */
  results?: Map<string, AttachedResult>;
};

type MessageBodyProps = MessageBodyOptions & {
  m: Msg;
  active?: boolean;
};

function MessageBodyImpl({ m, active = false, hideThinking, workspaceRoot, results }: MessageBodyProps): ReactElement {
  if (m.role === "system" && m.steering) {
    const delivered = parseDeliveryReason(m.steering.reason);
    if (delivered) return <AgentInboxRow delivered={delivered} workspaceRoot={workspaceRoot} />;
    return <SteeringRow reason={m.steering.reason} />;
  }
  if (m.role === "system" && m.runError) {
    return <RunFailedRow message={m.runError.message} />;
  }
  if (m.role === "system" && m.runInterrupted) {
    return <RunInterruptedRow />;
  }
  if (m.role === "system" && m.compaction) {
    return <CompactionRow count={m.compaction.count} summary={m.compaction.summary} source={m.compaction.source} messages={m.compaction.messages} toolCalls={m.compaction.toolCalls} />;
  }

  if (m.role === "tool") {
    return (
      <ToolResultRow
        content={m.content}
        active={active}
        toolName={m.toolName}
        observedBy={m.observedBy}
      />
    );
  }

  if (m.role === "assistant") {
    if (m.delegateConsole) {
      return (
        <DelegateConsole
          provider={m.delegateProvider ?? "Delegate"}
          output={m.content}
          active={active}
        />
      );
    }
    // Strip two flavours of "the model is thinking out loud" leak:
    //   1. `<think>…</think>` blocks some models emit inline.
    //   2. A bare `{"analysis":…,"plan":…,"commands":[…]}` JSON that
    //      smaller local chat models (qwen, gemma, small ollama
    //      weights) fall back to. The commands are would-be tool
    //      calls that chat mode doesn't honour; surfacing them as
    //      thinking + leaving the visible text empty is the honest
    //      answer.
    // Background subagent report (dispatched via an embedded @role mention,
    // running concurrently with the main answer): a Codex-style @role header on
    // top, an accent-railed report below, and a quiet "working…" until it lands.
    if (m.subagent) {
      return (
        <div style={{ margin: "4px 0 8px" }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 500, letterSpacing: "0.01em", color: "var(--accent)", marginBottom: 4 }}>
            @{m.subagent}
            {m.subagentPending && <span style={{ color: "var(--fg-dim)", fontWeight: 400 }}> · working…</span>}
          </div>
          {m.content.trim() && (
            <div style={{ padding: "8px 11px", fontSize: 12.5, lineHeight: 1.55, color: "var(--fg-subtle)", background: "color-mix(in srgb, var(--bg-elevated) 60%, var(--bg))", border: "1px solid var(--border)", borderLeft: "2px solid var(--accent)", borderRadius: "var(--radius-sm)" }}>
              {renderMarkdown(m.content)}
            </div>
          )}
        </div>
      );
    }
    const { content: cleanedContent } = splitThinking(m.content);
    const { content } = stripPlanJson(cleanedContent);
    const visibleContent = stripToolNarration(content, !!m.toolCalls?.length);
    // Everything the model thought out loud, however it arrived — structured
    // block, inline <think> leak, or plan-JSON fallback (see extractThinking).
    const mergedThinking = extractThinking(m);
    // Streaming: no content yet → show thinking open. After arrival: closed.
    const streaming =
      active &&
      visibleContent === "" &&
      m.content === "" &&
      !!mergedThinking;
    return (
      <>
        {mergedThinking && !hideThinking && (
          <ThinkingBlock text={mergedThinking} streaming={streaming} startedAt={m.thinkingStartedAt} thinkingMs={m.thinkingMs} />
        )}
        {visibleContent && (
          <div style={{ marginBottom: m.toolCalls?.length ? 4 : 0, fontSize: 13, lineHeight: 1.58 }}>
            {renderMarkdown(visibleContent, { streaming: active })}
          </div>
        )}
        {(() => {
          // Identical agent messages sent back to back — "pong" to two pings —
          // are one line with a count; every other call keeps its row.
          const calls = m.toolCalls ?? [];
          const rows = foldIdentical(
            calls.map((tc, index) => ({ tc, key: toolCallKey(tc, index) })),
            ({ tc }) => (COORDINATION_TOOL_NAMES.has(tc.name) ? `${tc.name}\n${JSON.stringify(tc.args ?? null)}` : null),
          ).map(({ item: { tc, key }, count }) => (
            <ToolCallRow key={key} name={tc.name} args={tc.args} count={count} result={results?.get(key)} />
          ));
          if (!visibleContent || calls.length < MIN_STACKED_CALLS) return rows;
          const names: string[] = [];
          for (const tc of calls) if (!names.includes(tc.name)) names.push(tc.name);
          const label = toolRunLabel({ start: 0, end: 0, calls: calls.length, names });
          const working = active || [...(results?.values() ?? [])].some((r) => r.active);
          return (
            <InlineToolRun count={label.count} names={label.names} working={working}>
              {rows}
            </InlineToolRun>
          );
        })()}
        {m.meta && !active && visibleContent !== "" && !m.toolCalls?.length && (
          <MessageMeta meta={m.meta} />
        )}
      </>
    );
  }

  // The plain-body fallback. A user message never arrives here — `AiPanel`
  // renders those itself, with its own attachment strips (photo thumbnails, a
  // document line, and a name for a photo the snapshot cache dropped) — so
  // this branch stays about content and nothing else.
  return (
    <div>
      {m.content && <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>}
    </div>
  );
}

/**
 * The memo boundary under every transcript row.
 *
 * The Conversation fold and `transcriptReducer` already keep an untouched
 * `Msg` at the same object identity from one flush to the next; the panel
 * re-renders ~28 times a second while a Run streams (`streamPacer`). Without a
 * boundary here every row re-ran `renderMarkdown`, `splitThinking` and
 * `stripPlanJson` on each tick, so streaming cost grew with the length of the
 * whole Conversation instead of with the delta. `memo` compares the props
 * shallowly: a settled row's `m` is the same object, `active` is false, and
 * the rest are strings or the caller's `Map` — so it returns the element it
 * already made. Only the live tail row, whose `m` changes, renders.
 */
export const MessageBody = memo(MessageBodyImpl);

/** The call-site shape the panel has always used; it now lands on the memo
 *  boundary above rather than running the body inline in the parent. */
export function renderMessageBody(m: Msg, active = false, opts?: MessageBodyOptions): ReactElement {
  return (
    <MessageBody
      m={m}
      active={active}
      hideThinking={opts?.hideThinking}
      workspaceRoot={opts?.workspaceRoot}
      results={opts?.results}
    />
  );
}
