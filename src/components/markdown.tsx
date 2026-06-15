import { useState, type CSSProperties, type ReactElement, type ReactNode } from "react";

type MdNode = string | ReactElement;

export type MarkdownOptions = {
  // Hook for the Mission Control wire-format tool markers
  // (`[tool: <name> <summary>]` on its own line). The renderer owns
  // the marker parsing; the caller decides how to render a tool
  // card. The AI panel never sees these markers and never passes
  // this hook.
  renderTool?: (name: string, summary?: string) => ReactNode;
};

const CODE_KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while",
  "do", "switch", "case", "break", "continue", "new", "class", "extends",
  "super", "import", "export", "from", "default", "async", "await", "yield",
  "try", "catch", "finally", "throw", "typeof", "instanceof", "in", "of",
  "this", "void", "delete", "static", "public", "private", "protected",
  "readonly", "interface", "type", "enum", "implements", "namespace", "as",
  "keyof", "get", "set", "fn", "mut", "impl", "trait", "struct", "pub", "use",
  "mod", "match", "loop", "move", "ref", "where", "dyn", "crate", "self",
  "unsafe", "def", "lambda", "elif", "with", "pass", "global", "nonlocal",
  "raise", "except", "and", "or", "not", "true", "false", "null", "undefined",
  "None", "True", "False",
]);

const CODE_TOKEN_RE =
  /(\/\/[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][A-Za-z0-9_$]*)/g;

