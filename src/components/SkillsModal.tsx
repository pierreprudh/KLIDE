import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useFlipIndicator } from "../hooks/useFlipIndicator";
import { invoke } from "@tauri-apps/api/core";
import {
  type Skill,
  genSkillId,
  SKILL_TOOLS,
  getAvailableTools,
} from "../skills";

type Props = {
  open: boolean;
  skills: Skill[];
  onChange: (skills: Skill[]) => void;
  onReloadFilesystemSkills: () => Promise<void> | void;
  onClose: () => void;
};

type Tab = "skills" | "install" | "tools";

type Draft = {
  id: string | null;
  name: string;
  description: string;
  instructions: string;
  tools: string[];
};

type ToolEntry = { id: string; label: string; description: string };

/* ------------------------------------------------------------------ icons */

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.2-3.2" />
    </svg>
  );
}
function PlusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}
function EyeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  );
}
function CodeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 8l-4 4 4 4" />
      <path d="M15 8l4 4-4 4" />
    </svg>
  );
}
function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}
function ChevronRight() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function NavSkillsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7l8-4 8 4-8 4-8-4z" />
      <path d="M4 12l8 4 8-4" />
      <path d="M4 17l8 4 8-4" />
    </svg>
  );
}
function NavInstallIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4v12" />
      <path d="M6 10l6 6 6-6" />
      <path d="M5 20h14" />
    </svg>
  );
}
function NavToolsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14.7 6.3a4 4 0 0 1 5 5L9 22l-7-7L13.7 3.3a4 4 0 0 1 1 3z" />
    </svg>
  );
}

/* ------------------------------------------------------ tiny markdown view */

let mdKey = 0;
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out.push(<strong key={mdKey++} style={{ color: "var(--fg-strong)", fontWeight: 600 }}>{m[1]}</strong>);
    } else {
      out.push(
        <code key={mdKey++} className="klide-code-chip">{m[2]}</code>
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderMarkdown(text: string): ReactNode[] {
  mdKey = 0;
  const blocks: ReactNode[] = [];
  const segments = text.split("```");
  segments.forEach((seg, si) => {
    if (si % 2 === 1) {
      const nl = seg.indexOf("\n");
      const code = (nl >= 0 ? seg.slice(nl + 1) : seg).replace(/\n$/, "");
      blocks.push(
        <pre key={`c-${si}`} className="klide-paper" style={{ margin: "14px 0", padding: "14px 16px", overflowX: "auto", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.7, color: "var(--fg-strong)", whiteSpace: "pre" }}>
          {code}
        </pre>
      );
      return;
    }
    const lines = seg.split("\n");
    let para: string[] = [];
    let list: { ordered: boolean; items: string[] } | null = null;
    const flushPara = () => {
      if (!para.length) return;
      blocks.push(<p key={`p-${si}-${blocks.length}`} style={{ margin: "10px 0", lineHeight: 1.72, color: "var(--fg)", fontSize: 13.5, letterSpacing: "-0.002em" }}>{inline(para.join(" "))}</p>);
      para = [];
    };
    const flushList = () => {
      if (!list) return;
      const cur = list;
      const items = cur.items.map((it, i) => <li key={i} style={{ margin: "4px 0", lineHeight: 1.7, color: "var(--fg)" }}>{inline(it)}</li>);
      blocks.push(cur.ordered
        ? <ol key={`ol-${si}-${blocks.length}`} style={{ margin: "10px 0", paddingLeft: 22, color: "var(--fg)" }}>{items}</ol>
        : <ul key={`ul-${si}-${blocks.length}`} style={{ margin: "10px 0", paddingLeft: 22, color: "var(--fg)" }}>{items}</ul>);
      list = null;
    };
    for (const line of lines) {
      if (!line.trim()) { flushPara(); flushList(); continue; }
      const h = /^(#{1,3})\s+(.*)$/.exec(line);
      if (h) {
        flushPara(); flushList();
        const lvl = h[1].length;
        blocks.push(
          <div key={`h-${si}-${blocks.length}`} style={{ fontWeight: 600, fontSize: lvl === 1 ? 18 : lvl === 2 ? 15 : 13, color: "var(--fg-strong)", margin: lvl === 1 ? "22px 0 8px" : lvl === 2 ? "18px 0 6px" : "14px 0 4px", letterSpacing: "-0.012em" }}>
            {inline(h[2])}
          </div>
        );
        continue;
      }
      const ul = /^\s*[-*]\s+(.*)$/.exec(line);
      const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
      if (ul) { flushPara(); if (!list || list.ordered) { flushList(); list = { ordered: false, items: [] }; } list.items.push(ul[1]); continue; }
      if (ol) { flushPara(); if (!list || !list.ordered) { flushList(); list = { ordered: true, items: [] }; } list.items.push(ol[1]); continue; }
      para.push(line);
    }
    flushPara(); flushList();
  });
  return blocks;
}

/* --------------------------------------------------------------- shared UI */

const fieldStyle: CSSProperties = {
  width: "100%",
  background: "var(--bg-elevated)",
  border: "1px solid var(--border-strong)",
  borderRadius: "var(--radius-sm)",
  color: "var(--fg-strong)",
  font: "inherit",
  fontSize: 13,
  padding: "8px 10px",
  outline: "none",
  display: "block",
};
const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 10.5,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--fg-subtle)",
  marginBottom: 6,
  fontWeight: 600,
};

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={on ? "Enabled — click to disable" : "Disabled — click to enable"}
      onClick={onClick}
      style={{
        flexShrink: 0, width: 30, height: 18, borderRadius: 999, padding: 0, position: "relative",
        background: on ? "var(--accent)" : "var(--border-strong)",
        transition: "background var(--motion-med) var(--ease-out)",
      }}
    >
      <span style={{ position: "absolute", top: 2, left: on ? 14 : 2, width: 14, height: 14, borderRadius: "50%", background: "#fff", transition: "left var(--motion-med) var(--ease-out)" }} />
    </button>
  );
}

