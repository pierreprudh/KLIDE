import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  addTask,
  dispatchTask,
  getTaskBuffer,
  getTaskSessions,
  lastAgent,
  removeTask,
  stopTask,
  subscribeTasks,
  type TaskSession,
  type TaskSource,
} from "../tasks";
import {
  getKlideConvos,
  subscribeKlideConvos,
  type KlideConvo,
} from "../klideConvos";
import type { ThemeId } from "../theme";
import {
  fetchAgentRuns,
  fetchRunMessages,
  seedRuns,
  relativeTime,
  SOURCE_COLOR,
  SOURCE_LABEL,
  STATUS_COLOR,
  STATUS_LABEL,
  STATUS_ORDER,
  type Run,
  type RunMessage,
  type RunSource,
  type RunStatus,
} from "../runs";

// Mission Control — KIDE's agentic control panel. A board of agent runs pulled
// from every tool you use (its own AI panel + external Claude Code / Codex
// sessions), grouped by status, with a metadata detail pane. Inspired by the
// 2026 "dispatch hub" pattern (GitHub Agent HQ, Antigravity Agent Manager,
// Codex app): aggregate every run in one place, filter by source, drill in.
//
// Devin-style delegation: the composer at the top is a todo list — add a
// task, it sits in Queued; open it and send an agent (claude / codex) to
// complete it. A dispatched task's detail pane is a live terminal you can
// watch, type into (take over), or stop. Klide's own AI-panel conversations
// are listed on the same board. Diff review on completion comes next.

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Present a dispatched task as a Run so it shares the board's rows, filters
// and status groups with the disk-log runs.
function taskToRun(t: TaskSession): Run {
  return {
    id: t.id,
    path: "",
    // Undispatched todos wear the Klide mark until an agent is sent.
    source: t.source ?? "klide",
    title: t.title,
    status: t.status,
    model: null,
    project: t.cwd ? t.cwd.split("/").filter(Boolean).pop() ?? null : null,
    cwd: t.cwd,
    branch: null,
    messageCount: 0,
    updatedMs: t.startedMs,
  };
}

// Same for an AI-panel conversation — Klide's own chats join the board.
function convoToRun(c: KlideConvo): Run {
  return {
    id: c.id,
    path: "",
    source: "klide",
    title: c.title,
    status: c.status,
    model: c.model,
    project: c.cwd ? c.cwd.split("/").filter(Boolean).pop() ?? null : null,
    cwd: c.cwd,
    branch: null,
    messageCount: c.messages.length,
    updatedMs: c.updatedMs,
  };
}

function StatusDot({ status, size = 7 }: { status: RunStatus; size?: number }) {
  const color = STATUS_COLOR[status];
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
        animation:
          status === "running" ? "klide-pulse 1.6s ease-in-out infinite" : undefined,
      }}
    />
  );
}

// Official brand marks (Simple Icons, single-path, currentColor → theme- and
// hover-aware), so each run wears its tool's real logo instead of a flat color.
const BRAND_PATH: Partial<Record<RunSource, string>> = {
  "claude-code":
    "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
  codex:
    "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
};

function SourceLogo({ source, size = 14 }: { source: RunSource; size?: number }) {
  const path = BRAND_PATH[source];
  const color = SOURCE_COLOR[source];
  if (path) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
        style={{ color }}
      >
        <path d={path} />
      </svg>
    );
  }
  // Klide's own runs — a quiet spark.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ color }}
    >
      <path d="M12 3.5l1.6 4.4L18 9.5l-4.4 1.6L12 15.5l-1.6-4.4L6 9.5l4.4-1.6L12 3.5z" />
    </svg>
  );
}

function RunAvatar({ source, size = 26 }: { source: RunSource; size?: number }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        display: "grid",
        placeItems: "center",
        borderRadius: "var(--radius-sm)",
        background: `color-mix(in srgb, ${SOURCE_COLOR[source]} 12%, var(--bg-elevated))`,
        border: `1px solid color-mix(in srgb, ${SOURCE_COLOR[source]} 28%, var(--border))`,
        color: SOURCE_COLOR[source],
      }}
    >
      <SourceLogo source={source} size={Math.round(size * 0.56)} />
    </span>
  );
}

