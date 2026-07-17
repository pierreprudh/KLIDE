// FocusMode — the third main screen: a chat-first workspace in the Codex /
// Claude-desktop pattern, spoken in Klide's language. A quiet left rail
// (conversations grouped by project, profile at the foot), and a main canvas
// that is either the hero home (greeting + one large composer + pick-up-where-
// you-left-off cards) or the live conversation (the same fully-wired AiPanel
// instance the other layouts use, in its fullscreen "focus" design variant —
// centered reading column, roomier type — passed in via `renderChat`).
//
// Identity rules honoured here: bone surfaces, hairline borders, sage accent
// only, no chips/pills/status dots — state is plain text, middots, color, and
// a 2px spine. Motion is choreography, not decoration: the rail settles in
// from its hairline, hero elements rise in three beats (title → composer →
// cards, `klide-focus-rise`), and home ⇄ chat crossfades as one surface
// (`klide-focus-chat-in`). All of it collapses under prefers-reduced-motion.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Z } from "../zLayers";
import { loadConversations, relativeTime, isSubsequence } from "./ai/utils";
import type { Conversation } from "./ai/types";
import type { ProviderId } from "../agent/types";
import { PROVIDER_GROUPS, DEFAULT_MODELS, providerName } from "../agent/providers";
import { ModelPicker } from "./ai/ModelPicker";
import { ProviderLogo } from "./ai/icons";

type Props = {
  workspaceRoot: string | null;
  branch: string | null;
  /** Recent project roots (the same list the activity-bar popover shows). */
  projects: string[];
  chatActive: boolean;
  onSwitchProject: (root: string) => void;
  /** Back to the hero home — the next submit starts a fresh conversation. */
  onNewChat: () => void;
  onOpenConversation: (convo: Conversation) => void;
  onSubmit: (text: string) => void;
  onOpenMissionControl: () => void;
  renderChat: () => ReactNode;
  /** Race watch — one tab per racing agent over the chat canvas. Empty or
   *  absent means the normal single-conversation chat. The parent keeps every
   *  tab's panel mounted; this component only draws the strip. */
  raceTabs?: { panelId: string; label: string }[];
  activeRaceTab?: string | null;
  onSelectRaceTab?: (panelId: string) => void;
  /** "Ask both" — send one follow-up into every racer's conversation. */
  onRaceFollowUp?: (text: string) => void;
  /** Leave the race view — close the racers' panels and go back home. */
  onCloseRaceTabs?: () => void;
  /** Composer run settings — the same per-panel / per-model state the AI
   *  panel and Settings read (provider → model → effort → context). */
  provider: ProviderId;
  onProviderChange: (provider: ProviderId) => void;
  model: string;
  onModelChange: (model: string) => void;
  effort: string | undefined;
  onEffortChange: (effort: string | undefined) => void;
  contextWindow: number | undefined;
  onContextWindowChange: (window: number | undefined) => void;
};

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function initialsOf(name: string): string {
  const parts = name.replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/* ------------------------------------------------------------------ icons */

const iconProps = {
  width: 15,
  height: 15,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

function NewChatIcon() {
  return (
    <svg {...iconProps}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function BoardIcon() {
  return (
    <svg {...iconProps}>
      <rect x="3.5" y="4" width="17" height="16" rx="2" />
      <path d="M3.5 9h17" />
      <path d="M9.5 9v11" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg {...iconProps} width={14} height={14}>
      <path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg {...iconProps} width={14} height={14} strokeWidth={2}>
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  );
}

/* ---------------------------------------------------------------- sidebar */

// Rows follow the Settings sidebar design: 29px tall, radius 9, active =
// strong text + weight, inactive = subtle; hover fill only when inactive.
// No spine, no accent icons — weight and color carry "current".
function NavRow({
  icon,
  label,
  onClick,
  active = false,
  expanded,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  /** When defined, the row is a disclosure — a small chevron turns with it. */
  expanded?: boolean;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-current={active ? "true" : undefined}
      aria-expanded={expanded}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        width: "100%",
        height: 29,
        textAlign: "left",
        padding: "0 10px",
        borderRadius: 9,
        border: "1px solid transparent",
        background: hover && !active ? "var(--bg-hover)" : "transparent",
        color: active ? "var(--fg-strong)" : "var(--fg-subtle)",
        fontSize: 13,
        fontWeight: active ? 600 : 400,
        cursor: "pointer",
        transition:
          "background var(--motion-fast) var(--ease-out), color 0.15s var(--ease-out)",
      }}
    >
      <span style={{ width: 16, height: 16, display: "grid", placeItems: "center", flexShrink: 0 }}>
        {icon}
      </span>
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </span>
      {expanded !== undefined && (
        <svg
          width="9"
          height="9"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          style={{
            flexShrink: 0,
            opacity: 0.55,
            transform: expanded ? "rotate(90deg)" : "none",
            transition: "transform var(--motion-med) var(--ease-out)",
          }}
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
      )}
    </button>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: "0 10px",
        marginTop: 20,
        marginBottom: 5,
        fontSize: 9,
        letterSpacing: 0.4,
        textTransform: "uppercase",
        color: "var(--fg-dim)",
      }}
    >
      {children}
    </div>
  );
}

