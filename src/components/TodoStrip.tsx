import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, type CSSProperties } from "react";

type TodoItem = {
  id: string;
  text: string;
  done: boolean;
  created_at: number;
  updated_at?: number;
};

type TodoEvent = {
  seq: number;
  action: "add" | "complete" | "uncomplete" | "edit" | "remove" | string;
  todo_id?: string | null;
  text?: string | null;
  previous_text?: string | null;
  done?: boolean | null;
  at: number;
};

type TodoStore = {
  todos: TodoItem[];
  next_id: number;
  events?: TodoEvent[];
  next_event_id?: number;
};

const DISMISSED_TODOS_KEY = "klide.todoStrip.dismissedCompleted";

function readDismissedTodoStrips(): Record<string, string> {
  try {
    const raw = localStorage.getItem(DISMISSED_TODOS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function writeDismissedTodoStrips(map: Record<string, string>) {
  try {
    const entries = Object.entries(map).slice(-200);
    localStorage.setItem(DISMISSED_TODOS_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* localStorage is convenience only */
  }
}

function dismissalKey(workspaceRoot: string | null, conversationId: string): string {
  return `${workspaceRoot ?? "no-workspace"}::${conversationId}`;
}

function completionSignature(items: TodoItem[], events: TodoEvent[]): string {
  const itemState = items
    .map((item) => `${item.id}:${item.done ? 1 : 0}:${item.updated_at ?? item.created_at}`)
    .join("|");
  const latestEvent = events.reduce((max, event) => Math.max(max, event.seq), 0);
  return `${items.length}:${latestEvent}:${itemState}`;
}

function completedTodosWereDismissed(
  workspaceRoot: string | null,
  conversationId: string,
  signature: string
): boolean {
  return readDismissedTodoStrips()[dismissalKey(workspaceRoot, conversationId)] === signature;
}

function rememberCompletedTodosDismissed(
  workspaceRoot: string | null,
  conversationId: string,
  signature: string
) {
  const map = readDismissedTodoStrips();
  map[dismissalKey(workspaceRoot, conversationId)] = signature;
  writeDismissedTodoStrips(map);
}

function CheckIcon() {
  return (
    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      style={{ transform: `rotate(${open ? 180 : 0}deg)`, transition: "transform 0.15s ease" }}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function safeScope(scope: string): string {
  return scope.replace(/[^A-Za-z0-9_-]/g, "_");
}

// Minimalist progress: a 3px hairline track with a green fill.
function ProgressBar({ percent }: { percent: number }) {
  return (
    <span
      aria-hidden
      style={{
        position: "relative",
        height: 3,
        minWidth: 40,
        overflow: "hidden",
        borderRadius: 999,
        background: "color-mix(in srgb, var(--fg-dim) 16%, transparent)",
      }}
    >
      <span
        style={{
          position: "absolute",
          inset: "0 auto 0 0",
          width: `${percent}%`,
          background: "var(--accent)",
          borderRadius: 999,
          transition: "width var(--motion-med) var(--ease-out)",
        }}
      />
    </span>
  );
}

// Opaque narrow panel that floats over the bottom of the conversation and
// docks onto the composer. Narrower than the chat, so messages stay visible in
// the side margins. No shadow — it cast a dark halo (the "black bars") in dark
// themes; the hairline border alone defines the panel. No backdrop-filter —
// solid surface (the webview has a known backdrop-filter bug).
const glassCard: CSSProperties = {
  background: "var(--bg-elevated)",
  border: "none",
  borderTop: "1px solid var(--border-strong)",
};

// Floats just above the composer, INSIDE the conversation area. It must not
// overlap the composer (no negative bottom): the chatbox is wider than this
// narrow bar, so any overlap makes the composer's rounded top corners peek out
// on either side of the bar.
const dockWrap: CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  bottom: 0,
  display: "flex",
  justifyContent: "center",
  pointerEvents: "none",
  zIndex: 6,
};

export function TodoStrip({
  workspaceRoot,
  conversationId,
  goal: goalProp,
  onDockHeightChange,
}: {
  workspaceRoot: string | null;
  conversationId: string;
  goal?: string;
  onDockHeightChange?: (height: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [items, setItems] = useState<TodoItem[]>([]);
  const [events, setEvents] = useState<TodoEvent[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Drop the previous conversation's list right away so it never flashes
    // under a freshly-started one before the new file loads.
    setItems([]);
    setEvents([]);
    if (!workspaceRoot) return;

    const todoPath = `.agents/todos/${safeScope(conversationId)}.json`;
    async function load() {
      try {
        const raw = await invoke<string>("read_text_file", {
          workspaceRoot,
          path: `${workspaceRoot}/${todoPath}`,
        });
        const store: TodoStore = JSON.parse(raw);
        setItems(store.todos ?? []);
        setEvents(store.events ?? []);
      } catch {
        setItems([]);
        setEvents([]);
      }
    }

    load();
    intervalRef.current = setInterval(load, 3000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [workspaceRoot, conversationId]);

  useEffect(() => {
    setOpen(true);
    setDismissed(false);
  }, [conversationId]);

  const total = items.length;
  const done = items.filter((item) => item.done).length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  const recentEvents = [...events].sort((a, b) => b.seq - a.seq).slice(0, 5);
  const recentIds = new Set(recentEvents.map((event) => event.todo_id).filter(Boolean));
  const visibleItems = items;
  // Prefer the user's actual ask (the goal write-up) over the current step.
  const goal = goalProp?.replace(/\s+/g, " ").trim() || items[0]?.text || recentEvents[0]?.text || "Working through the plan";

  const allDone = total > 0 && done === total;
  const doneSignature = completionSignature(items, events);

  function dismissCompletedTodos() {
    if (allDone) rememberCompletedTodosDismissed(workspaceRoot, conversationId, doneSignature);
    setDismissed(true);
  }

  // When the plan finishes, collapse to the slim pill so the agent's final
  // output stays visible (a tall card would sit over it like a dark box). If
  // work resumes after a dismiss, bring the box back.
  useEffect(() => {
    if (allDone) setOpen(false);
    else setDismissed(false);
  }, [allDone]);

  useEffect(() => {
    if (!allDone) return;
    if (completedTodosWereDismissed(workspaceRoot, conversationId, doneSignature)) {
      setDismissed(true);
    }
  }, [allDone, workspaceRoot, conversationId, doneSignature]);

  const visible = !dismissed && !(total === 0 && recentEvents.length === 0);

  useEffect(() => {
    onDockHeightChange?.(visible ? (open ? 116 : 32) : 0);
  }, [visible, open, onDockHeightChange]);

  if (!visible) return null;

  if (!open) {
    return (
      <div style={dockWrap}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open agent todo panel"
          style={{
            ...glassCard,
            pointerEvents: "auto",
            width: "min(620px, calc(100% - 48px))",
            minHeight: 32,
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) minmax(32px, 26%) auto auto",
            alignItems: "center",
            gap: 12,
            padding: "6px 14px 7px 14px",
            borderRadius: "12px 12px 0 0",
            color: "var(--fg)",
            cursor: "pointer",
            textAlign: "left",
            animation: "klide-todo-collapse-in var(--motion-med) var(--ease-soft)",
          }}
        >
          <span style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0, whiteSpace: "nowrap" }}>
            <span style={{ color: "var(--fg-dim)", fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase" }}>
              Goal
            </span>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--fg-strong)", fontSize: 12, fontWeight: 460 }}>
              {goal}
            </span>
          </span>
          <ProgressBar percent={percent} />
          <span style={{ color: "var(--fg-subtle)", fontSize: 11.5, fontWeight: 500, fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}>
            {percent}%
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 2, color: "var(--fg-dim)" }}>
            <span style={{ display: "grid", placeItems: "center" }}>
              <ChevronIcon open={false} />
            </span>
            {allDone && (
              <span
                role="button"
                tabIndex={0}
                aria-label="Dismiss completed todo panel"
                onClick={(e) => { e.stopPropagation(); dismissCompletedTodos(); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); dismissCompletedTodos(); } }}
                style={{ width: 18, height: 18, display: "grid", placeItems: "center", cursor: "pointer" }}
              >
                <CloseIcon />
              </span>
            )}
          </span>
        </button>
      </div>
    );
  }

  return (
    <div style={dockWrap}>
      <section
        className="klide-todo-strip"
        aria-label="Agent todo progress"
        style={{
          ...glassCard,
          pointerEvents: "auto",
          position: "relative",
          width: "min(620px, calc(100% - 48px))",
          padding: "11px 16px 12px 18px",
          display: "grid",
          gridTemplateRows: "auto minmax(0, 1fr)",
          gap: 9,
          height: 116,
          overflow: "hidden",
          borderRadius: "14px 14px 0 0",
          animation: "klide-todo-open-in var(--motion-slow) var(--ease-soft)",
        }}
      >
        {/* header: GOAL · progress bar · percentage */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) minmax(32px, 30%) auto auto",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0, whiteSpace: "nowrap" }}>
            <span style={{ color: "var(--fg-dim)", fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase" }}>
              Goal
            </span>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--fg-strong)", fontSize: 12.5, fontWeight: 480 }}>
              {goal}
            </span>
          </span>
          <ProgressBar percent={percent} />
          <span style={{ color: "var(--fg-subtle)", fontSize: 11.5, fontWeight: 500, fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}>
            {percent}%
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 2 }}>
            <button
              onClick={() => setOpen(false)}
              aria-label="Collapse agent todo panel"
              style={{
                width: 18,
                height: 18,
                display: "grid",
                placeItems: "center",
                border: "none",
                background: "transparent",
                color: "var(--fg-dim)",
                cursor: "pointer",
              }}
            >
              <ChevronIcon open={true} />
            </button>
            {allDone && (
              <button
                onClick={dismissCompletedTodos}
                aria-label="Dismiss completed todo panel"
                style={{
                  width: 18,
                  height: 18,
                  display: "grid",
                  placeItems: "center",
                  border: "none",
                  background: "transparent",
                  color: "var(--fg-dim)",
                  cursor: "pointer",
                }}
              >
                <CloseIcon />
              </button>
            )}
          </span>
        </div>

        {/* scrollable list: left spine + oval checkboxes + ruled rows */}
        <div
          className="todo-scroll"
          style={{
            position: "relative",
            overflowY: "auto",
            padding: "1px 8px 1px 0",
          }}
        >
          {visibleItems.map((item, idx) => {
            const hot = recentIds.has(item.id);
            const active = !item.done && idx === visibleItems.findIndex((candidate) => !candidate.done);
            const isLast = idx === visibleItems.length - 1;
            const treeColor = active
              ? "color-mix(in srgb, var(--accent) 55%, transparent)"
              : "color-mix(in srgb, var(--fg-dim) 30%, transparent)";
            return (
              <div
                key={item.id}
                className={active ? "klide-todo-row-active" : undefined}
                style={{
                  position: "relative",
                  display: "grid",
                  gridTemplateColumns: "26px minmax(0, 1fr)",
                  alignItems: "center",
                  gap: 8,
                  minHeight: 20,
                }}
              >
                {/* tree spine — full height for ├, half (top→node) for └ on the last row */}
                <span
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: 9,
                    top: 0,
                    bottom: isLast ? "50%" : 0,
                    width: 1,
                    background: treeColor,
                  }}
                />
                {/* tree branch — horizontal tick from the spine to the node */}
                <span
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: 9,
                    width: 9,
                    top: "50%",
                    height: 1,
                    background: treeColor,
                  }}
                />
                <span
                  style={{
                    position: "relative",
                    zIndex: 1,
                    justifySelf: "end",
                    width: 11,
                    height: 13,
                    borderRadius: "50%",
                    display: "grid",
                    placeItems: "center",
                    background: item.done
                      ? "var(--accent)"
                      : active
                        ? "color-mix(in srgb, var(--accent) 9%, var(--bg-elevated))"
                        : "color-mix(in srgb, var(--bg-elevated) 76%, transparent)",
                    border: item.done
                      ? "none"
                      : active
                        ? "1.5px solid color-mix(in srgb, var(--accent) 74%, transparent)"
                        : "1.5px solid color-mix(in srgb, var(--fg-dim) 34%, transparent)",
                    color: item.done ? "var(--bg-elevated)" : "transparent",
                    transition: "background var(--motion-med) var(--ease-out), border-color var(--motion-med) var(--ease-out)",
                  }}
                >
                  {item.done && <CheckIcon />}
                </span>
                <span
                  style={{
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: 12.5,
                    lineHeight: "17px",
                    fontWeight: active ? 430 : hot && !item.done ? 420 : 400,
                    color: item.done ? "var(--fg-subtle)" : active ? "var(--fg-strong)" : "var(--fg)",
                    textDecoration: item.done ? "line-through" : "none",
                    textDecorationColor: item.done ? "color-mix(in srgb, var(--fg-dim) 62%, transparent)" : undefined,
                  }}
                >
                  {item.text}
                </span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
