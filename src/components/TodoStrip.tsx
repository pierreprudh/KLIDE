import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

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

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
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

function safeScope(scope: string): string {
  return scope.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function TodoStrip({
  workspaceRoot,
  conversationId,
}: {
  workspaceRoot: string | null;
  conversationId: string;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<TodoItem[]>([]);
  const [events, setEvents] = useState<TodoEvent[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!workspaceRoot) {
      setItems([]);
      setEvents([]);
      return;
    }

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
  }, [conversationId]);

  const total = items.length;
  const done = items.filter((item) => item.done).length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  const recentEvents = [...events].sort((a, b) => b.seq - a.seq).slice(0, 5);
  const recentIds = new Set(recentEvents.map((event) => event.todo_id).filter(Boolean));
  const visibleItems = items;
  const goal = items.find((item) => !item.done)?.text ?? items[0]?.text ?? recentEvents[0]?.text ?? "Working through the plan";

  if (total === 0 && recentEvents.length === 0) return null;

  if (!open) {
    return (
      <div style={{ marginBottom: -1 }}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open agent todo panel"
          style={{
            width: "min(780px, calc(100% - 88px))",
            minHeight: 32,
            margin: "0 auto",
            display: "grid",
            gridTemplateColumns: "minmax(140px, 1fr) minmax(120px, 30%) auto auto",
            alignItems: "center",
            gap: 8,
            padding: "5px 9px 5px 12px",
            borderRadius: "14px 14px 0 0",
            border: "1px solid color-mix(in srgb, var(--border-strong) 22%, transparent)",
            borderBottomColor: "transparent",
            background: "transparent",
            color: "var(--fg)",
            boxShadow: "none",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 }}>
            <span style={{ color: "var(--fg-strong)", fontSize: 11.5, fontWeight: 560, whiteSpace: "nowrap" }}>
              Goal:
            </span>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--fg-subtle)", fontSize: 11.5, fontWeight: 380 }}>
              {goal}
            </span>
          </span>
          <span
            aria-hidden
            style={{
              position: "relative",
              height: 6,
              overflow: "hidden",
              borderRadius: "var(--radius-sm)",
              border: "none",
              background: "color-mix(in srgb, var(--fg-dim) 12%, transparent)",
            }}
          >
            <span
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: 0,
                width: `${percent}%`,
                background: "color-mix(in srgb, var(--accent) 78%, transparent)",
                transition: "width var(--motion-med) var(--ease-out)",
              }}
            />
          </span>
          <span style={{ color: "var(--fg-subtle)", fontSize: 11.5, fontWeight: 500, fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}>
            {percent}%
          </span>
          <span style={{ color: "var(--fg-dim)", display: "grid", placeItems: "center" }}>
            <ChevronIcon open={false} />
          </span>
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        marginBottom: -1,
      }}
    >
      <section
        aria-label="Agent todo progress"
        style={{
          position: "relative",
          width: "min(780px, calc(100% - 88px))",
          margin: "0 auto",
          padding: "15px 22px 12px",
          display: "grid",
          gridTemplateRows: "auto minmax(0, 1fr)",
          gap: 12,
          height: 144,
          overflow: "hidden",
          borderRadius: "18px 18px 0 0",
          border: "1px solid color-mix(in srgb, var(--border-strong) 22%, transparent)",
          borderBottomColor: "transparent",
          background: "transparent",
          boxShadow: "none",
        }}
      >
        <button
          onClick={() => setOpen(false)}
          aria-label="Close agent todo panel"
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            width: 24,
            height: 24,
            display: "grid",
            placeItems: "center",
            borderRadius: "var(--radius-md)",
            border: "none",
            background: "transparent",
            color: "var(--fg-subtle)",
            cursor: "pointer",
          }}
        >
          <ChevronIcon open={true} />
        </button>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(180px, 1fr) minmax(220px, 38%) minmax(48px, auto)",
            alignItems: "center",
            gap: 18,
            paddingRight: 24,
          }}
        >
          <span style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 }}>
            <span style={{ color: "var(--fg-strong)", fontSize: 13.5, fontWeight: 560, letterSpacing: 0 }}>
              Goal:
            </span>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--fg-subtle)", fontSize: 12.5, fontWeight: 360 }}>
              {goal}
            </span>
          </span>
          <span style={{ display: "grid", gap: 5, minWidth: 0 }}>
            <span
              aria-hidden
              style={{
                position: "relative",
                height: 8,
                overflow: "hidden",
                borderRadius: 999,
                border: "none",
                background: "color-mix(in srgb, var(--fg-dim) 10%, transparent)",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: 0,
                  width: `${percent}%`,
                  background: "color-mix(in srgb, var(--accent) 76%, transparent)",
                  transition: "width var(--motion-med) var(--ease-out)",
                }}
              />
            </span>
          </span>
          <span style={{ color: "var(--fg-subtle)", fontSize: 12.5, fontWeight: 500, fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}>
            {percent}%
          </span>
        </div>

        <div
          style={{
            position: "relative",
            overflowY: "auto",
            padding: "0 10px 0 0",
            maxHeight: 80,
            scrollbarWidth: "thin",
          }}
        >
          <span
            aria-hidden
            style={{
              position: "absolute",
              left: 26,
              top: -4,
              bottom: 0,
              width: 1,
              background: "color-mix(in srgb, var(--danger) 42%, var(--border))",
              opacity: 0.72,
            }}
          />
          {visibleItems.map((item) => {
            const hot = recentIds.has(item.id);
            return (
              <div
                key={item.id}
                style={{
                  position: "relative",
                  display: "grid",
                  gridTemplateColumns: "52px minmax(0, 1fr)",
                  alignItems: "center",
                  gap: 12,
                  minHeight: 27,
                  color: item.done ? "var(--fg-subtle)" : "var(--fg)",
                }}
              >
                <span
                  style={{
                    position: "relative",
                    zIndex: 1,
                    justifySelf: "center",
                    width: 20,
                    height: 20,
                    borderRadius: "50%",
                    display: "grid",
                    placeItems: "center",
                    background: item.done ? "color-mix(in srgb, var(--accent) 12%, var(--bg-elevated))" : "color-mix(in srgb, var(--bg-elevated) 86%, transparent)",
                    border: item.done
                      ? "1px solid color-mix(in srgb, var(--accent) 58%, var(--border))"
                      : "1px solid color-mix(in srgb, var(--fg-dim) 28%, transparent)",
                    color: item.done ? "var(--accent)" : "transparent",
                  }}
                >
                  {item.done && <CheckIcon />}
                </span>
                <span
                  style={{
                    position: "relative",
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: 13,
                    lineHeight: "18px",
                    fontWeight: hot && !item.done ? 480 : 380,
                    opacity: item.done ? 0.7 : 1,
                    borderBottom: "1px solid color-mix(in srgb, var(--border-strong) 42%, transparent)",
                    paddingBottom: 3,
                  }}
                >
                  {item.done && (
                    <span
                      aria-hidden
                      style={{
                        position: "absolute",
                        left: 0,
                        right: 0,
                        top: "45%",
                        height: 1,
                        borderRadius: 999,
                        background: "color-mix(in srgb, var(--warning) 58%, transparent)",
                        opacity: 0.72,
                      }}
                    />
                  )}
                  <span style={{ position: "relative" }}>{item.text}</span>
                </span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
