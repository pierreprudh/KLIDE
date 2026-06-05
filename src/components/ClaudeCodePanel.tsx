import { useCallback, useEffect, useRef, useState } from "react";
import { loadConversations } from "./ai/utils";
import type { Conversation } from "./ai/types";
import type { ProviderId } from "../agent/types";
import {
  publishKlideConvo,
  settleKlideConvo,
} from "../klideConvos";

// ── Types ─────────────────────────────────────────────────────────────
type Msg = {
  role: "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  toolCalls?: { name: string; args: string; result?: string }[];
  attachments?: { name: string; path: string; content: string }[];
};

type Props = {
  workspaceRoot: string | null;
  width: number;
  fill?: boolean;
  model: string;
  onModelChange: (model: string) => void;
  availableModels: string[];
  onAvailableModelsChange: (models: string[]) => void;
  apiKeyVersion?: number;
  requireDiffReview: boolean;
  stopAfterRejection: boolean;
  projectContext?: { selectedPath: string; focused: { id: string; path: string; label: string; detail: string; weight?: number }[]; feature: { id: string; path: string; label: string; detail: string; weight?: number }[]; workspace: { id: string; path: string; label: string; detail: string; weight?: number }[]; lens: { id: string; path: string; label: string; detail: string; weight?: number }[] } | null;
  harnessSettings?: {
    chatPrompt?: string;
    planPrompt?: string;
    goalPrompt?: string;
    toolOverrides?: Record<string, boolean>;
  };
  onDuplicate?: () => void;
  onClose?: () => void;
  resumeConversation?: Conversation | null;
  onResumeConsumed?: () => void;
};

// ── Claude Logo ───────────────────────────────────────────────────────
function ClaudeLogo({ size = 48 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M50 0C22.4 0 0 22.4 0 50s22.4 50 50 50 50-22.4 50-50S77.6 0 50 0zm0 15c19.3 0 35 15.7 35 35s-15.7 35-35 35-35-15.7-35-35 15.7-35 35-35z"
        fill="#D4A574"
      />
      <path
        d="M50 25c-13.8 0-25 11.2-25 25s11.2 25 25 25 25-11.2 25-25-11.2-25-25-25zm0 10c8.3 0 15 6.7 15 15s-6.7 15-15 15-15-6.7-15-15 6.7-15 15-15z"
        fill="#D4A574"
      />
      <circle cx="50" cy="50" r="8" fill="#D4A574" />
    </svg>
  );
}

// ── Action Icons ──────────────────────────────────────────────────────
function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function SlashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 18l6-12" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function NewChatIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

