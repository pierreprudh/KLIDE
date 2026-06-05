import type { ReactElement } from "react";
import type { Msg } from "./types";
import { DelegateConsole } from "./DelegateTerminal";
import { renderMarkdown } from "./markdown";

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

// Premium tool-call card. Tool name in a header row, args rendered as a
// compact JSON tree, and the optional result nested underneath. Matches
// the Claude-Code "tool execution" visual idiom.
function ToolCallCard({ name, args }: { name: string; args: unknown }) {
  const argsText = formatJson(args);
  return (
    <div
      style={{
        margin: "6px 0",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        background: "color-mix(in srgb, var(--bg-elevated) 60%, var(--bg))",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "5px 10px",
          borderBottom: argsText ? "1px solid var(--border)" : "none",
          background: "color-mix(in srgb, var(--bg-elevated) 80%, var(--bg))",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "var(--accent)",
            boxShadow: "0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent)",
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11.5,
            color: "var(--fg-strong)",
            fontWeight: 500,
          }}
        >
          {name}
        </span>
        <span style={{ color: "var(--fg-dim)", fontSize: 10 }}>·</span>
        <span
          style={{
            color: "var(--fg-dim)",
            fontSize: 10,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            fontFamily: "var(--font-mono)",
          }}
        >
          tool call
        </span>
      </div>
      {argsText && (
        <pre
          style={{
            margin: 0,
            padding: "8px 12px",
            fontSize: 11.5,
            fontFamily: "var(--font-mono)",
            color: "var(--fg)",
            background: "color-mix(in srgb, var(--bg) 60%, var(--bg-elevated))",
            overflowX: "auto",
            whiteSpace: "pre",
            lineHeight: 1.55,
          }}
        >
          {argsText}
        </pre>
      )}
    </div>
  );
}

// Tool result card. Collapsed by default when there's already a user-visible
// answer; expanded when this IS the assistant's content. Result content
// runs through the markdown renderer so code blocks / tables show
// properly.
function ToolResultCard({ name, content }: { name: string; content: string }) {
  return (
    <details
      style={{
        margin: "6px 0",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        background: "color-mix(in srgb, var(--bg-elevated) 40%, var(--bg))",
        overflow: "hidden",
      }}
    >
      <summary
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "5px 10px",
          cursor: "pointer",
          listStyle: "none",
          userSelect: "none",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "var(--fg-dim)",
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--fg-subtle)",
            fontFamily: "var(--font-mono)",
          }}
        >
          Result
        </span>
        <span
          style={{
            fontSize: 11,
            color: "var(--fg-subtle)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {name}
        </span>
      </summary>
      <div
        style={{
          padding: "8px 12px 10px",
          fontSize: 12,
          lineHeight: 1.55,
          color: "var(--fg-subtle)",
          borderTop: "1px solid var(--border)",
        }}
      >
        {renderMarkdown(content)}
      </div>
    </details>
  );
}

function formatJson(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function renderMessageBody(m: Msg, active = false): ReactElement {
  if (m.role === "tool") {
    return <ToolResultCard name={m.toolName} content={m.content} />;
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
    // Streaming: no content yet → show thinking open. After arrival: closed.
    const streaming = active && m.content === "" && !!m.thinking;
    return (
      <>
        {m.thinking && (
          <ThinkingBlock text={m.thinking} streaming={streaming} />
        )}
        {m.content && (
          <div style={{ marginBottom: m.toolCalls?.length ? 6 : 0, fontSize: 13, lineHeight: 1.65 }}>
            {renderMarkdown(m.content)}
          </div>
        )}
        {m.toolCalls?.map((tc, i) => (
          <ToolCallCard key={i} name={tc.name} args={tc.args} />
        ))}
      </>
    );
  }

  return <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>;
}
