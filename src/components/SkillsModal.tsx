import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  type Skill,
  genSkillId,
  SKILL_TOOLS,
  ALL_TOOL_IDS,
} from "../skills";

type Props = {
  open: boolean;
  skills: Skill[];
  onChange: (skills: Skill[]) => void;
  onClose: () => void;
};

type Tab = "skills" | "tools";

type Draft = {
  id: string | null; // null = creating a new skill
  name: string;
  description: string;
  instructions: string;
  tools: string[];
};

/* ------------------------------------------------------------------ icons */

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.2-3.2" />
    </svg>
  );
}
function PlusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}
function EyeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  );
}
function CodeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 8l-4 4 4 4" />
      <path d="M15 8l4 4-4 4" />
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
        <code key={mdKey++} style={{ fontFamily: "var(--font-mono)", fontSize: 12, background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: "var(--radius-xs)", padding: "1px 5px" }}>
          {m[2]}
        </code>
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
        <pre key={`c-${si}`} style={{ margin: "10px 0", padding: "12px 14px", background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", overflowX: "auto", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.6, color: "var(--fg-strong)", whiteSpace: "pre" }}>
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
      blocks.push(<p key={`p-${si}-${blocks.length}`} style={{ margin: "7px 0", lineHeight: 1.65, color: "var(--fg)" }}>{inline(para.join(" "))}</p>);
      para = [];
    };
    const flushList = () => {
      if (!list) return;
      const cur = list;
      const items = cur.items.map((it, i) => <li key={i} style={{ margin: "3px 0", lineHeight: 1.65, color: "var(--fg)" }}>{inline(it)}</li>);
      blocks.push(cur.ordered
        ? <ol key={`ol-${si}-${blocks.length}`} style={{ margin: "7px 0", paddingLeft: 20 }}>{items}</ol>
        : <ul key={`ul-${si}-${blocks.length}`} style={{ margin: "7px 0", paddingLeft: 20 }}>{items}</ul>);
      list = null;
    };
    for (const line of lines) {
      if (!line.trim()) { flushPara(); flushList(); continue; }
      const h = /^(#{1,3})\s+(.*)$/.exec(line);
      if (h) {
        flushPara(); flushList();
        const lvl = h[1].length;
        blocks.push(
          <div key={`h-${si}-${blocks.length}`} style={{ fontWeight: 600, fontSize: lvl === 1 ? 16 : lvl === 2 ? 14 : 13, color: "var(--fg-strong)", margin: lvl === 1 ? "16px 0 6px" : "13px 0 5px", letterSpacing: "-0.01em" }}>
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

const fieldStyle: React.CSSProperties = {
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
const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--fg-subtle)",
  marginBottom: 6,
  fontWeight: 500,
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
        flexShrink: 0, width: 32, height: 18, borderRadius: 999, padding: 0, position: "relative",
        background: on ? "var(--accent)" : "var(--border-strong)",
        transition: "background var(--motion-med) var(--ease-out)",
      }}
    >
      <span style={{ position: "absolute", top: 2, left: on ? 16 : 2, width: 14, height: 14, borderRadius: "50%", background: "#fff", transition: "left var(--motion-med) var(--ease-out)" }} />
    </button>
  );
}

function relTime(ts?: number): string {
  if (!ts) return "never edited";
  return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function textBtn(color: string): React.CSSProperties {
  return { height: 28, padding: "0 11px", borderRadius: "var(--radius-sm)", fontSize: 12.5, color, background: "transparent" };
}

/* ============================================================ the modal ===*/

export function SkillsModal({ open, skills, onChange, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("skills");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedTool, setSelectedTool] = useState<string>(ALL_TOOL_IDS[0]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [rawView, setRawView] = useState(false);

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

  if (!open) return null;

  function startCreate() {
    setDraft({ id: null, name: "", description: "", instructions: "", tools: [...ALL_TOOL_IDS] });
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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Customize"
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 5000, display: "grid", placeItems: "center", background: "rgba(0,0,0,0.30)", backdropFilter: "blur(3px)" }}
    >
      <div
        className="floating-panel"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(1080px, calc(100vw - 96px))",
          height: "min(680px, calc(100vh - 96px))",
          borderRadius: "var(--radius-lg)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* header: segmented tabs + close */}
        <header style={{ height: 50, flexShrink: 0, padding: "0 12px 0 14px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ display: "flex", gap: 2, padding: 3, borderRadius: "var(--radius-md)", background: "var(--bg-elevated)" }}>
            {(["skills", "tools"] as Tab[]).map((t) => {
              const active = tab === t;
              return (
                <button
                  key={t}
                  onClick={() => { setTab(t); setDraft(null); }}
                  style={{
                    height: 28, padding: "0 14px", borderRadius: "var(--radius-sm)", fontSize: 12.5,
                    fontWeight: active ? 600 : 500,
                    color: active ? "var(--fg-strong)" : "var(--fg-subtle)",
                    background: active ? "var(--bg)" : "transparent",
                    boxShadow: active ? "0 1px 2px rgba(38,38,32,0.10)" : "none",
                  }}
                >
                  {t === "skills" ? "Skills" : "Tools & MCP"}
                </button>
              );
            })}
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} aria-label="Close" style={{ width: 30, height: 30, display: "grid", placeItems: "center", color: "var(--fg-subtle)" }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--fg-strong)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--fg-subtle)"; }}>
            <CloseIcon />
          </button>
        </header>

        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          {tab === "skills" ? (
            <>
              {/* list */}
              <div style={{ width: 270, flexShrink: 0, borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", minHeight: 0 }}>
                <div style={{ height: 44, flexShrink: 0, padding: "0 8px 0 14px", display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ flex: 1, fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--fg-subtle)", fontWeight: 500 }}>
                    {skills.length} {skills.length === 1 ? "skill" : "skills"}
                  </span>
                  <button onClick={() => setSearchOpen((o) => !o)} aria-label="Search" style={iconBtn(searchOpen)}
                    onMouseEnter={(e) => (e.currentTarget.style.color = "var(--fg-strong)")}
                    onMouseLeave={(e) => (e.currentTarget.style.color = searchOpen ? "var(--fg-strong)" : "var(--fg-subtle)")}><SearchIcon /></button>
                  <button onClick={startCreate} aria-label="New skill" title="New skill" style={iconBtn(false)}
                    onMouseEnter={(e) => (e.currentTarget.style.color = "var(--fg-strong)")}
                    onMouseLeave={(e) => (e.currentTarget.style.color = "var(--fg-subtle)")}><PlusIcon /></button>
                </div>
                {searchOpen && (
                  <div style={{ padding: "0 10px 8px" }}>
                    <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter…" style={{ ...fieldStyle, padding: "6px 9px" }} />
                  </div>
                )}
                <div style={{ flex: 1, overflow: "auto", padding: "2px 8px 10px", minHeight: 0 }}>
                  {filtered.length === 0 && <div style={{ padding: "14px 8px", color: "var(--fg-subtle)", fontSize: 13 }}>No skills.</div>}
                  {filtered.map((s) => {
                    const active = s.id === selectedId && !draft;
                    return (
                      <div
                        key={s.id}
                        onClick={() => { setSelectedId(s.id); setDraft(null); setRawView(false); }}
                        style={{
                          padding: "10px 11px", marginBottom: 5, cursor: "pointer",
                          borderRadius: "var(--radius-md)",
                          border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                          background: active ? "var(--accent-soft)" : "var(--bg)",
                          opacity: s.enabled ? 1 : 0.62,
                          transition: "border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
                        }}
                        onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--bg-hover)"; }}
                        onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "var(--bg)"; }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, color: "var(--fg-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {s.name || "Untitled"}
                          </span>
                          <span onClick={(e) => e.stopPropagation()} style={{ display: "flex" }}>
                            <Toggle on={s.enabled} onClick={() => toggleEnabled(s.id)} label={`${s.enabled ? "Disable" : "Enable"} ${s.name}`} />
                          </span>
                        </div>
                        {s.description && (
                          <div style={{ fontSize: 11.5, color: "var(--fg-subtle)", marginTop: 4, lineHeight: 1.45, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                            {s.description}
                          </div>
                        )}
                        <div style={{ marginTop: 7, display: "flex", alignItems: "center", gap: 6 }}>
                          {s.builtin && <span style={pillStyle()}>Built-in</span>}
                          <span style={{ fontSize: 10.5, color: "var(--fg-dim)", fontFamily: "var(--font-mono)" }}>
                            {s.tools.length}/{ALL_TOOL_IDS.length} tools
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* detail */}
              <div style={{ flex: 1, minWidth: 0, overflow: "auto" }}>
                {draft ? (
                  <SkillForm draft={draft} setDraft={setDraft} onSave={saveDraft} onCancel={() => setDraft(null)} />
                ) : selected ? (
                  <SkillDetail
                    skill={selected}
                    rawView={rawView}
                    setRawView={setRawView}
                    onToggle={() => toggleEnabled(selected.id)}
                    onEdit={() => startEdit(selected)}
                    onDelete={() => deleteSkill(selected)}
                  />
                ) : (
                  <EmptyDetail onCreate={startCreate} />
                )}
              </div>
            </>
          ) : (
            <ToolsView skills={skills} selectedTool={selectedTool} setSelectedTool={setSelectedTool} />
          )}
        </div>
      </div>
    </div>
  );
}

function iconBtn(active: boolean): React.CSSProperties {
  return { width: 28, height: 28, display: "grid", placeItems: "center", color: active ? "var(--fg-strong)" : "var(--fg-subtle)" };
}
function pillStyle(): React.CSSProperties {
  return { fontSize: 9.5, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--fg-dim)", border: "1px solid var(--border)", borderRadius: "var(--radius-xs)", padding: "1px 5px" };
}
function segBtn(active: boolean): React.CSSProperties {
  return { width: 28, height: 24, display: "grid", placeItems: "center", borderRadius: "var(--radius-xs)", color: active ? "var(--fg-strong)" : "var(--fg-subtle)", background: active ? "var(--bg-hover)" : "transparent" };
}

/* ----------------------------------------------------------- detail (view) */

function SkillDetail({
  skill, rawView, setRawView, onToggle, onEdit, onDelete,
}: {
  skill: Skill;
  rawView: boolean;
  setRawView: (v: boolean) => void;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div style={{ padding: "22px 26px", maxWidth: 760 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <h2 style={{ flex: 1, minWidth: 0, margin: 0, fontSize: 19, fontWeight: 600, color: "var(--fg-strong)", letterSpacing: "-0.01em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {skill.name}
        </h2>
        <Toggle on={skill.enabled} onClick={onToggle} label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`} />
        <button onClick={onEdit} style={textBtn("var(--fg)")}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--fg-strong)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--fg)"; }}>
          Edit
        </button>
        {!skill.builtin && (
          <button onClick={onDelete} style={textBtn("#D64545")}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
            Delete
          </button>
        )}
      </div>

      {/* compact meta line */}
      <div style={{ marginTop: 10, fontSize: 12, color: "var(--fg-subtle)", display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <span>{skill.builtin ? "Built-in" : "Custom"}</span>
        <span style={{ color: "var(--fg-dim)" }}>·</span>
        <span>Updated {relTime(skill.updatedAt)}</span>
        <span style={{ color: "var(--fg-dim)" }}>·</span>
        <span>{skill.tools.length} of {ALL_TOOL_IDS.length} tools</span>
      </div>

      <p style={{ margin: "16px 0 0", fontSize: 13.5, lineHeight: 1.6, color: "var(--fg)" }}>
        {skill.description || "No description."}
      </p>

      {skill.tools.length > 0 && (
        <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 6 }}>
          {skill.tools.map((t) => (
            <span key={t} style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--fg-subtle)", background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: "var(--radius-xs)", padding: "2px 7px" }}>{t}</span>
          ))}
        </div>
      )}

      {/* instructions */}
      <div style={{ marginTop: 22 }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
          <span style={labelStyle as React.CSSProperties}>Instructions</span>
          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", gap: 2 }}>
            <button onClick={() => setRawView(false)} aria-label="Preview" title="Preview" style={segBtn(!rawView)}><EyeIcon /></button>
            <button onClick={() => setRawView(true)} aria-label="Source" title="Source" style={segBtn(rawView)}><CodeIcon /></button>
          </div>
        </div>
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-md)", background: "var(--bg)", padding: "16px 20px" }}>
          {skill.instructions.trim() === "" ? (
            <div style={{ color: "var(--fg-subtle)", fontSize: 13 }}>No instructions yet.</div>
          ) : rawView ? (
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.65, color: "var(--fg)" }}>{skill.instructions}</pre>
          ) : (
            <div style={{ fontSize: 13.5 }}>{renderMarkdown(skill.instructions)}</div>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyDetail({ onCreate }: { onCreate: () => void }) {
  return (
    <div style={{ height: "100%", display: "grid", placeItems: "center", color: "var(--fg-subtle)", textAlign: "center" }}>
      <div>
        <div style={{ color: "var(--fg)", marginBottom: 8, fontSize: 14 }}>No skill selected</div>
        <button onClick={onCreate} style={{ color: "var(--accent)", fontSize: 13 }}>Create your first skill</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ detail (form) */

function SkillForm({
  draft, setDraft, onSave, onCancel,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const canSave = draft.name.trim().length > 0;
  function toggleTool(id: string) {
    setDraft({ ...draft, tools: draft.tools.includes(id) ? draft.tools.filter((t) => t !== id) : [...draft.tools, id] });
  }
  return (
    <div style={{ padding: "22px 26px", maxWidth: 720 }}>
      <h2 style={{ margin: "0 0 18px", fontSize: 17, fontWeight: 600, color: "var(--fg-strong)" }}>
        {draft.id === null ? "New skill" : "Edit skill"}
      </h2>
      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle} htmlFor="sf-name">Name</label>
        <input id="sf-name" autoFocus value={draft.name} placeholder="e.g. linkedin-weekly-post" onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={fieldStyle} />
      </div>
      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle} htmlFor="sf-desc">Description</label>
        <input id="sf-desc" value={draft.description} placeholder="When the assistant should use this skill" onChange={(e) => setDraft({ ...draft, description: e.target.value })} style={fieldStyle} />
      </div>
      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle} htmlFor="sf-inst">Instructions</label>
        <textarea id="sf-inst" value={draft.instructions} placeholder="What the assistant should do — markdown supported…" onChange={(e) => setDraft({ ...draft, instructions: e.target.value })} rows={12}
          style={{ ...fieldStyle, minHeight: 240, resize: "vertical", lineHeight: 1.6, fontFamily: "var(--font-mono)", fontSize: 12 }} />
      </div>
      <div style={{ marginBottom: 22 }}>
        <label style={labelStyle}>Tools</label>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
          {SKILL_TOOLS.map((tool) => {
            const checked = draft.tools.includes(tool.id);
            return (
              <button key={tool.id} role="checkbox" aria-checked={checked} onClick={() => toggleTool(tool.id)}
                style={{ display: "flex", alignItems: "flex-start", gap: 9, textAlign: "left", padding: "9px 11px", borderRadius: "var(--radius-sm)", border: `1px solid ${checked ? "var(--accent)" : "var(--border)"}`, background: checked ? "var(--accent-soft)" : "transparent" }}>
                <span aria-hidden="true" style={{ flexShrink: 0, marginTop: 1, width: 15, height: 15, borderRadius: "var(--radius-xs)", border: `1px solid ${checked ? "var(--accent)" : "var(--border-strong)"}`, background: checked ? "var(--accent)" : "transparent", display: "grid", placeItems: "center", color: "#fff" }}>
                  {checked && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 6" /></svg>}
                </span>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--fg-strong)", fontFamily: "var(--font-mono)" }}>{tool.id}</span>
                  <span style={{ display: "block", fontSize: 10.5, color: "var(--fg-subtle)", marginTop: 2 }}>{tool.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={onSave} disabled={!canSave} style={{ height: 32, padding: "0 18px", borderRadius: "var(--radius-sm)", color: canSave ? "#fff" : "var(--fg-dim)", background: canSave ? "var(--accent)" : "var(--bg-elevated)", fontSize: 12.5, fontWeight: 500, cursor: canSave ? "pointer" : "default" }}>
          {draft.id === null ? "Create skill" : "Save changes"}
        </button>
        <button onClick={onCancel} style={{ height: 32, padding: "0 15px", borderRadius: "var(--radius-sm)", color: "var(--fg-subtle)", background: "var(--bg-elevated)", fontSize: 12.5 }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--fg-strong)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--fg-subtle)")}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- Tools & MCP ---*/

function MetaCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, color: "var(--fg-subtle)", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 13, color: "var(--fg-strong)" }}>{children}</div>
    </div>
  );
}

function ToolsView({
  skills, selectedTool, setSelectedTool,
}: {
  skills: Skill[];
  selectedTool: string;
  setSelectedTool: (id: string) => void;
}) {
  const tool = SKILL_TOOLS.find((t) => t.id === selectedTool) ?? SKILL_TOOLS[0];
  const usedBy = skills.filter((s) => s.tools.includes(tool.id));
  return (
    <>
      <div style={{ width: 270, flexShrink: 0, borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ flex: 1, overflow: "auto", padding: "10px 8px", minHeight: 0 }}>
          <div style={{ padding: "4px 6px 6px", fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--fg-subtle)", fontWeight: 500 }}>Built-in tools</div>
          {SKILL_TOOLS.map((t) => {
            const active = t.id === selectedTool;
            return (
              <button key={t.id} onClick={() => setSelectedTool(t.id)}
                style={{ width: "100%", textAlign: "left", padding: "8px 11px", marginBottom: 3, borderRadius: "var(--radius-sm)", fontSize: 12.5, fontFamily: "var(--font-mono)", color: active ? "var(--fg-strong)" : "var(--fg)", background: active ? "var(--accent-soft)" : "transparent", border: `1px solid ${active ? "var(--accent)" : "transparent"}` }}
                onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}>
                {t.id}
              </button>
            );
          })}
          <div style={{ padding: "16px 6px 6px", fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--fg-subtle)", fontWeight: 500 }}>MCP servers</div>
          <div style={{ padding: "4px 6px", fontSize: 12, color: "var(--fg-dim)", lineHeight: 1.55 }}>None connected yet.</div>
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 0, overflow: "auto" }}>
        <div style={{ padding: "22px 26px", maxWidth: 760 }}>
          <h2 style={{ margin: 0, fontSize: 19, fontWeight: 600, color: "var(--fg-strong)", fontFamily: "var(--font-mono)" }}>{tool.id}</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 18, marginTop: 18 }}>
            <MetaCell label="Name">{tool.label}</MetaCell>
            <MetaCell label="Source">Built-in</MetaCell>
            <MetaCell label="Used by">{usedBy.length} {usedBy.length === 1 ? "skill" : "skills"}</MetaCell>
          </div>
          <p style={{ margin: "18px 0 0", fontSize: 13.5, lineHeight: 1.6, color: "var(--fg)" }}>{tool.description}</p>
          <div style={{ marginTop: 20, border: "1px solid var(--border)", borderRadius: "var(--radius-md)", padding: "16px 20px" }}>
            <div style={{ fontSize: 12.5, fontWeight: 500, color: "var(--fg-strong)", marginBottom: 10 }}>Enabled in</div>
            {usedBy.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--fg-subtle)" }}>No skills currently allow this tool.</div>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {usedBy.map((s) => (
                  <span key={s.id} style={{ fontSize: 12, color: "var(--fg)", background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: "var(--radius-xs)", padding: "3px 9px" }}>{s.name}</span>
                ))}
              </div>
            )}
          </div>
          <div style={{ marginTop: 14, fontSize: 12, color: "var(--fg-dim)", lineHeight: 1.6 }}>
            MCP server support is planned — once connected, their tools will appear here alongside the built-ins.
          </div>
        </div>
      </div>
    </>
  );
}