function RunRow({
  run,
  selected,
  onSelect,
  action,
}: {
  run: Run;
  selected: boolean;
  onSelect: () => void;
  // Hover-revealed control (e.g. quick-send on a todo) — swaps in where the
  // status dot sits so rows stay quiet until you reach for them.
  action?: React.ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const meta = [SOURCE_LABEL[run.source], run.model, run.branch]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        textAlign: "left",
        padding: "8px 10px",
        borderRadius: "var(--radius-sm)",
        background: selected
          ? "var(--bg-selected)"
          : hovered
          ? "var(--bg-hover)"
          : "transparent",
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
    >
      <RunAvatar source={run.source} />
      <span style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1, minWidth: 0 }}>
        <span
          style={{
            fontSize: 13,
            color: "var(--fg-strong)",
            lineHeight: 1.3,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {run.title}
        </span>
        <span
          style={{
            fontSize: 11,
            color: "var(--fg-subtle)",
            fontFamily: "var(--font-mono)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {meta ? `${meta} · ` : ""}
          {relativeTime(run.updatedMs)}
        </span>
      </span>
      {action && hovered ? action : <StatusDot status={run.status} />}
    </button>
  );
}

function SendIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}

// One-click dispatch on a todo row: sends the last-used agent and selects the
// task so its terminal is in view as the agent lands. Nested inside the row's
// <button>, so it's a span with button semantics.
function QuickSend({ taskId, onSent }: { taskId: string; onSent: () => void }) {
  const agent = lastAgent();
  return (
    <span
      role="button"
      aria-label={`Send ${SOURCE_LABEL[agent]}`}
      title={`Send ${SOURCE_LABEL[agent]}`}
      onClick={(e) => {
        e.stopPropagation();
        onSent();
        void dispatchTask(taskId, agent).catch(() => {
          // Failure flips the task to error in the store; the detail pane
          // (now selected) shows the message and re-send controls.
        });
      }}
      style={{
        width: 22,
        height: 22,
        flexShrink: 0,
        display: "grid",
        placeItems: "center",
        borderRadius: "var(--radius-sm)",
        border: "1px solid var(--border)",
        color: "var(--accent)",
        background: "var(--accent-soft)",
      }}
    >
      <SendIcon />
    </span>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: 11,
        padding: "3px 9px",
        borderRadius: 999,
        border: "1px solid var(--border)",
        color: active ? "var(--fg-strong)" : "var(--fg-subtle)",
        background: active ? "var(--bg-selected)" : "transparent",
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
    >
      {label}
    </button>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt style={{ color: "var(--fg-subtle)" }}>{label}</dt>
      <dd style={{ margin: 0, color: "var(--fg-strong)", fontFamily: "var(--font-mono)" }}>
        {value}
      </dd>
    </>
  );
}

function CopyButton({ value, label = "Copy" }: { value: string | null; label?: string }) {
  const [copied, setCopied] = useState(false);
  const disabled = !value;

  async function copy() {
    if (!value) return;
    try {
      await navigator.clipboard?.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => void copy()}
      title={disabled ? "Nothing to copy" : label}
      style={{
        fontSize: 11,
        padding: "3px 7px",
        borderRadius: "var(--radius-sm)",
        border: "1px solid var(--border)",
        color: disabled ? "var(--fg-dim)" : copied ? "var(--accent)" : "var(--fg-subtle)",
        background: copied ? "var(--accent-soft)" : "transparent",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

function DetailLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: "var(--fg-subtle)",
        marginBottom: 8,
        fontFamily: "var(--font-mono)",
      }}
    >
      {children}
    </div>
  );
}

function ConversationView({ run, preloaded }: { run: Run; preloaded?: RunMessage[] }) {
  const [messages, setMessages] = useState<RunMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    // In-memory conversations (Klide's own panels) skip the disk read.
    if (preloaded) {
      setMessages(preloaded);
      setLoading(false);
      setError(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(false);
    setMessages([]);
    fetchRunMessages(run)
      .then((rows) => {
        if (!cancelled) setMessages(rows);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [run.id, run.path, run.source, preloaded]);

  const muted = { fontSize: 12, color: "var(--fg-subtle)" } as const;
  if (loading) return <div style={muted}>Loading conversation…</div>;
  if (error) return <div style={muted}>Couldn't read this session.</div>;
  if (messages.length === 0) return <div style={muted}>No readable messages.</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {messages.map((m, i) => (
        <div key={i}>
          <div
            style={{
              fontSize: 10,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              fontFamily: "var(--font-mono)",
              color: m.role === "user" ? "var(--accent)" : "var(--fg-subtle)",
              marginBottom: 4,
            }}
          >
            {m.role === "user" ? "You" : SOURCE_LABEL[run.source]}
          </div>
          <div
            style={{
              fontSize: 12.5,
              color: "var(--fg)",
              lineHeight: 1.55,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {m.text}
          </div>
        </div>
      ))}
    </div>
  );
}

// The todo box. Type a task and hit Enter — it lands in Queued. Sending an
// agent to it happens from the task's detail pane, so adding stays instant.
function TaskComposer({
  workspaceRoot,
  onAdded,
}: {
  workspaceRoot: string | null;
  onAdded: (id: string) => void;
}) {
  const [text, setText] = useState("");

  function add() {
    const title = text.trim();
    if (!title) return;
    const task = addTask(title, workspaceRoot);
    setText("");
    onAdded(task.id);
  }

  return (
    <div style={{ padding: "10px 16px 12px", borderBottom: "1px solid var(--border)" }}>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
        placeholder="Add a task…"
        style={{
          width: "100%",
          fontSize: 12.5,
          lineHeight: 1.5,
          fontFamily: "inherit",
          color: "var(--fg-strong)",
          background: "var(--bg-elevated)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          padding: "7px 9px",
          outline: "none",
        }}
      />
    </div>
  );
}

// Live console of a dispatched task. The PTY was spawned at dispatch time —
// here we replay the buffered scrollback, then stream. Typing goes straight to
// the CLI, so "take over" is just clicking in and typing. Mirrors the main
// TerminalPanel's xterm setup so both terminals feel like the same surface.
function TaskTerminal({ sessionId, theme }: { sessionId: string; theme: ThemeId }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const term = new Terminal({
      fontSize: 12,
      fontFamily:
        "Monaspace Neon, Monaspace Argon, Monaspace, SF Mono, JetBrains Mono, ui-monospace, monospace",
      theme: {
        background: cssVar("--terminal-bg"),
        foreground: cssVar("--terminal-fg"),
        cursor: cssVar("--terminal-cursor"),
      },
      cursorBlink: true,
      scrollback: 5000,
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    // Fit (and tell the PTY the real size) BEFORE replaying the scrollback —
    // otherwise the replay wraps at the spawn-time 100 cols and looks mangled
    // until the CLI's next full redraw.
    const syncSize = () => {
      fit.fit();
      void invoke("delegate_pty_resize", { sessionId, rows: term.rows, cols: term.cols });
    };
    syncSize();
    term.write(getTaskBuffer(sessionId));
    term.focus();

    const unlisten = listen<{ sessionId: string; data: string }>(
      "delegate-pty:data",
      (e) => {
        if (e.payload.sessionId === sessionId) term.write(e.payload.data);
      }
    );
    term.onData((data) => {
      void invoke("delegate_pty_write", { sessionId, data });
    });

    const resize = new ResizeObserver(syncSize);
    resize.observe(ref.current);

    return () => {
      unlisten.then((u) => u());
      resize.disconnect();
      term.dispose();
    };
    // `theme` re-creates the terminal so cssVar() picks up the new palette —
    // same pattern as TerminalPanel. The replay buffer restores the content.
  }, [sessionId, theme]);

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "color-mix(in srgb, var(--terminal-bg) 96%, var(--bg))",
        borderTop: "1px solid var(--terminal-border)",
      }}
    >
      <div ref={ref} style={{ flex: 1, minHeight: 0, padding: 6 }} />
    </div>
  );
}

function TaskDetail({ task, theme }: { task: TaskSession; theme: ThemeId }) {
  const [agent, setAgent] = useState<TaskSource>(lastAgent);
  const [failure, setFailure] = useState<string | null>(null);

  // queued/error = the todo needs (re)dispatching; running/done = a delegate
  // worked on it and the terminal is the record.
  const needsAgent = task.status === "queued" || task.status === "error";

  async function send() {
    setFailure(null);
    try {
      await dispatchTask(task.id, agent);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ padding: "20px 24px 14px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <RunAvatar source={task.source ?? "klide"} size={30} />
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span
              style={{ fontSize: 12, color: "var(--fg-strong)", fontFamily: "var(--font-mono)" }}
            >
              {task.source ? SOURCE_LABEL[task.source] : "Todo"}
            </span>
            <span
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 11,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                color: STATUS_COLOR[task.status],
                fontFamily: "var(--font-mono)",
              }}
            >
              <StatusDot status={task.status} size={6} />
              {STATUS_LABEL[task.status]}
            </span>
          </div>
          <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {task.status === "running" ? (
              <ActionButton label="Stop" onClick={() => void stopTask(task.id)} />
            ) : (
              <ActionButton label="Remove" onClick={() => removeTask(task.id)} />
            )}
          </span>
        </div>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--fg-strong)", margin: 0 }}>
          {task.title}
        </h2>
        {task.cwd && (
          <div
            style={{
              marginTop: 6,
              fontSize: 11,
              color: "var(--fg-subtle)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {task.cwd}
          </div>
        )}
      </div>
      {needsAgent ? (
        <div style={{ padding: "6px 24px 24px" }}>
          <DetailLabel>Send an agent</DetailLabel>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {(["claude-code", "codex"] as const).map((s) => (
              <FilterChip
                key={s}
                label={SOURCE_LABEL[s]}
                active={agent === s}
                onClick={() => setAgent(s)}
              />
            ))}
            <span style={{ marginLeft: 10 }}>
              <ActionButton label="Send agent" primary onClick={() => void send()} />
            </span>
          </div>
          <div style={{ marginTop: 10, fontSize: 12, color: "var(--fg-subtle)", lineHeight: 1.5 }}>
            The agent opens in the workspace with this task as its first
            prompt. You can watch it live here, type to take over, or stop it.
          </div>
          {failure && (
            <div style={{ marginTop: 8, fontSize: 11, color: "var(--danger, #B42318)" }}>
              {failure}
            </div>
          )}
        </div>
      ) : (
        <TaskTerminal sessionId={task.id} theme={theme} />
      )}
    </div>
  );
}

function RunDetail({ run, messages }: { run: Run; messages?: RunMessage[] }) {
  return (
    <div style={{ padding: "20px 24px", overflowY: "auto", height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <RunAvatar source={run.source} size={30} />
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span
            style={{ fontSize: 12, color: "var(--fg-strong)", fontFamily: "var(--font-mono)" }}
          >
            {SOURCE_LABEL[run.source]}
          </span>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: STATUS_COLOR[run.status],
              fontFamily: "var(--font-mono)",
            }}
          >
            <StatusDot status={run.status} size={6} />
            {STATUS_LABEL[run.status]}
          </span>
        </div>
      </div>

      <h2 style={{ fontSize: 18, fontWeight: 600, color: "var(--fg-strong)", margin: "0 0 14px" }}>
        {run.title}
      </h2>

      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <CopyButton value={run.path || null} label="Copy log path" />
        <CopyButton value={run.cwd} label="Copy cwd" />
        <ActionButton disabled label="Resume later" />
      </div>

      {!messages && (
        <div
          style={{
            marginBottom: 18,
            padding: "8px 10px",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--border)",
            color: "var(--fg-subtle)",
            fontSize: 12,
            lineHeight: 1.45,
          }}
        >
          Read-only inspector for the local session log. Resume/open controls are
          intentionally parked until Klide can hand the run back to the right CLI.
        </div>
      )}

      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "7px 18px",
          fontSize: 12,
          margin: "0 0 22px",
        }}
      >
        <MetaRow label="Model" value={run.model ?? "—"} />
        <MetaRow label="Project" value={run.project ?? "—"} />
        <MetaRow label="Branch" value={run.branch ?? "—"} />
        <MetaRow label="Messages" value={String(run.messageCount)} />
        <MetaRow label="Updated" value={relativeTime(run.updatedMs)} />
        {run.path && <MetaRow label="Log" value={run.path} />}
        {run.cwd && <MetaRow label="Directory" value={run.cwd} />}
      </dl>

      <DetailLabel>Conversation</DetailLabel>
      <ConversationView run={run} preloaded={messages} />
    </div>
  );
}

