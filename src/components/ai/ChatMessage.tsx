import type { ReactElement } from "react";
import type { Msg } from "./types";
import { DelegateConsole } from "./DelegateTerminal";
import { DotGridLoader, ToolIcon } from "./icons";
import { renderMarkdown, splitThinking, stripPlanJson } from "../markdown";

// Premium thinking block. Renders as a soft card with a pulsing dot while the
// agent is still streaming, a rotating chevron, and a markdown body so code
// blocks inside the reasoning render properly. Open by default while the
// message is still streaming (no content yet), collapsed once the answer
// arrives — matches Claude Code's "thought process" disclosure.
function normalizeThinking(text: string): string {
  return text.replace(/\n+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function ThinkingBlock({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <details
      open={streaming}
      style={{
        margin: "0 0 8px",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        background: "color-mix(in srgb, var(--bg-elevated) 50%, var(--bg))",
        overflow: "hidden",
      }}
    >
      <summary
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "6px 10px",
          cursor: "pointer",
          listStyle: "none",
          userSelect: "none",
          color: "var(--fg-subtle)",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: streaming ? "var(--accent)" : "var(--fg-dim)",
            boxShadow: streaming
              ? "0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent)"
              : "none",
            animation: streaming
              ? "klide-pulse 1.6s ease-in-out infinite"
              : "none",
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            fontFamily: "var(--font-mono)",
          }}
        >
          {streaming ? "Thinking…" : "Thought process"}
        </span>
        <span
          aria-hidden
          style={{
            marginLeft: "auto",
            width: 8,
            height: 8,
            display: "grid",
            placeItems: "center",
            color: "var(--fg-dim)",
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
          padding: "6px 12px 10px",
          fontSize: 12,
          lineHeight: 1.6,
          color: "var(--fg-subtle)",
          borderTop: "1px solid var(--border)",
          background: "color-mix(in srgb, var(--bg) 70%, transparent)",
        }}
      >
        {renderMarkdown(normalizeThinking(text))}
      </div>
    </details>
  );
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

// Minimalist tool-call line, à la Claude Code's `⏺ Read(file)`: one slim
// mono row — tool glyph, tool name, primary arg — expandable to the full
// args JSON.
function ToolCallRow({ name, args }: { name: string; args: unknown }) {
  const argsText = formatJson(args);
  const summary = summarizeArgs(args);
  return (
    <details style={{ margin: "3px 0 0" }}>
      <summary
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "2px 0",
          cursor: "pointer",
          listStyle: "none",
          userSelect: "none",
          minWidth: 0,
        }}
      >
        <span aria-hidden style={{ display: "grid", placeItems: "center", color: "var(--fg-subtle)", flexShrink: 0 }}>
          <ToolIcon name={name} />
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11.5,
            color: "var(--fg-strong)",
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
              color: "var(--fg-subtle)",
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
            margin: "3px 0 3px 20px",
            padding: "6px 10px",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: "var(--fg-subtle)",
            background: "color-mix(in srgb, var(--bg-elevated) 60%, var(--bg))",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            overflowX: "auto",
            whiteSpace: "pre",
            lineHeight: 1.5,
          }}
        >
          {argsText}
        </pre>
      )}
    </details>
  );
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
function ToolResultRow({ content, active }: { content: string; active: boolean }) {
  const pending = active && /^Running /.test(content);
  const isError = /^(Tool error from|Error:)/.test(content);
  const { line, extra } = summarizeResult(content);
  return (
    <details style={{ margin: "0 0 3px", paddingLeft: 20 }}>
      <summary
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "1px 0",
          cursor: pending ? "default" : "pointer",
          listStyle: "none",
          userSelect: "none",
          minWidth: 0,
        }}
      >
        {pending ? (
          <DotGridLoader size={13} />
        ) : (
          <span
            aria-hidden
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: isError ? "var(--danger)" : "var(--fg-dim)",
              flexShrink: 0,
            }}
          >
            ⎿
          </span>
        )}
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
          {pending ? "Running…" : line}
        </span>
        {!pending && extra && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--fg-dim)",
              flexShrink: 0,
            }}
          >
            · {extra}
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
            borderRadius: "var(--radius-sm)",
          }}
        >
          {renderMarkdown(content)}
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
// Order: tok/s · tokens · time · TTFT.
function MessageMeta({ meta }: { meta: { ms?: number; tokens?: number; promptTokens?: number; ttftMs?: number; tps?: number; exact?: boolean; costUsd?: number } }) {
  const parts: string[] = [];
  if (meta.tps) parts.push(`${meta.tps} tok/s`);
  if (meta.tokens) parts.push(`${meta.exact ? "" : "~"}${meta.tokens.toLocaleString()} tokens`);
  if (meta.ms !== undefined) parts.push(formatDuration(meta.ms));
  if (meta.ttftMs !== undefined) parts.push(`TTFT ${formatDuration(meta.ttftMs)}`);
  // Cost last, so the eye lands on it. Sub-cent turns show "<$0.01".
  if (meta.costUsd !== undefined && meta.costUsd > 0) {
    parts.push(meta.costUsd < 0.01 ? "<$0.01" : `$${meta.costUsd.toFixed(meta.costUsd < 1 ? 3 : 2)}`);
  }
  if (parts.length === 0) return null;
  return (
    <div
      className="klide-msg-meta"
      style={{
        marginTop: 6,
        display: "flex",
        justifyContent: "center",
        gap: 10,
        fontSize: 10,
        fontFamily: "var(--font-mono)",
        color: "var(--fg-dim)",
        letterSpacing: "0.02em",
        userSelect: "none",
      }}
    >
      {parts.map((p, i) => (
        <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
          {i > 0 && <span aria-hidden style={{ opacity: 0.5 }}>·</span>}
          {p}
        </span>
      ))}
    </div>
  );
}

export function renderMessageBody(m: Msg, active = false): ReactElement {
  if (m.role === "tool") {
    return <ToolResultRow content={m.content} active={active} />;
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
    const { thinking: inlineThinking, content: cleanedContent } =
      splitThinking(m.content);
    const { thinking: planThinking, content: visibleContent } =
      stripPlanJson(cleanedContent);
    // Preserve any structured thinking block the adapter already
    // captured (Anthropic / Ollama) and append what we lifted from
    // the text, so nothing is lost.
    const mergedThinking = [m.thinking, inlineThinking, planThinking]
      .filter(Boolean)
      .join("\n\n");
    // Streaming: no content yet → show thinking open. After arrival: closed.
    const streaming =
      active &&
      visibleContent === "" &&
      m.content === "" &&
      !!mergedThinking;
    return (
      <>
        {mergedThinking && (
          <ThinkingBlock text={mergedThinking} streaming={streaming} />
        )}
        {visibleContent && (
          <div style={{ marginBottom: m.toolCalls?.length ? 6 : 0, fontSize: 13, lineHeight: 1.65 }}>
            {renderMarkdown(visibleContent)}
          </div>
        )}
        {m.toolCalls?.map((tc, i) => (
          <ToolCallRow key={i} name={tc.name} args={tc.args} />
        ))}
        {m.meta && !active && visibleContent !== "" && <MessageMeta meta={m.meta} />}
      </>
    );
  }

  return <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>;
}
