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
  width: number;
  model: string;
  onModelChange: (model: string) => void;
  availableModels: string[];
  onAvailableModelsChange: (models: string[]) => void;
  requireDiffReview: boolean;
  stopAfterRejection: boolean;
};

type PendingEditRequest = PendingEdit & {
  fullPath: string;
  resolve: (result: string) => void;
};

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

function buildSystemPrompt(
  workspaceRoot: string | null,
  stopAfterRejection: boolean
): string {
  if (!workspaceRoot) {
    return `You are Klide's coding assistant, embedded in a code editor. No workspace folder is currently open — ask the user to open one via the Files panel before exploring code.`;
  }
  return `You are Klide's coding assistant, embedded in a code editor.

Workspace root: ${workspaceRoot}

Tool usage:
- read_file / list_dir: read-only. Use whenever you need to know contents or structure.
- write_file / create_file: edit tools. Every edit opens a diff modal for the user to APPLY or REJECT — you never write directly.

Paths are relative to the workspace root (e.g. "src/App.tsx" or ".").

How to read tool results:
- "Applied: ..." → the user approved the edit. Confirm briefly and stop, unless more changes are needed.
- "Rejected by user: ..." → the user declined. ${
    stopAfterRejection
      ? "STOP. Do NOT retry the same edit. Ask the user what they want differently, or end your turn."
      : "Do not retry the exact same edit. You may suggest a smaller alternative if it directly addresses the user's request."
  }
- "Error: ..." → the tool itself failed (e.g. file not found, ambiguous match). Read the error and fix the call.

Be concise. When you have enough information, answer the user directly.`;
}