function NavRail({
  navItems, tab, onTabChange,
}: {
  navItems: { id: Tab; label: string; icon: ReactNode; count: number | null }[];
  tab: Tab;
  onTabChange: (t: Tab) => void;
}) {
  const flip = useFlipIndicator(tab, { size: 32, active: true });
  return (
    <div
      ref={flip.trackRef}
      className="klide-nav-rail-list"
      data-flip={flip.flip}
      style={{ position: "relative", display: "flex", flexDirection: "column" }}
    >
      {navItems.map((n) => {
        const active = tab === n.id;
        return (
          <button
            key={n.id}
            ref={flip.setItemRef(n.id)}
            onClick={() => onTabChange(n.id)}
            className="klide-nav-rail-item"
            data-active={active}
            aria-current={active ? "page" : undefined}
          >
            <span className="klide-nav-rail-icon">{n.icon}</span>
            <span>{n.label}</span>
            {n.count !== null && <span className="klide-nav-rail-count">{n.count}</span>}
          </button>
        );
      })}
      <span
        className="klide-nav-rail-indicator"
        style={flip.style}
        aria-hidden="true"
      />
    </div>
  );
}

function relTime(ts?: number): string {
  if (!ts) return "never edited";
  return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function iconBtn(active: boolean): CSSProperties {
  return { width: 28, height: 28, display: "grid", placeItems: "center", color: active ? "var(--fg-strong)" : "var(--fg-subtle)" };
}

function segBtn(active: boolean): CSSProperties {
  return { width: 28, height: 24, display: "grid", placeItems: "center", borderRadius: "var(--radius-xs)", color: active ? "var(--fg-strong)" : "var(--fg-subtle)", background: active ? "var(--bg-hover)" : "transparent" };
}

const codeInline: CSSProperties = {
  fontFamily: "var(--font-mono)", fontSize: 11.5,
  background: "var(--bg-elevated)", border: "1px solid var(--border)",
  borderRadius: "var(--radius-xs)", padding: "1px 5px", color: "var(--fg-strong)",
};

/* ============================================================ the modal ===*/

export function SkillsModal({ open, skills, onChange, onReloadFilesystemSkills, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("skills");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedTool, setSelectedTool] = useState<string>(SKILL_TOOLS[0]?.id ?? "");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [query, setQuery] = useState("");
  const [rawView, setRawView] = useState(false);
  const [installPkg, setInstallPkg] = useState("");
  const [installBusy, setInstallBusy] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installOk, setInstallOk] = useState<string | null>(null);
  const [tools, setTools] = useState<ToolEntry[]>(SKILL_TOOLS);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const live = await getAvailableTools();
      if (cancelled) return;
      setTools(live);
      setSelectedTool((prev) => (live.some((t) => t.id === prev) ? prev : (live[0]?.id ?? "")));
    })();
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (skills.length && !skills.some((s) => s.id === selectedId)) setSelectedId(skills[0].id);
  }, [open, skills, selectedId]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (draft) setDraft(null);
      else onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, draft, onClose]);

  const selected = skills.find((s) => s.id === selectedId) ?? null;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
  }, [skills, query]);

  const enabledCount = skills.filter((s) => s.enabled).length;
  const filesystemCount = skills.filter((s) => !!s.fromFile).length;

  if (!open) return null;

  function startCreate() {
    setDraft({ id: null, name: "", description: "", instructions: "", tools: tools.map((t) => t.id) });
  }
  function startEdit(s: Skill) {
    setDraft({ id: s.id, name: s.name, description: s.description, instructions: s.instructions, tools: [...s.tools] });
  }
  function saveDraft() {
    if (!draft || !draft.name.trim()) return;
    const fields = { name: draft.name.trim(), description: draft.description.trim(), instructions: draft.instructions, tools: draft.tools, updatedAt: Date.now() };
    if (draft.id === null) {
      const id = genSkillId();
      onChange([...skills, { id, ...fields, enabled: true }]);
      setSelectedId(id);
    } else {
      onChange(skills.map((s) => (s.id === draft.id ? { ...s, ...fields } : s)));
    }
    setDraft(null);
  }
  function toggleEnabled(id: string) {
    onChange(skills.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)));
  }
  function deleteSkill(s: Skill) {
    if (s.builtin) return;
    if (!window.confirm(`Delete the "${s.name}" skill?`)) return;
    onChange(skills.filter((x) => x.id !== s.id));
    if (draft?.id === s.id) setDraft(null);
  }

  const navItems: { id: Tab; label: string; icon: ReactNode; count: number | null }[] = [
    { id: "skills", label: "Skills", icon: <NavSkillsIcon />, count: skills.length },
    { id: "install", label: "Install", icon: <NavInstallIcon />, count: filesystemCount },
    { id: "tools", label: "Tools & MCP", icon: <NavToolsIcon />, count: tools.length },
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Skills"
      onClick={onClose}
      className="skills-tab-in"
      style={{
        position: "fixed", inset: 0, zIndex: 5000,
        display: "grid", placeItems: "center",
        background: "rgba(0,0,0,0.30)",
        backdropFilter: "blur(3px)",
      }}
    >
      <div
        className="floating-panel"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(1080px, calc(100vw - 80px))",
          height: "min(700px, calc(100vh - 80px))",
          borderRadius: "var(--radius-lg)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Top hero strip — title, subtitle, status counts, close */}
        <header
          style={{
            flexShrink: 0,
            height: 64,
            padding: "0 18px 0 24px",
            display: "flex",
            alignItems: "center",
            gap: 18,
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: "var(--fg-strong)", letterSpacing: "-0.012em" }}>
              Skills
            </div>
            <div style={{ fontSize: 11.5, color: "var(--fg-subtle)", marginTop: 2, fontFamily: "var(--font-mono)", letterSpacing: "0.02em" }}>
              {enabledCount} of {skills.length} enabled · {filesystemCount} from disk
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <button
            onClick={onClose}
            aria-label="Close"
            className="klide-button klide-button-ghost"
            style={{ minHeight: 30, padding: "0 10px" }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--fg-strong)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--fg-subtle)"; }}
          >
            <CloseIcon />
          </button>
        </header>

        {/* Body — left rail + main content */}
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          {/* Vertical nav rail */}
          <nav
            aria-label="Sections"
            style={{
              width: 200,
              flexShrink: 0,
              borderRight: "1px solid var(--border)",
              padding: "10px 0 14px",
              display: "flex",
              flexDirection: "column",
              background: "color-mix(in srgb, var(--bg) 88%, var(--bg-elevated))",
            }}
          >
            <div style={{ padding: "0 14px 8px", fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--fg-subtle)", fontWeight: 600 }}>
              Sections
            </div>
            <NavRail navItems={navItems} tab={tab} onTabChange={(t) => { setTab(t); setDraft(null); }} />
            <div style={{ flex: 1 }} />
            <div style={{ padding: "10px 14px 0", fontSize: 10.5, color: "var(--fg-dim)", lineHeight: 1.55, fontFamily: "var(--font-mono)" }}>
              <span style={{ color: "var(--fg-subtle)" }}>⌘</span> S to save · <span style={{ color: "var(--fg-subtle)" }}>esc</span> to close
            </div>
          </nav>

          {/* Main content area */}
          <main style={{ flex: 1, minWidth: 0, display: "flex" }} className="skills-tab-in" key={tab}>
            {tab === "skills" ? (
              <SkillsPane
                skills={skills}
                filtered={filtered}
                selected={selected}
                draft={draft}
                query={query}
                setQuery={setQuery}
                searchOpen={query.length > 0}
                onSelect={(id) => { setSelectedId(id); setDraft(null); setRawView(false); }}
                onCreate={startCreate}
                onToggleEnabled={toggleEnabled}
                onEdit={startEdit}
                onDelete={deleteSkill}
                onSaveDraft={saveDraft}
                onCancelDraft={() => setDraft(null)}
                setDraft={setDraft}
                rawView={rawView}
                setRawView={setRawView}
                tools={tools}
              />
            ) : tab === "install" ? (
              <InstallView
                skills={skills}
                pkg={installPkg}
                setPkg={setInstallPkg}
                busy={installBusy}
                error={installError}
                ok={installOk}
                onInstall={async () => {
                  const trimmed = installPkg.trim();
                  if (!trimmed || installBusy) return;
                  setInstallBusy(true);
                  setInstallError(null);
                  setInstallOk(null);
                  try {
                    type R = { ok: boolean; exitCode: number | null; stdout: string; stderr: string };
                    const r = (await invoke("install_skill", { package: trimmed })) as R;
                    if (!r.ok) {
                      const msg = (r.stderr || r.stdout || `Exit ${r.exitCode ?? "?"}`).trim();
                      setInstallError(msg || "Install failed.");
                    } else {
                      setInstallOk(r.stdout.trim() || "Installed.");
                      setInstallPkg("");
                      await onReloadFilesystemSkills();
                    }
                  } catch (e) {
                    setInstallError(String(e));
                  } finally {
                    setInstallBusy(false);
                  }
                }}
                onUninstall={async (name: string) => {
                  if (!window.confirm(`Uninstall "${name}"? This removes ~/.claude/skills/${name}.`)) return;
                  setInstallBusy(true);
                  setInstallError(null);
                  setInstallOk(null);
                  try {
                    type R = { ok: boolean; exitCode: number | null; stdout: string; stderr: string };
                    const r = (await invoke("uninstall_skill", { name })) as R;
                    if (!r.ok) setInstallError((r.stderr || r.stdout || "Uninstall failed.").trim());
                    else {
                      setInstallOk(r.stdout.trim() || "Uninstalled.");
                      await onReloadFilesystemSkills();
                    }
                  } catch (e) {
                    setInstallError(String(e));
                  } finally {
                    setInstallBusy(false);
                  }
                }}
              />
            ) : (
              <ToolsView skills={skills} selectedTool={selectedTool} setSelectedTool={setSelectedTool} tools={tools} />
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

/* ============================================================ Skills pane */

function SkillsPane({
  filtered, selected, draft, query, setQuery, onSelect, onCreate,
  onToggleEnabled, onEdit, onDelete, onSaveDraft, onCancelDraft, setDraft,
  rawView, setRawView, tools,
}: {
  skills: Skill[];
  filtered: Skill[];
  selected: Skill | null;
  draft: Draft | null;
  query: string;
  setQuery: (s: string) => void;
  searchOpen: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onToggleEnabled: (id: string) => void;
  onEdit: (s: Skill) => void;
  onDelete: (s: Skill) => void;
  onSaveDraft: () => void;
  onCancelDraft: () => void;
  setDraft: (d: Draft | null) => void;
  rawView: boolean;
  setRawView: (v: boolean) => void;
  tools: ToolEntry[];
}) {
  return (
    <>
      {/* Skill list */}
      <aside
        aria-label="Skill list"
        style={{
          width: 280, flexShrink: 0,
          borderRight: "1px solid var(--border)",
          display: "flex", flexDirection: "column", minHeight: 0,
        }}
      >
        <div style={{ flexShrink: 0, padding: "12px 12px 8px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ flex: 1, fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--fg-subtle)", fontWeight: 600 }}>
              All skills
            </span>
            <button onClick={() => setQuery(query ? "" : " ")} aria-label="Search" style={iconBtn(query.length > 0)}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--fg-strong)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = query.length > 0 ? "var(--fg-strong)" : "var(--fg-subtle)")}>
              <SearchIcon />
            </button>
            <button onClick={onCreate} aria-label="New skill" title="New skill" style={iconBtn(false)}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--fg-strong)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--fg-subtle)")}>
              <PlusIcon />
            </button>
          </div>
          {query.length > 0 && (
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter skills…"
              style={{ ...fieldStyle, padding: "6px 10px", fontSize: 12.5 }}
            />
          )}
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: "0 8px 12px", minHeight: 0 }}>
          {filtered.length === 0 && (
            <div style={{ padding: "18px 12px", color: "var(--fg-subtle)", fontSize: 12.5, textAlign: "center" }}>
              {query ? "No skills match." : "No skills yet."}
            </div>
          )}
          {filtered.map((s) => {
            const active = !draft && selected !== null && s.id === selected.id;
            return (
              <button
                key={s.id}
                onClick={() => onSelect(s.id)}
                className="klide-skill-row"
                data-active={active}
                data-disabled={!s.enabled}
                aria-current={active ? "true" : undefined}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, color: "var(--fg-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", letterSpacing: "-0.005em" }}>
                    {s.name || "Untitled"}
                  </span>
                  <span onClick={(e) => e.stopPropagation()} style={{ display: "flex" }}>
                    <Toggle on={s.enabled} onClick={() => onToggleEnabled(s.id)} label={`${s.enabled ? "Disable" : "Enable"} ${s.name}`} />
                  </span>
                </div>
                {s.description && (
                  <div style={{ fontSize: 11.5, color: "var(--fg-subtle)", marginTop: 4, lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                    {s.description}
                  </div>
                )}
                <div style={{ marginTop: 7, display: "flex", alignItems: "center", gap: 8 }}>
                  {s.fromFile && (
                    <span style={{ fontSize: 10, color: "var(--fg-dim)", fontFamily: "var(--font-mono)", letterSpacing: "0.02em" }}>
                      {groupBadge(s)}
                    </span>
                  )}
                  {s.builtin && <span style={pillStyle()}>Built-in</span>}
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 10.5, color: "var(--fg-dim)", fontFamily: "var(--font-mono)" }}>
                    {s.tools.length}/{tools.length} tools
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      {/* Detail / form */}
      <div style={{ flex: 1, minWidth: 0, overflow: "auto" }} className="skills-tab-in" key={String(draft?.id ?? "view")}>
        {draft ? (
          <SkillForm draft={draft} setDraft={setDraft} onSave={onSaveDraft} onCancel={onCancelDraft} tools={tools} />
        ) : selected ? (
          <SkillDetail
            skill={selected}
            rawView={rawView}
            setRawView={setRawView}
            onToggle={() => onToggleEnabled(selected.id)}
            onEdit={() => onEdit(selected)}
            onDelete={() => onDelete(selected)}
            tools={tools}
          />
        ) : (
          <EmptyDetail onCreate={onCreate} />
        )}
      </div>
    </>
  );
}

