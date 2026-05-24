import { useEffect, useRef, useState } from "react";
import {
  exists,
  readDir,
  readTextFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { DiffModal, PendingEdit } from "./DiffModal";

type ToolCall = { name: string; args: any };

type Msg =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "system"; content: string }
  | { role: "tool"; content: string; toolName: string };

type Props = {
  workspaceRoot: string | null;
  onFileWritten?: (path: string, newContent: string) => void;
  visible: boolean;
};

type PendingEditRequest = PendingEdit & {
  fullPath: string;
  resolve: (result: string) => void;
};

const MODEL = "llama3.1:8b";
const MAX_TOOL_CALLS = 10;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full text contents of a file in the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'Path relative to the workspace root, e.g. "src/App.tsx".',
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List the entries (files and folders) of a directory.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'Path relative to the workspace root. Use "." for the workspace root itself.',
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Propose a search-and-replace edit to an existing file. The user reviews the diff and approves or rejects it — this tool does NOT write directly.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: 'Path of the existing file, relative to the workspace root.',
          },
          old_str: {
            type: "string",
            description:
              "The exact text to find in the file. Must match a unique substring (whitespace included). Include enough surrounding context that no other occurrence exists.",
          },
          new_str: {
            type: "string",
            description:
              "The replacement text. Use an empty string to delete the matched text.",
          },
        },
        required: ["path", "old_str", "new_str"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_file",
      description:
        "Propose creating a brand-new file with the given contents. Fails if the file already exists. The user reviews the new contents and approves or rejects.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path of the new file, relative to the workspace root.",
          },
          contents: {
            type: "string",
            description: "Full text contents of the new file.",
          },
        },
        required: ["path", "contents"],
      },
    },
  },
];

function buildSystemPrompt(workspaceRoot: string | null): string {
  if (!workspaceRoot) {
    return `You are KIDE's coding assistant, embedded in a code editor. No workspace folder is currently open — ask the user to open one via the Files panel before exploring code.`;
  }
  return `You are KIDE's coding assistant, embedded in a code editor.

Workspace root: ${workspaceRoot}

Tool usage:
- read_file / list_dir: read-only. Use whenever you need to know contents or structure.
- write_file / create_file: edit tools. Every edit opens a diff modal for the user to APPLY or REJECT — you never write directly.

Paths are relative to the workspace root (e.g. "src/App.tsx" or ".").

How to read tool results:
- "Applied: ..." → the user approved the edit. Confirm briefly and stop, unless more changes are needed.
- "Rejected by user: ..." → the user declined. STOP. Do NOT retry the same edit. Ask the user what they want differently, or end your turn.
- "Error: ..." → the tool itself failed (e.g. file not found, ambiguous match). Read the error and fix the call.

Be concise. When you have enough information, answer the user directly.`;
}

