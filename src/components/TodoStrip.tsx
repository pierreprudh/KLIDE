import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

type TodoItem = {
  id: string;
  text: string;
  done: boolean;
  created_at: number;
};

type TodoStore = {
  todos: TodoItem[];
  next_id: number;
};

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

export function TodoStrip({ workspaceRoot }: { workspaceRoot: string | null }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<TodoItem[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!workspaceRoot) { setItems([]); return; }
    async function load() {
      try {
        const raw = await invoke<string>("read_text_file", {
          workspaceRoot,
          path: `${workspaceRoot}/.agents/todos.json`,
        });
        const store: TodoStore = JSON.parse(raw);
        setItems(store.todos ?? []);
      } catch {
        setItems([]);
      }
    }
    load();
    intervalRef.current = setInterval(load, 3000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [workspaceRoot]);

  const total = items.length;
  const done = items.filter((i) => i.done).length;
  if (total === 0) return null;

  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      <button
        onClick={() => setOpen(!open)}
        aria-label={open ? "Hide todo list" : "Show todo list"}
        style={{
          height: 28, padding: "0 12px", width: "100%", display: "flex",
          alignItems: "center", gap: 7, fontSize: 11, fontWeight: 600,
          color: "var(--fg-subtle)", border: "none", background: "none",
          cursor: "pointer", letterSpacing: "0.04em", textTransform: "uppercase",
        }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <line x1="9" y1="9" x2="15" y2="9" /><line x1="9" y1="13" x2="15" y2="13" /><line x1="9" y1="17" x2="13" y2="17" />
        </svg>
        <span style={{ flex: 1, textAlign: "left" }}>Tasks</span>
        <span style={{ color: "var(--fg-dim)", fontWeight: 500 }}>
          {done}/{total}
        </span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
          style={{ transform: `rotate(${open ? 180 : 0}deg)`, transition: "transform 0.15s ease" }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div style={{ padding: "0 6px 6px", maxHeight: 160, overflow: "auto" }}>
          {items.map((item) => (
            <div key={item.id} style={{
              display: "flex", alignItems: "center", gap: 7,
              padding: "3px 6px", borderRadius: "var(--radius-xs)",
              fontSize: 12, color: item.done ? "var(--fg-dim)" : "var(--fg)",
              textDecoration: item.done ? "line-through" : "none",
              opacity: item.done ? 0.6 : 1,
            }}>
              <span style={{
                width: 16, height: 16, borderRadius: "var(--radius-xs)", flexShrink: 0,
                display: "grid", placeItems: "center",
                background: item.done ? "var(--accent)" : "var(--bg)",
                border: item.done ? "1px solid var(--accent)" : "1px solid var(--border)",
                color: item.done ? "#fff" : "transparent",
              }}>
                {item.done && <CheckIcon />}
              </span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {item.text}
              </span>
              <span style={{ marginLeft: "auto", color: "var(--fg-dim)", fontSize: 10, fontFamily: "var(--font-mono)" }}>
                {item.id}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
