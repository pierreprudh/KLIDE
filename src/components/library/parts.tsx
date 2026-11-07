// The Library's shared parts — the command menu's field, rail, rows and paper,
// drawn once for every tab that lists things and opens one (Skills, Memory).
// A tab composes these; it does not restyle them.

import type { CSSProperties, ReactNode } from "react";
import { useSlidingHighlight } from "../../hooks/useSlidingHighlight";

/* ------------------------------------------------------------------ icons */

export function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.2-3.2" />
    </svg>
  );
}
export function PlusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}
export function EyeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  );
}
export function CodeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 8l-4 4 4 4" />
      <path d="M15 8l4 4-4 4" />
    </svg>
  );
}
export function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}
export function TrashIcon() {
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

export function renderMarkdown(text: string): ReactNode[] {
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

export const fieldStyle: CSSProperties = {
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
export const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 11,
  color: "var(--fg-dim)",
  marginBottom: 6,
};

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span style={{ ...labelStyle, fontSize: 12, color: "var(--fg-subtle)", marginBottom: 0, display: "inline-flex", alignItems: "center" }}>
      {children}
    </span>
  );
}

export function segBtn(active: boolean): CSSProperties {
  return { width: 28, height: 24, display: "grid", placeItems: "center", borderRadius: "var(--radius-xs)", color: active ? "var(--fg-strong)" : "var(--fg-subtle)", background: active ? "var(--bg-hover)" : "transparent" };
}

/** Preview / Source — the two eyes over a paper card. */
export function ViewToggle({ raw, onChange }: { raw: boolean; onChange: (raw: boolean) => void }) {
  return (
    <div style={{ display: "flex", gap: 2 }}>
      <button onClick={() => onChange(false)} aria-label="Preview" aria-pressed={!raw} title="Preview" style={segBtn(!raw)}><EyeIcon /></button>
      <button onClick={() => onChange(true)} aria-label="Source" aria-pressed={raw} title="Source" style={segBtn(raw)}><CodeIcon /></button>
    </div>
  );
}

/** A quiet icon action in a detail title row — dim until pointed at. */
export function DetailAction({ label, onClick, danger = false, children }: { label: string; onClick: () => void; danger?: boolean; children: ReactNode }) {
  return (
    <button onClick={onClick} aria-label={label} title={label} className="klide-button klide-button-subtle" style={{ minHeight: 30, padding: "0 8px", color: "var(--fg-subtle)" }}
      onMouseEnter={(e) => { e.currentTarget.style.color = danger ? "var(--danger)" : "var(--fg-strong)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-subtle)"; e.currentTarget.style.background = "transparent"; }}>
      {children}
    </button>
  );
}

/** The on / off switch beside a row or a page title. */
export function Toggle({ on, onClick, label, disabled = false }: { on: boolean; onClick: () => void; label: string; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      style={{
        flexShrink: 0, width: 30, height: 18, borderRadius: 999, padding: 0, position: "relative", opacity: disabled ? 0.45 : 1, cursor: disabled ? "default" : "pointer",
        background: on ? "var(--accent)" : "var(--border-strong)",
        transition: "background var(--motion-med) var(--ease-out)",
      }}
    >
      <span style={{ position: "absolute", top: 2, left: on ? 14 : 2, width: 14, height: 14, borderRadius: "50%", background: "var(--control-primary-fg)", transition: "left var(--motion-med) var(--ease-out)" }} />
    </button>
  );
}

/** The command menu's highlight, placed by `useSlidingHighlight`. */
export function Highlight({ at }: { at: ReturnType<typeof useSlidingHighlight>["indicator"] }) {
  if (!at) return null;
  return <div className="klide-cmd-indicator" data-ready={at.ready || undefined} style={at.style} aria-hidden="true" />;
}

export type NavItem<T extends string> = { id: T; label: string; icon: ReactNode; count: number | null };

/** A tab's sections as menu rows, then one action under a hairline. */
export function NavRail<T extends string>({
  navItems, tab, onTabChange, action,
}: {
  navItems: NavItem<T>[];
  tab: T;
  onTabChange: (t: T) => void;
  action?: { label: string; icon: ReactNode; onClick: () => void };
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
      {action && (
        <>
          <div className="klide-skills-rule" />
          <button {...hl.row("__action")} onClick={action.onClick} className="klide-cmd-option klide-skills-option">
            {action.icon}
            <span className="klide-cmd-label"><span>{action.label}</span></span>
          </button>
        </>
      )}
    </div>
  );
}