async function executeTool(
  call: ToolCall,
  workspaceRoot: string | null,
  requestEdit: (req: Omit<PendingEditRequest, "resolve">) => Promise<string>
): Promise<string> {
  if (!workspaceRoot) {
    return "Error: no workspace folder is open. Ask the user to open one via the Files panel.";
  }
  const resolvePath = (p: string): string => {
    const full = p.startsWith("/") ? p : `${workspaceRoot}/${p}`;
    if (!full.startsWith(workspaceRoot)) {
      throw new Error(`Path "${p}" is outside the workspace`);
    }
    return full;
  };

  try {
    if (call.name === "read_file") {
      const content = await readTextFile(resolvePath(call.args.path));
      return `Contents of ${call.args.path} (${content.length} chars):\n\`\`\`\n${content}\n\`\`\``;
    }
    if (call.name === "list_dir") {
      const p = call.args.path ?? ".";
      const entries = await readDir(resolvePath(p));
      const formatted = entries
        .slice()
        .sort(
          (a, b) =>
            Number(b.isDirectory) - Number(a.isDirectory) ||
            a.name.localeCompare(b.name)
        )
        .map((e) => `${e.isDirectory ? "[dir] " : "      "}${e.name}`)
        .join("\n");
      return `Entries in ${p}:\n${formatted}`;
    }
    if (call.name === "write_file") {
      const { path, old_str, new_str } = call.args;
      if (typeof path !== "string" || typeof old_str !== "string" || typeof new_str !== "string") {
        return "Error: write_file requires string fields { path, old_str, new_str }.";
      }
      const full = resolvePath(path);
      const current = await readTextFile(full);
      const occurrences = current.split(old_str).length - 1;
      if (occurrences === 0) {
        return `Error: old_str not found in ${path}. Read the file again and use an exact substring (whitespace matters).`;
      }
      if (occurrences > 1) {
        return `Error: old_str matches ${occurrences} locations in ${path}. Include more surrounding context so it matches exactly once.`;
      }
      const newContent = current.replace(old_str, new_str);
      return await requestEdit({
        path,
        fullPath: full,
        oldContent: current,
        newContent,
        isCreate: false,
      });
    }
    if (call.name === "create_file") {
      const { path, contents } = call.args;
      if (typeof path !== "string" || typeof contents !== "string") {
        return "Error: create_file requires string fields { path, contents }.";
      }
      const full = resolvePath(path);
      if (await exists(full)) {
        return `Error: ${path} already exists. Use write_file to modify an existing file.`;
      }
      return await requestEdit({
        path,
        fullPath: full,
        oldContent: "",
        newContent: contents,
        isCreate: true,
      });
    }
    return `Error: unknown tool "${call.name}"`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Error: ${msg}`;
  }
}

function toOllamaMessage(m: Msg): any {
  if (m.role === "assistant") {
    const out: any = { role: "assistant", content: m.content };
    if (m.toolCalls && m.toolCalls.length > 0) {
      out.tool_calls = m.toolCalls.map((tc) => ({
        function: { name: tc.name, arguments: tc.args },
      }));
    }
    return out;
  }
  if (m.role === "tool") {
    return { role: "tool", content: m.content, name: m.toolName };
  }
  return { role: m.role, content: m.content };
}

function parseToolCallsFromChunk(raw: any): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((tc) => {
      const fn = tc.function ?? tc;
      const name = fn?.name;
      let args = fn?.arguments;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = { _raw: args };
        }
      }
      return name ? { name, args: args ?? {} } : null;
    })
    .filter((x): x is ToolCall => x !== null);
}

export function AiPanel({ workspaceRoot, onFileWritten, visible }: Props) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [pending, setPending] = useState<PendingEditRequest | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  function requestEdit(
    req: Omit<PendingEditRequest, "resolve">
  ): Promise<string> {
    return new Promise((resolve) => {
      setPending({ ...req, resolve });
    });
  }

  async function applyPending() {
    if (!pending) return;
    const p = pending;
    setPending(null);
    try {
      await writeTextFile(p.fullPath, p.newContent);
      onFileWritten?.(p.path, p.newContent);
      p.resolve(
        p.isCreate
          ? `Applied: created ${p.path} (${p.newContent.length} chars).`
          : `Applied: edited ${p.path}.`
      );
    } catch (e) {
      p.resolve(`Error writing ${p.path}: ${(e as Error).message}`);
    }
  }

  function rejectPending() {
    if (!pending) return;
    const p = pending;
    setPending(null);
    p.resolve(
      p.isCreate
        ? `Rejected by user: ${p.path} was not created.`
        : `Rejected by user: ${p.path} was not changed.`
    );
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [msgs]);

  async function streamOnce(
    history: Msg[]
  ): Promise<{ text: string; toolCalls: ToolCall[] }> {
    const sys: Msg = { role: "system", content: buildSystemPrompt(workspaceRoot) };

    const res = await fetch("http://localhost:11434/api/chat", {
      method: "POST",
      body: JSON.stringify({
        model: MODEL,
        messages: [sys, ...history].map(toOllamaMessage),
        tools: TOOLS,
        stream: true,
      }),
    });
    if (!res.ok || !res.body) throw new Error(`Ollama returned ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let text = "";
    const toolCalls: ToolCall[] = [];

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const j = JSON.parse(line);
        text += j.message?.content ?? "";
        const newCalls = parseToolCallsFromChunk(j.message?.tool_calls);
        if (newCalls.length) toolCalls.push(...newCalls);
        setMsgs((cur) => {
          const next = [...cur];
          next[next.length - 1] = {
            role: "assistant",
            content: text,
            toolCalls: toolCalls.length ? [...toolCalls] : undefined,
          };
          return next;
        });
      } catch {
        /* partial line */
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    }
    if (buf.trim()) handleLine(buf);
    return { text, toolCalls };
  }

  async function send() {
    if (!input.trim() || streaming) return;

    let history: Msg[] = [
      ...msgs,
      { role: "user", content: input },
      { role: "assistant", content: "" },
    ];
    setMsgs(history);
    setInput("");
    setStreaming(true);

    try {
      for (let iter = 0; iter < MAX_TOOL_CALLS; iter++) {
        const { text, toolCalls } = await streamOnce(history.slice(0, -1));
        history = [
          ...history.slice(0, -1),
          {
            role: "assistant",
            content: text,
            toolCalls: toolCalls.length ? toolCalls : undefined,
          },
        ];

        if (toolCalls.length === 0) break;

        const toolMsgs: Msg[] = [];
        for (const call of toolCalls) {
          const result = await executeTool(call, workspaceRoot, requestEdit);
          toolMsgs.push({ role: "tool", content: result, toolName: call.name });
        }

        history = [
          ...history,
          ...toolMsgs,
          { role: "assistant", content: "" },
        ];
        setMsgs(history);
      }
    } catch (e) {
      setMsgs((cur) => {
        const next = [...cur];
        next[next.length - 1] = {
          role: "assistant",
          content: `⚠ ${(e as Error).message}. Is Ollama running?`,
        };
        return next;
      });
    }
    setStreaming(false);
  }

  function renderMessageBody(m: Msg) {
    if (m.role === "tool") {
      return (
        <details>
          <summary
            style={{
              color: "var(--fg-muted)",
              cursor: "pointer",
              fontSize: 12,
              userSelect: "none",
            }}
          >
            ↳ {m.toolName} result
          </summary>
          <pre
            style={{
              fontSize: 11,
              color: "var(--fg-muted)",
              whiteSpace: "pre-wrap",
              margin: "6px 0 0",
              fontFamily: "var(--font-mono)",
            }}
          >
            {m.content}
          </pre>
        </details>
      );
    }

    if (m.role === "assistant") {
      return (
        <>
          {m.content && (
            <div style={{ whiteSpace: "pre-wrap", marginBottom: m.toolCalls ? 6 : 0 }}>
              {m.content}
            </div>
          )}
          {m.toolCalls?.map((tc, i) => (
            <div
              key={i}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--accent)",
                background: "var(--accent-soft)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                padding: "6px 10px",
                marginTop: i > 0 ? 4 : 0,
                wordBreak: "break-word",
              }}
            >
              <span style={{ color: "var(--fg-subtle)" }}>↳ </span>
              {tc.name}({JSON.stringify(tc.args)})
            </div>
          ))}
        </>
      );
    }

    return <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>;
  }

  function displayRole(m: Msg): string {
    if (m.role === "tool") return "TOOL";
    return m.role.toUpperCase();
  }

  return (
    <>
    <aside
      style={{
        width: "var(--size-ai-panel)",
        background: "var(--bg-elevated)",
        borderLeft: "1px solid var(--border)",
        display: visible ? "flex" : "none",
        flexDirection: "column",
      }}
    >
      <header
        style={{
          padding: "10px 14px",
          fontSize: 11,
          color: "var(--fg-subtle)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          fontWeight: 500,
          borderBottom: "1px solid var(--border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span>
          AI · {MODEL}
          {workspaceRoot && " · Agent"}
        </span>
        {msgs.length > 0 && (
          <button
            onClick={() => setMsgs([])}
            style={{
              color: "var(--fg-subtle)",
              fontSize: 11,
              padding: "2px 6px",
              borderRadius: 4,
              textTransform: "none",
              letterSpacing: 0,
            }}
            title="Clear conversation"
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--fg-strong)";
              e.currentTarget.style.background = "var(--bg-hover)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--fg-subtle)";
              e.currentTarget.style.background = "transparent";
            }}
          >
            Clear
          </button>
        )}
      </header>

      <div
        ref={scrollRef}
        style={{ flex: 1, overflow: "auto", padding: 12, fontSize: 13 }}
      >
        {msgs.length === 0 && (
          <div style={{ color: "var(--fg-subtle)", fontSize: 13, lineHeight: 1.6 }}>
            {workspaceRoot
              ? "Agent mode. Ask about your code — I can read files, list directories, and propose edits."
              : "Open a folder to enable agent mode."}
            <br />
            <br />
            <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>
              Enter to send · Shift+Enter for newline
            </span>
          </div>
        )}
        {msgs.map((m, i) => {
          const isStreamingPlaceholder =
            streaming &&
            i === msgs.length - 1 &&
            m.role === "assistant" &&
            m.content === "" &&
            !m.toolCalls;
          return (
            <div key={i} style={{ margin: "12px 0" }}>
              <div
                style={{
                  fontSize: 10,
                  color: "var(--fg-subtle)",
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  fontWeight: 500,
                  marginBottom: 4,
                }}
              >
                {displayRole(m)}
              </div>
              <div style={{ color: "var(--fg)" }}>
                {isStreamingPlaceholder ? (
                  <span style={{ color: "var(--fg-dim)" }}>…</span>
                ) : (
                  renderMessageBody(m)
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ borderTop: "1px solid var(--border)", padding: 10 }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={streaming ? "Working…" : "Ask anything…"}
          disabled={streaming}
          style={{
            width: "100%",
            height: 64,
            resize: "none",
            background: "var(--bg)",
            border: "1px solid var(--border-strong)",
            borderRadius: 6,
            color: "var(--fg-strong)",
            font: "inherit",
            fontSize: 13,
            padding: 10,
            outline: "none",
            opacity: streaming ? 0.6 : 1,
            transition: "border-color 120ms ease",
          }}
          onFocus={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
          onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border-strong)")}
        />
      </div>
    </aside>
    {pending && (
      <DiffModal
        edit={{
          path: pending.path,
          oldContent: pending.oldContent,
          newContent: pending.newContent,
          isCreate: pending.isCreate,
        }}
        onApply={applyPending}
        onReject={rejectPending}
      />
    )}
    </>
  );
}