async function executeTool(
  call: ToolCall,
  workspaceRoot: string | null,
  requestEdit: (req: Omit<PendingEditRequest, "resolve">) => Promise<string>,
  requireDiffReview: boolean,
  onFileWritten?: (path: string, newContent: string) => void
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
      if (!requireDiffReview) {
        await writeTextFile(full, newContent);
        onFileWritten?.(path, newContent);
        return `Applied: edited ${path}.`;
      }
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
      if (!requireDiffReview) {
        await writeTextFile(full, contents);
        onFileWritten?.(path, contents);
        return `Applied: created ${path} (${contents.length} chars).`;
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

function BouncingDots() {
  return (
    <div className="loader-bounce" aria-label="Model is thinking">
      <span />
      <span />
      <span />
    </div>
  );
}

function OrbitLoader() {
  return (
    <div className="loader-orbit" aria-label="Waiting for output">
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}

function SendIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 19V5" />
      <path d="M6 11l6-6 6 6" />
    </svg>
  );
}

export function AiPanel({
  workspaceRoot,
  onFileWritten,
  visible,
  width,
  model,
  onModelChange,
  availableModels,
  onAvailableModelsChange,
  requireDiffReview,
  stopAfterRejection,
}: Props) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [activity, setActivity] = useState<"thinking" | "waiting" | null>(null);
  const [pending, setPending] = useState<PendingEditRequest | null>(null);
  const [composerFocused, setComposerFocused] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

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

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [input]);

  useEffect(() => {
    let cancelled = false;
    async function loadOllamaModels() {
      try {
        const res = await fetch("http://localhost:11434/api/tags");
        if (!res.ok) return;
        const data = await res.json();
        const names = Array.isArray(data.models)
          ? data.models
              .map((m: { name?: string }) => m.name)
              .filter((name: unknown): name is string => typeof name === "string")
          : [];
        if (!cancelled && names.length > 0) {
          onAvailableModelsChange(names);
          if (!names.includes(model)) onModelChange(names[0]);
        }
      } catch {
        /* Ollama may be offline; keep the configured fallback model. */
      }
    }
    loadOllamaModels();
    return () => {
      cancelled = true;
    };
  }, [model, onAvailableModelsChange, onModelChange]);

  async function streamOnce(
    history: Msg[]
  ): Promise<{ text: string; toolCalls: ToolCall[] }> {
    const sys: Msg = {
      role: "system",
      content: buildSystemPrompt(workspaceRoot, stopAfterRejection),
    };

    const res = await fetch("http://localhost:11434/api/chat", {
      method: "POST",
      body: JSON.stringify({
        model,
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
    setActivity("thinking");

    try {
      for (let iter = 0; iter < MAX_TOOL_CALLS; iter++) {
        setActivity("thinking");
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
          setActivity("waiting");
          const result = await executeTool(
            call,
            workspaceRoot,
            requestEdit,
            requireDiffReview,
            onFileWritten
          );
          toolMsgs.push({ role: "tool", content: result, toolName: call.name });
        }

        setActivity("thinking");
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
    setActivity(null);
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
                borderRadius: "var(--radius-sm)",
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
      className="floating-panel"
      style={{
        width,
        margin: "4px 4px 4px 0",
        display: visible ? "flex" : "none",
        flexDirection: "column",
        flexShrink: 0,
        overflow: "hidden",
      }}
    >
      <header
        style={{
          padding: "8px 10px",
          fontSize: 11,
          color: "var(--fg-subtle)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          fontWeight: 500,
          borderBottom: "1px solid var(--border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span>AI</span>
          <span
            title="Local Ollama models. Cloud providers and vLLM will be added later."
            style={{
              color: "var(--fg-dim)",
              textTransform: "none",
              letterSpacing: 0,
              fontSize: 11,
            }}
          >
            Ollama
          </span>
        </div>
        {msgs.length > 0 && (
          <button
            onClick={() => setMsgs([])}
            style={{
              color: "var(--fg-subtle)",
              fontSize: 11,
              padding: "2px 6px",
              borderRadius: "var(--radius-sm)",
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
        style={{
          flex: 1,
          overflow: "auto",
          padding: 12,
          fontSize: 13,
          display: msgs.length === 0 ? "grid" : "block",
          placeItems: msgs.length === 0 ? "center" : undefined,
          minHeight: 0,
        }}
      >
        {msgs.length === 0 && (
          <div
            style={{
              width: "min(260px, 80%)",
              textAlign: "center",
              color: "var(--fg-subtle)",
              lineHeight: 1.55,
              transform: "translateY(-10px)",
            }}
          >
            <div
              style={{
                width: 38,
                height: 38,
                margin: "0 auto 14px",
                borderRadius: "var(--radius-lg)",
                display: "grid",
                placeItems: "center",
                color: "var(--accent)",
                background: "color-mix(in srgb, var(--accent-soft) 70%, transparent)",
                border: "1px solid var(--panel-border)",
                boxShadow: "inset 0 1px 0 var(--panel-highlight)",
              }}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.35"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 3.5l1.6 4.4L18 9.5l-4.4 1.6L12 15.5l-1.6-4.4L6 9.5l4.4-1.6L12 3.5z" />
                <path d="M18 16l.7 1.8L20.5 18.5l-1.8.7L18 21l-.7-1.8L15.5 18.5l1.8-.7L18 16z" />
              </svg>
            </div>
            <div
              style={{
                color: "var(--fg-strong)",
                fontSize: 14,
                fontWeight: 500,
                marginBottom: 6,
              }}
            >
              {workspaceRoot ? "Ask Klide" : "Open a workspace"}
            </div>
            <div style={{ fontSize: 12 }}>
              {workspaceRoot
                ? "Read, reason, and propose edits with your local Ollama model."
                : "Open a folder to enable local agent mode."}
            </div>
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
                  <span style={{ color: "var(--fg-dim)", display: "inline-flex" }}>
                    {activity === "waiting" ? <OrbitLoader /> : <BouncingDots />}
                  </span>
                ) : (
                  renderMessageBody(m)
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ padding: 10 }}>
        {(streaming || pending) && (
          <div
            style={{
              height: 18,
              display: "flex",
              alignItems: "center",
              gap: 6,
              color: "var(--fg-subtle)",
              fontSize: 11,
              padding: "0 2px 6px",
            }}
          >
            {activity === "waiting" || pending ? <OrbitLoader /> : <BouncingDots />}
            <span>{activity === "waiting" || pending ? "Waiting for output" : "Thinking"}</span>
          </div>
        )}
        <div
          style={{
            border: `1px solid ${
              composerFocused ? "var(--accent)" : "var(--border-strong)"
            }`,
            borderRadius: "var(--radius-md)",
            background: "var(--bg)",
            boxShadow: composerFocused
              ? "0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent)"
              : "0 0 0 0 transparent",
            transition:
              "border-color var(--motion-med) var(--ease-out), box-shadow var(--motion-med) var(--ease-out)",
            opacity: streaming ? 0.7 : 1,
          }}
        >
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            onFocus={() => setComposerFocused(true)}
            onBlur={() => setComposerFocused(false)}
            placeholder={
              streaming ? "Working…" : "Ask anything, or describe an edit…"
            }
            disabled={streaming}
            rows={1}
            style={{
              width: "100%",
              minHeight: 38,
              maxHeight: 160,
              resize: "none",
              background: "transparent",
              border: "none",
              color: "var(--fg-strong)",
              font: "inherit",
              fontSize: 13,
              lineHeight: 1.5,
              padding: "10px 10px 2px",
              outline: "none",
              display: "block",
            }}
          />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 6,
              padding: "2px 6px 6px",
            }}
          >
            <div
              style={{
                position: "relative",
                display: "flex",
                alignItems: "center",
                minWidth: 0,
              }}
            >
              <select
                value={model}
                onChange={(e) => onModelChange(e.target.value)}
                disabled={streaming}
                title="Select an Ollama model"
                style={{
                  appearance: "none",
                  WebkitAppearance: "none",
                  MozAppearance: "none",
                  maxWidth: 180,
                  height: 24,
                  color: "var(--fg-subtle)",
                  background: "transparent",
                  border: "none",
                  borderRadius: "var(--radius-xs)",
                  font: "inherit",
                  fontSize: 11,
                  outline: "none",
                  padding: "0 18px 0 6px",
                  cursor: streaming ? "default" : "pointer",
                  textOverflow: "ellipsis",
                  transition: "color var(--motion-fast) var(--ease-out)",
                }}
                onMouseEnter={(e) => {
                  if (!streaming)
                    e.currentTarget.style.color = "var(--fg-strong)";
                }}
                onMouseLeave={(e) =>
                  (e.currentTarget.style.color = "var(--fg-subtle)")
                }
              >
                {availableModels.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                style={{
                  position: "absolute",
                  right: 4,
                  pointerEvents: "none",
                  color: "var(--fg-dim)",
                }}
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </div>
            <button
              onClick={send}
              disabled={!input.trim() || streaming}
              aria-label="Send message"
              title="Send (Enter)"
              style={{
                width: 28,
                height: 28,
                flexShrink: 0,
                display: "grid",
                placeItems: "center",
                borderRadius: "50%",
                color: input.trim() && !streaming ? "#fff" : "var(--fg-dim)",
                background:
                  input.trim() && !streaming
                    ? "var(--accent)"
                    : "var(--bg-elevated)",
                cursor: input.trim() && !streaming ? "pointer" : "default",
                transition:
                  "background var(--motion-med) var(--ease-out), color var(--motion-med) var(--ease-out), filter var(--motion-fast) var(--ease-out)",
              }}
              onMouseEnter={(e) => {
                if (input.trim() && !streaming)
                  e.currentTarget.style.filter = "brightness(1.08)";
              }}
              onMouseLeave={(e) => (e.currentTarget.style.filter = "none")}
            >
              <SendIcon />
            </button>
          </div>
        </div>
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