function ActionButton({
  label,
  primary,
  disabled,
  onClick,
}: {
  label: string;
  primary?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      title={disabled && !onClick ? "Not wired yet" : undefined}
      style={{
        fontSize: 12,
        padding: "5px 12px",
        borderRadius: "var(--radius-sm)",
        border: "1px solid var(--border)",
        color: disabled ? "var(--fg-subtle)" : primary ? "var(--fg-strong)" : "var(--fg)",
        background: primary && !disabled ? "var(--accent-soft)" : "transparent",
        opacity: disabled ? 0.55 : 1,
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {label}
    </button>
  );
}

function RefreshIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 4v5h-5" />
    </svg>
  );
}

const PAGE = 10;

export function MissionControl({
  workspaceRoot,
  theme,
}: {
  workspaceRoot: string | null;
  theme: ThemeId;
}) {
  const tasks = useSyncExternalStore(subscribeTasks, getTaskSessions);
  const convos = useSyncExternalStore(subscribeKlideConvos, getKlideConvos);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [error, setError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<RunSource | "all">("all");

  // Initial load (and refresh) — just the most-recent page.
  async function load() {
    setLoading(true);
    try {
      const rows = await fetchAgentRuns(PAGE, 0);
      setRuns(rows);
      setHasMore(rows.length === PAGE);
      setNextOffset(PAGE);
      setError(false);
    } catch {
      // Outside Tauri (or the command failed) — show the illustrative seed.
      setRuns(seedRuns());
      setHasMore(false);
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  // Page in the next batch of older runs, appended (deduped by id).
  async function loadMore() {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const rows = await fetchAgentRuns(PAGE, nextOffset);
      setRuns((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...rows.filter((r) => !seen.has(r.id))];
      });
      setHasMore(rows.length === PAGE);
      setNextOffset((o) => o + PAGE);
    } catch {
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // Your todos lead the board, then Klide's own conversations, then runs
  // pulled off disk from the external CLIs.
  const allRuns = useMemo(
    () => [...tasks.map(taskToRun), ...convos.map(convoToRun), ...runs],
    [tasks, convos, runs]
  );

  // Which source chips to show — only sources actually present.
  const presentSources = useMemo(() => {
    const set = new Set<RunSource>();
    for (const r of allRuns) set.add(r.source);
    return Array.from(set);
  }, [allRuns]);

  const filtered = useMemo(
    () =>
      sourceFilter === "all" ? allRuns : allRuns.filter((r) => r.source === sourceFilter),
    [allRuns, sourceFilter]
  );

  const grouped = useMemo(() => {
    const by: Record<RunStatus, Run[]> = {
      running: [],
      waiting: [],
      queued: [],
      done: [],
      error: [],
    };
    for (const r of filtered) by[r.status].push(r);
    return by;
  }, [filtered]);

  // Keep a valid selection as the filter/data changes.
  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedId(null);
    } else if (!filtered.some((r) => r.id === selectedId)) {
      setSelectedId(filtered[0].id);
    }
  }, [filtered, selectedId]);

  const selectedTask = tasks.find((t) => t.id === selectedId) ?? null;
  const selectedConvo = selectedTask
    ? null
    : convos.find((c) => c.id === selectedId) ?? null;
  const selected =
    selectedTask || selectedConvo
      ? null
      : allRuns.find((r) => r.id === selectedId) ?? null;
  const activeCount =
    grouped.running.length + grouped.waiting.length + grouped.queued.length;

  return (
    <div style={{ flex: 1, display: "flex", minWidth: 0, background: "var(--bg)" }}>
      {/* Left: the board */}
      <div
        style={{
          width: 340,
          flexShrink: 0,
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <header style={{ padding: "16px 16px 10px", borderBottom: "1px solid var(--border)" }}>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              marginBottom: 12,
            }}
          >
            <h1 style={{ fontSize: 14, fontWeight: 600, color: "var(--fg-strong)", margin: 0 }}>
              Mission Control
            </h1>
            <span
              style={{ fontSize: 11, color: "var(--fg-subtle)", fontFamily: "var(--font-mono)" }}
            >
              {loading ? "loading…" : `${activeCount} active · ${runs.length} loaded`}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <FilterChip
              label="All"
              active={sourceFilter === "all"}
              onClick={() => setSourceFilter("all")}
            />
            {presentSources.map((s) => (
              <FilterChip
                key={s}
                label={SOURCE_LABEL[s]}
                active={sourceFilter === s}
                onClick={() => setSourceFilter(s)}
              />
            ))}
            <button
              onClick={() => void load()}
              title="Refresh"
              aria-label="Refresh runs"
              style={{
                marginLeft: "auto",
                width: 26,
                height: 26,
                display: "grid",
                placeItems: "center",
                color: "var(--fg-subtle)",
                borderRadius: "var(--radius-sm)",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <RefreshIcon />
            </button>
          </div>
        </header>

        <TaskComposer
          workspaceRoot={workspaceRoot}
          onAdded={(id) => setSelectedId(id)}
        />

        <div style={{ overflowY: "auto", padding: "8px 8px 16px", minHeight: 0, flex: 1 }}>
          {!loading && filtered.length === 0 && (
            <div style={{ padding: "24px 12px", fontSize: 12, color: "var(--fg-subtle)", lineHeight: 1.55 }}>
              <div style={{ color: "var(--fg-strong)", marginBottom: 5 }}>
                No matching runs.
              </div>
              Mission Control reads Claude Code and Codex session logs from your
              local machine. Start or refresh an agent session, then come back here.
            </div>
          )}
          {STATUS_ORDER.map((status) => {
            const list = grouped[status];
            if (list.length === 0) return null;
            return (
              <div key={status} style={{ marginBottom: 14 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 10px",
                    fontSize: 10,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    color: "var(--fg-subtle)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {STATUS_LABEL[status]}
                  <span style={{ opacity: 0.7 }}>{list.length}</span>
                </div>
                {list.map((run) => {
                  // Todos (and failed dispatches) get the one-click send.
                  const task = tasks.find((t) => t.id === run.id);
                  const sendable =
                    task && (task.status === "queued" || task.status === "error");
                  return (
                    <RunRow
                      key={run.id}
                      run={run}
                      selected={run.id === selectedId}
                      onSelect={() => setSelectedId(run.id)}
                      action={
                        sendable ? (
                          <QuickSend
                            taskId={run.id}
                            onSent={() => setSelectedId(run.id)}
                          />
                        ) : undefined
                      }
                    />
                  );
                })}
              </div>
            );
          })}
          {hasMore && (
            <button
              onClick={() => void loadMore()}
              disabled={loadingMore}
              style={{
                width: "calc(100% - 16px)",
                margin: "4px 8px 0",
                padding: "8px",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                color: "var(--fg-subtle)",
                border: "1px dashed var(--border)",
                borderRadius: "var(--radius-sm)",
                background: "transparent",
              }}
              onMouseEnter={(e) => {
                if (!loadingMore) e.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
        </div>

        {error && (
          <div
            style={{
              padding: "8px 16px",
              fontSize: 11,
              color: "var(--fg-subtle)",
              borderTop: "1px solid var(--border)",
            }}
          >
            Showing sample data. Local session logs were unavailable in this run.
          </div>
        )}
      </div>

      {/* Right: detail */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {selectedTask ? (
          <TaskDetail task={selectedTask} theme={theme} />
        ) : selectedConvo ? (
          <RunDetail run={convoToRun(selectedConvo)} messages={selectedConvo.messages} />
        ) : selected ? (
          <RunDetail run={selected} />
        ) : (
          <div
            style={{
              height: "100%",
              display: "grid",
              placeItems: "center",
              color: "var(--fg-subtle)",
              fontSize: 13,
              textAlign: "center",
              padding: 24,
            }}
          >
            {loading ? "Loading runs..." : "Select a run to inspect its transcript and metadata."}
          </div>
        )}
      </div>
    </div>
  );
}
