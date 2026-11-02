import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useSlidingHighlight } from "../hooks/useSlidingHighlight";
import { Z } from "../zLayers";
import { notify } from "../toast";
import { listConnectors, type Connector } from "../ipc/connectors";
import { canOpenSettings, openSettingsSection } from "../settingsNavigation";
import {
  SKILL_MARKS,
  appearanceOf,
  defaultLabel,
  resetAppearance,
  saveAppearance,
  useSkillAppearances,
} from "../skillAppearance";
import { MARK_NAMES, SkillMarkGlyph } from "./ai/skillMarks";
import {
  type Skill,
  genSkillId,
  SKILL_TOOLS,
  type AvailableTool,
  getAvailableTools,
  installSkill,
  uninstallSkill,
  enabledFirst,
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

type ToolEntry = AvailableTool;

/* ------------------------------------------------------------------ icons */

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
        <code key={mdKey++} style={{ fontFamily: "var(--font-mono)", fontSize: "0.9em", color: "var(--fg-strong)", background: "var(--bg-hover)", padding: "1px 4px", borderRadius: "var(--radius-xs)" }}>{m[2]}</code>
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
// The command menu's heading: small, dim, sentence case — never shouted.
const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 11,
  color: "var(--fg-dim)",
  marginBottom: 6,
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
      <span style={{ position: "absolute", top: 2, left: on ? 14 : 2, width: 14, height: 14, borderRadius: "50%", background: "var(--control-primary-fg)", transition: "left var(--motion-med) var(--ease-out)" }} />
    </button>
  );
}

/** The command menu's highlight, placed by `useSlidingHighlight`. */
function Highlight({ at }: { at: ReturnType<typeof useSlidingHighlight>["indicator"] }) {
  if (!at) return null;
  return <div className="klide-cmd-indicator" data-ready={at.ready || undefined} style={at.style} aria-hidden="true" />;
}

function NavRail({
  navItems, tab, onTabChange, onCreate,
}: {
  navItems: { id: Tab; label: string; icon: ReactNode; count: number | null }[];
  tab: Tab;
  onTabChange: (t: Tab) => void;
  onCreate: () => void;
}) {
  const hl = useSlidingHighlight(tab, navItems.map((n) => `${n.id}:${n.count}`).join("|"));
  return (
    <div className="klide-skills-list" {...hl.list}>
      <Highlight at={hl.indicator} />
      {navItems.map((n) => {
        const active = tab === n.id;
        return (
          <button
            key={n.id}
            {...hl.row(n.id)}
            onClick={() => onTabChange(n.id)}
            className="klide-cmd-option klide-skills-option"
            data-active={active || undefined}
            aria-current={active ? "page" : undefined}
          >
            {n.icon}
            <span className="klide-cmd-label"><span>{n.label}</span></span>
            {n.count !== null && <span className="klide-cmd-hint">{n.count}</span>}
          </button>
        );
      })}
      <div className="klide-skills-rule" />
      <button {...hl.row("new")} onClick={onCreate} className="klide-cmd-option klide-skills-option">
        <PlusIcon />
        <span className="klide-cmd-label"><span>New skill</span></span>
      </button>
    </div>
  );
}

/** Named for what it returns: an absolute date, not a relative time. It was
 *  called `relTime`, which read as a fourth copy of `relativeTime` and is the
 *  opposite of what it does. */