// ── Welcome State ─────────────────────────────────────────────────────
function WelcomeState({ onQuickAction }: { onQuickAction: (action: string) => void }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 40,
        textAlign: "center",
      }}
    >
      <ClaudeLogo size={64} />
      <h2
        style={{
          marginTop: 24,
          fontSize: 20,
          fontWeight: 500,
          color: "var(--fg-strong)",
          fontFamily: "var(--font-display)",
        }}
      >
        Claude Code
      </h2>
      <p
        style={{
          marginTop: 12,
          fontSize: 14,
          color: "var(--fg-subtle)",
          maxWidth: 280,
          lineHeight: 1.5,
        }}
      >
        What to do first? Ask about this codebase or we can start writing code.
      </p>
      <div
        style={{
          marginTop: 32,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          width: "100%",
          maxWidth: 280,
        }}
      >
        {[
          { label: "Explain this codebase", icon: "📚" },
          { label: "Fix a bug", icon: "🐛" },
          { label: "Add a feature", icon: "✨" },
          { label: "Refactor code", icon: "♻️" },
        ].map(({ label, icon }) => (
          <button
            key={label}
            onClick={() => onQuickAction(label)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "12px 16px",
              background: "var(--bg-elevated)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-md)",
              color: "var(--fg)",
              fontSize: 13,
              cursor: "pointer",
              transition: "all 0.15s ease",
              textAlign: "left",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--bg-hover)";
              e.currentTarget.style.borderColor = "var(--accent)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "var(--bg-elevated)";
              e.currentTarget.style.borderColor = "var(--border)";
            }}
          >
            <span style={{ fontSize: 16 }}>{icon}</span>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Chat Message ──────────────────────────────────────────────────────
function ChatMessage({ msg }: { msg: Msg }) {
  const isUser = msg.role === "user";
  const isTool = msg.role === "tool";

  return (
    <div
      style={{
        padding: "16px 20px",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "flex-start",
        }}
      >
        {/* Avatar */}
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: "var(--radius-sm)",
            background: isUser
              ? "var(--accent-soft)"
              : isTool
              ? "var(--bg-elevated)"
              : "#D4A574",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            fontSize: 12,
            fontWeight: 600,
            color: isUser ? "var(--accent)" : isTool ? "var(--fg-subtle)" : "#fff",
          }}
        >
          {isUser ? "You" : isTool ? "🔧" : "Claude"}
        </div>

        {/* Content */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              lineHeight: 1.6,
              color: "var(--fg)",
              whiteSpace: "pre-wrap",
            }}
          >
            {msg.content}
          </div>

          {/* Tool calls */}
          {msg.toolCalls && msg.toolCalls.length > 0 && (
            <div style={{ marginTop: 12 }}>
              {msg.toolCalls.map((tc, i) => (
                <div
                  key={i}
                  style={{
                    padding: "8px 12px",
                    background: "var(--bg-elevated)",
                    borderRadius: "var(--radius-sm)",
                    marginBottom: 6,
                    fontSize: 12,
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  <span style={{ color: "var(--accent)" }}>{tc.name}</span>
                  <span style={{ color: "var(--fg-subtle)", marginLeft: 8 }}>
                    {tc.args.slice(0, 100)}
                    {tc.args.length > 100 ? "..." : ""}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Thinking */}
          {msg.thinking && (
            <details style={{ marginTop: 8 }}>
              <summary
                style={{
                  fontSize: 12,
                  color: "var(--fg-subtle)",
                  cursor: "pointer",
                }}
              >
                Thinking...
              </summary>
              <div
                style={{
                  marginTop: 8,
                  padding: 12,
                  background: "var(--bg-elevated)",
                  borderRadius: "var(--radius-sm)",
                  fontSize: 12,
                  color: "var(--fg-subtle)",
                  lineHeight: 1.5,
                }}
              >
                {msg.thinking}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────
export function ClaudeCodePanel({
  workspaceRoot,
  width,
  fill,
  model,
  onModelChange: _onModelChange,
  availableModels: _availableModels,
  onAvailableModelsChange: _onAvailableModelsChange,
  apiKeyVersion: _apiKeyVersion,
  requireDiffReview: _requireDiffReview,
  stopAfterRejection: _stopAfterRejection,
  projectContext,
  harnessSettings: _harnessSettings,
  onDuplicate: _onDuplicate,
  onClose: _onClose,
  resumeConversation,
  onResumeConsumed,
}: Props) {
  // ── State ─────────────────────────────────────────────────────────
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [mode, setMode] = useState<"chat" | "plan" | "goal">("chat");
  const [provider] = useState<string>("ollama");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conversations] = useState<Conversation[]>(() =>
    loadConversations<Conversation>()
  );
  const [, setCurrentId] = useState<string | null>(null);

  const msgsRef = useRef(msgs);
  const streamingRef = useRef(false);
  const activeRunRef = useRef<string | null>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const convoIdRef = useRef<string | null>(null);

  // ── Effects ───────────────────────────────────────────────────────
  useEffect(() => {
    msgsRef.current = msgs;
  }, [msgs]);

  // Publish convo to Mission Control
  useEffect(() => {
    if (!convoIdRef.current) convoIdRef.current = crypto.randomUUID();
    const firstUser = msgs.find((m) => m.role === "user");
    publishKlideConvo({
      id: convoIdRef.current,
      title: (firstUser?.content.trim() || "Untitled chat").slice(0, 120),
      status: streaming ? "running" : "waiting",
      model: model ?? null,
      cwd: workspaceRoot,
      messages: msgs.flatMap((m) =>
        (m.role === "user" || (m.role === "assistant" && !m.toolCalls?.length)) && m.content.trim()
          ? [{ role: m.role, text: m.content }]
          : []
      ),
      updatedMs: Date.now(),
    });
  }, [msgs, streaming, model, workspaceRoot]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (convoIdRef.current) settleKlideConvo(convoIdRef.current);
    };
  }, []);

  // Load resumed conversation
  const prevResumeRef = useRef<string | null>(null);
  useEffect(() => {
    if (resumeConversation && resumeConversation.id !== prevResumeRef.current) {
      prevResumeRef.current = resumeConversation.id;
      setMsgs(resumeConversation.msgs as Msg[]);
      setCurrentId(resumeConversation.id);
      onResumeConsumed?.();
    }
    if (!resumeConversation) prevResumeRef.current = null;
  }, [resumeConversation, onResumeConsumed]);

  // ── Handlers ──────────────────────────────────────────────────────
  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || streaming) return;

    const userMsg: Msg = { role: "user", content: text };
    setMsgs((prev) => [...prev, userMsg]);
    setInput("");
    setStreaming(true);
    streamingRef.current = true;

    try {
      const { startAgentRun } = await import("../agent/client");
      const session = await startAgentRun(
        {
          workspaceRoot: workspaceRoot ?? "",
          mode,
          provider: provider as ProviderId,
          model,
          text,
          attachments: [],
          context: {
            workspaceRoot: workspaceRoot ?? "",
            attachments: [],
            lensItems: projectContext?.lens ?? [],
            estimatedTokens: 0,
            omitted: [],
          },
          systemPrompt: `You are Claude Code, an AI assistant helping with software engineering tasks. Be concise and helpful.`,
        },
        (event) => {
          switch (event.type) {
            case "assistant_message": {
              const content = typeof event.content === "string"
                ? event.content
                : Array.isArray(event.content)
                ? event.content.map((c: { type: string; text?: string }) => c.text ?? "").join("")
                : "";
              setMsgs((prev) => {
                const last = prev[prev.length - 1];
                if (last?.role === "assistant") {
                  return [
                    ...prev.slice(0, -1),
                    { ...last, content: last.content + content },
                  ];
                }
                return [...prev, { role: "assistant", content }];
              });
              break;
            }
            case "run_error": {
              if (event.error.code !== "aborted") {
                setMsgs((prev) => [
                  ...prev,
                  { role: "assistant", content: `Error: ${event.error.message}` },
                ]);
              }
              break;
            }
          }
        }
      );

      activeRunRef.current = session.runId;
      abortRef.current = () => {
        import("../agent/client").then(({ stopAgentRun }) => stopAgentRun(session.runId));
      };
      await session.done;
    } catch (e) {
      setMsgs((prev) => [
        ...prev,
        { role: "assistant", content: `Error: ${e instanceof Error ? e.message : String(e)}` },
      ]);
    } finally {
      setStreaming(false);
      streamingRef.current = false;
      activeRunRef.current = null;
      abortRef.current = null;
    }
  }, [streaming, workspaceRoot, mode, provider, model, projectContext]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage(input);
      }
    },
    [input, sendMessage]
  );

  const handleQuickAction = useCallback((action: string) => {
    const prompts: Record<string, string> = {
      "Explain this codebase": "Explain the structure of this codebase and what each major component does.",
      "Fix a bug": "I found a bug. Let me describe it...",
      "Add a feature": "I want to add a new feature. Here's what I'm thinking...",
      "Refactor code": "I want to refactor some code to improve clarity and maintainability.",
    };
    setInput(prompts[action] || action);
  }, []);

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div
      style={{
        width: fill ? "100%" : width,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        borderLeft: "1px solid var(--border)",
        fontFamily: "var(--font-ui)",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <ClaudeLogo size={20} />
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--fg-strong)",
            }}
          >
            Claude Code
          </span>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            onClick={() => setHistoryOpen(!historyOpen)}
            style={{
              padding: 6,
              background: "transparent",
              border: "none",
              color: "var(--fg-subtle)",
              cursor: "pointer",
              borderRadius: "var(--radius-sm)",
            }}
            title="History"
          >
            <HistoryIcon />
          </button>
          <button
            onClick={() => {
              setMsgs([]);
              setCurrentId(null);
              convoIdRef.current = null;
            }}
            style={{
              padding: 6,
              background: "transparent",
              border: "none",
              color: "var(--fg-subtle)",
              cursor: "pointer",
              borderRadius: "var(--radius-sm)",
            }}
            title="New chat"
          >
            <NewChatIcon />
          </button>
        </div>
      </div>

      {/* Messages or Welcome */}
      {msgs.length === 0 ? (
        <WelcomeState onQuickAction={handleQuickAction} />
      ) : (
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            overflowX: "hidden",
          }}
        >
          {msgs.map((msg, i) => (
            <ChatMessage key={i} msg={msg} />
          ))}
          {streaming && (
            <div
              style={{
                padding: "16px 20px",
                color: "var(--fg-subtle)",
                fontSize: 13,
              }}
            >
              <span className="pulse">Claude is thinking...</span>
            </div>
          )}
        </div>
      )}

      {/* Input Area */}
      <div
        style={{
          padding: "16px",
          borderTop: "1px solid var(--border)",
        }}
      >
        {/* File reference chip */}
        <div
          style={{
            display: "flex",
            gap: 8,
            marginBottom: 8,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 8px",
              background: "var(--bg-elevated)",
              borderRadius: "var(--radius-sm)",
              fontSize: 12,
              color: "var(--fg-subtle)",
            }}
          >
            <span>📄</span>
            <span>Ideas.md</span>
          </div>
        </div>

        {/* Input box */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)",
            overflow: "hidden",
          }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask Claude to edit..."
            rows={1}
            style={{
              width: "100%",
              padding: "12px 16px",
              background: "transparent",
              border: "none",
              color: "var(--fg)",
              fontSize: 14,
              fontFamily: "var(--font-ui)",
              resize: "none",
              outline: "none",
              minHeight: 44,
            }}
          />

          {/* Action bar */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "8px 12px",
              borderTop: "1px solid var(--border)",
            }}
          >
            <div style={{ display: "flex", gap: 4 }}>
              <button
                style={{
                  padding: 6,
                  background: "transparent",
                  border: "none",
                  color: "var(--fg-subtle)",
                  cursor: "pointer",
                  borderRadius: "var(--radius-sm)",
                }}
                title="Add file"
              >
                <PlusIcon />
              </button>
              <button
                style={{
                  padding: 6,
                  background: "transparent",
                  border: "none",
                  color: "var(--fg-subtle)",
                  cursor: "pointer",
                  borderRadius: "var(--radius-sm)",
                }}
                title="Commands"
              >
                <SlashIcon />
              </button>
              <button
                style={{
                  padding: 6,
                  background: "transparent",
                  border: "none",
                  color: "var(--fg-subtle)",
                  cursor: "pointer",
                  borderRadius: "var(--radius-sm)",
                }}
                title="Voice input"
              >
                <MicIcon />
              </button>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {/* Ask before edits toggle */}
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  color: "var(--fg-subtle)",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  defaultChecked
                  style={{ accentColor: "var(--accent)" }}
                />
                Ask before edits
              </label>

              {/* Send button */}
              <button
                onClick={() => sendMessage(input)}
                disabled={!input.trim() || streaming}
                style={{
                  width: 28,
                  height: 28,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: input.trim() ? "var(--accent)" : "var(--bg-elevated)",
                  border: "none",
                  borderRadius: "var(--radius-sm)",
                  color: input.trim() ? "#fff" : "var(--fg-subtle)",
                  cursor: input.trim() ? "pointer" : "default",
                  transition: "all 0.15s ease",
                }}
              >
                <SendIcon />
              </button>
            </div>
          </div>
        </div>

        {/* Mode selector */}
        <div
          style={{
            display: "flex",
            gap: 4,
            marginTop: 8,
          }}
        >
          {(["chat", "plan", "goal"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                padding: "4px 8px",
                background: mode === m ? "var(--accent-soft)" : "transparent",
                border: `1px solid ${mode === m ? "var(--accent)" : "var(--border)"}`,
                borderRadius: "var(--radius-sm)",
                color: mode === m ? "var(--accent)" : "var(--fg-subtle)",
                fontSize: 11,
                fontWeight: 500,
                cursor: "pointer",
                transition: "all 0.15s ease",
              }}
            >
              {m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* History drawer */}
      {historyOpen && (
        <div
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            width: 280,
            height: "100%",
            background: "var(--bg-elevated)",
            borderLeft: "1px solid var(--border)",
            zIndex: 100,
            overflowY: "auto",
          }}
        >
          <div
            style={{
              padding: "12px 16px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-strong)" }}>
              History
            </span>
            <button
              onClick={() => setHistoryOpen(false)}
              style={{
                padding: 4,
                background: "transparent",
                border: "none",
                color: "var(--fg-subtle)",
                cursor: "pointer",
              }}
            >
              ✕
            </button>
          </div>
          {conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => {
                setMsgs(c.msgs as Msg[]);
                setCurrentId(c.id);
                setHistoryOpen(false);
              }}
              style={{
                width: "100%",
                padding: "10px 16px",
                background: "transparent",
                border: "none",
                textAlign: "left",
                cursor: "pointer",
                borderBottom: "1px solid var(--border)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              <div
                style={{
                  fontSize: 13,
                  color: "var(--fg)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {c.title}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--fg-subtle)",
                  marginTop: 4,
                }}
              >
                {new Date(c.updatedAt).toLocaleDateString()}
              </div>
            </button>
          ))}
        </div>
      )}

      <style>{`
        .pulse {
          animation: pulse 1.5s ease-in-out infinite;
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
}