function highlightCode(code: string): MdNode[] {
  const out: MdNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  CODE_TOKEN_RE.lastIndex = 0;
  while ((m = CODE_TOKEN_RE.exec(code))) {
    if (m.index > last) out.push(code.slice(last, m.index));
    const [full, comment, str, num, word] = m;
    if (comment) {
      out.push(<span key={key++} style={{ color: "var(--code-comment)", fontStyle: "italic" }}>{full}</span>);
    } else if (str) {
      out.push(<span key={key++} style={{ color: "var(--code-string)" }}>{full}</span>);
    } else if (num) {
      out.push(<span key={key++} style={{ color: "var(--code-number)" }}>{full}</span>);
    } else if (word && CODE_KEYWORDS.has(word)) {
      out.push(<span key={key++} style={{ color: "var(--code-keyword)", fontWeight: 500 }}>{full}</span>);
    } else {
      out.push(full);
    }
    last = m.index + full.length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

// Premium code block: language chip in the header, a Copy button on the
// right, a subtle bg-elevated tint, monospace body with our token highlighter.
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  }
  return (
    <div
      style={{
        margin: "8px 0",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        overflow: "hidden",
        background: "color-mix(in srgb, var(--bg-elevated) 60%, var(--bg))",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "4px 6px 4px 10px",
          borderBottom: "1px solid var(--border)",
          background: "color-mix(in srgb, var(--bg-elevated) 90%, var(--bg))",
        }}
      >
        <span
          style={{
            fontSize: 9,
            fontWeight: 600,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "var(--fg-dim)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {lang || "code"}
        </span>
        <button
          onClick={copy}
          title="Copy code"
          style={{
            fontSize: 9,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            fontFamily: "var(--font-mono)",
            color: copied ? "var(--accent)" : "var(--fg-dim)",
            padding: "2px 7px",
            borderRadius: "var(--radius-xs)",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            transition: "color var(--motion-fast) var(--ease-out)",
          }}
          onMouseEnter={(e) => {
            if (!copied) e.currentTarget.style.color = "var(--fg-strong)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = copied ? "var(--accent)" : "var(--fg-dim)";
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre
        style={{
          margin: 0,
          padding: "10px 12px",
          overflowX: "auto",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          lineHeight: 1.55,
          color: "var(--fg)",
          whiteSpace: "pre",
          tabSize: 2,
        }}
      >
        <code style={{ fontFamily: "inherit" }}>{highlightCode(code)}</code>
      </pre>
    </div>
  );
}

// One inline node at a time. Match the earliest of all supported patterns;
// anything else flows through as plain text (HTML-safe by construction).
const INLINE_RE =
  /\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|`([^`]+)`|\*(.+?)\*|~~([^~]+)~~|\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]+)")?\)/g;

function renderInline(text: string, keyBase: string): MdNode[] {
  const out: MdNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out.push(
        <strong key={`${keyBase}-${key++}`} style={{ fontWeight: 700, color: "var(--fg-strong)" }}>
          <em style={{ fontStyle: "italic", fontWeight: 600 }}>{m[1]}</em>
        </strong>
      );
    } else if (m[2] !== undefined) {
      out.push(
        <strong key={`${keyBase}-${key++}`} style={{ fontWeight: 600, color: "var(--fg-strong)" }}>
          {m[2]}
        </strong>
      );
    } else if (m[3] !== undefined) {
      out.push(
        <code
          key={`${keyBase}-${key++}`}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.9em",
            background: "color-mix(in srgb, var(--bg-elevated) 80%, var(--bg))",
            border: "1px solid var(--border)",
            borderRadius: 4,
            padding: "1px 5px",
            color: "var(--fg)",
          }}
        >
          {m[3]}
        </code>
      );
    } else if (m[4] !== undefined) {
      out.push(
        <em key={`${keyBase}-${key++}`} style={{ fontStyle: "italic", color: "var(--fg)" }}>
          {m[4]}
        </em>
      );
    } else if (m[5] !== undefined) {
      out.push(
        <span
          key={`${keyBase}-${key++}`}
          style={{ textDecoration: "line-through", color: "var(--fg-subtle)" }}
        >
          {m[5]}
        </span>
      );
    } else if (m[6] !== undefined) {
      out.push(
        <a
          key={`${keyBase}-${key++}`}
          href={m[7]}
          target="_blank"
          rel="noreferrer"
          title={m[8] ?? m[7]}
          style={{
            color: "var(--accent)",
            textDecoration: "underline",
            textDecorationColor: "color-mix(in srgb, var(--accent) 35%, transparent)",
            textUnderlineOffset: 2,
          }}
        >
          {m[6]}
        </a>
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Block-level renderer: handles headers, ordered/unordered/task lists,
// blockquotes, horizontal rules, and paragraph breaks. Operates on a string
// that's already had fenced code blocks extracted (so we don't run formatting
// on code contents).
function renderProse(text: string, keyBase: string, options?: MarkdownOptions): MdNode[] {
  const lines = text.split("\n");
  const blocks: MdNode[] = [];
  let para: string[] = [];
  type ListState = { kind: "ul" | "ol" | "tasks"; items: string[] };
  let list: ListState | null = null;
  let k = 0;

  const flushPara = () => {
    if (para.length === 0) return;
    const content: MdNode[] = [];
    para.forEach((ln, i) => {
      if (i > 0) content.push(<br key={`br-${keyBase}-${k}-${i}`} />);
      content.push(...renderInline(ln, `${keyBase}-p${k}-${i}`));
    });
    blocks.push(
      <div
        key={`${keyBase}-para-${k++}`}
        style={{ margin: "2px 0", color: "var(--fg)", lineHeight: 1.6 }}
      >
        {content}
      </div>
    );
    para = [];
  };

  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it, i) => {
      if (list!.kind === "tasks") {
        const done = it.startsWith("[x] ");
        const text = it.replace(/^\[[ x]\]\s+/, "");
        return (
          <li
            key={`${keyBase}-li-${k}-${i}`}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 7,
              padding: "2px 0",
              fontSize: 12.5,
              lineHeight: 1.55,
              color: done ? "var(--fg-subtle)" : "var(--fg)",
              textDecoration: done ? "line-through" : "none",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 12,
                height: 12,
                flexShrink: 0,
                marginTop: 2,
                borderRadius: 3,
                border: done
                  ? "1px solid var(--accent)"
                  : "1px solid var(--border)",
                background: done ? "var(--accent)" : "transparent",
                display: "grid",
                placeItems: "center",
                color: "var(--bg)",
                fontSize: 9,
                fontWeight: 700,
                lineHeight: 1,
              }}
            >
              {done ? "✓" : ""}
            </span>
            <span style={{ flex: 1 }}>{renderInline(text, `${keyBase}-li${k}-${i}`)}</span>
          </li>
        );
      }
      return (
        <li
          key={`${keyBase}-li-${k}-${i}`}
          style={{ margin: "1px 0" }}
        >
          {renderInline(it, `${keyBase}-li${k}-${i}`)}
        </li>
      );
    });
    if (list.kind === "ul") {
      blocks.push(
        <ul
          key={`${keyBase}-ul-${k++}`}
          style={{ margin: "4px 0", paddingLeft: 0, listStyle: "none" }}
        >
          {items}
        </ul>
      );
    } else if (list.kind === "ol") {
      blocks.push(
        <ol
          key={`${keyBase}-ol-${k++}`}
          style={{ margin: "4px 0", paddingLeft: 22 }}
        >
          {items}
        </ol>
      );
    } else {
      blocks.push(
        <ul
          key={`${keyBase}-tasks-${k++}`}
          style={{ margin: "4px 0", paddingLeft: 0, listStyle: "none" }}
        >
          {items}
        </ul>
      );
    }
    list = null;
  };

  // GFM table: a run of `| … |` lines whose second line is the `---`
  // separator row. Anything that doesn't validate flows back into the
  // paragraph buffer untouched.
  let tableBuf: string[] | null = null;
  const splitRow = (line: string): string[] =>
    line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const flushTable = () => {
    if (!tableBuf) return;
    const buf = tableBuf;
    tableBuf = null;
    const sepRe = /^:?-{2,}:?$/;
    const isSep = buf.length >= 2 && splitRow(buf[1]).every((c) => sepRe.test(c));
    if (!isSep) {
      para.push(...buf);
      return;
    }
    const header = splitRow(buf[0]);
    const aligns = splitRow(buf[1]).map((c) =>
      c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left"
    ) as Array<"left" | "center" | "right">;
    const rows = buf.slice(2).map(splitRow);
    const cellStyle = (col: number): CSSProperties => ({
      padding: "5px 12px",
      fontSize: 12,
      lineHeight: 1.5,
      textAlign: aligns[col] ?? "left",
      verticalAlign: "top",
    });
    blocks.push(
      <div
        key={`${keyBase}-table-${k++}`}
        style={{
          margin: "8px 0",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-md)",
          overflowX: "auto",
        }}
      >
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "max-content" }}>
          <thead>
            <tr style={{ background: "color-mix(in srgb, var(--bg-elevated) 80%, var(--bg))" }}>
              {header.map((cell, ci) => (
                <th
                  key={ci}
                  style={{
                    ...cellStyle(ci),
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: "0.07em",
                    textTransform: "uppercase",
                    color: "var(--fg-subtle)",
                    fontFamily: "var(--font-mono)",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  {renderInline(cell, `${keyBase}-th${k}-${ci}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                {header.map((_, ci) => (
                  <td
                    key={ci}
                    style={{
                      ...cellStyle(ci),
                      color: "var(--fg)",
                      borderTop: ri > 0 ? "1px solid var(--border)" : "none",
                    }}
                  >
                    {renderInline(row[ci] ?? "", `${keyBase}-td${k}-${ri}-${ci}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  let inBlockquote = false;
  let bqBuf: string[] = [];
  const flushBlockquote = () => {
    if (bqBuf.length === 0) return;
    blocks.push(
      <blockquote
        key={`${keyBase}-bq-${k++}`}
        style={{
          margin: "6px 0",
          padding: "4px 12px",
          borderLeft: "2px solid var(--border-strong, var(--border))",
          color: "var(--fg-subtle)",
          fontStyle: "italic",
        }}
      >
        {renderProse(bqBuf.join("\n"), `${keyBase}-bq-${k}`, options)}
      </blockquote>
    );
    bqBuf = [];
  };

  for (const line of lines) {
    // Table lines (`| a | b |`). Collect the run; flushTable validates the
    // separator row and falls back to plain text when it isn't a table.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (!tableBuf) {
        flushPara();
        flushList();
        tableBuf = [];
      }
      tableBuf.push(line);
      continue;
    } else if (tableBuf) {
      flushTable();
    }
    // Wire-format tool marker (`[tool: <name> <summary>]` on its own line).
    // Emitted by the opencode / codex delegate run flat­teners. Only honored
    // when the caller passes `renderTool`; otherwise the line falls through
    // to plain text so the AI panel's path is unaffected.
    if (options?.renderTool) {
      const toolMatch = /^\[tool:\s*([^\]]+)\]\s*$/.exec(line);
      if (toolMatch) {
        flushPara();
        flushList();
        flushBlockquote();
        const marker = toolMatch[1].trim();
        const m = marker.match(/^([^\s(:]+)(?:\s+(.+))?$/);
        const toolName = m?.[1] ?? (marker || "tool");
        const toolSummary = m?.[2]?.trim();
        blocks.push(
          <div key={`${keyBase}-tool-${k++}`} style={{ margin: "2px 0" }}>
            {options.renderTool(toolName, toolSummary)}
          </div>
        );
        continue;
      }
    }
    // Blockquote lines (`> text`).
    if (/^>\s?/.test(line)) {
      flushPara();
      flushList();
      bqBuf.push(line.replace(/^>\s?/, ""));
      inBlockquote = true;
      continue;
    } else if (inBlockquote) {
      flushBlockquote();
      inBlockquote = false;
    }
    // Horizontal rule (`---` on its own line).
    if (/^-{3,}\s*$|^\*{3,}\s*$/.test(line.trim())) {
      flushPara();
      flushList();
      blocks.push(
        <hr
          key={`${keyBase}-hr-${k++}`}
          style={{
            border: "none",
            borderTop: "1px solid var(--border)",
            margin: "10px 0",
          }}
        />
      );
      continue;
    }
    // Headings.
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      const level = heading[1].length;
      const size = level === 1 ? 16 : level === 2 ? 14 : 13;
      const weight = level === 1 ? 700 : 600;
      blocks.push(
        <div
          key={`${keyBase}-h-${k++}`}
          style={{
            fontWeight: weight,
            fontSize: size,
            color: "var(--fg-strong)",
            margin: `${level === 1 ? 12 : 8}px 0 2px`,
            lineHeight: 1.3,
          }}
        >
          {renderInline(heading[2], `${keyBase}-hh${k}`)}
        </div>
      );
      continue;
    }
    // Task list.
    if (/^[-*]\s+\[[ x]\]\s+/.test(line)) {
      flushPara();
      if (!list || list.kind !== "tasks") {
        flushList();
        list = { kind: "tasks", items: [] };
      }
      list.items.push(line.replace(/^[-*]\s+/, ""));
      continue;
    }
    // Unordered list.
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    if (ul) {
      flushPara();
      if (!list || list.kind !== "ul") {
        flushList();
        list = { kind: "ul", items: [] };
      }
      list.items.push(ul[1]);
      continue;
    }
    // Ordered list.
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ol) {
      flushPara();
      if (!list || list.kind !== "ol") {
        flushList();
        list = { kind: "ol", items: [] };
      }
      list.items.push(ol[1]);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushTable();
  flushPara();
  flushList();
  flushBlockquote();
  return blocks;
}

export function splitThinking(raw: string): { thinking: string; content: string } {
  const OPEN = "<think>";
  const CLOSE = "</think>";
  let thinking = "";
  let content = "";
  let rest = raw;
  while (true) {
    const open = rest.indexOf(OPEN);
    if (open === -1) { content += rest; break; }
    content += rest.slice(0, open);
    const after = rest.slice(open + OPEN.length);
    const close = after.indexOf(CLOSE);
    if (close === -1) { thinking += after; break; }
    thinking += after.slice(0, close);
    rest = after.slice(close + CLOSE.length);
  }
  return { thinking, content: content.replace(/^\s+/, "") };
}

type StrippedPlan = { thinking: string; content: string };

/**
 * Some local chat models (qwen, gemma, smaller ollama weights) emit a
 * structured "plan" JSON in their visible text — `{ analysis, plan,
 * commands }` — instead of the `<think>…</think>` format. The
 * `commands` field is a would-be tool call (read_file, get_git_status,
 * etc.) that chat mode doesn't honour, so the JSON is pure noise to
 * the reader. Lift the analysis + plan into the thinking channel and
 * leave the user-visible text empty; the UI's existing "I'm in chat
 * mode" reasoning block carries the answer.
 *
 * The detector is intentionally conservative:
 *   - the entire response must be a single JSON object (after a trim),
 *   - the object must carry at least one of the known plan keys.
 *
 * A "here's the answer, and here's a JSON plan after it" reply is left
 * alone — the JSON is part of the user's answer in that case, not
 * reasoning.
 */
export function stripPlanJson(raw: string): StrippedPlan {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return { thinking: "", content: raw };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { thinking: "", content: raw };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { thinking: "", content: raw };
  }
  const obj = parsed as Record<string, unknown>;
  const analysis = typeof obj.analysis === "string" ? obj.analysis : "";
  const plan = typeof obj.plan === "string" ? obj.plan : "";
  const commands = Array.isArray(obj.commands) ? obj.commands : [];
  const hasPlanShape =
    analysis.length > 0 || plan.length > 0 || commands.length > 0;
  if (!hasPlanShape) {
    return { thinking: "", content: raw };
  }
  // Render the analysis + plan + command list in the thinking channel.
  // Commands are summarised as a short list so the user can see what
  // the model *wanted* to do — useful when they're trying to figure
  // out why the model went silent in chat mode.
  const parts: string[] = [];
  if (analysis) parts.push(analysis);
  if (plan) parts.push(plan);
  if (commands.length > 0) {
    const cmds = commands
      .slice(0, 8)
      .map((c) => {
        if (!c || typeof c !== "object") return "- (invalid command)";
        const o = c as Record<string, unknown>;
        const name = typeof o.tool_name === "string" ? o.tool_name : "tool";
        const args = o.arguments;
        const argText =
          args && typeof args === "object"
            ? " " +
              Object.entries(args as Record<string, unknown>)
                .slice(0, 3)
                .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                .join(" ")
            : "";
        return `- ${name}${argText}`;
      })
      .join("\n");
    parts.push(`Would have called:\n${cmds}`);
  }
  return { thinking: parts.join("\n\n"), content: "" };
}

export function renderMarkdown(text: string, options?: MarkdownOptions): MdNode[] {
  // Split on ``` so every odd-indexed segment is a code block and every
  // even-indexed segment is prose. Render code blocks first so their
  // contents (which can contain their own ```) are not interpreted again.
  const segments = text.split("```");
  const out: MdNode[] = [];
  segments.forEach((seg, idx) => {
    if (idx % 2 === 1) {
      const nl = seg.indexOf("\n");
      let lang = "";
      let code = seg;
      if (nl >= 0) {
        const first = seg.slice(0, nl).trim();
        if (/^[\w+#-]*$/.test(first)) { lang = first; code = seg.slice(nl + 1); }
      }
      code = code.replace(/\n$/, "");
      out.push(<CodeBlock key={`code-${idx}`} code={code} lang={lang} />);
    } else if (seg) {
      out.push(...renderProse(seg, `seg-${idx}`, options));
    }
  });
  return out;
}