function editedDate(ts?: number): string {
  if (!ts) return "never edited";
  return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
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
  const [connectors, setConnectors] = useState<Connector[]>([]);

  // Skills land on disk from outside the modal too — a terminal `npx skills
  // add`, an agent writing a SKILL.md — so opening the list re-reads it.
  useEffect(() => {
    if (open) void onReloadFilesystemSkills();
  }, [open, onReloadFilesystemSkills]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const live = await getAvailableTools();
      if (cancelled) return;
      setTools(live);
      setSelectedTool((prev) => (live.some((t) => t.id === prev) ? prev : (live[0]?.id ?? "")));
      // The inventory answers "what can an agent reach?", and a connector is
      // part of that answer even before its tools are callable.
      const added = await listConnectors().catch(() => []);
      if (!cancelled) setConnectors(added);
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
    const ordered = enabledFirst(skills);
    if (!q) return ordered;
    return ordered.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
  }, [skills, query]);

  // Tools filter and order the way the list draws them, so ↑ / ↓ follow the
  // rows on screen rather than the registry's order.
  const filteredTools = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? tools.filter((t) => t.id.toLowerCase().includes(q) || t.label.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
      : tools;
    return groupTools(matched).flatMap((group) => group.tools);
  }, [tools, query]);

  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

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

  // The header is the command menu's field: it filters the list beside it,
  // and ↑ / ↓ walk that list the way they walk the menu's rows.
  function step(delta: 1 | -1) {
    const ids = tab === "tools" ? filteredTools.map((t) => t.id) : filtered.map((s) => s.id);
    if (ids.length === 0) return;
    const current = tab === "tools" ? selectedTool : selectedId;
    const at = current ? ids.indexOf(current) : -1;
    const next = ids[at < 0 ? 0 : Math.max(0, Math.min(ids.length - 1, at + delta))];
    if (tab === "tools") setSelectedTool(next);
    else {
      setSelectedId(next);
      setDraft(null);
      setRawView(false);
    }
  }

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      className="klide-skills-scrim"
      style={{ zIndex: Z.modal }}
    >
      <div className="klide-skills" role="dialog" aria-modal="true" aria-label="Skills">
          <div className="klide-cmd-header">
            <SearchIcon />
            <input
              ref={searchRef}
              className="klide-cmd-input"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (tab === "install") setTab("skills");
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); step(1); }
                else if (e.key === "ArrowUp") { e.preventDefault(); step(-1); }
              }}
              placeholder={tab === "tools" ? "Search tools…" : "Search skills…"}
              spellCheck={false}
              autoComplete="off"
              aria-label={tab === "tools" ? "Search tools" : "Search skills"}
            />
            <button className="klide-cmd-esc" onClick={onClose} aria-label="Close">Esc</button>
          </div>

          {/* Body — sections, the list, the page */}
          <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
            <nav aria-label="Sections" className="klide-skills-column" style={{ width: 196 }}>
              <NavRail
                navItems={navItems}
                tab={tab}
                onTabChange={(t) => { setTab(t); setDraft(null); }}
                onCreate={() => { setTab("skills"); startCreate(); }}
              />
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
                    // Pre-validate the format so a typo fails instantly with a
                    // clear message instead of a cryptic shell error 20s later.
                    const formatError = validateSkillPackage(trimmed);
                    if (formatError) {
                      setInstallError(formatError);
                      return;
                    }
                    setInstallBusy(true);
                    setInstallError(null);
                    setInstallOk(null);
                    try {
                      const r = await installSkill(trimmed);
                      if (!r.ok) {
                        const msg = interpretInstallError(r.stderr || r.stdout || `Exit ${r.exitCode ?? "?"}`);
                        setInstallError(msg);
                        notify(`Couldn't install ${trimmed}: ${msg}`, { tone: "error" });
                      } else {
                        setInstallOk(r.stdout.trim() || "Installed.");
                        setInstallPkg("");
                        // The reload announces each skill it finds new.
                        await onReloadFilesystemSkills();
                      }
                    } catch (e) {
                      const msg = interpretInstallError(String(e));
                      setInstallError(msg);
                      notify(`Couldn't install ${trimmed}: ${msg}`, { tone: "error" });
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
                      const r = await uninstallSkill(name);
                      if (!r.ok) {
                        const msg = interpretInstallError(r.stderr || r.stdout || "Uninstall failed.");
                        setInstallError(msg);
                        notify(`Couldn't uninstall ${name}: ${msg}`, { tone: "error" });
                      } else {
                        setInstallOk(r.stdout.trim() || "Uninstalled.");
                        await onReloadFilesystemSkills();
                        notify(`Uninstalled ${name}`, { tone: "success" });
                      }
                    } catch (e) {
                      setInstallError(String(e));
                    } finally {
                      setInstallBusy(false);
                    }
                  }}
                />
              ) : (
                <ToolsView skills={skills} selectedTool={selectedTool} setSelectedTool={setSelectedTool} tools={tools} filteredTools={filteredTools} query={query} connectors={connectors} />
              )}
            </main>
          </div>
      </div>
    </div>
  );
}

/* ============================================================ Skills pane */

