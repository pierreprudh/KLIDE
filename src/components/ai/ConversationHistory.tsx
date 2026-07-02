import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import type { Conversation } from "./types";
import { relativeTime } from "./utils";

type Props = {
  conversations: Conversation[];
  currentId: string;
  historyOpen: boolean;
  setHistoryOpen: (open: boolean) => void;
  onSelect: (c: Conversation) => void;
  onDelete: (id: string, e: ReactMouseEvent) => void;
};

export function ConversationHistory({ conversations, currentId, historyOpen, setHistoryOpen, onSelect, onDelete }: Props) {
  const historyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!historyOpen) return;
    function onDown(e: MouseEvent) {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) setHistoryOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [historyOpen, setHistoryOpen]);

  return (
    <div ref={historyRef} style={{ display: "flex", alignItems: "center", gap: 2, position: "relative", textTransform: "none", letterSpacing: 0 }}>
      <button
        onClick={() => setHistoryOpen(!historyOpen)}
        title="Conversation history"
        aria-label="Conversation history"
        aria-expanded={historyOpen}
        style={{
          width: 26, height: 22, display: "grid", placeItems: "center", borderRadius: "var(--radius-sm)",
          color: historyOpen ? "var(--fg-strong)" : "var(--fg-subtle)", background: historyOpen ? "var(--bg-hover)" : "transparent",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--fg-strong)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { if (!historyOpen) { e.currentTarget.style.color = "var(--fg-subtle)"; e.currentTarget.style.background = "transparent"; } }}
      >
        <HistoryIcon />
      </button>

      {historyOpen && (
        <div
          className="floating-panel"
          onWheel={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            position: "absolute", top: "calc(100% + 6px)", right: 0, width: 264,
            maxHeight: "min(340px, calc(100vh - 96px))", overflow: "auto",
            overscrollBehavior: "contain", padding: 6, zIndex: 100,
          }}
        >
          {conversations.length === 0 ? (
            <div style={{ padding: "12px 8px", color: "var(--fg-subtle)", fontSize: 12, textAlign: "center" }}>
              No past conversations yet.
            </div>
          ) : (
            conversations.map((c) => {
              const current = c.id === currentId;
              return (
              <div
                key={c.id}
                onClick={() => onSelect(c)}
                aria-current={current || undefined}
                style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "7px 8px",
                  borderRadius: "var(--radius-sm)", cursor: "pointer",
                  background: current ? "var(--bg-selected)" : "transparent",
                  // The ongoing conversation reads as "you are here": an accent
                  // spine (inset shadow — no layout shift) + heavier title.
                  boxShadow: current ? "inset 2px 0 0 var(--accent)" : "none",
                }}
                onMouseEnter={(e) => { if (!current) e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = current ? "var(--bg-selected)" : "transparent"; }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: current ? 650 : 500, color: "var(--fg-strong)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {c.title}
                  </div>
                  <div
                    title={c.model ? `${c.model}` : undefined}
                    style={{ fontSize: 11, color: "var(--fg-subtle)", marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                  >
                    {current ? "Current · " : ""}{relativeTime(c.updatedAt)}{c.model ? ` · ${c.model}` : ""}
                  </div>
                </div>
                <button
                  onClick={(e) => onDelete(c.id, e)}
                  title="Delete conversation"
                  aria-label="Delete conversation"
                  style={{ flexShrink: 0, width: 22, height: 22, display: "grid", placeItems: "center", borderRadius: "var(--radius-xs)", color: "var(--fg-dim)" }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--fg-strong)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-dim)"; e.currentTarget.style.background = "transparent"; }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

function HistoryIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 1.8" />
    </svg>
  );
}