function ConvoRow({
  convo,
  onOpen,
  indent = false,
}: {
  convo: Conversation;
  onOpen: () => void;
  indent?: boolean;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={convo.title}
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 8,
        width: "100%",
        height: 27,
        textAlign: "left",
        padding: indent ? "0 10px 0 35px" : "0 10px",
        borderRadius: 9,
        border: "none",
        background: hover ? "var(--bg-hover)" : "transparent",
        color: hover ? "var(--fg-strong)" : "var(--fg-subtle)",
        fontSize: 12.5,
        cursor: "pointer",
        transition:
          "background var(--motion-fast) var(--ease-out), color 0.15s var(--ease-out)",
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          lineHeight: "27px",
        }}
      >
        {convo.title || "Untitled"}
      </span>
      <span style={{ flexShrink: 0, fontSize: 10.5, color: "var(--fg-dim)" }}>
        {relativeTime(convo.updatedAt)}
      </span>
    </button>
  );
}

/* ----------------------------------------------------------------- screen */

export function FocusMode({
  workspaceRoot,
  branch,
  projects,
  chatActive,
  onSwitchProject,
  onNewChat,
  onOpenConversation,
  onSubmit,
  onOpenMissionControl,
  renderChat,
  raceTabs,
  activeRaceTab,
  onSelectRaceTab,
  onRaceFollowUp,
  onCloseRaceTabs,
  provider,
  onProviderChange,
  model,
  onModelChange,
  effort,
  onEffortChange,
  contextWindow,
  onContextWindowChange,
}: Props) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  // "Ask both" strip composer — local draft, cleared on send.
  const [raceAsk, setRaceAsk] = useState("");
  const [username, setUsername] = useState<string>("");
  const [hostname, setHostname] = useState<string>("");
  const searchRef = useRef<HTMLInputElement>(null);
  // Several projects can hold their history open at once. The active project
  // opens itself; the rest remember their state for the session.
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    () => new Set(workspaceRoot ? [workspaceRoot] : [])
  );

  useEffect(() => {
    if (!workspaceRoot) return;
    setExpandedProjects((prev) => {
      if (prev.has(workspaceRoot)) return prev;
      const next = new Set(prev);
      next.add(workspaceRoot);
      return next;
    });
  }, [workspaceRoot]);

  function toggleProject(p: string) {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  useEffect(() => {
    invoke<{ username: string; hostname: string }>("app_user_info")
      .then((u) => {
        setUsername(u.username);
        setHostname(u.hostname);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  // Reload the conversation list whenever we come back to the home screen —
  // a chat that just happened should appear without a manual refresh.
  const convos = useMemo(
    () => loadConversations<Conversation>(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chatActive, searchOpen]
  );

  const projectName = workspaceRoot ? basename(workspaceRoot) : null;
  const convosByProject = useMemo(() => {
    const byProject = new Map<string, Conversation[]>();
    for (const c of convos) {
      if (!c.cwd) continue;
      const list = byProject.get(c.cwd);
      if (list) list.push(c);
      else byProject.set(c.cwd, [c]);
    }
    return byProject;
  }, [convos]);
  const projectConvos = useMemo(
    () => (workspaceRoot ? convosByProject.get(workspaceRoot) ?? [] : []),
    [convosByProject, workspaceRoot]
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return convos
      .filter(
        (c) =>
          (c.title || "").toLowerCase().includes(q) ||
          isSubsequence(q, (c.title || "").toLowerCase())
      )
      .slice(0, 20);
  }, [convos, query]);

  const searching = searchOpen && query.trim().length > 0;

  return (
    <div style={{ flex: 1, display: "flex", minWidth: 0, minHeight: 0 }}>
      {/* ── Left rail ─────────────────────────────────────────────── */}
      <aside
        className="klide-focus-rail"
        style={{
          width: 248,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          borderRight: "1px solid var(--border)",
          padding: "12px 8px 8px",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <NavRow icon={<NewChatIcon />} label="New chat" onClick={onNewChat} />
          <NavRow
            icon={<SearchIcon />}
            label="Search"
            active={searchOpen}
            onClick={() => {
              setSearchOpen((v) => !v);
              setQuery("");
            }}
          />
          <NavRow icon={<BoardIcon />} label="Mission Control" onClick={onOpenMissionControl} />
        </div>

        {searchOpen && (
          <input
            ref={searchRef}
            className="klide-focus-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSearchOpen(false);
                setQuery("");
              }
            }}
            placeholder="Search conversations…"
            style={{
              margin: "8px 2px 0",
              padding: "5px 9px",
              fontSize: 12,
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border)",
              background: "var(--bg-elevated)",
              color: "var(--fg-strong)",
              outline: "none",
            }}
          />
        )}

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", marginTop: 2 }}>
          {searching ? (
            <>
              <SectionLabel>Results</SectionLabel>
              {filtered.length === 0 ? (
                <div style={{ padding: "4px 10px", fontSize: 12, color: "var(--fg-dim)" }}>
                  No conversations match.
                </div>
              ) : (
                filtered.map((c) => (
                  <ConvoRow key={c.id} convo={c} onOpen={() => onOpenConversation(c)} />
                ))
              )}
            </>
          ) : (
            <>
              <SectionLabel>Projects</SectionLabel>
              {projects.length === 0 && (
                <div style={{ padding: "4px 10px", fontSize: 12, color: "var(--fg-dim)" }}>
                  Open a folder to start.
                </div>
              )}
              {projects.map((p) => {
                const isActive = p === workspaceRoot;
                const isExpanded = expandedProjects.has(p);
                const history = convosByProject.get(p) ?? [];
                return (
                  <div key={p}>
                    <NavRow
                      icon={<FolderIcon />}
                      label={basename(p)}
                      active={isActive}
                      expanded={isExpanded}
                      onClick={() => {
                        // Switching makes a project current; clicking the
                        // current one just folds its history open/closed.
                        if (isActive) toggleProject(p);
                        else onSwitchProject(p);
                      }}
                    />
                    {isExpanded &&
                      history
                        .slice(0, 8)
                        .map((c) => (
                          <ConvoRow
                            key={c.id}
                            convo={c}
                            indent
                            onOpen={() => onOpenConversation(c)}
                          />
                        ))}
                    {isExpanded && history.length === 0 && (
                      <div style={{ padding: "2px 10px 4px 35px", fontSize: 11.5, color: "var(--fg-dim)" }}>
                        No conversations yet.
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </div>

        {/* Profile foot — local identity, flat avatar (allowed circle). */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "10px 10px 4px",
            borderTop: "1px solid var(--border)",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 26,
              height: 26,
              borderRadius: "50%",
              flexShrink: 0,
              display: "grid",
              placeItems: "center",
              background: "var(--accent-soft)",
              color: "var(--fg-strong)",
              fontSize: 10.5,
            }}
          >
            {initialsOf(username || "?")}
          </span>
          <span style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
            <span
              style={{
                fontSize: 12.5,
                color: "var(--fg-strong)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {username || "Local profile"}
            </span>
            <span style={{ fontSize: 10.5, color: "var(--fg-dim)" }}>{hostname}</span>
          </span>
        </div>
      </aside>

      {/* ── Canvas ────────────────────────────────────────────────── */}
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {chatActive ? (
          <div
            className="klide-focus-chat-in"
            style={{
              flex: 1,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            {raceTabs && raceTabs.length > 0 && (
              /* Race watch — one soft-segment tab per racing agent: the same
                 design as the docked editor and Artifact Inspector strips.
                 The active tab carries a quiet neutral fill (the hover token,
                 not a saturated pill) as its only marker; the panels stay
                 mounted in the parent, this strip only picks which is
                 visible. */
              <div
                role="tablist"
                aria-label="Racing agents"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "0 16px",
                  height: 38,
                  flexShrink: 0,
                  borderBottom: "1px solid var(--border)",
                }}
              >
                {raceTabs.map((t) => {
                  const active = t.panelId === (activeRaceTab ?? raceTabs[0].panelId);
                  return (
                    <button
                      key={t.panelId}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => onSelectRaceTab?.(t.panelId)}
                      style={{
                        border: "none",
                        background: active ? "var(--bg-hover)" : "transparent",
                        font: "inherit",
                        fontSize: 12.5,
                        fontWeight: active ? 550 : 400,
                        color: active ? "var(--fg-strong)" : "var(--fg-subtle)",
                        padding: "0 10px",
                        height: 24,
                        borderRadius: "var(--radius-sm)",
                        cursor: "pointer",
                        transition:
                          "color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
                      }}
                      onMouseEnter={(e) => {
                        if (!active) {
                          e.currentTarget.style.color = "var(--fg-strong)";
                          e.currentTarget.style.background =
                            "color-mix(in srgb, var(--bg-hover) 45%, transparent)";
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!active) {
                          e.currentTarget.style.color = "var(--fg-subtle)";
                          e.currentTarget.style.background = "transparent";
                        }
                      }}
                    >
                      {t.label}
                    </button>
                  );
                })}
                {onRaceFollowUp && (
                  <input
                    value={raceAsk}
                    onChange={(e) => setRaceAsk(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      const t = raceAsk.trim();
                      if (!t) return;
                      onRaceFollowUp(t);
                      setRaceAsk("");
                    }}
                    placeholder={raceTabs.length > 1 ? "Ask both…" : "Ask the racer…"}
                    title="One follow-up, sent into every racer's conversation"
                    style={{
                      marginLeft: "auto",
                      width: 220,
                      fontSize: 12,
                      fontFamily: "inherit",
                      color: "var(--fg-strong)",
                      background: "var(--bg)",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-sm)",
                      padding: "4px 8px",
                      outline: "none",
                      transition: "border-color var(--motion-fast) var(--ease-out)",
                    }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = "var(--border-strong)"; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border)"; }}
                  />
                )}
                <button
                  type="button"
                  onClick={() => onCloseRaceTabs?.()}
                  title="Close the race view — both runs keep going and stay on Mission Control"
                  style={{
                    marginLeft: onRaceFollowUp ? undefined : "auto",
                    border: "none",
                    background: "transparent",
                    font: "inherit",
                    fontSize: 11.5,
                    color: "var(--fg-dim)",
                    padding: 0,
                    cursor: "pointer",
                    flexShrink: 0,
                    transition: "color var(--motion-fast) var(--ease-out)",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--fg-strong)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-dim)"; }}
                >
                  End watch
                </button>
              </div>
            )}
            {renderChat()}
          </div>
        ) : (
          <FocusHome
            projectName={projectName}
            branch={branch}
            recent={projectConvos.slice(0, 3)}
            onOpenConversation={onOpenConversation}
            onSubmit={onSubmit}
            provider={provider}
            onProviderChange={onProviderChange}
            model={model}
            onModelChange={onModelChange}
            effort={effort}
            onEffortChange={onEffortChange}
            contextWindow={contextWindow}
            onContextWindowChange={onContextWindowChange}
          />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ inline menu */

type MenuOption = {
  label: string;
  value: string | number | undefined;
  /** Non-clickable section eyebrow inside the menu (provider groups). */
  heading?: boolean;
  /** Per-row mark, in the ModelPicker idiom (provider logo, effort bars). */
  icon?: ReactNode;
  /** Quiet second line under the label. */
  caption?: string;
};

/** Reasoning-effort glyph — the AI panel's reflection-bars language: five
 *  bars, filled up to the chosen level; Auto shows them all at rest. */
function EffortBars({ level, size = 16 }: { level: number; size?: number }) {
  const heights = [5, 7, 9, 11, 13];
  return (
    <svg width={size} height={size * 0.875} viewBox="0 0 16 14" aria-hidden>
      {heights.map((h, i) => (
        <rect
          key={i}
          x={i * 3 + 0.5}
          y={13.5 - h}
          width="2"
          height={h}
          rx="1"
          fill="currentColor"
          opacity={level > 0 && i < level ? 0.9 : 0.28}
        />
      ))}
    </svg>
  );
}

/** Context-window glyph — a simple gauge arc in the same stroke language. */
function ContextGaugeIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M5 17a8 8 0 1 1 14 0" />
      <path d="M12 13l3.5-3.5" />
    </svg>
  );
}

/** A flat text trigger opening the AI panel's picker surface — the same
 *  design as the ModelPicker dropdown: glass card, framed-icon header with a
 *  caption, hairline dividers, icon rows with the accent-tint active state.
 *  Portalled to <body> so no ancestor clip can swallow it. */
function InlineMenu({
  label,
  display,
  options,
  selected,
  onSelect,
  mono = false,
  leading,
  header,
  width = 236,
  variant = "text",
  ringRatio = 0,
}: {
  label: string;
  display: string;
  options: MenuOption[];
  selected: string | number | undefined;
  onSelect: (value: string | number | undefined) => void;
  mono?: boolean;
  /** Optional glyph before the value (the provider trigger's logo). */
  leading?: ReactNode;
  /** The picker header: framed icon + title + quiet caption. */
  header: { icon: ReactNode; title: string; caption: string };
  width?: number;
  /** "ring" renders the AI panel's context-meter circle as the trigger —
   *  28px round button, border track ring, accent arc — instead of text.
   *  `ringRatio` (0..1) drives the arc; the panel floors it at 2 so the
   *  glyph always reads as a meter. */
  variant?: "text" | "ring";
  ringRatio?: number;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [focusIdx, setFocusIdx] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Portalled to <body> (fixed, measured from the trigger) so it escapes the
  // composer card's `overflow: hidden` clip — the same reason the AI panel
  // portals its ModelPicker and mode menus.
  const [menuPos, setMenuPos] = useState<{ bottom: number; left: number } | null>(null);

  function toggleMenu() {
    if (open) {
      setOpen(false);
      return;
    }
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(Math.round(r.left), window.innerWidth - width - 8));
    setMenuPos({ bottom: Math.round(window.innerHeight - r.top + 8), left });
    setFocusIdx(-1);
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const target = e.target as Node | null;
      if (rootRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const hasIcons = options.some((o) => !o.heading && o.icon);

  return (
    <div ref={rootRef} style={{ position: "relative", display: "flex", minWidth: 0 }}>
      {variant === "ring" ? (
        /* The AI panel's context-meter circle, verbatim: 28px round button,
           `--border` track ring, accent arc floored at 2% so the glyph
           always reads as a meter. */
        <button
          type="button"
          onClick={toggleMenu}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          aria-label={`${label} — ${display}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          title={`${label} · ${display}`}
          style={{
            width: 28,
            height: 28,
            flexShrink: 0,
            display: "grid",
            placeItems: "center",
            border: "none",
            borderRadius: "50%",
            background: open || hover ? "var(--bg-hover)" : "transparent",
            color: "var(--accent)",
            cursor: "pointer",
            transition:
              "background var(--motion-fast) var(--ease-out), color var(--motion-med) var(--ease-out)",
          }}
        >
          <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
            <circle cx="11" cy="11" r="7.5" fill="none" stroke="var(--border)" strokeWidth="1.6" />
            <circle
              cx="11"
              cy="11"
              r="7.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              pathLength="100"
              strokeDasharray={`${Math.max(2, Math.round(ringRatio * 100))} 100`}
              transform="rotate(-90 11 11)"
              style={{
                transition:
                  "stroke-dasharray var(--motion-med) var(--ease-out), stroke var(--motion-med) var(--ease-out)",
              }}
            />
          </svg>
        </button>
      ) : (
      <button
        type="button"
        onClick={toggleMenu}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={label}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          height: 24,
          border: "1px solid transparent",
          background: open ? "var(--bg-hover)" : "transparent",
          padding: "0 5px",
          borderRadius: "var(--radius-sm)",
          fontSize: 11,
          fontWeight: 500,
          fontFamily: mono ? "var(--font-mono)" : "inherit",
          color: open || hover ? "var(--fg-strong)" : "var(--fg-subtle)",
          cursor: "pointer",
          minWidth: 0,
          transition:
            "color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
        }}
      >
        {leading && <span style={{ display: "flex", flexShrink: 0 }}>{leading}</span>}
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 170,
          }}
        >
          {display}
        </span>
        <svg
          width="9"
          height="9"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          style={{
            flexShrink: 0,
            color: "var(--fg-dim)",
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform var(--motion-fast) var(--ease-out)",
          }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      )}
      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          role="listbox"
          aria-label={label}
          className="popover-enter"
          style={{
            position: "fixed",
            bottom: menuPos.bottom,
            left: menuPos.left,
            width,
            maxHeight: 340,
            display: "flex",
            flexDirection: "column",
            background: "var(--panel-glass)",
            border: "1px solid var(--panel-border)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--panel-shadow)",
            backdropFilter: "blur(22px) saturate(1.18)",
            WebkitBackdropFilter: "blur(22px) saturate(1.18)",
            overflow: "hidden",
            zIndex: Z.popover,
          }}
        >
          {/* Header — same frame as the ModelPicker's: a bordered icon tile,
              the menu's name, and a quiet caption. */}
          <div
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 9,
              padding: "10px 12px 9px",
              borderBottom: "1px solid var(--panel-border)",
              background: "color-mix(in srgb, var(--panel-highlight) 30%, transparent)",
            }}
          >
            <span
              style={{
                display: "grid",
                placeItems: "center",
                width: 26,
                height: 26,
                borderRadius: 8,
                background: "var(--bg-elevated)",
                border: "1px solid var(--border)",
                color: "var(--fg-subtle)",
                flexShrink: 0,
              }}
            >
              {header.icon}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: "var(--fg-strong)",
                  letterSpacing: "-0.005em",
                }}
              >
                {header.title}
              </div>
              <div style={{ fontSize: 10, color: "var(--fg-dim)", marginTop: 1 }}>
                {header.caption}
              </div>
            </div>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 4 }}>
            {options.map((o, idx) => {
              if (o.heading) {
                return (
                  <div
                    key={`h-${o.label}`}
                    style={{
                      padding: "7px 9px 3px",
                      fontSize: 9.5,
                      fontWeight: 600,
                      letterSpacing: "0.07em",
                      textTransform: "uppercase",
                      color: "var(--fg-dim)",
                    }}
                  >
                    {o.label}
                  </div>
                );
              }
              const active = o.value === selected;
              const focused = idx === focusIdx;
              return (
                <button
                  key={String(o.value)}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    setOpen(false);
                    onSelect(o.value);
                  }}
                  onMouseEnter={() => setFocusIdx(idx)}
                  onMouseLeave={() => setFocusIdx((i) => (i === idx ? -1 : i))}
                  style={{
                    display: "block",
                    width: "100%",
                    padding: "7px 9px",
                    border: "none",
                    borderRadius: "var(--radius-sm)",
                    background: active
                      ? "color-mix(in srgb, var(--accent-soft) 80%, transparent)"
                      : focused
                        ? "var(--bg-hover)"
                        : "transparent",
                    color: "var(--fg-strong)",
                    textAlign: "left",
                    cursor: "pointer",
                    transition: "background var(--motion-fast) var(--ease-out)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {hasIcons && (
                      <span
                        style={{
                          width: 20,
                          height: 20,
                          flexShrink: 0,
                          display: "grid",
                          placeItems: "center",
                          color: "var(--fg-subtle)",
                        }}
                      >
                        {o.icon}
                      </span>
                    )}
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontSize: 12,
                        fontWeight: active ? 550 : 500,
                        fontFamily: mono ? "var(--font-mono)" : "inherit",
                      }}
                    >
                      {o.label}
                    </span>
                  </div>
                  {o.caption && (
                    <div
                      style={{
                        marginTop: 2,
                        marginLeft: hasIcons ? 26 : 0,
                        fontSize: 10,
                        color: "var(--fg-dim)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {o.caption}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// Providers the hero can start a conversation on — the same groups the AI
// panel's picker shows, minus the not-yet-available rows. Each row carries
// its provider mark, ModelPicker-style.
const PROVIDER_OPTIONS: MenuOption[] = PROVIDER_GROUPS.flatMap((group) => {
  const items = group.items.filter((item) => item.available);
  if (items.length === 0) return [];
  return [
    { label: group.label, value: `__heading_${group.label}`, heading: true },
    ...items.map((item) => ({
      label: item.name,
      value: item.id,
      icon: <ProviderLogo id={item.id} size={17} />,
    })),
  ];
});

const EFFORT_LEVELS: { label: string; value: string | undefined; level: number; caption: string }[] = [
  { label: "Auto", value: undefined, level: 0, caption: "Provider default" },
  { label: "minimal", value: "minimal", level: 1, caption: "Smallest reasoning effort" },
  { label: "low", value: "low", level: 2, caption: "Lower reasoning effort" },
  { label: "medium", value: "medium", level: 3, caption: "Default reasoning effort" },
  { label: "high", value: "high", level: 4, caption: "Higher reasoning effort" },
  { label: "xhigh", value: "xhigh", level: 5, caption: "Highest reasoning effort" },
];

const EFFORT_OPTIONS: MenuOption[] = EFFORT_LEVELS.map((e) => ({
  label: e.label,
  value: e.value,
  caption: e.caption,
  icon: <EffortBars level={e.level} />,
}));

function effortLevelOf(effort: string | undefined): number {
  return EFFORT_LEVELS.find((e) => e.value === effort)?.level ?? 0;
}

const CONTEXT_OPTIONS: MenuOption[] = [
  { label: "Auto", value: undefined, caption: "Detected from the model" },
  { label: "8K", value: 8192 },
  { label: "16K", value: 16384 },
  { label: "32K", value: 32768 },
  { label: "64K", value: 65536 },
  { label: "128K", value: 131072 },
];

function contextLabel(window: number | undefined): string {
  if (window === undefined) return "auto ctx";
  return `${Math.round(window / 1024)}K ctx`;
}

/* ------------------------------------------------------------------- home */

const STARTERS: { title: string; sub: string; prompt: string }[] = [
  {
    title: "Explain this codebase",
    sub: "A guided tour of the structure and key modules",
    prompt: "Give me a tour of this codebase: the structure, the key modules, and how they fit together.",
  },
  {
    title: "Review my working diff",
    sub: "Look over uncommitted changes before a commit",
    prompt: "Review my uncommitted changes and point out bugs, risks, and cleanups before I commit.",
  },
  {
    title: "Plan a change",
    sub: "Turn an idea into concrete steps first",
    prompt: "Help me plan a change: ask me what I want to build, then propose concrete steps.",
  },
];

function FocusHome({
  projectName,
  branch,
  recent,
  onOpenConversation,
  onSubmit,
  provider,
  onProviderChange,
  model,
  onModelChange,
  effort,
  onEffortChange,
  contextWindow,
  onContextWindowChange,
}: {
  projectName: string | null;
  branch: string | null;
  recent: Conversation[];
  onOpenConversation: (convo: Conversation) => void;
  onSubmit: (text: string) => void;
  provider: ProviderId;
  onProviderChange: (provider: ProviderId) => void;
  model: string;
  onModelChange: (model: string) => void;
  effort: string | undefined;
  onEffortChange: (effort: string | undefined) => void;
  contextWindow: number | undefined;
  onContextWindowChange: (window: number | undefined) => void;
}) {
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // The model list for the chosen provider — the same discovery command the
  // AI panel and Settings use. Falls back to the provider's default so the
  // menu is never empty while a server is down.
  const [models, setModels] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const fallback = [model, DEFAULT_MODELS[provider]].filter(Boolean) as string[];
    setModels(Array.from(new Set(fallback)));
    invoke<string[]>("ai_provider_models", { provider })
      .then((list) => {
        if (!cancelled && Array.isArray(list) && list.length > 0) setModels(list);
      })
      .catch(() => {
        /* server down / no key — keep the fallback */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  useEffect(() => {
    taRef.current?.focus();
  }, []);

  function submit() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    onSubmit(text);
  }

  const canSend = draft.trim().length > 0;

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "32px 32px 40px",
      }}
    >
      <h1
        className="klide-focus-rise"
        style={{
          margin: "0 0 28px",
          fontSize: 26,
          fontWeight: 400,
          color: "var(--fg-strong)",
          textAlign: "center",
          letterSpacing: "-0.015em",
        }}
      >
        {projectName ? `What should we build in ${projectName}?` : "What should we build?"}
      </h1>

      {/* Composer — the AI panel's chatbox, verbatim: same card, same
          textarea metrics, same footer anatomy (hairline top rule, left
          identity, right controls), plus the provider trigger the hero
          needs. Model choice IS the panel's ModelPicker component. */}
      <div className="klide-focus-rise" data-beat="1" style={{ width: "min(660px, 100%)" }}>
        <div
          style={{
            position: "relative",
            border: `1px solid ${focused ? "var(--accent)" : "var(--border-strong)"}`,
            borderRadius: "var(--radius-lg)",
            background: "var(--bg-elevated)",
            boxShadow: focused
              ? "0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent), 0 4px 16px rgba(38, 38, 32, 0.08)"
              : "0 1px 3px rgba(38, 38, 32, 0.05)",
            transition:
              "border-color var(--motion-med) var(--ease-out), box-shadow var(--motion-med) var(--ease-out)",
          }}
        >
          <div style={{ overflow: "hidden", borderRadius: "var(--radius-lg)" }}>
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Ask anything…"
            rows={2}
            style={{
              width: "100%",
              minHeight: 52,
              maxHeight: 168,
              resize: "none",
              background: "transparent",
              border: "none",
              color: "var(--fg-strong)",
              font: "inherit",
              fontSize: 13.5,
              lineHeight: 1.55,
              padding: "12px 14px 8px",
              outline: "none",
              display: "block",
              boxSizing: "border-box",
            }}
          />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 6,
              padding: "6px 8px",
              borderTop: "1px solid color-mix(in srgb, var(--border) 30%, transparent)",
              flexWrap: "nowrap",
            }}
          >
            {/* Left: where this conversation will run — provider trigger in
                the panel's delegate-identity style (logo + name). */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: "0 0 auto" }}>
              <InlineMenu
                label="Provider"
                display={providerName(provider)}
                leading={<ProviderLogo id={provider} size={13} />}
                header={{
                  icon: <ProviderLogo id={provider} size={15} />,
                  title: "Provider",
                  caption: "Where this conversation runs",
                }}
                options={PROVIDER_OPTIONS}
                selected={provider}
                onSelect={(v) => {
                  if (typeof v === "string" && !v.startsWith("__heading_")) {
                    onProviderChange(v as ProviderId);
                  }
                }}
              />
            </div>
            {/* Right: model · effort · context · send — the panel's cluster. */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 2, flex: "1 1 auto", minWidth: 0 }}>
              <ModelPicker
                provider={provider}
                model={model}
                availableModels={models}
                disabled={false}
                onChange={onModelChange}
              />
              <InlineMenu
                label="Reasoning effort"
                display={effort ?? "auto"}
                leading={<EffortBars level={effortLevelOf(effort)} size={13} />}
                header={{
                  icon: <EffortBars level={effortLevelOf(effort)} />,
                  title: "Reasoning effort",
                  caption: "Applied per model, saved in harness settings",
                }}
                width={216}
                options={EFFORT_OPTIONS}
                selected={effort}
                onSelect={(v) => onEffortChange(v === undefined ? undefined : String(v))}
              />
              <InlineMenu
                label="Context window"
                display={contextLabel(contextWindow)}
                variant="ring"
                ringRatio={contextWindow ? contextWindow / 131072 : 0}
                header={{
                  icon: <ContextGaugeIcon />,
                  title: "Context window",
                  caption: "Override the auto-detected window",
                }}
                width={200}
                options={CONTEXT_OPTIONS}
                selected={contextWindow}
                onSelect={(v) => onContextWindowChange(typeof v === "number" ? v : undefined)}
              />
              <button
                type="button"
                onClick={submit}
                aria-label="Send"
                disabled={!canSend}
                style={{
                  width: 30,
                  height: 30,
                  flexShrink: 0,
                  marginLeft: 4,
                  display: "grid",
                  placeItems: "center",
                  borderRadius: "50%",
                  border: canSend ? "none" : "1px solid var(--border)",
                  background: canSend ? "var(--accent)" : "var(--bg-elevated)",
                  color: canSend ? "var(--control-primary-fg)" : "var(--fg-dim)",
                  cursor: canSend ? "pointer" : "default",
                  transition:
                    "background var(--motion-med) var(--ease-out), color var(--motion-med) var(--ease-out)",
                }}
              >
                <SendIcon />
              </button>
            </div>
          </div>
          </div>
        </div>

        {/* Context line — where this conversation will run. */}
        <div
          style={{
            marginTop: 12,
            display: "flex",
            justifyContent: "center",
            gap: 7,
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: "var(--fg-subtle)",
          }}
        >
          {projectName && <span>{projectName}</span>}
          {projectName && branch && <span style={{ color: "var(--fg-dim)" }}>·</span>}
          {branch && <span>{branch}</span>}
          {(projectName || branch) && <span style={{ color: "var(--fg-dim)" }}>·</span>}
          <span>working locally</span>
        </div>
      </div>

      {/* Pick-up cards: recent project conversations, else starters. */}
      <div
        className="klide-focus-rise"
        data-beat="2"
        style={{
          marginTop: 44,
          display: "flex",
          gap: 12,
          width: "min(760px, 100%)",
          justifyContent: "center",
          flexWrap: "wrap",
        }}
      >
        {(recent.length > 0
          ? recent.map((c) => ({
              key: c.id,
              title: c.title || "Untitled conversation",
              sub: `${relativeTime(c.updatedAt)} · resume`,
              onClick: () => onOpenConversation(c),
            }))
          : STARTERS.map((s) => ({
              key: s.title,
              title: s.title,
              sub: s.sub,
              onClick: () => onSubmit(s.prompt),
            }))
        ).map((card) => (
          <HomeCard key={card.key} title={card.title} sub={card.sub} onClick={card.onClick} />
        ))}
      </div>
    </div>
  );
}

function HomeCard({ title, sub, onClick }: { title: string; sub: string; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flex: "1 1 200px",
        maxWidth: 240,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 4,
        padding: "13px 14px",
        borderRadius: 12,
        border: `1px solid ${hover ? "var(--border-strong)" : "var(--border)"}`,
        background: hover ? "var(--bg-hover)" : "transparent",
        cursor: "pointer",
        textAlign: "left",
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
      }}
    >
      <span
        style={{
          fontSize: 12.5,
          color: "var(--fg-strong)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          maxWidth: "100%",
        }}
      >
        {title}
      </span>
      <span
        style={{
          fontSize: 11,
          color: "var(--fg-subtle)",
          lineHeight: 1.45,
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {sub}
      </span>
    </button>
  );
}