function SkillsPane({
  filtered, selected, draft, query, onSelect, onCreate,
  onToggleEnabled, onEdit, onDelete, onSaveDraft, onCancelDraft, setDraft,
  rawView, setRawView, tools,
}: {
  skills: Skill[];
  filtered: Skill[];
  selected: Skill | null;
  draft: Draft | null;
  query: string;
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
  const sections = [
    { label: "Enabled", items: filtered.filter((s) => s.enabled) },
    { label: "Off", items: filtered.filter((s) => !s.enabled) },
  ].filter((section) => section.items.length > 0);
  const hl = useSlidingHighlight(
    draft ? null : selected?.id ?? null,
    filtered.map((s) => `${s.id}:${s.enabled}`).join("|"),
  );
  return (
    <>
      {/* Skill list — the command menu's rows: on first, then off */}
      <aside aria-label="Skill list" className="klide-skills-column" style={{ width: 300 }}>
        <div className="klide-skills-list" role="listbox" aria-label="Skills" {...hl.list}>
          <Highlight at={hl.indicator} />
          {filtered.length === 0 && (
            <div className="klide-cmd-empty">{query.trim() ? `No skills matching "${query.trim()}"` : "No skills yet"}</div>
          )}
          {sections.map((section) => (
            <Fragment key={section.label}>
              <div className="klide-cmd-heading">{section.label}</div>
              {section.items.map((s) => {
                const active = !draft && selected !== null && s.id === selected.id;
                return (
                  <div
                    key={s.id}
                    {...hl.row(s.id)}
                    onClick={() => onSelect(s.id)}
                    className="klide-cmd-option klide-skill-option"
                    role="option"
                    aria-selected={active}
                    data-active={active || undefined}
                    data-disabled={!s.enabled || undefined}
                  >
                    <div className="klide-skill-text">
                      <span>{s.name || "Untitled"}</span>
                      {s.description && <small>{s.description}</small>}
                    </div>
                    <span onClick={(e) => e.stopPropagation()} style={{ display: "flex" }}>
                      <Toggle on={s.enabled} onClick={() => onToggleEnabled(s.id)} label={`${s.enabled ? "Disable" : "Enable"} ${s.name}`} />
                    </span>
                  </div>
                );
              })}
            </Fragment>
          ))}
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
        <button onClick={onEdit} aria-label="Edit skill" title="Edit skill" className="klide-button klide-button-subtle" style={{ minHeight: 30, padding: "0 8px", color: "var(--fg-subtle)" }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--fg-strong)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-subtle)"; e.currentTarget.style.background = "transparent"; }}>
          <PencilIcon />
        </button>
        {!skill.builtin && (
          <button onClick={onDelete} aria-label="Delete skill" title="Delete skill" className="klide-button klide-button-subtle" style={{ minHeight: 30, padding: "0 8px", color: "var(--fg-subtle)" }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--danger)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-subtle)"; e.currentTarget.style.background = "transparent"; }}>
            <TrashIcon />
          </button>
        )}
      </div>

      {/* Meta strip */}
      <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", rowGap: 6, columnGap: 22, alignItems: "center", fontSize: 12, color: "var(--fg-subtle)" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-dim)" }}>{skill.builtin ? "Built-in" : groupBadge(skill)}</span>
        <span>Updated {editedDate(skill.updatedAt)}</span>
        <span>{skill.tools.length} of {tools.length} tools allowed</span>
        {skill.fromFile && (<>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 320 }} title={skill.fromFile}>
            {shortenPath(skill.fromFile)}
          </span>
        </>)}
      </div>

      {/* Quote */}
      {skill.description && (
        <blockquote className="klide-quote" style={{ marginTop: 20, fontSize: 13 }}>
          {skill.description}
        </blockquote>
      )}

      {/* How it reads once it is typed */}
      <SkillLedeSection skill={skill} key={skill.id} />

      {/* Allowed tools list */}
      {skill.tools.length > 0 && (
        <section style={{ marginTop: 28 }}>
          <SectionLabel>Allowed tools</SectionLabel>
          <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", rowGap: 8, columnGap: 22, fontSize: 11.5, fontFamily: "var(--font-mono)", color: "var(--fg)" }}>
            {skill.tools.map((id) => (
              <span key={id} style={{ whiteSpace: "nowrap" }}>{id}</span>
            ))}
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
            <span style={{ color: "var(--fg-subtle)", fontFamily: "var(--font-mono)" }}>SKILL.md</span>
            <span style={{ flex: 1 }} />
            <span style={{ color: "var(--fg-dim)" }}>{lineCount} {lineCount === 1 ? "line" : "lines"}</span>
            <span style={{ color: "var(--fg-dim)", marginLeft: 20 }}>{charCount} chars</span>
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

/* ------------------------------------------- lede (how the skill reads typed) */

// A skill invocation is text: `/visualise draw the flow` goes out as typed, and
// the composer draws that leading command as the skill instead — its name, in
// the accent (see components/ai/skillToken.ts). Every enabled skill reads that
// way; what it is called, whether it carries a mark, and whether it reads as a
// skill at all are chosen here, per skill, and saved.
//
// The sample is the real drawing, not a picture of one: the same mark component
// the composer uses, at the composer's type size. Writing on each keystroke
// keeps it that way — there is no Save to forget.
export function SkillLedeSection({ skill }: { skill: Skill }) {
  const saved = useSkillAppearances();
  const current = appearanceOf(skill, saved);
  const stored = saved.some((a) => a.command === current.command);
  if (!current.command) return null;

  const write = (patch: Partial<typeof current>) =>
    saveAppearance({ ...current, ...patch });

  return (
    <section style={{ marginTop: 28 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <SectionLabel>In the composer</SectionLabel>
        <div style={{ flex: 1 }} />
        {stored && (
          <button onClick={() => resetAppearance(current.command)} title="Forget this and use the default"
            style={{ background: "transparent", border: 0, color: "var(--fg-dim)", font: "inherit", fontSize: 11, cursor: "pointer" }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--fg-strong)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-dim)"; }}>
            Default
          </button>
        )}
        <Toggle
          on={current.lede}
          onClick={() => write({ lede: !current.lede })}
          label={`${current.lede ? "Stop drawing" : "Draw"} ${skill.name} as a lede in the composer`}
        />
      </div>

      {/* The sample line — what the composer will draw, at its own size. */}
      <div style={{ marginTop: 12, border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--bg-elevated)", padding: "13px 15px", display: "flex", alignItems: "center", gap: 7, fontSize: 13.5, minWidth: 0 }}>
        {current.lede ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--accent)", whiteSpace: "nowrap" }}>
            {current.label.trim() || defaultLabel(skill.name)}
            {current.mark && <SkillMarkGlyph mark={current.mark} size={14} />}
          </span>
        ) : (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, color: "var(--fg)", whiteSpace: "nowrap" }}>/{current.command}</span>
        )}
        <span style={{ color: "var(--fg-subtle)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          what you type next
        </span>
      </div>

      {current.lede ? (
        <div className="skills-tab-in" style={{ marginTop: 14, display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
          <label style={{ flex: "1 1 200px", minWidth: 180 }}>
            <span style={labelStyle}>Name</span>
            <input
              value={current.label}
              placeholder={defaultLabel(skill.name)}
              onChange={(e) => write({ label: e.target.value })}
              style={fieldStyle}
            />
          </label>
          <div>
            <span style={labelStyle}>Mark</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 2, maxWidth: 260 }}>
              {/* None first, because most skills read as their name alone. */}
              <button
                onClick={() => write({ mark: null })}
                aria-label="No mark"
                aria-pressed={current.mark === null}
                title="No mark — the name alone"
                style={{
                  width: 30, height: 30, display: "grid", placeItems: "center",
                  border: 0, borderRadius: "var(--radius-sm)", cursor: "pointer",
                  font: "inherit", fontSize: 15, lineHeight: 1,
                  background: current.mark === null ? "var(--bg-hover)" : "transparent",
                  color: current.mark === null ? "var(--accent)" : "var(--fg-subtle)",
                  transition: "color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
                }}
                onMouseEnter={(e) => { if (current.mark !== null) e.currentTarget.style.color = "var(--fg-strong)"; }}
                onMouseLeave={(e) => { if (current.mark !== null) e.currentTarget.style.color = "var(--fg-subtle)"; }}
              >
                &ndash;
              </button>
              {SKILL_MARKS.map((mark) => (
                <button
                  key={mark}
                  onClick={() => write({ mark })}
                  aria-label={MARK_NAMES[mark]}
                  aria-pressed={mark === current.mark}
                  title={MARK_NAMES[mark]}
                  style={{
                    width: 30, height: 30, display: "grid", placeItems: "center",
                    border: 0, borderRadius: "var(--radius-sm)", cursor: "pointer",
                    background: mark === current.mark ? "var(--bg-hover)" : "transparent",
                    color: mark === current.mark ? "var(--accent)" : "var(--fg-subtle)",
                    transition: "color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
                  }}
                  onMouseEnter={(e) => { if (mark !== current.mark) e.currentTarget.style.color = "var(--fg-strong)"; }}
                  onMouseLeave={(e) => { if (mark !== current.mark) e.currentTarget.style.color = "var(--fg-subtle)"; }}
                >
                  <SkillMarkGlyph mark={mark} size={16} />
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 10, fontSize: 12, color: "var(--fg-subtle)", lineHeight: 1.55 }}>
          Typed plainly, as the command. Turn this on to have the composer read
          it as {defaultLabel(skill.name)} instead{skill.enabled ? "" : " — while the skill is enabled"}.
        </div>
      )}

      {current.lede && !skill.enabled && (
        <div style={{ marginTop: 10, fontSize: 12, color: "var(--fg-subtle)" }}>
          The composer draws this once the skill is enabled — a lede for a skill
          the run won't follow would promise what the send can't keep.
        </div>
      )}
    </section>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span style={{ ...labelStyle, fontSize: 12, color: "var(--fg-subtle)", marginBottom: 0, display: "inline-flex", alignItems: "center" }}>
      {children}
    </span>
  );
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

/** Section heading per capability, in the order the inventory lists them. */
const CAPABILITY_GROUPS: { capability: string; label: string }[] = [
  { capability: "read_workspace", label: "Read-only" },
  { capability: "read_conversation_history", label: "Conversation history" },
  { capability: "read_project_memory", label: "Project memory" },
  { capability: "propose_project_memory", label: "Memory proposals" },
  { capability: "update_plan_state", label: "Plan state" },
  { capability: "write_workspace", label: "Write · diff review" },
  { capability: "run_command", label: "Command · approval" },
  { capability: "manage_background_shell", label: "Background shell" },
  { capability: "network", label: "Network · approval" },
  { capability: "pause_for_user", label: "Pause" },
  { capability: "coordinate_agents", label: "Coordination" },
];

function capabilityLabel(capability: string | undefined): string {
  return CAPABILITY_GROUPS.find((group) => group.capability === capability)?.label ?? "Other";
}

/** The tools in capability groups, in the order the inventory lists them. */
function groupTools(tools: ToolEntry[]): { label: string; tools: ToolEntry[] }[] {
  const known = new Set(CAPABILITY_GROUPS.map((group) => group.capability));
  return [
    ...CAPABILITY_GROUPS.map(({ capability, label }) => ({
      label,
      tools: tools.filter((t) => t.capability === capability),
    })),
    { label: "Other", tools: tools.filter((t) => !t.capability || !known.has(t.capability)) },
  ].filter((group) => group.tools.length > 0);
}

function ToolsView({
  skills, selectedTool, setSelectedTool, tools, filteredTools, query, connectors,
}: {
  skills: Skill[];
  selectedTool: string;
  setSelectedTool: (id: string) => void;
  tools: ToolEntry[];
  /** `tools` narrowed by the header search, already in list order. */
  filteredTools: ToolEntry[];
  query: string;
  /** MCP servers the user has added (Settings → Connectors). Listed beside the
   *  built-ins because that is the inventory question this pane answers — their
   *  tools join the list once the harness can call them. */
  connectors: Connector[];
}) {
  const tool = tools.find((t) => t.id === selectedTool) ?? tools[0];
  const usedBy = tool ? skills.filter((s) => s.tools.includes(tool.id)) : [];
  const groups = groupTools(filteredTools);
  const searching = query.trim().length > 0;
  const hl = useSlidingHighlight(tool?.id ?? null, filteredTools.map((t) => t.id).join("|"));
  return (
    <>
      <aside aria-label="Tool list" className="klide-skills-column" style={{ width: 300 }}>
        <div className="klide-skills-list" role="listbox" aria-label="Tools" {...hl.list}>
          <Highlight at={hl.indicator} />
          {groups.length === 0 && <div className="klide-cmd-empty">No tools matching "{query.trim()}"</div>}
          {groups.map((group) => (
            <Fragment key={group.label}>
              <div className="klide-cmd-heading">{group.label}</div>
              {group.tools.map((t) => {
                const active = t.id === tool?.id;
                return (
                  <div
                    key={t.id}
                    {...hl.row(t.id)}
                    onClick={() => setSelectedTool(t.id)}
                    className="klide-cmd-option klide-tool-option"
                    role="option"
                    aria-selected={active}
                    data-active={active || undefined}
                  >
                    <div className="klide-cmd-label"><span>{t.id}</span></div>
                  </div>
                );
              })}
            </Fragment>
          ))}
          {!searching && (
            <>
              <div className="klide-cmd-heading">Connectors</div>
              <div style={{ padding: "2px 10px 8px", fontSize: 12, color: "var(--fg-subtle)", lineHeight: 1.7 }}>
                {connectors.length === 0 ? (
                  <span style={{ color: "var(--fg-dim)" }}>None yet.</span>
                ) : (
                  connectors.map((c) => (
                    <div key={c.id} style={{ opacity: c.enabled ? 1 : 0.5 }}>{c.label}</div>
                  ))
                )}
                {canOpenSettings() && (
                  <button
                    type="button"
                    onClick={() => openSettingsSection("connectors")}
                    style={{
                      display: "block", marginTop: 4, padding: 0, border: "none", background: "none",
                      color: "var(--accent)", fontSize: 12, cursor: "pointer", font: "inherit",
                    }}
                  >
                    Manage connectors
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </aside>

      <div style={{ flex: 1, minWidth: 0, overflow: "auto" }} className="skills-tab-in" key={selectedTool}>
        {tool ? (
          <div style={{ padding: "32px 36px", maxWidth: 720 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
              <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: "var(--fg-strong)", fontFamily: "var(--font-mono)", letterSpacing: "-0.01em" }}>
                {tool.id}
              </h2>
              <span style={{ fontSize: 10.5, fontFamily: "var(--font-mono)", color: tool.capability === "write_workspace" ? "var(--warning)" : "var(--fg-subtle)" }}>
                {capabilityLabel(tool.capability)}
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
                <span>Enabled in</span>
              </div>
              <div style={{ padding: "14px 18px" }}>
                {usedBy.length === 0 ? (
                  <div style={{ fontSize: 13, color: "var(--fg-subtle)" }}>No skills currently allow this tool.</div>
                ) : (
                  <div style={{ fontSize: 11.5, color: "var(--fg)", lineHeight: 1.9 }}>
                    {usedBy.map((s, i) => (
                      <span key={s.id} style={{ whiteSpace: "nowrap" }}>
                        {i > 0 && <span style={{ color: "var(--fg-dim)", whiteSpace: "normal" }}>{" · "}</span>}
                        {s.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div style={{ marginTop: 18, fontSize: 12, color: "var(--fg-dim)", lineHeight: 1.6 }}>
              Connector tools are not callable yet — a connector's tools are listed in
              Settings → Connectors, and join this inventory once the harness can run them.
            </div>
          </div>
        ) : (
          <div style={{ padding: 40, color: "var(--fg-subtle)", textAlign: "center" }}>No tools available.</div>
        )}
      </div>
    </>
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

// Accept `owner/repo` or `owner/repo/nested/skill-path`. Returns an error
// string when malformed so we never fire a doomed `npx` shell call.
function validateSkillPackage(pkg: string): string | null {
  if (!/^[\w.-]+\/[\w.-]+(\/[\w.-]+)*$/.test(pkg)) {
    return "Use the form owner/repo or owner/repo/skill-name (letters, numbers, dots and dashes only).";
  }
  return null;
}

// Turn raw npx/git stderr into one human sentence. Falls back to the raw text
// (trimmed) so we never hide detail we couldn't classify.
function interpretInstallError(raw: string): string {
  const m = raw.toLowerCase();
  if (/(npx|npm).*(not found|enoent)|command not found/.test(m) && /npx|npm/.test(m)) {
    return "npx isn't available — install Node.js (it includes npx), then try again.";
  }
  if (/git.*(not found|enoent)/.test(m)) {
    return "git isn't available — install git, then try again.";
  }
  if (/(404|not found|could not resolve|repository not found|does not exist)/.test(m)) {
    return "Couldn't find that package — check the owner/repo is spelled correctly and the repo is public.";
  }
  if (/(etimedout|enotfound|getaddrinfo|network|econnrefused|socket hang up)/.test(m)) {
    return "Network error — check your connection and try again.";
  }
  const trimmed = raw.trim();
  return trimmed.length > 400 ? trimmed.slice(0, 400) + "…" : trimmed || "Install failed.";
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

        {busy && (
          <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 9, fontSize: 12.5, color: "var(--fg-subtle)" }}>
            <span className="ai-assistant-placeholder-loader" aria-hidden><span /><span /><span /></span>
            Fetching from GitHub and installing — this can take up to a minute.
          </div>
        )}
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
                    <span style={{ fontSize: 11, color: "var(--fg-dim)" }}>
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