function groupBadge(s: Skill): string {
  if (s.group) return s.group;
  return s.fromFile ? "Local" : "Custom";
}

function pillStyle(): CSSProperties {
  return { fontSize: 9.5, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--fg-dim)", border: "1px solid var(--border)", borderRadius: "var(--radius-xs)", padding: "1px 5px", fontWeight: 500 };
}

/* ----------------------------------------------------------- detail (view) */

function SkillDetail({
  skill, rawView, setRawView, onToggle, onEdit, onDelete, tools,
}: {
  skill: Skill;
  rawView: boolean;
  setRawView: (v: boolean) => void;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  tools: ToolEntry[];
}) {
  const instr = skill.instructions.trim();
  const lineCount = instr ? instr.split("\n").length : 0;
  const charCount = instr.length;
  return (
    <div style={{ padding: "32px 36px", maxWidth: 780 }}>
      {/* Title row */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1 style={{ flex: 1, minWidth: 0, margin: 0, fontSize: 22, fontWeight: 600, color: "var(--fg-strong)", letterSpacing: "-0.018em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {skill.name}
        </h1>
        <Toggle on={skill.enabled} onClick={onToggle} label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`} />
        <div style={{ width: 1, height: 18, background: "var(--border)" }} />
        <button onClick={onEdit} aria-label="Edit skill" title="Edit skill" className="klide-button klide-button-ghost" style={{ minHeight: 30, padding: "0 8px", color: "var(--fg-subtle)" }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--fg-strong)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-subtle)"; e.currentTarget.style.background = "transparent"; }}>
          <PencilIcon />
        </button>
        {!skill.builtin && (
          <button onClick={onDelete} aria-label="Delete skill" title="Delete skill" className="klide-button klide-button-ghost" style={{ minHeight: 30, padding: "0 8px", color: "var(--fg-subtle)" }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "#A8514A"; e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-subtle)"; e.currentTarget.style.background = "transparent"; }}>
            <TrashIcon />
          </button>
        )}
      </div>

      {/* Meta strip */}
      <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", fontSize: 12, color: "var(--fg-subtle)" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-dim)" }}>{skill.builtin ? "built-in" : skill.fromFile ? "from file" : "custom"}</span>
        <Dot />
        <span>Updated {relTime(skill.updatedAt)}</span>
        <Dot />
        <span>{skill.tools.length} of {tools.length} tools allowed</span>
        {skill.fromFile && (<>
          <Dot />
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 320 }} title={skill.fromFile}>
            {shortenPath(skill.fromFile)}
          </span>
        </>)}
      </div>

      {/* Quote */}
      {skill.description && (
        <blockquote className="klide-quote" style={{ marginTop: 22 }}>
          {skill.description}
        </blockquote>
      )}

      {/* Allowed tools grid */}
      {skill.tools.length > 0 && (
        <section style={{ marginTop: 28 }}>
          <SectionLabel>Allowed tools</SectionLabel>
          <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 6 }}>
            {skill.tools.map((id) => {
              return (
                <div key={id} className="klide-status-chip" style={{ minHeight: 26, padding: "0 9px", fontSize: 11.5, fontFamily: "var(--font-mono)", color: "var(--fg)" }}>
                  {id}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Instructions paper card */}
      <section style={{ marginTop: 32 }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <SectionLabel>Instructions</SectionLabel>
          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", gap: 2 }}>
            <button onClick={() => setRawView(false)} aria-label="Preview" title="Preview" style={segBtn(!rawView)}><EyeIcon /></button>
            <button onClick={() => setRawView(true)} aria-label="Source" title="Source" style={segBtn(rawView)}><CodeIcon /></button>
          </div>
        </div>
        <div className="klide-paper" style={{ marginTop: 10 }}>
          <div className="klide-paper-header">
            <span style={{ textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--fg-subtle)" }}>SKILL.md</span>
            <span style={{ flex: 1 }} />
            <span style={{ color: "var(--fg-dim)" }}>{lineCount} {lineCount === 1 ? "line" : "lines"}</span>
            <span style={{ color: "var(--fg-dim)" }}>·</span>
            <span style={{ color: "var(--fg-dim)" }}>{charCount} chars</span>
          </div>
          <div style={{ padding: "22px 26px" }}>
            {instr === "" ? (
              <div style={{ color: "var(--fg-subtle)", fontSize: 13 }}>No instructions yet.</div>
            ) : rawView ? (
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.7, color: "var(--fg)" }}>{skill.instructions}</pre>
            ) : (
              <div>{renderMarkdown(skill.instructions)}</div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span style={{ ...labelStyle, marginBottom: 0, display: "inline-flex", alignItems: "center", gap: 6 }}>
      {children}
      <ChevronRight />
    </span>
  );
}

function Dot() {
  return <span style={{ width: 3, height: 3, borderRadius: "50%", background: "var(--fg-dim)", display: "inline-block" }} />;
}

// Shortens a user's home path to "~" for display. The webview has no
// access to process.env, so we just sniff the standard macOS / Linux
// home prefixes.
function shortenPath(p: string): string {
  if (!p) return p;
  if (p.startsWith("/Users/")) {
    const rest = p.slice("/Users/".length);
    const slash = rest.indexOf("/");
    return slash >= 0 ? `~${rest.slice(slash)}` : p;
  }
  if (p.startsWith("/home/")) {
    const rest = p.slice("/home/".length);
    const slash = rest.indexOf("/");
    return slash >= 0 ? `~${rest.slice(slash)}` : p;
  }
  return p;
}

function EmptyDetail({ onCreate }: { onCreate: () => void }) {
  return (
    <div style={{ height: "100%", display: "grid", placeItems: "center", color: "var(--fg-subtle)", textAlign: "center", padding: 40 }}>
      <div style={{ maxWidth: 320 }}>
        <div style={{ width: 44, height: 44, borderRadius: "var(--radius-md)", background: "var(--bg-elevated)", border: "1px solid var(--border)", display: "grid", placeItems: "center", margin: "0 auto 14px", color: "var(--fg-subtle)" }}>
          <NavSkillsIcon />
        </div>
        <div style={{ color: "var(--fg-strong)", marginBottom: 6, fontSize: 14, fontWeight: 600 }}>No skill selected</div>
        <div style={{ fontSize: 12.5, lineHeight: 1.55, color: "var(--fg-subtle)", marginBottom: 16 }}>
          Pick a skill from the list to see its instructions and tools, or create a new one.
        </div>
        <button onClick={onCreate} className="klide-button klide-button-secondary" style={{ minHeight: 32, padding: "0 14px" }}>
          <PlusIcon /> New skill
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ detail (form) */

function SkillForm({
  draft, setDraft, onSave, onCancel, tools,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
  tools: ToolEntry[];
}) {
  const canSave = draft.name.trim().length > 0;
  function toggleTool(id: string) {
    setDraft({ ...draft, tools: draft.tools.includes(id) ? draft.tools.filter((t) => t !== id) : [...draft.tools, id] });
  }
  return (
    <div style={{ padding: "32px 36px", maxWidth: 720 }}>
      <h2 style={{ margin: "0 0 22px", fontSize: 19, fontWeight: 600, color: "var(--fg-strong)", letterSpacing: "-0.014em" }}>
        {draft.id === null ? "New skill" : "Edit skill"}
      </h2>
      <div style={{ marginBottom: 18 }}>
        <label style={labelStyle} htmlFor="sf-name">Name</label>
        <input id="sf-name" autoFocus value={draft.name} placeholder="e.g. linkedin-weekly-post" onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={fieldStyle} />
      </div>
      <div style={{ marginBottom: 18 }}>
        <label style={labelStyle} htmlFor="sf-desc">Description</label>
        <input id="sf-desc" value={draft.description} placeholder="When the assistant should use this skill" onChange={(e) => setDraft({ ...draft, description: e.target.value })} style={fieldStyle} />
      </div>
      <div style={{ marginBottom: 22 }}>
        <label style={labelStyle} htmlFor="sf-inst">Instructions</label>
        <textarea
          id="sf-inst"
          value={draft.instructions}
          placeholder="What the assistant should do — markdown supported…"
          onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
          rows={12}
          style={{ ...fieldStyle, minHeight: 260, resize: "vertical", lineHeight: 1.7, fontFamily: "var(--font-mono)", fontSize: 12.5 }}
        />
      </div>
      <div style={{ marginBottom: 24 }}>
        <label style={labelStyle}>Tools</label>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6, marginTop: 8 }}>
          {tools.map((tool) => {
            const checked = draft.tools.includes(tool.id);
            return (
              <button
                key={tool.id}
                role="checkbox"
                aria-checked={checked}
                onClick={() => toggleTool(tool.id)}
                className="klide-tool-card"
                data-checked={checked}
              >
                <span aria-hidden="true" className="klide-tool-check">
                  {checked && (
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12l5 5L20 6" />
                    </svg>
                  )}
                </span>
                <span style={{ minWidth: 0 }}>
                  <span className="klide-tool-name">{tool.id}</span>
                  <span className="klide-tool-desc">{tool.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          onClick={onSave}
          disabled={!canSave}
          className={canSave ? "klide-button klide-button-primary" : "klide-button klide-button-secondary"}
          style={{ minHeight: 32, padding: "0 16px" }}
        >
          {draft.id === null ? "Create skill" : "Save changes"}
        </button>
        <button onClick={onCancel} className="klide-button klide-button-ghost" style={{ minHeight: 32, padding: "0 12px", color: "var(--fg-subtle)" }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--fg-strong)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-subtle)"; }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- Tools & MCP ---*/

const WRITE_TOOL_IDS = new Set(["write_file", "create_file", "create_skill"]);

function ToolsView({
  skills, selectedTool, setSelectedTool, tools,
}: {
  skills: Skill[];
  selectedTool: string;
  setSelectedTool: (id: string) => void;
  tools: ToolEntry[];
}) {
  const tool = tools.find((t) => t.id === selectedTool) ?? tools[0];
  const usedBy = tool ? skills.filter((s) => s.tools.includes(tool.id)) : [];
  const readOnly = tools.filter((t) => !WRITE_TOOL_IDS.has(t.id));
  const write = tools.filter((t) => WRITE_TOOL_IDS.has(t.id));
  return (
    <>
      <aside
        aria-label="Tool list"
        style={{
          width: 280, flexShrink: 0,
          borderRight: "1px solid var(--border)",
          display: "flex", flexDirection: "column", minHeight: 0,
        }}
      >
        <div style={{ padding: "12px 12px 8px", fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--fg-subtle)", fontWeight: 600 }}>
          Read-only · {readOnly.length}
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: "0 8px 8px", minHeight: 0 }}>
          {readOnly.map((t) => toolButton(t, selectedTool, setSelectedTool))}
          <div style={{ padding: "16px 6px 8px", fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--fg-subtle)", fontWeight: 600 }}>
            Write · diff review · {write.length}
          </div>
          {write.map((t) => toolButton(t, selectedTool, setSelectedTool))}
          <div style={{ padding: "16px 6px 8px", fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--fg-subtle)", fontWeight: 600 }}>
            MCP servers
          </div>
          <div style={{ padding: "4px 6px 8px", fontSize: 12, color: "var(--fg-dim)", lineHeight: 1.55 }}>
            None connected yet.
          </div>
        </div>
      </aside>

      <div style={{ flex: 1, minWidth: 0, overflow: "auto" }} className="skills-tab-in" key={selectedTool}>
        {tool ? (
          <div style={{ padding: "32px 36px", maxWidth: 720 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
              <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: "var(--fg-strong)", fontFamily: "var(--font-mono)", letterSpacing: "-0.01em" }}>
                {tool.id}
              </h2>
              <span className="klide-status-chip" style={{ minHeight: 22, padding: "0 8px", fontSize: 10.5, fontFamily: "var(--font-mono)" }}>
                {WRITE_TOOL_IDS.has(tool.id) ? "Write" : "Read-only"}
              </span>
            </div>
            <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 18 }}>
              <MetaCell label="Label">{tool.label}</MetaCell>
              <MetaCell label="Source">Built-in</MetaCell>
              <MetaCell label="Used by">{usedBy.length} {usedBy.length === 1 ? "skill" : "skills"}</MetaCell>
            </div>
            <p style={{ margin: "18px 0 0", fontSize: 13.5, lineHeight: 1.65, color: "var(--fg)" }}>
              {tool.description}
            </p>
            <div className="klide-paper" style={{ marginTop: 24 }}>
              <div className="klide-paper-header">
                <span style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>Enabled in</span>
              </div>
              <div style={{ padding: "14px 18px" }}>
                {usedBy.length === 0 ? (
                  <div style={{ fontSize: 13, color: "var(--fg-subtle)" }}>No skills currently allow this tool.</div>
                ) : (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {usedBy.map((s) => (
                      <span key={s.id} className="klide-status-chip" style={{ minHeight: 26, padding: "0 9px", fontSize: 11.5 }}>
                        {s.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div style={{ marginTop: 18, fontSize: 12, color: "var(--fg-dim)", lineHeight: 1.6 }}>
              MCP server support is planned — once connected, their tools will appear here alongside the built-ins.
            </div>
          </div>
        ) : (
          <div style={{ padding: 40, color: "var(--fg-subtle)", textAlign: "center" }}>No tools available.</div>
        )}
      </div>
    </>
  );
}

function toolButton(
  t: ToolEntry,
  selectedTool: string,
  setSelectedTool: (id: string) => void,
) {
  const active = t.id === selectedTool;
  return (
    <button
      key={t.id}
      onClick={() => setSelectedTool(t.id)}
      className="klide-skill-row"
      data-active={active}
      style={{ marginBottom: 2, padding: "7px 12px 7px 15px" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: active ? 600 : 500, color: active ? "var(--fg-strong)" : "var(--fg)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {t.id}
        </span>
      </div>
    </button>
  );
}

function MetaCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ ...labelStyle, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 13.5, color: "var(--fg-strong)", fontWeight: 500 }}>{children}</div>
    </div>
  );
}

/* --------------------------------------------------------------- Install ---*/

const GROUP_ORDER = [
  "Workspace (auto-generated)",
  "Workspace",
  "Personal",
  "Anthropic",
  "Matt Pocock",
  "Vercel",
];
function sortGroupIndex(label: string): number {
  const i = GROUP_ORDER.indexOf(label);
  if (i >= 0) return i;
  return GROUP_ORDER.length;
}
function groupedInstalled(skills: Skill[]): { group: string; items: Skill[] }[] {
  const buckets = new Map<string, Skill[]>();
  for (const s of skills) {
    const g = s.group ?? "Other";
    const arr = buckets.get(g);
    if (arr) arr.push(s);
    else buckets.set(g, [s]);
  }
  const entries = Array.from(buckets.entries()).map(([group, items]) => ({ group, items }));
  entries.sort((a, b) => {
    const da = sortGroupIndex(a.group);
    const db = sortGroupIndex(b.group);
    if (da !== db) return da - db;
    if (da === GROUP_ORDER.length) return a.group.localeCompare(b.group);
    return 0;
  });
  for (const e of entries) e.items.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

function InstallView({
  skills, pkg, setPkg, busy, error, ok, onInstall, onUninstall,
}: {
  skills: Skill[];
  pkg: string;
  setPkg: (s: string) => void;
  busy: boolean;
  error: string | null;
  ok: string | null;
  onInstall: () => void;
  onUninstall: (name: string) => void;
}) {
  const installedFromFile = skills.filter((s) => s.fromFile);
  const trimmed = pkg.trim();
  return (
    <div style={{ flex: 1, minWidth: 0, overflow: "auto" }} className="skills-tab-in">
      <div style={{ padding: "32px 36px", maxWidth: 760 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: "var(--fg-strong)", letterSpacing: "-0.018em" }}>
          Install a skill
        </h1>
        <p style={{ margin: "8px 0 0", fontSize: 13.5, lineHeight: 1.6, color: "var(--fg)" }}>
          Paste a GitHub package — e.g. <code style={codeInline}>anthropics/skills</code> or <code style={codeInline}>vercel-labs/agent-skills/web-design</code>. Klide runs <code style={codeInline}>npx skills add</code> and the skill lands in <code style={codeInline}>~/.claude/skills/</code>, ready to enable.
        </p>

        <div style={{ marginTop: 22, display: "flex", gap: 8 }}>
          <input
            value={pkg}
            onChange={(e) => setPkg(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onInstall(); }}
            placeholder="owner/repo  or  owner/repo/skill-name"
            disabled={busy}
            className="klide-field"
            style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: 12.5 }}
          />
          <button
            onClick={onInstall}
            disabled={busy || !trimmed}
            className={!busy && trimmed ? "klide-button klide-button-primary" : "klide-button klide-button-secondary"}
            style={{ minHeight: 32, padding: "0 16px" }}
          >
            {busy ? "Installing…" : "Install"}
          </button>
        </div>

        {error && (
          <div className="klide-paper" style={{ marginTop: 14, padding: "12px 14px", borderColor: "color-mix(in srgb, var(--danger) 35%, var(--border))" }}>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--danger)", fontSize: 12, fontFamily: "var(--font-mono)", lineHeight: 1.55 }}>{error}</pre>
          </div>
        )}
        {ok && (
          <div className="klide-paper" style={{ marginTop: 14, padding: "12px 14px" }}>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--fg)", fontSize: 12, fontFamily: "var(--font-mono)", lineHeight: 1.55 }}>{ok}</pre>
          </div>
        )}

        {/* Loaded from disk */}
        <section style={{ marginTop: 36 }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <SectionLabel>Loaded from disk</SectionLabel>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: "var(--fg-dim)", fontFamily: "var(--font-mono)" }}>
              {installedFromFile.length} {installedFromFile.length === 1 ? "skill" : "skills"}
            </span>
          </div>
          {installedFromFile.length === 0 ? (
            <div className="klide-paper" style={{ marginTop: 10, padding: "16px 18px", color: "var(--fg-subtle)", fontSize: 13, lineHeight: 1.6 }}>
              No filesystem skills yet. Install one above or drop a <code style={codeInline}>SKILL.md</code> into <code style={codeInline}>~/.claude/skills/</code> (or <code style={codeInline}>&lt;workspace&gt;/.agents/skills/</code>).
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 10 }}>
              {groupedInstalled(installedFromFile).map(({ group, items }) => (
                <div key={group} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 2px 4px" }}>
                    <span style={{ fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--fg-subtle)", fontWeight: 600 }}>
                      {group}
                    </span>
                    <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
                    <span style={{ fontSize: 10.5, color: "var(--fg-dim)", fontFamily: "var(--font-mono)" }}>{items.length}</span>
                  </div>
                  <div className="klide-surface">
                    {items.map((s, i) => {
                      const folder = s.fromFile?.split("/").slice(-2, -1)[0] ?? s.id;
                      return (
                        <div
                          key={s.id}
                          className="klide-settings-row"
                          style={{ minHeight: 60, padding: "12px 18px", gridTemplateColumns: "minmax(0, 1fr) auto", borderBottom: i < items.length - 1 ? "1px solid var(--border)" : "none" }}
                        >
                          <div style={{ minWidth: 0 }}>
                            <div className="klide-row-title" style={{ marginBottom: 3 }}>{s.name}</div>
                            <div style={{ fontSize: 11, color: "var(--fg-subtle)", fontFamily: "var(--font-mono)", letterSpacing: "0.02em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {folder} · {s.fromFile ? shortenPath(s.fromFile) : ""}
                            </div>
                          </div>
                          <button
                            onClick={() => onUninstall(folder)}
                            disabled={busy}
                            className="klide-button klide-button-ghost"
                            style={{ minHeight: 28, padding: "0 12px", color: "var(--fg-subtle)" }}
                            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--danger)"; }}
                            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-subtle)"; }}
                          >
                            Uninstall
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
